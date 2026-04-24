import crypto from "node:crypto";
import express, { type Request } from "express";
import Arcade from "@arcadeai/arcadejs";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  ARCADE_API_KEY: z.string().min(1, "ARCADE_API_KEY is required"),
  ARCADE_USER_ID: z.string().min(1, "ARCADE_USER_ID is required"),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  JIRA_ISSUE_REGEX: z.string().default("[A-Z][A-Z0-9]+-\\d+"),
  REQUIRE_EXACT_BRANCH_KEY: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  JIRA_COMMENT_MARKER: z.string().default("[github-jira-sync]")
});

const parsedEnv = envSchema.safeParse(process.env);
if (!parsedEnv.success) {
  console.error("Invalid environment configuration:", parsedEnv.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsedEnv.data;

const config = {
  port: env.PORT,
  arcadeApiKey: env.ARCADE_API_KEY,
  arcadeUserId: env.ARCADE_USER_ID,
  githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET?.trim() || undefined,
  jiraIssueRegex: env.JIRA_ISSUE_REGEX,
  requireExactBranchKey: env.REQUIRE_EXACT_BRANCH_KEY,
  jiraCommentMarker: env.JIRA_COMMENT_MARKER
};

const issueKeyPattern = new RegExp(
  config.requireExactBranchKey ? `^${config.jiraIssueRegex}$` : config.jiraIssueRegex
);

const arcade = new Arcade({ apiKey: config.arcadeApiKey });

const pullRequestEventSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    number: z.number(),
    title: z.string().optional(),
    html_url: z.string().optional(),
    head: z.object({
      ref: z.string()
    })
  }),
  repository: z.object({
    name: z.string(),
    owner: z.object({
      login: z.string()
    })
  })
});

type RawBodyRequest = Request & {
  rawBody?: Buffer;
};

type ToolExecutionResult =
  | {
      needsAuthorization: true;
      output: null;
      authorizationUrl?: string;
      authorizationId?: string;
    }
  | {
      needsAuthorization: false;
      output: unknown;
    };

const app = express();
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as RawBodyRequest).rawBody = Buffer.from(buf);
    }
  })
);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/auth/check", async (_req, res) => {
  const toolNames = ["Github.GetPullRequest", "Jira.GetIssueComments", "Jira.AddCommentToIssue"];

  const authStatuses = await Promise.all(
    toolNames.map(async (toolName) => {
      try {
        const auth = await arcade.tools.authorize({
          tool_name: toolName,
          user_id: config.arcadeUserId
        });

        return {
          tool: toolName,
          status: auth.status,
          authorization_url: auth.status === "completed" ? null : auth.url ?? null
        };
      } catch (error) {
        return {
          tool: toolName,
          status: "error",
          error: toErrorMessage(error)
        };
      }
    })
  );

  res.json({
    user_id: config.arcadeUserId,
    tools: authStatuses
  });
});

app.post("/webhook", async (req, res) => {
  const webhookRequest = req as RawBodyRequest;

  if (!isGithubSignatureValid(webhookRequest, config.githubWebhookSecret)) {
    return res.status(401).json({ status: "unauthorized", reason: "invalid_signature" });
  }

  const githubEvent = req.header("x-github-event");
  if (githubEvent !== "pull_request") {
    return res.status(200).json({
      status: "ignored",
      reason: "unsupported_event",
      event: githubEvent ?? null
    });
  }

  const payloadResult = pullRequestEventSchema.safeParse(req.body);
  if (!payloadResult.success) {
    return res.status(400).json({ status: "bad_request", reason: "invalid_payload" });
  }

  const payload = payloadResult.data;

  if (payload.action !== "opened") {
    return res.status(200).json({
      status: "ignored",
      reason: "unsupported_action",
      action: payload.action
    });
  }

  const branchName = payload.pull_request.head.ref;
  const jiraIssueKey = extractJiraIssueKey(branchName);

  if (!jiraIssueKey) {
    return res.status(200).json({
      status: "ignored",
      reason: "no_jira_key",
      branch: branchName
    });
  }

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const prNumber = payload.pull_request.number;

  try {
    const prResult = await executeTool("Github.GetPullRequest", {
      owner,
      repo,
      pull_number: prNumber
    });

    if (prResult.needsAuthorization) {
      console.warn(
        `[auth] ${prResult.authorizationUrl ?? "Authorization URL unavailable"} for Github.GetPullRequest`
      );
      return res.status(202).json({
        status: "pending_authorization",
        tool: "Github.GetPullRequest",
        authorization_url: prResult.authorizationUrl ?? null
      });
    }

    const prDetails = resolvePullRequestDetails(prResult.output, {
      title: payload.pull_request.title ?? `Pull Request #${prNumber}`,
      url: payload.pull_request.html_url ?? `https://github.com/${owner}/${repo}/pull/${prNumber}`
    });

    const commentsResult = await executeTool("Jira.GetIssueComments", {
      issue: jiraIssueKey,
      limit: 100,
      order_by: "created_date_descending"
    });

    if (commentsResult.needsAuthorization) {
      console.warn(
        `[auth] ${commentsResult.authorizationUrl ?? "Authorization URL unavailable"} for Jira.GetIssueComments`
      );
      return res.status(202).json({
        status: "pending_authorization",
        tool: "Jira.GetIssueComments",
        authorization_url: commentsResult.authorizationUrl ?? null
      });
    }

    const existingComments = extractSerializedComments(commentsResult.output);
    const dedupeMarker = `${config.jiraCommentMarker} pr#${prNumber}`.toLowerCase();
    const normalizedPrUrl = prDetails.url.toLowerCase();

    const duplicateCommentExists = existingComments.some(
      (comment) => comment.includes(dedupeMarker) || comment.includes(normalizedPrUrl)
    );

    if (duplicateCommentExists) {
      return res.status(200).json({
        status: "skipped",
        reason: "duplicate_comment",
        issue: jiraIssueKey,
        pr: prNumber
      });
    }

    const commentBody = buildJiraComment({
      jiraIssueKey,
      owner,
      repo,
      prNumber,
      branchName,
      prTitle: prDetails.title,
      prUrl: prDetails.url
    });

    const addCommentResult = await executeTool("Jira.AddCommentToIssue", {
      issue: jiraIssueKey,
      body: commentBody
    });

    if (addCommentResult.needsAuthorization) {
      console.warn(
        `[auth] ${addCommentResult.authorizationUrl ?? "Authorization URL unavailable"} for Jira.AddCommentToIssue`
      );
      return res.status(202).json({
        status: "pending_authorization",
        tool: "Jira.AddCommentToIssue",
        authorization_url: addCommentResult.authorizationUrl ?? null
      });
    }

    console.log(
      `[success] Commented on Jira issue ${jiraIssueKey} for PR #${prNumber} (${owner}/${repo})`
    );

    return res.status(200).json({
      status: "ok",
      issue: jiraIssueKey,
      pr: prNumber,
      pr_url: prDetails.url
    });
  } catch (error) {
    console.error(`[error] Failed processing webhook: ${toErrorMessage(error)}`);
    return res.status(500).json({ status: "error", message: "Failed to process webhook" });
  }
});

