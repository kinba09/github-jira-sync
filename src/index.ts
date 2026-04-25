import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Request } from "express";
import Arcade from "@arcadeai/arcadejs";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3000),
    ARCADE_API_KEY: z.string().min(1, "ARCADE_API_KEY is required"),
    ARCADE_USER_ID: z.string().min(1, "ARCADE_USER_ID is required"),
    GITHUB_WEBHOOK_SECRET: z.string().optional(),
    JIRA_WEBHOOK_TOKEN: z.string().optional(),
    JIRA_ISSUE_REGEX: z.string().default("[A-Z][A-Z0-9]+-\\d+"),
    REQUIRE_EXACT_BRANCH_KEY: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    JIRA_COMMENT_MARKER: z.string().default("[github-jira-sync]"),
    ALERT_DELAY_SECONDS: z.coerce.number().int().positive().default(60),
    JIRA_CLOSED_STATUS_KEYWORDS: z.string().default("done,closed,resolved"),
    SLACK_ALERT_CHANNEL: z.string().optional(),
    SLACK_ALERT_CONVERSATION_ID: z.string().optional()
  })
  .refine((data) => Boolean(data.SLACK_ALERT_CHANNEL || data.SLACK_ALERT_CONVERSATION_ID), {
    message: "Set either SLACK_ALERT_CHANNEL or SLACK_ALERT_CONVERSATION_ID",
    path: ["SLACK_ALERT_CHANNEL"]
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
  jiraWebhookToken: env.JIRA_WEBHOOK_TOKEN?.trim() || undefined,
  jiraIssueRegex: env.JIRA_ISSUE_REGEX,
  requireExactBranchKey: env.REQUIRE_EXACT_BRANCH_KEY,
  jiraCommentMarker: env.JIRA_COMMENT_MARKER,
  alertDelayMs: env.ALERT_DELAY_SECONDS * 1000,
  jiraClosedKeywords: env.JIRA_CLOSED_STATUS_KEYWORDS.split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean),
  slackAlertChannel: env.SLACK_ALERT_CHANNEL?.trim() || undefined,
  slackAlertConversationId: env.SLACK_ALERT_CONVERSATION_ID?.trim() || undefined
};

const issueKeyPattern = new RegExp(
  config.requireExactBranchKey ? `^${config.jiraIssueRegex}$` : config.jiraIssueRegex
);

const dataDir = path.join(process.cwd(), "data");
const stateFilePath = path.join(dataDir, "monitor-state.json");

const arcade = new Arcade({ apiKey: config.arcadeApiKey });

const pullRequestEventSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    number: z.number(),
    title: z.string().optional(),
    html_url: z.string().optional(),
    state: z.string().optional(),
    merged: z.boolean().optional(),
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
    }
  | {
      needsAuthorization: false;
      output: unknown;
    };

type TrackedPullRequest = {
  key: string;
  owner: string;
  repo: string;
  pullNumber: number;
  branchName: string;
  jiraIssueKey: string;
  latestPrTitle?: string;
  latestPrUrl?: string;
  latestPrOpen?: boolean;
  latestJiraClosed?: boolean;
  lastAlertState?: "pr_open_jira_closed" | "pr_closed_jira_open";
  lastUpdatedAt: string;
};

type MonitorState = {
  trackedPullRequests: Record<string, TrackedPullRequest>;
};

const app = express();
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as RawBodyRequest).rawBody = Buffer.from(buf);
    }
  })
);

