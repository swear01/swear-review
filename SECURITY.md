# Security Policy

## Scope

Swear Review handles GitHub source code, pull-request metadata, review output,
and credentials for an LLM provider. Treat a deployment as a security-sensitive
service even though the target repositories need no code changes.

## Supported versions

Only the latest `main` revision and the currently deployed release are expected
to receive security fixes. OCR versions are pinned separately and are upgraded
only through the contract-test process described in
[`docs/deployment.md`](docs/deployment.md).

## Reporting a vulnerability

Please do not open a public issue containing exploit details, credentials,
private keys, webhook payloads, or repository source. Use GitHub's private
security advisory/contact mechanism for the repository owner. Include:

- affected commit or release;
- deployment mode (Docker or systemd);
- reproduction steps with secrets removed;
- impact and any suggested mitigation.

## Secret handling rules

Never commit or paste any of the following:

- GitHub App private keys;
- `GITHUB_WEBHOOK_SECRET`;
- `OPENCODE_GO_KEY` or another provider credential;
- production `.env`, `config.yaml`, database, or runtime workspace files;
- signed webhook payloads or bearer tokens.

Use `.env.example` and `config.example.yaml` only as templates. Keep the real
values in a secret manager, an owner-only environment file, or an equivalent
runtime secret store. The OCR child process receives only the LLM credential;
it must never receive the GitHub App private key.

## Deployment posture

- Terminate the webhook endpoint behind HTTPS.
- Validate GitHub's HMAC signature before processing a delivery.
- Keep the service's configuration and database off public mounts.
- Leave `auto_review_external_prs` disabled unless external contributor code,
  model quota, and prompt-injection risk have been explicitly accepted.
- Keep `/metrics`, `/readyz`, and administrative GitHub App permissions private
  to the deployment unless they are intentionally protected.
- Rotate any credential that appears in logs, a commit, a container layer, or a
  public issue.
