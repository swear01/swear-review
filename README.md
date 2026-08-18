# Swear Review

A self-hosted GitHub App that gives every pull request an independent AI review
through [Alibaba Open Code Review (OCR)](https://github.com/alibaba/opencode-review)
and an OpenAI-compatible LLM endpoint. It publishes native GitHub inline
comments, a sticky summary, and a Check Run.

Swear Review is deliberately a thin product layer:

```text
GitHub PR webhook
      │
      ▼
checkout → queue → OCR 1.9.x → findings
      │                         │
      └────── GitHub API ◀──────┘
              │
              ├─ inline review comments
              ├─ sticky summary comment
              └─ Swear Review Check Run
```

## Features

- **Zero target-repository setup** — install the GitHub App; target repositories
  do not need Actions, a config file, or a dependency.
- **Full-PR automatic reviews** — every configured PR event reviews the complete
  merge-base-to-HEAD range.
- **Native GitHub output** — inline comments, one deduplicated sticky summary,
  and a Check Run.
- **Duplicate suppression** — repeated full reviews do not spam the same finding.
- **Optional merge gates** — `off`, `check`, or `managed` per repository.
- **Abuse protection** — automatic reviews of external contributors are disabled
  by default, and manual commands require repository write-level permission.
- **Docs-only PR support** — OCR's `status: skipped` result is treated as a
  successful empty review when no selectable files exist.
- **Fail-closed infrastructure errors** — provider, checkout, OCR, and GitHub
  publication failures do not become fake successful reviews.

## Architecture

| Layer | Implementation |
| --- | --- |
| Runtime | Node.js 24 + TypeScript |
| GitHub | `@octokit/app`, `@octokit/webhooks` |
| HTTP | Fastify |
| Persistence | SQLite (`node:sqlite`) |
| Review engine | `@alibaba-group/open-code-review@1.9.0` |
| Model endpoint | OpenCode Go by default, `deepseek-v4-flash` |
| Deployment | Docker Compose or a systemd service |

The OCR release is pinned because its JSON output is a compatibility boundary.
The adapter has a real-output contract fixture and must be updated deliberately
when OCR changes.

## Requirements

- Node.js 24 or newer
- Git 2.41 or newer (required by OCR's partial-clone workflow)
- Docker Engine + Compose (recommended), or Node.js and the OCR CLI
- A GitHub App with a publicly reachable HTTPS webhook endpoint
- An OpenAI-compatible LLM endpoint and server-side credential

## Quick start with Docker

### 1. Create the GitHub App

Create an app at <https://github.com/settings/apps/new> with:

**Repository permissions**

| Permission | Access | Purpose |
| --- | --- | --- |
| Metadata | Read | Repository metadata |
| Contents | Read | Checkout and inspect source |
| Pull requests | Read & write | Reviews and inline comments |
| Issues | Read & write | Conversation commands and summary |
| Checks | Read & write | Check Runs |
| Commit statuses | Read & write | Required-status compatibility |
| Administration | Read & write | Optional `managed` gate rulesets only |

**Webhook events**

- `pull_request`
- `issue_comment`
- `check_run`
- `installation`
- `installation_repositories`
- `repository`

Use a long random webhook secret. Download the App's private key once and
store it outside Git.

### 2. Prepare local configuration

```bash
cp .env.example .env
cp config.example.yaml config.yaml
# Put the downloaded key at the path configured by GITHUB_APP_PRIVATE_KEY_PATH.
```

Set the values in `.env`:

```dotenv
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=./github-app.private-key.pem
GITHUB_WEBHOOK_SECRET=replace-with-a-long-random-secret
OPENCODE_GO_KEY=sk-example-do-not-use
```

The example values are placeholders. Never commit `.env`, the PEM file, a real
webhook secret, or an LLM credential.

### 3. Start the service

```bash
docker compose up -d --build
curl -fsS http://127.0.0.1:3000/healthz
curl -fsS http://127.0.0.1:3000/readyz
```

The Compose setup persists `config.yaml` and the SQLite database under `data/`.
Review workspaces under `/tmp/swear-review` are temporary and cleaned after each
job.

The webhook URL configured in GitHub must route to the service's `/webhooks`
endpoint. A stable HTTPS endpoint is recommended for production; temporary
Quick Tunnels are suitable only for local testing.

## Configuration

`config.yaml` is the central configuration source. Target repositories do not
need a configuration file.

Important defaults:

```yaml
review:
  auto: true
  default_mode: full
  review_drafts: false
  triggers:
    opened: true
    synchronize: true
    reopened: true
    ready_for_review: true

ocr:
  version: "1.9.0"
  concurrency: 16       # fixed per deployment; no adaptive fallback
  timeout_minutes: 10
  hard_timeout_minutes: 45

publication:
  deduplicate: true
  sticky_summary: true
  comment_batch_size: 50

security:
  auto_review_external_prs: false

gate:
  mode: off             # off | check | managed
  block_categories: [bug, security]
  fail_closed_on_review_error: true
```

`ocr.concurrency` is fixed for each process configuration; the service does not
silently fall back from 16 to 8 or 4. Smaller deployments may choose a lower
explicit value after measuring their memory and provider limits.

Repository overrides use the precedence:

```text
safe defaults < global config < repository glob < exact repository
```

Example:

```yaml
repositories:
  "example-org/critical-*":
    gate:
      mode: managed
  "example-org/experimental-project":
    review:
      auto: false
```

### Merge gates

- **`off`** — findings are published, the Check Run succeeds, and merging is
  unaffected. Infrastructure failures still fail the Check Run.
- **`check`** — configured blocking categories make the Check Run fail. GitHub
  can enforce it if `Swear Review` is marked as a required check.
- **`managed`** — the service creates or updates a repository ruleset requiring
  the Check Run. This needs `Administration: write` and may be unavailable on
  some GitHub plans.

### OCR status `skipped`

OCR can return `status: skipped` with `Review skipped: no items were selected.`
when a diff contains no selectable review files, such as a documentation-only
PR. Swear Review treats that as a successful empty review, publishes the reason
in the summary and Check Run, and does not block the PR.

## Using the bot

Automatic reviews run for the configured pull-request events. Each automatic
review covers the full merge-base-to-HEAD range.

Commands are entered as PR conversation comments:

| Command | Effect |
| --- | --- |
| `/swear-review` | Full PR review |
| `/swear-review full` | Full PR review |
| `/swear-review incremental` | Review `last successful review → HEAD`; falls back to full |
| `/swear-review status` | Show head, review, job, gate, OCR, and model state |
| `/swear-review help` | Show available commands |

Manual commands require OWNER, ADMIN, MAINTAIN, or WRITE permission. External
contributors cannot consume the configured model quota by default.

## Deployment and upgrades

See **[`docs/deployment.md`](docs/deployment.md)** for:

- Docker and Git-backed systemd deployment
- secret handling and backups
- OCR upgrades and contract tests
- safe release/rollback steps
- health and readiness verification
- production troubleshooting

The Oracle release path is `./scripts/deploy-oracle.sh <ref>`; it fetches a clean
Git checkout, runs the test/build gate, reloads systemd, restarts the service,
and verifies both health endpoints.

The short version for an OCR or application release is:

```bash
npm ci
npm test
npm run typecheck
npm run build
docker compose up -d --build
curl -fsS http://127.0.0.1:3000/healthz
curl -fsS http://127.0.0.1:3000/readyz
```

## Development

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run dev
```

The test suite covers command parsing, config precedence, queue superseding,
deduplication, gate policy, webhook validation, OCR contract parsing, and the
full webhook → queue → checkout → OCR → publication pipeline.

When upgrading OCR:

1. Install the candidate OCR version in an isolated environment.
2. Capture representative JSON for complete, failed, partial, cancelled, and
   skipped runs.
3. Update the adapter contract and fixtures.
4. Run the full test suite and Docker verification workflow.
5. Only then change the pinned version in `Dockerfile`, `package.json`, and
   `config.example.yaml`.

## Operational endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /healthz` | Process liveness |
| `GET /readyz` | Readiness, including SQLite availability |
| `GET /metrics` | Prometheus-style basic counters |

Logs are structured JSON. Secrets are redacted by key name and are never
included in GitHub comments.

## Security

Read [`SECURITY.md`](SECURITY.md) before deploying. In particular:

- keep GitHub App private keys, webhook secrets, and LLM credentials in the
  server environment or a secret manager;
- do not expose `/webhooks` without HTTPS and the configured HMAC secret;
- keep `auto_review_external_prs: false` unless you intentionally accept the
  model-quota and prompt-injection risk;
- keep the SQLite database and runtime data directory private.

## E2E verification

The reusable acceptance checklist is in
[`docs/E2E-CHECKLIST.md`](docs/E2E-CHECKLIST.md). It intentionally uses
placeholders for App IDs, installation IDs, accounts, repositories, and webhook
URLs so the document can be published safely.

## License

MIT. See [`LICENSE`](LICENSE).
