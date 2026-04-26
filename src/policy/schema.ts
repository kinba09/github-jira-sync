import { z } from "zod";

export const policyFileSchema = z.object({
  version: z.number().int().positive(),
  rules: z.array(
    z.object({
      id: z.string().min(1),
      enabled: z.boolean().default(true),
      when: z
        .object({
          owner: z.string().min(1).optional(),
          repo: z.string().min(1).optional(),
          trigger_in: z.array(z.string().min(1)).optional(),
          pr_open: z.boolean().optional(),
          jira_closed: z.boolean().optional(),
          jira_issue_pattern: z.string().min(1).optional()
        })
        .default({}),
      action: z.object({
        type: z.literal("slack_alert"),
        alert_state: z.string().min(1),
        message: z.string().min(1)
      })
    })
  )
});
