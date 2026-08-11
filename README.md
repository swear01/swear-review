# Swear Review

A self-hosted GitHub App that reviews every pull request with **Alibaba Open Code Review (OCR)** running **DeepSeek V4 Flash** through **OpenCode Go**, publishing **GitHub-native inline comments, a sticky summary, and a Check Run**.

Swear Review is an **independent second opinion** — no matter whether the code was written by a human, Cursor, Codex, Claude Code, or OpenCode, a completely separate pipeline re-checks it.

```
Coding Agent / Human ──push──▶ GitHub Pull Request
                                    │
                                    ▼
                          Swear Review GitHub App
                                    │
                                    ▼
                       Alibaba Open Code Review (concurrency 16)
                                    │
                                    ▼
                         OpenCode Go · deepseek-v4-flash
                                    │
                                    ▼
              GitHub native review: inline comments + sticky summary + Check Run
```

## Why this is different

- **Target repositories need ZERO configuration.** No GitHub Actions, no `.swear-review.yml`, nothing. The bot is a GitHub App installed on your personal account with **All repositories** access.
- **Every push re-reviews the entire PR** (full diff from merge-base to head), not just the new commit.
- **Full compute, deduplicated publication.** OCR recomputes the whole PR every time, but the publication layer never spams duplicate comments (finding fingerprints + location-overlap detection).
- **Responsibility boundary:** GitHub integration (webhooks, queue, checkout, publication, checks, merge policy) lives here. Review intelligence (file selection, bundling, agent orchestration, finding generation) belongs entirely to OCR. Swear Review is a *thin, reliable product layer*, not another review framework.

## Architecture

| Layer | Tech |
| --- | --- |
| Runtime | Node.js 24 · TypeScript |
| GitHub | `@octokit/app`, `@octokit/webhooks` |
| HTTP | Fastify |
| Persistence | SQLite (`node:sqlite`, built-in) |
| Review engine | `@alibaba-group/open-code-review@1.9.0` (pinned) |
| LLM | OpenCode Go `https://opencode.ai/zen/go/v1/chat/completions` · `deepseek-v4-flash` |
| Deployment | Docker |

Fixed product decisions (do not change without re-reading the spec):

- OCR concurrency is **always 16** — no adaptive fallback (16 → 8 → 4 does not exist).
- OCR/SDK native retry is enabled; Swear Review adds **no outer retry** (no retry amplification).
- A **Check Run is always created** for every review.
- Merge gating is **off by default** and optional per repository (`off | check | managed`).

---

## 1. Create the GitHub App

1. Go to **https://github.com/settings/apps/new** (personal account).
2. Fill in:
   - **GitHub App name:** `Swear Review` (slug fallback: `swear-review-ai`, `swear-code-review`)
   - **Homepage URL:** any (e.g. your GitHub profile)
   - **Webhook URL:** `https://your-server.example.com/webhooks`
   - **Webhook secret:** a long random string — save it for later (`GITHUB_WEBHOOK_SECRET`)
3. **Permissions** (Repository permissions):

   | Permission | Access | Why |
   | --- | --- | --- |
   | Metadata | **Read** | repo metadata |
   | Contents | **Read** | clone/fetch code (never modified) |
   | Pull requests | **Read & write** | PR reviews + inline comments |
   | Issues | **Read & write** | PR conversation, sticky summary, commands |
   | Checks | **Read & write** | Check Runs |
   | Commit statuses | **Read & write** | required-status compatibility |
   | Administration | **Read & write** | optional managed-gate rulesets only |

4. **Webhook events** — subscribe to:

   ```
   pull_request
   issue_comment
   check_run
   installation
   installation_repositories
   repository
   ```

5. **Where can this GitHub App be installed?** → *Any account* (so you can install it on your personal account).
6. **Create the app.** Download the **private key** (`.pem` file) — it is shown only once.

## 2. Configuration

Copy the example files:

```bash
cp .env.example .env
cp config.example.yaml config.yaml
```

Edit `.env`:

```bash
GITHUB_APP_ID=123456                     # from the app settings page
GITHUB_APP_PRIVATE_KEY_PATH=./github-app.private-key.pem
GITHUB_WEBHOOK_SECRET=<the secret from step 1>
OPENCODE_GO_KEY=sk-opencode-go-...       # https://opencode.ai
```