const state = loadMonitorState();
const pendingTimers = new Map<string, NodeJS.Timeout>();

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/auth/check", async (_req, res) => {
  const toolNames = [
    "Github.GetPullRequest",
    "Github.ListPullRequests",
    "Jira.GetIssueById",
    "Jira.GetIssueComments",
    "Jira.AddCommentToIssue",
    "Slack.SendMessage"
  ];

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
    return res.status(200).json({ status: "ignored", reason: "unsupported_event" });
  }

  const payloadResult = pullRequestEventSchema.safeParse(req.body);
  if (!payloadResult.success) {
    return res.status(400).json({ status: "bad_request", reason: "invalid_payload" });
  }

  const payload = payloadResult.data;
  const { action } = payload;
  console.log(`[github] event=pull_request action=${action}`);

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;
  const prNumber = payload.pull_request.number;
  const branchName = payload.pull_request.head.ref;
  const recordKey = buildRecordKey(owner, repo, prNumber);

  if (action === "closed") {
    updateTrackedPullRequest(recordKey, {
      key: recordKey,
      owner,
      repo,
      pullNumber: prNumber,
      branchName,
      jiraIssueKey: extractJiraIssueKey(branchName) ?? "",
      latestPrTitle: payload.pull_request.title,
      latestPrUrl: payload.pull_request.html_url,
      latestPrOpen: false,
      lastUpdatedAt: new Date().toISOString()
    });

    return res.status(200).json({ status: "ok", reason: "pr_closed_recorded", pr: prNumber });
  }

  if (action !== "opened" && action !== "reopened") {
    return res.status(200).json({ status: "ignored", reason: "unsupported_action", action });
  }

  const jiraIssueKey = extractJiraIssueKey(branchName);
  if (!jiraIssueKey) {
    return res.status(200).json({ status: "ignored", reason: "no_jira_key", branch: branchName });
  }

  updateTrackedPullRequest(recordKey, {
    key: recordKey,
    owner,
    repo,
    pullNumber: prNumber,
    branchName,
    jiraIssueKey,
    latestPrTitle: payload.pull_request.title,
    latestPrUrl: payload.pull_request.html_url,
    latestPrOpen: true,
    lastUpdatedAt: new Date().toISOString()
  });
  console.log(`[github] tracked ${recordKey} issue=${jiraIssueKey}`);

  try {
    const prResult = await executeTool("Github.GetPullRequest", {
      owner,
      repo,
      pull_number: prNumber
    });

    if (prResult.needsAuthorization) {
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

    updateTrackedPullRequest(recordKey, {
      key: recordKey,
      owner,
      repo,
      pullNumber: prNumber,
      branchName,
      jiraIssueKey,
      latestPrTitle: prDetails.title,
      latestPrUrl: prDetails.url,
      latestPrOpen: true,
      lastUpdatedAt: new Date().toISOString()
    });

    const commentsResult = await executeTool("Jira.GetIssueComments", {
      issue: jiraIssueKey,
      limit: 100,
      order_by: "created_date_descending"
    });

    if (commentsResult.needsAuthorization) {
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

    if (!duplicateCommentExists) {
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
        return res.status(202).json({
          status: "pending_authorization",
          tool: "Jira.AddCommentToIssue",
          authorization_url: addCommentResult.authorizationUrl ?? null
        });
      }
    }

    scheduleConsistencyCheck(recordKey, "github_pr_opened");
    console.log(`[github] scheduled check for ${recordKey} in ${config.alertDelayMs / 1000}s`);

    return res.status(200).json({
      status: "ok",
      issue: jiraIssueKey,
      pr: prNumber,
      scheduled_check_in_seconds: config.alertDelayMs / 1000
    });
  } catch (error) {
    console.error(`[error] Failed processing GitHub webhook: ${toErrorMessage(error)}`);
    return res.status(500).json({ status: "error", message: "Failed to process GitHub webhook" });
  }
});

app.post("/jira/webhook", (req, res) => {
  if (!isJiraWebhookAuthorized(req as RawBodyRequest, config.jiraWebhookToken)) {
    console.warn("[jira] unauthorized webhook request");
    return res.status(401).json({ status: "unauthorized", reason: "invalid_jira_token" });
  }

  const issueKey = extractIssueKeyFromJiraWebhook(req.body);
  if (!issueKey) {
    console.log("[jira] ignored webhook: no issue key");
    return res.status(200).json({ status: "ignored", reason: "no_issue_key" });
  }

  const isClosedFromPayload = extractJiraClosedFromWebhook(req.body);
  if (!isClosedFromPayload) {
    console.log(`[jira] ignored webhook for ${issueKey}: status is not closed`);
    return res.status(200).json({ status: "ignored", reason: "issue_not_closed" });
  }
  console.log(`[jira] closed event received for issue=${issueKey}`);

  const relatedRecords = Object.values(state.trackedPullRequests).filter(
    (record) => record.jiraIssueKey === issueKey
  );

  if (relatedRecords.length === 0) {
    console.log(`[jira] no related tracked PRs for issue=${issueKey}`);
    return res.status(200).json({ status: "ok", reason: "no_related_pr_records", issue: issueKey });
  }

  for (const record of relatedRecords) {
    scheduleConsistencyCheck(record.key, "jira_issue_closed");
    console.log(`[jira] scheduled check for ${record.key} in ${config.alertDelayMs / 1000}s`);
  }

  return res.status(200).json({
    status: "ok",
    issue: issueKey,
    scheduled_checks: relatedRecords.length,
    scheduled_check_in_seconds: config.alertDelayMs / 1000
  });
});

