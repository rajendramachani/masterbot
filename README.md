# masterbot

**Autonomous AI coding agent. Talk to it on Telegram. It builds your code on GitHub.**

---

## How It Works

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│  You (Telegram)                                                         │
│       │                                                                 │
│       │ 1. Describe a task                                              │
│       ▼                                                                 │
│  ┌─────────────────┐                                                    │
│  │  Event Handler  │ ──2──► LLM (OpenRouter) generates plan            │
│  │  (Telegram bot) │ ──3──► Sends plan to you for approval             │
│  └────────▲────────┘                                                    │
│           │                                                             │
│           │ 4. You approve                                              │
│           │                                                             │
│           ▼                                                             │
│  ┌─────────────────┐                                                    │
│  │     GitHub      │ ── Creates feat/<id> branch + job.md              │
│  │  (feat branch)  │                                                    │
│  └────────┬────────┘                                                    │
│           │                                                             │
│           │ 5. run-job.yml triggers                                     │
│           ▼                                                             │
│  ┌─────────────────┐                                                    │
│  │  Pi Coding      │ ── Reads job.md, implements code, commits         │
│  │  Agent (Docker) │                                                    │
│  └────────┬────────┘                                                    │
│           │                                                             │
│           │ 6. PR opened to {project}-dev                              │
│           ▼                                                             │
│  ┌─────────────────┐                                                    │
│  │  Code Review    │ ── AI reviews the PR (OpenRouter)                 │
│  │  Agent          │                                                    │
│  └────────┬────────┘                                                    │
│           │                                                             │
│           │ 7. Auto-merge (if approved)                                │
│           ▼                                                             │
│  ┌─────────────────┐                                                    │
│  │  Telegram       │ ── You get notified with PR link + summary        │
│  │  Notification   │                                                    │
│  └─────────────────┘                                                    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Branch Model

Each project gets its own isolated branch hierarchy:

```
main                         ← masterbot code (never touched by agent jobs)
├── {project}-master         ← project root (workflows, scripts bootstrapped here)
│   └── {project}-dev        ← integration branch (PR target for all feat branches)
│       └── feat/<id>        ← agent working branch (one per task)
```

The Pi coding agent works on `feat/<id>`, commits its code, and opens a PR to `{project}-dev`.
The code review agent reviews it. If approved, `feat-auto-merge.yml` squash-merges it.

---

## Get Started

### Prerequisites

