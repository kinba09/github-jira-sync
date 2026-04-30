import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const githubMappingSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  webhook_secret: z.string().optional()
});

const tenantInputSchema = z
  .object({
    id: z.string().min(1),
    arcade_user_id: z.string().min(1),
    github: z.array(githubMappingSchema).default([]),
    jira: z
      .object({
        project_keys: z.array(z.string().min(1)).default([]),
        webhook_token: z.string().optional()
      })
      .default({ project_keys: [] }),
    slack: z
      .object({
        channel_name: z.string().optional(),
        conversation_id: z.string().optional()
      })
      .optional()
  })
  .refine((data) => Boolean(data.slack?.channel_name || data.slack?.conversation_id), {
    message: "Each tenant must define slack.channel_name or slack.conversation_id",
    path: ["slack"]
  });

const tenantFileSchema = z.object({
  tenants: z.array(tenantInputSchema)
});

export type TenantInput = z.infer<typeof tenantInputSchema>;

export type Tenant = {
  id: string;
  arcadeUserId: string;
  githubMappings: Array<{
    owner: string;
    repo: string;
    webhookSecret?: string;
  }>;
  jiraProjectKeys: string[];
  jiraWebhookToken?: string;
  slackChannelName?: string;
  slackConversationId?: string;
};

export class TenantRegistry {
  private readonly configPath: string;
  private tenants: Tenant[];

  constructor(configPath?: string) {
    this.configPath =
      configPath && configPath.trim().length > 0
        ? path.resolve(configPath)
        : path.join(process.cwd(), "tenants.json");

    this.tenants = this.readTenants();
  }

  list(): Tenant[] {
    return [...this.tenants];
  }

  getById(id: string): Tenant | null {
    return this.tenants.find((tenant) => tenant.id === id) ?? null;
  }

  resolveForGithub(owner: string, repo: string): Tenant | null {
    return (
      this.tenants.find((tenant) =>
        tenant.githubMappings.some((mapping) => mapping.owner === owner && mapping.repo === repo)
      ) ?? null
    );
  }

  resolveForJiraIssue(issueKey: string): Tenant | null {
    const projectKey = issueKey.split("-")[0]?.toUpperCase() ?? "";
    if (!projectKey) {
      return null;
    }

    return (
      this.tenants.find((tenant) =>
        tenant.jiraProjectKeys.some((configuredKey) => configuredKey.toUpperCase() === projectKey)
      ) ?? null
    );
  }

  create(input: TenantInput): Tenant {
    const parsed = tenantInputSchema.parse(input);
    if (this.getById(parsed.id)) {
      throw new Error(`Tenant with id '${parsed.id}' already exists`);
    }

    this.validateUniqueness(parsed);

    const tenant = mapTenantInput(parsed);
    this.tenants.push(tenant);
    this.persist();
    return tenant;
  }

  update(id: string, input: TenantInput): Tenant {
    if (id !== input.id) {
      throw new Error("Path tenant id must match payload id");
    }

    const parsed = tenantInputSchema.parse(input);
    const existingIndex = this.tenants.findIndex((tenant) => tenant.id === id);
    if (existingIndex === -1) {
      throw new Error(`Tenant with id '${id}' was not found`);
    }

    this.validateUniqueness(parsed, id);

    const mapped = mapTenantInput(parsed);
    this.tenants[existingIndex] = mapped;
    this.persist();
    return mapped;
  }

  delete(id: string): boolean {
    const previousLength = this.tenants.length;
    this.tenants = this.tenants.filter((tenant) => tenant.id !== id);
    if (this.tenants.length === previousLength) {
      return false;
    }

    this.persist();
    return true;
  }

  getPath(): string {
    return this.configPath;
  }

  private readTenants(): Tenant[] {
    if (!fs.existsSync(this.configPath)) {
      return [];
    }

    const raw = fs.readFileSync(this.configPath, "utf8");
    const parsed = tenantFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new Error(`Invalid tenants config: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
    }

    return parsed.data.tenants.map(mapTenantInput);
  }

  private persist(): void {
    const serialized: { tenants: TenantInput[] } = {
      tenants: this.tenants.map((tenant) => ({
        id: tenant.id,
        arcade_user_id: tenant.arcadeUserId,
        github: tenant.githubMappings.map((mapping) => ({
          owner: mapping.owner,
          repo: mapping.repo,
          webhook_secret: mapping.webhookSecret
        })),
        jira: {
          project_keys: tenant.jiraProjectKeys,
          webhook_token: tenant.jiraWebhookToken
        },
        slack: {
          channel_name: tenant.slackChannelName,
          conversation_id: tenant.slackConversationId
        }
      }))
    };

    const dirPath = path.dirname(this.configPath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    fs.writeFileSync(this.configPath, JSON.stringify(serialized, null, 2));
  }

  private validateUniqueness(candidate: TenantInput, ignoreTenantId?: string): void {
    const existing = this.tenants.filter((tenant) => tenant.id !== ignoreTenantId);

    for (const mapping of candidate.github) {
      const duplicate = existing.find((tenant) =>
        tenant.githubMappings.some((current) => current.owner === mapping.owner && current.repo === mapping.repo)
      );
      if (duplicate) {
        throw new Error(
          `GitHub mapping ${mapping.owner}/${mapping.repo} is already assigned to tenant '${duplicate.id}'`
        );
      }
    }

    for (const key of candidate.jira.project_keys) {
      const duplicate = existing.find((tenant) =>
        tenant.jiraProjectKeys.some((projectKey) => projectKey.toUpperCase() === key.toUpperCase())
      );
      if (duplicate) {
        throw new Error(`Jira project key '${key}' is already assigned to tenant '${duplicate.id}'`);
      }
    }
  }
}

function mapTenantInput(tenant: TenantInput): Tenant {
  return {
    id: tenant.id,
    arcadeUserId: tenant.arcade_user_id,
    githubMappings: tenant.github.map((item) => ({
      owner: item.owner,
      repo: item.repo,
      webhookSecret: item.webhook_secret
    })),
    jiraProjectKeys: tenant.jira.project_keys,
    jiraWebhookToken: tenant.jira.webhook_token,
    slackChannelName: tenant.slack?.channel_name,
    slackConversationId: tenant.slack?.conversation_id
  };
}

export function resolveGithubWebhookSecretForTenant(
  tenant: Tenant,
  owner: string,
  repo: string
): string | undefined {
  return tenant.githubMappings.find((mapping) => mapping.owner === owner && mapping.repo === repo)
    ?.webhookSecret;
}
