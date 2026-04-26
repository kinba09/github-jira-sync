export type PolicyActionType = "slack_alert";

export type PolicyCondition = {
  owner?: string;
  repo?: string;
  trigger_in?: string[];
  pr_open?: boolean;
  jira_closed?: boolean;
  jira_issue_pattern?: string;
};

export type PolicyAction = {
  type: PolicyActionType;
  alert_state: string;
  message: string;
};

export type PolicyRule = {
  id: string;
  enabled: boolean;
  when: PolicyCondition;
  action: PolicyAction;
};

export type PolicyFile = {
  version: number;
  rules: PolicyRule[];
};

export type PolicyContext = {
  owner: string;
  repo: string;
  trigger: string;
  pr_open: boolean;
  jira_closed: boolean;
  jira_issue_key: string;
  jira_status_name: string;
  pr_number: number;
  pr_title: string;
  pr_url: string;
};

export type EvaluatedPolicyAction = {
  ruleId: string;
  alertState: string;
  message: string;
};