| Requirement | Notes |
|-------------|-------|
| **GitHub account** | Free tier works |
| **Telegram bot** | Create via [@BotFather](https://t.me/BotFather) |
| **OpenRouter API key** | [openrouter.ai](https://openrouter.ai) — free tier available |
| **GitHub PAT** | Scopes: `repo`, `workflow` |

### Step 1 — Fork this repository

[![Fork this repo](https://img.shields.io/badge/Fork_this_repo-238636?style=for-the-badge&logo=github&logoColor=white)](https://github.com/rajendramachani/masterbot/fork)

> Enable GitHub Actions on your fork: go to the **Actions** tab and click "I understand my workflows, go ahead and enable them."

### Step 2 — Set GitHub Secrets

Go to **Settings → Secrets and variables → Actions → Secrets** and add:

| Secret | Value |
|--------|-------|
| `SECRETS` | Base64-encoded JSON: `{"GH_TOKEN":"ghp_...","ANTHROPIC_API_KEY":"..."}` |
| `LLM_SECRETS` | Base64-encoded JSON: `{"OPENROUTER_API_KEY":"sk-or-v1-..."}` |
| `GH_WEBHOOK_SECRET` | Random string (generate: `openssl rand -hex 32`) |
| `GH_PAT` | GitHub PAT with `repo` + `workflow` scopes |
| `EVENT_HANDLER_ENV` | Base64-encoded `.env` file (see below) |
| `OPENROUTER_API_KEY` | Your OpenRouter key (for code review agent) |

To create `SECRETS`:
```bash
echo '{"GH_TOKEN":"ghp_your_token","ANTHROPIC_API_KEY":"sk-ant-..."}' | base64 -w0
```

To create `LLM_SECRETS`:
```bash
echo '{"OPENROUTER_API_KEY":"sk-or-v1-your_key"}' | base64 -w0
```

To create `EVENT_HANDLER_ENV`:
```bash
# Fill in event_handler/.env.example → save as event_handler/.env
cat event_handler/.env | base64 -w0
```

### Step 3 — Set GitHub Variables

Go to **Settings → Secrets and variables → Actions → Variables** and add:

| Variable | Value | Required |
|----------|-------|----------|
| `GH_WEBHOOK_URL` | Set automatically by `event-handler.yml` | Auto |
| `AUTO_MERGE` | Set to `false` to disable auto-merge | No |
| `AGENT_IMAGE_URL` | Custom Docker image URL (e.g. `ghcr.io/you/masterbot-agent`) | No |
| `AGENT_MODEL` | Override model for Pi agent (e.g. `openai/gpt-4o`) | No |
| `REVIEW_MODEL` | Override model for code review (e.g. `openai/gpt-4o-mini`) | No |

### Step 4 — Configure the Event Handler `.env`

Copy `event_handler/.env.example` to `event_handler/.env` and fill in:

```env
API_KEY=your_random_api_key
GH_TOKEN=ghp_your_token
GH_OWNER=your_github_username
GH_REPO=masterbot

TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_WEBHOOK_SECRET=your_webhook_secret
TELEGRAM_VERIFICATION=verify-abc12345
TELEGRAM_CHAT_ID=         # fill in after step 5

GH_WEBHOOK_SECRET=your_webhook_secret
OPENROUTER_API_KEY=sk-or-v1-your_key
```

### Step 5 — Get Your Telegram Chat ID

1. Start a chat with your bot on Telegram
2. Send your `TELEGRAM_VERIFICATION` code (e.g. `verify-abc12345`)
3. The bot replies with your chat ID
4. Add it to `TELEGRAM_CHAT_ID` in your `.env`
5. Re-encode and update `EVENT_HANDLER_ENV` secret

### Step 6 — Start the Event Handler

Trigger the `Event Handler` workflow manually from the **Actions** tab.

It will:
- Start the event handler server
- Create a Cloudflare Tunnel for the public URL
- Register your Telegram webhook automatically
- Run for ~6 hours then auto-restart

### Step 7 — Build the Agent Docker Image

Trigger the `Build Agent Docker Image` workflow from the **Actions** tab.

This builds and pushes the Pi coding agent image to GHCR.

---

## Using masterbot

### Sending a Task

Message your Telegram bot with a task description:

```
Build a REST API for a todo list with Node.js and Express. 
Include endpoints for CRUD operations and store data in a JSON file.
```

masterbot will reply with a plan:

```
Here's my plan:

Project: todo-api
Feature: rest-api-crud
Estimated time: ~15 minutes

Steps:
1. Create Express server with todo routes
2. Implement GET /todos, POST /todos, PUT /todos/:id, DELETE /todos/:id
3. Add JSON file persistence layer
4. Write basic error handling

I'll build a Node.js REST API for todo management with full CRUD operations 
and JSON file storage.

Reply "yes" to approve and start, "no" to cancel, or describe any changes.
```

### Approving a Plan

Reply with any of: `yes`, `approve`, `go`, `ok`, `proceed`, `confirm`, `start`, `lgtm`

masterbot creates the branch and starts the Pi coding agent.

### Modifying a Plan

Reply with feedback instead of approving:

```
Use SQLite instead of JSON file, and add pagination to GET /todos
```

masterbot re-plans with your feedback.

### Cancelling

Reply with: `no`, `cancel`, `abort`, `stop`

---

## Architecture

### Components

| Component | Location | Purpose |
|-----------|----------|---------|
| **Event Handler** | `event_handler/` | Telegram bot, plan/approval flow, job creation |
| **Pi Coding Agent** | `Dockerfile.agent` + `agent-entrypoint.sh` | Autonomous code implementation |
| **GitOps Service** | `src/` | Branch management, PR creation, queue |
| **Code Review Agent** | `agents/code-review/` | AI PR review via OpenRouter |
| **Operating System** | `operating_system/` | Agent personality, prompts, cron/trigger configs |

### GitHub Actions Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `event-handler.yml` | Push to `main` or manual | Runs event handler via Cloudflare Tunnel (auto-restarts) |
| `run-job.yml` | `feat/*` branch created | Runs Pi coding agent Docker container |
| `docker-build-agent.yml` | Push to `main` (agent files) | Builds and pushes agent Docker image to GHCR |
| `ci.yml` | Push to `feat/*` | Runs CI checks |
| `code-review.yml` | After CI completes | AI code review on feat branch PRs |
| `feat-auto-merge.yml` | After code review | Auto-merges approved PRs to `{project}-dev` |
| `update-event-handler.yml` | PR opened/closed on `*-dev` | Sends job results to event handler → Telegram notification |
| `issue-to-branch.yml` | Issue labeled `gitops-push` | Alternative: create feat branch from GitHub issue |

### LLM Providers

masterbot uses **OpenRouter** as the default LLM provider, giving you access to:
- `openai/gpt-4o` — best quality
- `openai/gpt-4o-mini` — fast and cheap (default)
- `anthropic/claude-3.5-sonnet` — excellent for code
- `google/gemini-flash-1.5` — very fast
- Any other model on OpenRouter

Set `EVENT_HANDLER_MODEL` in your `.env` to change the chat/planning model.
Set `AGENT_MODEL` GitHub variable to change the Pi agent model.
Set `REVIEW_MODEL` GitHub variable to change the code review model.

---

## Customization

### Agent Personality

Edit `operating_system/SOUL.md` to change the agent's personality and working style.

### Agent Instructions

Edit `operating_system/AGENT.md` to change the agent's environment description and rules.

### Chat Behavior

Edit `operating_system/CHATBOT.md` to change how the Telegram bot responds to messages.

### Job Summary Format

Edit `operating_system/JOB_SUMMARY.md` to change how completed jobs are summarized.

### Scheduled Jobs

Add entries to `operating_system/CRONS.json`:
```json
[
  {
    "schedule": "0 9 * * 1",
    "job": "weekly-report",
    "description": "Weekly status report every Monday at 9am"
  }
]
```

### Per-Project Workflows

Add project-specific workflow files to `projects/{project-name}/workflows/`.
If not present, `projects/_default/workflows/` is used.

---

## API Reference

The event handler exposes these endpoints (all except webhooks require `x-api-key` header):

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/ping` | GET | Yes | Health check |
| `/webhook` | POST | Yes | Create a job directly (bypasses Telegram) |
| `/jobs/status` | GET | Yes | Check job status by `job_id` |
| `/telegram/register` | POST | Yes | Register Telegram webhook URL |
| `/telegram/webhook` | POST | Secret | Receive Telegram updates |
| `/github/webhook` | POST | Secret | Receive job completion notifications |

Create a job via API:
```bash
curl -X POST https://your-tunnel-url/webhook \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{"task": "Add a dark mode toggle to the frontend", "project": "my-app", "feat_name": "dark-mode"}'
```

---

## Security

- **Secrets are never exposed to the LLM**: `SECRETS` are decoded at the shell level and filtered before the Pi agent's subprocess starts
- **LLM-accessible secrets**: Put API keys the agent needs (e.g. for calling external APIs) in `LLM_SECRETS`
- **Telegram security**: Bot only responds to your configured `TELEGRAM_CHAT_ID`
- **Webhook secrets**: Both Telegram and GitHub webhooks are validated with secrets
- **Path traversal protection**: The GitOps service validates all directory paths

---

## Docs

| Document | Description |
|----------|-------------|
| `operating_system/SOUL.md` | Agent personality |
| `operating_system/AGENT.md` | Agent environment and rules |
| `operating_system/CHATBOT.md` | Telegram chat system prompt |
| `operating_system/JOB_SUMMARY.md` | Job completion summary prompt |
| `event_handler/.env.example` | All environment variables |
| `projects/_default/` | Default project bootstrap files |
| `agents/code-review/` | Code review agent |
