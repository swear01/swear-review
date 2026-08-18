# Contributing

Thanks for improving Swear Review. The project intentionally keeps the GitHub
integration small and delegates review intelligence to OCR.

## Local setup

```bash
npm ci
npm test
npm run typecheck
npm run build
```

Install OCR separately only when running a real review locally:

```bash
npm install -g @alibaba-group/open-code-review@1.9.0
```

Use fake GitHub/OCR helpers for tests. Never use a production GitHub App key or
provider credential in a test fixture.

## Change boundaries

- Keep repository-specific configuration out of target repositories.
- Keep secrets in environment variables or a secret manager.
- Preserve HMAC verification, stale-HEAD protection, deduplication, and
  fail-closed error handling.
- Treat OCR JSON as an external contract. A version upgrade needs a real output
  fixture and adapter tests for every relevant terminal status.
- A docs-only OCR result with `status: skipped` is a successful empty review;
  do not turn it back into a failure.

## Pull requests

Before opening a PR:

- run `npm test`, `npm run typecheck`, and `npm run build`;
- run the Docker verification workflow when Docker or deployment files change;
- check `git status` and confirm no `.env`, PEM, database, or runtime data is
  included;
- explain configuration, permission, webhook, or migration changes;
- update the relevant README or `docs/` guide.

For OCR changes, include the captured JSON fixture and explain how the new
status or field is handled. For security issues, follow [`SECURITY.md`](SECURITY.md)
instead of opening a public issue with exploit details.
