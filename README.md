# GitHub PR -> Jira Comment + Slack Mismatch Alerts (Arcade + Docker)

This backend does three things using Arcade tools:

1. On GitHub PR opened, it comments on the Jira issue found in the branch name.
2. It runs delayed consistency checks between GitHub and Jira.
3. It applies Policy-as-Code rules from YAML to decide which Slack alerts to send.

The 1-minute consistency check can be triggered by:
- GitHub PR opened/reopened webhook
- Jira issue closed webhook

## Arcade Tools Used

- `Github.GetPullRequest`
- `Github.ListPullRequests` (authorized and available)
- `Jira.GetIssueComments`
- `Jira.AddCommentToIssue`
- `Jira.GetIssueById`
- `Slack.SendMessage`

## Event Flows

### A) PR Opened -> Jira Comment + Delayed Check
1. GitHub sends `pull_request` webhook (`opened` or `reopened`)
2. Backend extracts Jira key from branch name (`JIRA-123`)
3. Backend gets PR details with Arcade `Github.GetPullRequest`
4. Backend comments on Jira with Arcade `Jira.AddCommentToIssue` (deduped)
5. Backend waits 60s (configurable)
6. Backend re-checks PR + Jira via Arcade
7. If PR open and Jira closed, backend sends Slack alert via Arcade `Slack.SendMessage`

### B) Jira Closed -> Delayed Check
1. Jira sends issue webhook to `/jira/webhook`
2. If issue is closed, backend schedules 60s delayed check for linked PR records
3. Backend re-checks PR + Jira via Arcade
4. Policy rules decide whether to send Slack alert via Arcade

## Policy-as-Code

- Rules are loaded from `rules/*.yaml` at startup.
- Default policy file: `rules/default.yaml`.
- Current default rules:
  - `pr_open=true` and `jira_closed=true` -> alert (`pr_open_jira_closed`)
  - `pr_open=false` and `jira_closed=false` -> alert (`pr_closed_jira_open`)
- You can add repo-specific rules by creating more YAML files in `rules/`.
- Message templates support placeholders like `{{jira_issue_key}}`, `{{pr_url}}`, `{{owner}}`, `{{repo}}`.

## Prerequisites

- Docker Desktop
- Arcade account + API key
- Arcade integrations connected for GitHub, Jira, Slack
- GitHub repo admin rights (webhook setup)
- Jira project admin rights (webhook setup)

Relevant docs:
- [Arcade docs](https://docs.arcade.dev/en/home)
- [GitHub integration](https://docs.arcade.dev/en/resources/integrations/development/github)
- [Jira integration](https://docs.arcade.dev/en/resources/integrations/productivity/jira)
- [Slack integration](https://docs.arcade.dev/en/resources/integrations/social-communication/slack/reference)

## 1. Configure Environment

```bash
cp .env.example .env
```

Required in `.env`:
- `ARCADE_API_KEY`
- `ARCADE_USER_ID`
- `GITHUB_WEBHOOK_SECRET`
- One of:
  - `SLACK_ALERT_CHANNEL`
  - `SLACK_ALERT_CONVERSATION_ID`

Recommended:
- `JIRA_WEBHOOK_TOKEN`

Defaults:
- `ALERT_DELAY_SECONDS=60`
- `JIRA_CLOSED_STATUS_KEYWORDS=done,closed,resolved`

## 2. Run in Docker

```bash
docker compose up --build
```

Health check:

```bash
curl http://localhost:3000/health
```

## 3. Complete Arcade OAuth Authorizations

```bash
curl http://localhost:3000/auth/check
```

Open every `authorization_url` that is not completed.

## 4. Expose Local Service

For local development:

```bash
ngrok http 3000
```

Use resulting HTTPS base URL for webhook endpoints.

## 5. Configure GitHub Webhook

GitHub -> `Settings` -> `Webhooks` -> `Add webhook`
- Payload URL: `https://<public-url>/webhook`
- Content type: `application/json`
- Secret: same as `GITHUB_WEBHOOK_SECRET`
- Events: `Pull requests`

## 6. Configure Jira Webhook

Jira -> `System` -> `Webhooks` -> `Create`
- URL:
  - With token in query (easy setup):
    - `https://<public-url>/jira/webhook?token=<JIRA_WEBHOOK_TOKEN>`
  - Or send header `x-jira-webhook-token: <JIRA_WEBHOOK_TOKEN>`
- Events: Issue updated / transitioned (any event where closed status can be emitted)
- JQL (optional): narrow to your project

## 7. Test End-to-End

1. Create Jira issue `JIRA-123`.
2. Create branch `JIRA-123`, push, open PR.
3. Close Jira issue but keep PR open.
4. Wait 60 seconds.
5. Verify Slack alert appears.

Also verify reverse trigger path:
1. Merge or close PR.
2. Keep Jira issue open (for example `To Do`).
3. Wait 60 seconds.
4. Verify Slack alert appears.

## Endpoints

- `GET /health`
- `GET /auth/check`
- `POST /webhook` (GitHub)
- `POST /jira/webhook` (Jira)

## Notes

- The delayed checker uses local persisted state in `data/monitor-state.json`.
- State is local to this service instance.
- If you run multiple replicas, you should move state/timers to a shared queue/store (Redis + worker).
