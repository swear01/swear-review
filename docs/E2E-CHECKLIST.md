# Real-World E2E Checklist

This checklist verifies the deployed GitHub App against a private test
repository. It complements the local unit/integration suite.

> **Public-repository hygiene:** deployment-specific App IDs, installation IDs,
> account names, repository names, webhook URLs, tunnel URLs, and credentials are
> intentionally omitted from this document. Fill them in only in a private
> operator copy.

## Environment

| Item | Value |
| --- | --- |
| GitHub account | private operator account |
| GitHub App | `Swear Review` |
| App ID / installation | private deployment values |
| Webhook URL | stable HTTPS `/webhooks` endpoint or temporary test tunnel |
| Service | production Docker or systemd deployment |
| LLM | configured OpenAI-compatible endpoint and model |
| OCR | pinned release from `config.yaml` |
| Test repository | private E2E repository owned by the operator |

## A. Installation and automatic review

| # | Step | Expected result |
| --- | --- | --- |
| A1 | Install the GitHub App on a test account | Installation succeeds with intended repository selection |
| A2 | Open a PR with a deliberately planted code bug | `pull_request.opened` enqueues a full review |
| A3 | Wait for completion | Check Run is created and completed |
| A4 | Inspect the OCR range | It covers merge-base → current HEAD |
| A5 | Inspect findings | Inline comments use the correct file and line |
| A6 | Inspect the summary | One sticky summary contains counts and status |

## B. Model and runtime contract

| # | Step | Expected result |
| --- | --- | --- |
| B1 | Inspect startup logs | Configured OCR version, model, and concurrency are visible |
| B2 | Inspect the OCR manifest | Requested concurrency and model match `config.yaml` |
| B3 | Inspect the Check Run | Model and OCR version are reported |
| B4 | Inspect provider traffic | The request reaches the configured endpoint; no key is logged |

## C. Re-push and deduplication

| # | Step | Expected result |
| --- | --- | --- |
| C1 | Push a second commit | The full PR is reviewed again |
| C2 | Push while a review is running | The stale run is cancelled or discarded |
| C3 | Compare summaries/comments | Duplicate findings are not reposted |
| C4 | Create enough findings to exceed one batch | Review comments are published in bounded batches |

## D. Manual commands

| Command | Expected result |
| --- | --- |
| `/swear-review full` | Full PR review is enqueued for an authorized user |
| `/swear-review incremental` | Reviews last-successful HEAD → current HEAD, or falls back to full |
| `/swear-review status` | Reports current head, review, job, gate, OCR, and model state |
| `/swear-review help` | Lists available commands |
| Same commands from a read-only user | Command is denied and no model job is created |

## E. Merge gates

Run the test repository through each mode:

- `gate.mode: off`: findings publish and the Check succeeds; merging is unaffected.
- `gate.mode: check`: configured blocking categories make the Check fail.
- `gate.mode: managed`: the App creates/updates the required-status ruleset when
  the GitHub plan and App permissions allow it.
- `gate.strategy: any`: `AI Review Gate` passes when any configured provider
  reports `success` for the current HEAD; it remains pending until then and
  fails only after every provider reaches a non-success terminal result.
- Any-provider ruleset requires only `AI Review Gate`; individual provider
  checks must not also be required.
- A provider result from an older HEAD does not satisfy the gate.
- Managed-gate permission/plan failure: review publication continues and the
  gate reports unavailable instead of killing the review.

## F. Failure and cleanup

- Provider/OCR failure produces a failed Check Run when fail-closed is enabled.
- Failed reviews do not publish fake findings or fake success.
- A newer HEAD cannot receive comments from an older review.
- `/readyz` reports the database state correctly.
- Temporary checkout/workspace directories are removed after the job.
- The private E2E repository remains private and contains no production secret.

## G. OCR `skipped` status

**Executed 2026-08-16 after the OCR adapter fix.** A docs-only PR was created in
the private E2E repository. OCR 1.9.0 returned:

```json
{
  "status": "skipped",
  "message": "Review skipped: no items were selected.",
  "summary": { "files_reviewed": 0, "comments": 0 }
}
```

Expected and observed result:

- no adapter/schema failure;
- zero findings and zero inline comments;
- sticky summary includes the skip reason;
- Check Run concludes `success`;
- the run is recorded as a successful review.

This case must remain covered by both the real fixture contract test and the
pipeline integration test. It is common for documentation-only changes and
should never block a PR as an infrastructure failure.

## Acceptance checklist

- [ ] GitHub App installed with only the permissions required by the deployment
- [ ] Webhook delivery succeeds with HMAC validation enabled
- [ ] Private E2E repository used; no secrets committed
- [ ] Automatic full review succeeds
- [ ] Inline comments, sticky summary, and Check Run are correct
- [ ] Re-push deduplication and stale protection work
- [ ] Manual commands and permission denial work
- [ ] All gate modes behave as configured
- [ ] Any-provider gate passes with one successful provider and blocks with none
- [ ] OCR failure is fail-closed
- [ ] OCR `skipped` is an empty successful review
- [ ] `/healthz`, `/readyz`, and structured logs are healthy
- [ ] Temporary test data and tunnel processes are cleaned up