async function executeTool(
  toolName: string,
  input: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const auth = await arcade.tools.authorize({
    tool_name: toolName,
    user_id: config.arcadeUserId
  });

  if (auth.status !== "completed") {
    return {
      needsAuthorization: true,
      output: null,
      authorizationUrl: auth.url,
      authorizationId: auth.id
    };
  }

  const response = await arcade.tools.execute({
    tool_name: toolName,
    input,
    user_id: config.arcadeUserId
  });

  return {
    needsAuthorization: false,
    output: unpackToolOutput(response)
  };
}

function unpackToolOutput(value: unknown): unknown {
  const asObject = toObject(value);
  if (!asObject) {
    return value;
  }

  const output = asObject.output;
  const outputObject = toObject(output);

  if (outputObject && "value" in outputObject) {
    return outputObject.value;
  }

  return output;
}

function toObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  return value as Record<string, unknown>;
}

function resolvePullRequestDetails(
  output: unknown,
  fallback: { title: string; url: string }
): { title: string; url: string } {
  const data = toObject(output);

  const title =
    getStringValue(data, ["title"]) ??
    getStringValue(data, ["pull_request", "title"]) ??
    fallback.title;

  const url =
    getStringValue(data, ["html_url"]) ??
    getStringValue(data, ["pull_request", "html_url"]) ??
    fallback.url;

  return { title, url };
}

function getStringValue(
  obj: Record<string, unknown> | null,
  path: string[]
): string | undefined {
  if (!obj) {
    return undefined;
  }

  let current: unknown = obj;

  for (const key of path) {
    const currentObj = toObject(current);
    if (!currentObj) {
      return undefined;
    }

    current = currentObj[key];
  }

  return typeof current === "string" ? current : undefined;
}

function extractSerializedComments(output: unknown): string[] {
  const root = toObject(output);

  const allCommentItems: unknown[] = [];

  if (Array.isArray(output)) {
    allCommentItems.push(...output);
  }

  if (root) {
    const possibleKeys = ["comments", "items", "results", "data"];
    for (const key of possibleKeys) {
      const value = root[key];
      if (Array.isArray(value)) {
        allCommentItems.push(...value);
      }
    }
  }

  return allCommentItems.map((item) => JSON.stringify(item).toLowerCase());
}

function extractJiraIssueKey(branchName: string): string | null {
  if (config.requireExactBranchKey) {
    return issueKeyPattern.test(branchName) ? branchName : null;
  }

  const match = branchName.match(issueKeyPattern);
  return match ? match[0] : null;
}

function buildJiraComment(args: {
  jiraIssueKey: string;
  owner: string;
  repo: string;
  prNumber: number;
  branchName: string;
  prTitle: string;
  prUrl: string;
}): string {
  return `${config.jiraCommentMarker} pr#${args.prNumber}

Pull Request created in GitHub for ${args.jiraIssueKey}

- Repository: ${args.owner}/${args.repo}
- Branch: ${args.branchName}
- Title: ${args.prTitle}
- URL: ${args.prUrl}`;
}

function isGithubSignatureValid(request: RawBodyRequest, secret?: string): boolean {
  if (!secret) {
    return true;
  }

  const signature = request.header("x-hub-signature-256");
  if (!signature || !request.rawBody) {
    return false;
  }

  const expectedSignature = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(request.rawBody)
    .digest("hex")}`;

  const expectedBuffer = Buffer.from(expectedSignature);
  const providedBuffer = Buffer.from(signature);

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

app.listen(config.port, () => {
  console.log(`Server listening on port ${config.port}`);

  if (!config.githubWebhookSecret) {
    console.warn("GITHUB_WEBHOOK_SECRET is not set. Signature validation is disabled.");
  }
});