function scheduleConsistencyCheck(recordKey: string, reason: string): void {
  const existing = pendingTimers.get(recordKey);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(async () => {
    pendingTimers.delete(recordKey);

    try {
      console.log(`[check] running consistency check for ${recordKey}, trigger=${reason}`);
      await runConsistencyCheck(recordKey, reason);
    } catch (error) {
      console.error(`[error] Consistency check failed for ${recordKey}: ${toErrorMessage(error)}`);
    }
  }, config.alertDelayMs);

  pendingTimers.set(recordKey, timer);
}

async function runConsistencyCheck(recordKey: string, reason: string): Promise<void> {
  const record = state.trackedPullRequests[recordKey];
  if (!record || !record.jiraIssueKey) {
    console.log(`[check] skipped ${recordKey}: no tracked record or jira key`);
    return;
  }

  const prResult = await executeTool("Github.GetPullRequest", {
    owner: record.owner,
    repo: record.repo,
    pull_number: record.pullNumber
  });

  if (prResult.needsAuthorization) {
    console.warn(
      `[auth] ${prResult.authorizationUrl ?? "Authorization URL unavailable"} for Github.GetPullRequest`
    );
    return;
  }

  const prDetails = resolvePullRequestDetails(prResult.output, {
    title: record.latestPrTitle ?? `Pull Request #${record.pullNumber}`,
    url: record.latestPrUrl ?? `https://github.com/${record.owner}/${record.repo}/pull/${record.pullNumber}`
  });
  const prOpen = extractPrOpenState(prResult.output);

  const jiraIssueResult = await executeTool("Jira.GetIssueById", {
    issue: record.jiraIssueKey
  });

  if (jiraIssueResult.needsAuthorization) {
    console.warn(
      `[auth] ${jiraIssueResult.authorizationUrl ?? "Authorization URL unavailable"} for Jira.GetIssueById`
    );
    return;
  }

  const jiraStatus = extractJiraStatus(jiraIssueResult.output);
  const jiraClosed = jiraStatus.isClosed;
  console.log(
    `[check] ${recordKey} prOpen=${prOpen} jiraClosed=${jiraClosed} jiraStatus=${jiraStatus.name ?? "unknown"}`
  );

  const updatedRecord: TrackedPullRequest = {
    ...record,
    latestPrTitle: prDetails.title,
    latestPrUrl: prDetails.url,
    latestPrOpen: prOpen,
    latestJiraClosed: jiraClosed,
    lastUpdatedAt: new Date().toISOString()
  };

  if (prOpen && jiraClosed) {
    if (record.lastAlertState !== "pr_open_jira_closed") {
      const alertMessage = buildSlackAlertMessage({
        type: "pr_open_jira_closed",
        issueKey: record.jiraIssueKey,
        jiraStatusName: jiraStatus.name ?? "closed",
        owner: record.owner,
        repo: record.repo,
        pullNumber: record.pullNumber,
        prTitle: prDetails.title,
        prUrl: prDetails.url,
        reason
      });

      const alertResult = await sendSlackAlert(alertMessage);
      if (!alertResult.needsAuthorization) {
        console.log(`[slack] alert sent for ${recordKey}`);
        updatedRecord.lastAlertState = "pr_open_jira_closed";
      } else {
        console.warn(`[slack] alert not sent for ${recordKey}: authorization pending`);
      }
    }
  } else if (!prOpen && !jiraClosed) {
    if (record.lastAlertState !== "pr_closed_jira_open") {
      const alertMessage = buildSlackAlertMessage({
        type: "pr_closed_jira_open",
        issueKey: record.jiraIssueKey,
        jiraStatusName: jiraStatus.name ?? "open",
        owner: record.owner,
        repo: record.repo,
        pullNumber: record.pullNumber,
        prTitle: prDetails.title,
        prUrl: prDetails.url,
        reason
      });

      const alertResult = await sendSlackAlert(alertMessage);
      if (!alertResult.needsAuthorization) {
        console.log(`[slack] alert sent for ${recordKey}`);
        updatedRecord.lastAlertState = "pr_closed_jira_open";
      } else {
        console.warn(`[slack] alert not sent for ${recordKey}: authorization pending`);
      }
    }
  } else {
    updatedRecord.lastAlertState = undefined;
  }

  updateTrackedPullRequest(recordKey, updatedRecord);
}

