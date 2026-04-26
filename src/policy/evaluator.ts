import type { EvaluatedPolicyAction, PolicyContext, PolicyRule } from "./types";

export function evaluatePolicyRules(
  rules: PolicyRule[],
  context: PolicyContext
): EvaluatedPolicyAction[] {
  const actions: EvaluatedPolicyAction[] = [];

  for (const rule of rules) {
    if (!rule.enabled) {
      continue;
    }

    if (!matchesRule(rule, context)) {
      continue;
    }

    actions.push({
      ruleId: rule.id,
      alertState: rule.action.alert_state,
      message: renderTemplate(rule.action.message, context)
    });
  }

  return actions;
}

function matchesRule(rule: PolicyRule, context: PolicyContext): boolean {
  const { when } = rule;

  if (when.owner && when.owner !== context.owner) {
    return false;
  }

  if (when.repo && when.repo !== context.repo) {
    return false;
  }

  if (when.trigger_in && when.trigger_in.length > 0 && !when.trigger_in.includes(context.trigger)) {
    return false;
  }

  if (typeof when.pr_open === "boolean" && when.pr_open !== context.pr_open) {
    return false;
  }

  if (typeof when.jira_closed === "boolean" && when.jira_closed !== context.jira_closed) {
    return false;
  }

  if (when.jira_issue_pattern) {
    const jiraIssuePattern = new RegExp(when.jira_issue_pattern);
    if (!jiraIssuePattern.test(context.jira_issue_key)) {
      return false;
    }
  }

  return true;
}

function renderTemplate(template: string, context: PolicyContext): string {
  const values: Record<string, string> = {
    owner: context.owner,
    repo: context.repo,
    trigger: context.trigger,
    jira_issue_key: context.jira_issue_key,
    jira_status_name: context.jira_status_name,
    pr_number: String(context.pr_number),
    pr_title: context.pr_title,
    pr_url: context.pr_url,
    pr_open: String(context.pr_open),
    jira_closed: String(context.jira_closed)
  };

  let output = template;
  for (const [key, value] of Object.entries(values)) {
    output = output.split(`{{${key}}}`).join(value);
  }

  return output;
}
