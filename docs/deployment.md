# Deployment and Upgrade Guide

This guide covers a repeatable deployment for Swear Review. Keep application
code, `config.yaml`, the SQLite database, and secrets separate.

## Deployment invariants

Every release must preserve these invariants:

- Node.js 24 is available at runtime.
- Git is at least 2.41 (required by OCR's partial-clone workflow).
- The OCR version in the image, config, and contract fixtures agrees.
- GitHub App secrets never enter the image, repository, command line, or logs.
- `/data` and the configured SQLite database survive application restarts.
- A release is not complete until `/healthz`, `/readyz`, and the logs are checked.

Each OCR review process receives a fresh `x-opencode-session` UUID through
OCR's `OCR_LLM_EXTRA_HEADERS`. All requests and SDK retries in that review
reuse it; separate reviews receive different IDs. Existing extra headers are
preserved. Do not configure `x-opencode-session` yourself: the runner rejects
that override to prevent unrelated reviews sharing a fixed ID. The gateway
must preserve this header when forwarding to OpenCode Go.

## Docker Compose (recommended)

### First deployment

```bash
cp .env.example .env
cp config.example.yaml config.yaml
# Copy the GitHub App PEM to the path referenced by docker-compose.yml.
chmod 600 .env github-app.private-key.pem

npm test
npm run typecheck
npm run build

docker compose up -d --build
curl -fsS http://127.0.0.1:3000/healthz
curl -fsS http://127.0.0.1:3000/readyz
```

The Compose file mounts:

- `./data` as persistent configuration/database storage;
- `./config.yaml` as the read-only central application config;
- the GitHub App private key as a read-only container secret.

Do not put the real `.env`, PEM, or database in a public repository. The
repository's `.gitignore` and `.dockerignore` are defense-in-depth, not a
replacement for checking `git status` before publishing.

### Upgrade

```bash
git pull --ff-only
npm ci
npm test
npm run typecheck
npm run build
docker compose up -d --build
curl -fsS http://127.0.0.1:3000/healthz
curl -fsS http://127.0.0.1:3000/readyz
docker compose logs --tail=100 swear-review
```

The image build itself verifies Git and the pinned OCR release. The CI workflow
runs the same image checks on every push and pull request.

### Rollback

Keep the previous image tag or build artifact until the new service has passed
its health and webhook smoke checks:

```bash
docker image ls swear-review
# Re-tag/run the previous known-good image, then:
docker compose up -d
curl -fsS http://127.0.0.1:3000/readyz
```

Do not delete or restore the SQLite database as part of an application rollback
unless the database schema migration itself is the problem. Back up the file
before any migration:

```bash
install -D -m 600 data/swear-review.db \
  "backups/swear-review-$(date -u +%Y%m%dT%H%M%SZ).db"
```

## Git-backed systemd deployment (Oracle)

The production checkout is `/opt/swear-review/app`. It must contain only
versioned application files from the canonical Git remote. Keep these runtime
files outside Git:

```text
/opt/swear-review/data/config.yaml
/opt/swear-review/data/.env
/opt/swear-review/data/github-app.pem
/opt/swear-review/data/swear-review.db
```

The service unit is versioned at
[`deploy/swear-review.service`](../deploy/swear-review.service). It runs as the
non-root `ubuntu` service user, points at the external data directory, and
includes the Oracle resource limits. The Oracle deploy script intentionally
uses these fixed paths and user; its only argument is the Git ref to deploy.
The service starts reclaiming memory at 4 GiB and is stopped at 5 GiB. This
leaves headroom for concurrent OCR workers without allowing them to starve the
other Oracle services.

### Convert an existing copied deployment

Back up the data and keep the old application directory until the new checkout
passes health checks:

```bash
sudo install -d -m 700 /opt/swear-review/backups
sudo cp -a /opt/swear-review/data \
  "/opt/swear-review/backups/data-$(date -u +%Y%m%dT%H%M%SZ)"
sudo mv /opt/swear-review/app \
  "/opt/swear-review/app-pre-git-$(date -u +%Y%m%dT%H%M%SZ)"
git clone git@github.com:swear01/swear-review.git /opt/swear-review/app
sudo chown -R "$(id -un):$(id -gn)" /opt/swear-review/app
cd /opt/swear-review/app
```

Use the private repository URL that owns the application; do not use the
router repository for this checkout. Verify the remote before deploying:

```bash
git remote -v
git status --short
```

Then install the unit and run the repository's one-command deployment:

```bash
sudo install -m 0644 deploy/swear-review.service \
  /etc/systemd/system/swear-review.service
./scripts/deploy-oracle.sh main
```

`scripts/deploy-oracle.sh` refuses dirty or unexpected untracked checkouts,
fetches the requested ref, installs dependencies, runs tests/typecheck/build,
installs the unit, runs `daemon-reload`, restarts the service, and verifies
`/healthz` and `/readyz`. Do not hand-edit the production checkout or use
`rsync` for routine releases.

The environment file contains the secret values and must remain owner-only.
The deployment script enforces the modes on every release:

```bash
sudo chmod 600 /opt/swear-review/data/.env /opt/swear-review/data/github-app.pem
sudo systemctl is-enabled swear-review
sudo systemctl is-active swear-review
sudo journalctl -u swear-review --since '2 minutes ago' --no-pager
```

For rollback, keep the previous Git commit or release tag and run the same
script with that ref; the script checks out the fetched object detached, so
branches, tags, and commit-like refs use the same path. Confirm the database
schema is compatible first. Never restore the database merely because
application code was rolled back.

If several machines share a home or release directory (for example through
NFS), the binary is shared but each machine has its own process. Update the file
once, then restart the service on **every** machine. Verify the file hash and
health endpoint on every host; never assume a shared filesystem restarted a
running process.

## ChatGPT quota fallback

DeepSeek stays primary. To enable the optional fallback, first sign in using
OCR's [ChatGPT preview flow](https://github.com/alibaba/open-code-review/blob/v1.13.5/pages/src/content/docs/en/chatgpt-preview.md):

```bash
ocr auth login --provider chatgpt
ocr auth status --provider chatgpt
ocr llm models
```

Grant ChatGPT plan usage in the browser. If it is disabled, run
`ocr auth login --provider chatgpt --enable-plan`. Login is interactive and does
not support device codes. Available models and usage limits depend on the
selected account; OCR does not automatically switch to API billing.

Keep OCR's `accounts.json` and `host.json` in a service-owned directory outside
the review workspace. The directory must be private (`0700`); both files must be
regular service-owned files without group/other permissions (`0600`). On Oracle,
use `/opt/swear-review/data/chatgpt-auth`. A self-hosted VM needs its own stable
host ID; follow [OpenAI's VM guide](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)
when transferring a registration. Do not copy the whole local HOME or save tokens
in YAML, Git, review artifacts, or command arguments.

Add this to the central service configuration after verifying the login:

```yaml
llm:
  # Keep the existing DeepSeek url/model/use_anthropic values.
  chatgpt_fallback:
    auth_dir: /opt/swear-review/data/chatgpt-auth
    # model: <account-visible-model>  # omitted: account catalog default
```

Omitting `chatgpt_fallback` disables it. Each review still starts with DeepSeek.
Fallback runs once for the same immutable SHAs, with unchanged concurrency and
the time remaining in the original hard deadline. It requires failed provider
coverage and a structured OCR retry report where every failed logical request
exhausted retries on HTTP 429. The gateway already tries its configured routes
before returning aggregate 429; this can indicate exhausted quota or sustained
rate limiting. OCR does not expose the provider error body, so these two causes
cannot be distinguished. Generic provider errors, mixed non-429 failures,
budget/config/parse errors, cancellation and timeout never trigger fallback.

The final summary and stored run identify the model actually used. Findings from
a partial primary review are retained and deduplicated against fallback
findings. An incomplete or skipped fallback cannot turn selected primary files
into a successful review. The fallback has its own isolated session HOME, with
only its auth subtree linked to the persistent directory; OCR manages token
rotation and locking there. Workspace cleanup leaves the auth store intact.

## OCR upgrades

OCR output is a versioned compatibility boundary. Do not upgrade only the global
binary and leave the application pinned to an older contract.

1. Install the candidate OCR release in an isolated environment.
2. Capture JSON for at least `complete`, `failed`, `partial`, `cancelled`, and
   `skipped` runs.
3. Add or update fixtures under `tests/fixtures/`.
4. Update `src/review/ocr-adapter.ts` deliberately.
5. Run the adapter tests, integration tests, typecheck, and production image
   build.
6. Update the OCR version in `Dockerfile`, `package.json`, and
   `config.example.yaml` together.
7. Deploy to a staging or E2E installation before production.

A `skipped` result means OCR selected no reviewable files. It is a successful
empty review, not an OCR infrastructure failure.

## GitHub App verification

After deployment:

```bash
curl -fsS https://your-host.example/webhooks -X POST -d '{}' || true
```

The webhook endpoint should reject an unsigned request; that is expected. Use a
real GitHub App delivery or the repository's E2E procedure to verify the HMAC
path. Then check that a test PR produces:

- a Check Run;
- a sticky summary comment;
- inline comments when findings have valid positions;
- a successful empty review for a docs-only diff.

Do not use a production credential to test arbitrary untrusted repositories.
Keep `security.auto_review_external_prs: false` unless the quota and prompt
injection risks are understood.

## Troubleshooting

| Symptom | First checks |
| --- | --- |
| `/healthz` fails | service status, startup logs, port binding |
| `/readyz` fails | database path, permissions, disk space |
| `MISSING_CREDENTIAL` | `.env`/secret file exists, key name matches config |
| OCR parse failure | OCR version, raw JSON fixture, adapter contract tests |
| Partial OCR coverage | inspect `coverage.failures` in the structured `OCR review complete` log for each path, classification, and sanitized reason |
| Superseded review keeps consuming resources | deploy the process-group cancellation fix; verify the OCR wrapper and descendants exit together |
| No webhook jobs | public HTTPS URL, App events, HMAC secret, delivery logs |
| Docs-only PR fails review | OCR output status should be `skipped`; deploy the current adapter |
| Repeated/stale findings | check reviewed HEAD SHA and deduplication logs |

Never fix a credential error by placing a real key in `config.yaml` or a GitHub
comment. Rotate a credential immediately if it was ever committed or logged.