async function sendSlackAlert(message: string): Promise<ToolExecutionResult> {
  console.log(
    `[slack] sending alert to ${
      config.slackAlertConversationId
        ? `conversation_id=${config.slackAlertConversationId}`
        : `channel_name=${config.slackAlertChannel}`
    }`
  );
  if (config.slackAlertConversationId) {
    return executeTool("Slack.SendMessage", {
      conversation_id: config.slackAlertConversationId,
      message
    });
  }

  return executeTool("Slack.SendMessage", {
    channel_name: config.slackAlertChannel,
    message
  });
}

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
      authorizationUrl: auth.url
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

function extractPrOpenState(output: unknown): boolean {
  const data = toObject(output);
  const state =
    getStringValue(data, ["state"]) ?? getStringValue(data, ["pull_request", "state"]) ?? "open";

  const mergedValue =
    getBooleanValue(data, ["merged"]) ?? getBooleanValue(data, ["pull_request", "merged"]) ?? false;

  return state.toLowerCase() === "open" && !mergedValue;
}

function extractJiraStatus(output: unknown): { isClosed: boolean; name?: string; category?: string } {
  const data = toObject(output);
  const normalized = unwrapSingleRootObject(data);

  const statusName =
    getStringValue(normalized, ["fields", "status", "name"]) ??
    getStringValue(normalized, ["status", "name"]) ??
    getStringValue(normalized, ["status"]) ??
    findStringByKeyDeep(normalized, "statusName") ??
    findStringByKeyDeep(normalized, "name");

  const category =
    getStringValue(normalized, ["fields", "status", "statusCategory", "key"]) ??
    getStringValue(normalized, ["fields", "status", "statusCategory", "name"]) ??
    getStringValue(normalized, ["status", "statusCategory", "key"]) ??
    getStringValue(normalized, ["status", "statusCategory", "name"]) ??
    findStringByKeyDeep(normalized, "statusCategory") ??
    findStringByKeyDeep(normalized, "statusCategoryKey");

  const categoryClosed = category ? category.toLowerCase() === "done" : false;
  const statusKeywordClosed =
    statusName && config.jiraClosedKeywords.some((keyword) => statusName.toLowerCase().includes(keyword));

  return {
    isClosed: Boolean(categoryClosed || statusKeywordClosed),
    name: statusName,
    category
  };
}

function unwrapSingleRootObject(
  obj: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!obj) {
    return null;
  }

  // Arcade tool outputs can wrap payloads in a single root key.
  const keys = Object.keys(obj);
  if (keys.length === 1) {
    const nested = toObject(obj[keys[0]]);
    if (nested) {
      return nested;
    }
  }

  return obj;
}

function findStringByKeyDeep(value: unknown, targetKey: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringByKeyDeep(item, targetKey);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  const obj = value as Record<string, unknown>;

  const direct = obj[targetKey];
  if (typeof direct === "string") {
    return direct;
  }

  for (const nestedValue of Object.values(obj)) {
    const found = findStringByKeyDeep(nestedValue, targetKey);
    if (found) {
      return found;
    }
  }

  return undefined;
}

function getStringValue(
  obj: Record<string, unknown> | null,
  pathParts: string[]
): string | undefined {
  if (!obj) {
    return undefined;
  }

  let current: unknown = obj;
  for (const key of pathParts) {
    const currentObj = toObject(current);
    if (!currentObj) {
      return undefined;
    }
    current = currentObj[key];
  }

  return typeof current === "string" ? current : undefined;
}