All secrets (`GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `OPENCODE_GO_KEY`) live **only** in server env — never in the repo, never in command arguments, never in logs or GitHub comments. The OCR process receives the OpenCode key but **never** the GitHub private key.

### Central configuration (`config.yaml`)

The only configuration source. Target repositories never need a file. See `config.example.yaml` for the full reference. Highlights:

```yaml
review:
  auto: true
  review_drafts: false          # drafts: auto off until ready_for_review
ocr:
  version: "1.9.0"
  concurrency: 16               # fixed, do not change
security:
  auto_review_external_prs: false   # public repos: trusted collaborators only
gate:
  mode: off                     # off | check | managed
  block_categories: [bug, security]
repositories:
  "OWNER/critical-project":
    gate:
      mode: managed
  "OWNER/experimental-*":
    review:
      auto: false
```

Precedence: hardcoded defaults → global config → repository glob → exact repository.

## 3. Run it

### Docker (recommended)

```bash
docker compose up -d --build
```

The image contains Node 24, Git ≥ 2.41, and OCR v1.9.0. `/data/` (persistent volume) holds `config.yaml` and `swear-review.db`. Review workspaces (`/tmp/swear-review`) are ephemeral and cleaned up after each job.

### From source

```bash
npm install
npm run build
node dist/index.js
```

Requires `ocr` on `$PATH` (or set `OCR_BIN`):

```bash
npm install -g @alibaba-group/open-code-review@1.9.0
```

## 4. Install the App

1. Go to your GitHub App's **Install** page (or the app settings → Install App).
2. Install it on your **personal account**.
3. Repository access: **All repositories**.
4. No target repo files are created or required.

## 5. Use it

Push a PR — Swear Review automatically:

1. clones the repo (hooks disabled, blob:none partial clone, fresh per job),
2. runs `ocr review --from <merge-base> --to <head> --concurrency 16 --format json`,
3. publishes inline review comments (batches of 50, deduplicated),
4. upserts the sticky **Swear Review Summary** comment,
5. creates/completes the **Swear Review** Check Run.

### Manual commands (PR conversation)

| Command | Effect |
| --- | --- |
| `/swear-review` or `/swear-review full` | Full PR review |
| `/swear-review incremental` | Review only `last successful review → HEAD` (falls back to full if no prior review) |
| `/swear-review status` | Current head / last reviewed / last successful / job status / gate mode / OCR version / model |

Manual commands require **OWNER / ADMIN / MAINTAIN / WRITE** permission on the repository. Random strangers on public repos cannot burn your quota.

### Merge gates

- **`off`** (default): findings → comments, Check → success, merging unaffected. Check fails only on infrastructure/model failure.
- **`check`**: a bug/security finding flips the Check to failure. If you mark `Swear Review` as a required check, merging is blocked. Swear Review does not touch repo settings.
- **`managed`**: Swear Review creates/updates a repository ruleset (`Swear Review` → required status check on the default branch) automatically. Requires `Administration: write`; on GitHub plans without private-repo rulesets it degrades gracefully (review + check keep working, gate reported as unavailable).

Example — enable managed gate for one repo:

```yaml
repositories:
  "you/critical-project":
    gate:
      mode: managed
```

## 6. Development

```bash
npm run dev        # tsx watch
npm test           # vitest (unit + integration)
npm run typecheck
npm run build
```

Tests include:

- unit: command parser, dedup, gate policy, OCR adapter (against a real v1.9.0 capture in `tests/fixtures/ocr-v1.9.0.json`), config precedence, queue superseding;
- integration: webhook signature validation, and an end-to-end pipeline (webhook → queue → worker → git checkout → OCR (mock binary) → GitHub publication) covering auto review, 16-concurrency invocation, managed gate blocking, gate-off behavior, stale-head discard, OCR failure fail-closed, dedup across pushes, and external-PR abuse protection.

The OCR JSON contract is validated by `tests/unit/ocr-adapter.test.ts` against a **real v1.9.0 output capture**. When upgrading OCR, run the contract tests first — an incompatible schema fails loudly rather than publishing garbage.

## 7. Operational endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /healthz` | liveness |
| `GET /readyz` | readiness incl. DB |
| `GET /metrics` | basic counters (reviews, findings, OCR failures, publish failures, dedup, webhooks) |

Logs are structured JSON. Each review logs `installation_id`, repo, PR, job id, head SHA, mode, OCR version, model, duration, finding count, exit status. Secrets are redacted by key name.

## FAQ / notes

- **Why no GitHub Actions?** The bot is a first-class GitHub App; repos need zero setup and the review engine is fully under your control.
- **What if OCR fails?** The Check Run fails (fail-closed by default), the sticky summary reports the failure, no fake success. Retry with `/swear-review full`.
- **What if a newer commit lands while a review is running?** The running OCR process is cancelled if possible; if it finishes anyway, its results are discarded (stale-SHA protection) and the Check Run is cancelled. Old queued jobs are superseded.
- **Can target repos configure anything?** No — Phase 1 deliberately keeps all configuration on the server.
