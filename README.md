# GitHub PR -> Jira Comment Sync (Arcade + Docker)

This backend listens to GitHub pull request webhooks and comments on the matching Jira issue when a PR is opened.

Flow:
1. GitHub sends `pull_request` webhook (`action=opened`)
2. Backend extracts Jira key from branch name (example `JIRA-123`)
3. Backend calls Arcade `Github.GetPullRequest`
4. Backend checks Jira comments with `Jira.GetIssueComments` (dedupe)
5. Backend comments via `Jira.AddCommentToIssue`

## Stack

- Node.js + TypeScript
- Express
- Arcade JS SDK (`@arcadeai/arcadejs`)
- Docker + docker compose

## Prerequisites

- Docker Desktop
- Arcade account + API key
- Arcade integrations connected for GitHub and Jira
- GitHub repo admin rights (to add webhook)

Relevant docs:
- [Arcade docs](https://docs.arcade.dev/en/home)
- [Call tools in agents](https://docs.arcade.dev/en/get-started/quickstarts/call-tool-agent)
- [GitHub integration tools](https://docs.arcade.dev/en/resources/integrations/development/github)
- [Jira integration tools](https://docs.arcade.dev/en/resources/integrations/productivity/jira)

## 1. Configure environment

```bash
cp .env.example .env
```

Set these values in `.env`:
- `ARCADE_API_KEY`
- `ARCADE_USER_ID` (a stable user identifier used by Arcade)
- `GITHUB_WEBHOOK_SECRET` (same value you set in GitHub webhook config)

Optional:
- `REQUIRE_EXACT_BRANCH_KEY=true` if you want only exact branch names like `JIRA-123`
- `JIRA_ISSUE_REGEX` if your key format differs

## 2. Run in Docker

```bash
docker compose up --build
```

Service runs on `http://localhost:3000`.

Health check:

```bash
curl http://localhost:3000/health
```

## 3. Authorize Arcade tools (one-time per user/account)

Check tool auth state:

```bash
curl http://localhost:3000/auth/check
```

If any tool returns `pending` with an `authorization_url`, open that URL in a browser and complete OAuth.

Expected tools:
- `Github.GetPullRequest`
- `Jira.GetIssueComments`
- `Jira.AddCommentToIssue`

## 4. Expose local webhook URL to GitHub

For local development, use a tunnel such as ngrok:

```bash
ngrok http 3000
```

Use the HTTPS forwarding URL as your webhook base, then append `/webhook`.

Example payload URL:

```text
https://<your-ngrok-subdomain>.ngrok.io/webhook
```

## 5. Configure GitHub webhook

In your GitHub repo:
1. `Settings -> Webhooks -> Add webhook`
2. Payload URL: `https://<public-url>/webhook`
3. Content type: `application/json`
4. Secret: same value as `.env` `GITHUB_WEBHOOK_SECRET`
5. Events: select `Pull requests`

## 6. Demo flow

1. Create Jira issue `JIRA-123`
2. Create git branch `JIRA-123` (or branch containing key if exact match is disabled)
3. Push and open PR
4. Watch backend logs (`docker compose logs -f backend`)
5. Confirm Jira gets a new comment with PR title and URL

## Behavior notes

- Only `pull_request` events with `action=opened` are processed.
- Duplicate comments are prevented using a marker + PR URL check.
- If Jira key is missing from branch name, webhook is ignored.
- If webhook secret is unset, signature validation is disabled (not recommended for production).

## Endpoints

- `GET /health`
- `GET /auth/check`
- `POST /webhook`

## Local non-Docker dev (optional)

```bash
npm install
npm run dev
```