function getBooleanValue(
  obj: Record<string, unknown> | null,
  pathParts: string[]
): boolean | undefined {
  if (!obj) {
    return undefined;
  }

  let current: unknown = obj;
  for (const key of pathParts) {
    const currentObj = toObject(current);
    if (!currentObj) {
      return undefined;
    }
    current = currentObj[key];
  }

  return typeof current === "boolean" ? current : undefined;
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

function extractIssueKeyFromJiraWebhook(payload: unknown): string | null {
  const data = toObject(payload);
  const issueKey =
    getStringValue(data, ["issue", "key"]) ??
    getStringValue(data, ["issue", "id"]) ??
    getStringValue(data, ["key"]);

  return issueKey || null;
}

function extractJiraClosedFromWebhook(payload: unknown): boolean {
  const data = toObject(payload);
  if (!data) {
    return false;
  }

  const statusName =
    getStringValue(data, ["issue", "fields", "status", "name"]) ??
    getStringValue(data, ["issue", "status", "name"]) ??
    getStringValue(data, ["status", "name"]);

  const statusCategory =
    getStringValue(data, ["issue", "fields", "status", "statusCategory", "key"]) ??
    getStringValue(data, ["issue", "fields", "status", "statusCategory", "name"]);

  if (statusCategory && statusCategory.toLowerCase() === "done") {
    return true;
  }

  return Boolean(
    statusName && config.jiraClosedKeywords.some((keyword) => statusName.toLowerCase().includes(keyword))
  );
}

function buildRecordKey(owner: string, repo: string, prNumber: number): string {
  return `${owner}/${repo}#${prNumber}`;
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

function buildSlackAlertMessage(args: {
  type: "pr_open_jira_closed" | "pr_closed_jira_open";
  issueKey: string;
  jiraStatusName: string;
  owner: string;
  repo: string;
  pullNumber: number;
  prTitle: string;
  prUrl: string;
  reason: string;
}): string {
  if (args.type === "pr_open_jira_closed") {
    return [
      ":warning: GitHub/Jira mismatch detected after 1 minute",
      `- Jira issue: ${args.issueKey} is CLOSED (${args.jiraStatusName})`,
      `- Pull request: ${args.owner}/${args.repo}#${args.pullNumber} is still OPEN`,
      `- PR title: ${args.prTitle}`,
      `- PR URL: ${args.prUrl}`,
      `- Trigger: ${args.reason}`
    ].join("\n");
  }

  return [
    ":warning: GitHub/Jira mismatch detected after 1 minute",
    `- Pull request: ${args.owner}/${args.repo}#${args.pullNumber} is CLOSED or MERGED`,
    `- Jira issue: ${args.issueKey} is still OPEN (${args.jiraStatusName})`,
    `- PR title: ${args.prTitle}`,
    `- PR URL: ${args.prUrl}`,
    `- Trigger: ${args.reason}`
  ].join("\n");
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

function isJiraWebhookAuthorized(request: RawBodyRequest, configuredToken?: string): boolean {
  if (!configuredToken) {
    return true;
  }

  const headerToken = request.header("x-jira-webhook-token") || "";
  const queryToken =
    typeof request.query.token === "string" ? request.query.token : Array.isArray(request.query.token) ? request.query.token[0] : "";

  return headerToken === configuredToken || queryToken === configuredToken;
}

function updateTrackedPullRequest(recordKey: string, record: TrackedPullRequest): void {
  state.trackedPullRequests[recordKey] = record;
  persistMonitorState();
}

function loadMonitorState(): MonitorState {
  try {
    if (!fs.existsSync(stateFilePath)) {
      return { trackedPullRequests: {} };
    }

    const raw = fs.readFileSync(stateFilePath, "utf8");
    const parsed = JSON.parse(raw) as MonitorState;

    if (!parsed || typeof parsed !== "object" || !parsed.trackedPullRequests) {
      return { trackedPullRequests: {} };
    }

    return parsed;
  } catch (error) {
    console.error(`[warn] Failed to load monitor state: ${toErrorMessage(error)}`);
    return { trackedPullRequests: {} };
  }
}

function persistMonitorState(): void {
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error(`[warn] Failed to persist monitor state: ${toErrorMessage(error)}`);
  }
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
    console.warn("GITHUB_WEBHOOK_SECRET is not set. GitHub signature validation is disabled.");
  }

  if (!config.jiraWebhookToken) {
    console.warn("JIRA_WEBHOOK_TOKEN is not set. Jira webhook token validation is disabled.");
  }
});
