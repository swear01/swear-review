# Swear Review — Real-World E2E Checklist

> ## ⚠️ STATUS: NOT YET EXECUTED
>
> This checklist has **not** been run against a real GitHub repository. Production
> E2E is **not verified** until every item below is executed with the **real
> GitHub App installed** and a **real OpenCode Go key**, and this file is updated
> with results + dates.
>
> Anything in the automated suite that already passes (unit / integration /
> Docker verification) is marked `(auto: PASS)` for reference — it does **not**
> substitute for the real-world run.

## Prerequisites

| # | Item | Value | Status |
| --- | --- | --- | --- |
| P1 | GitHub App created (permissions + webhooks per README) | app id, webhook secret | ☐ |
| P2 | App installed on the **test** repository (`<owner>/swear-review-e2e`), All repositories or explicit | — | ☐ |
| P3 | Server running (Docker or from source) with real `OPENCODE_GO_KEY` | healthz/readyz OK | ☐ |
| P4 | `ocr` v1.9.0 on PATH (or `OCR_BIN`) | `ocr version` shows 1.9.0 | ☐ |
| P5 | Test repo cloned locally, `main` + feature branch | — | ☐ |

## Checklist

Legend: **Result** = ✅ PASS / ❌ FAIL / ⚠️ PARTIAL — plus a note and date for each row.

### A. Installation & auto review

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| A1 | Install app on test repo (personal account) | App appears in repo settings → GitHub Apps; **no files modified in target repo** | ☐ |
| A2 | Open a PR from `feature` → `main` containing an **intentional bug** (e.g. out-of-bounds array index, missing null check) | Webhook received (`pull_request.opened`) — server log shows `review job enqueued (full)`; Check Run `Swear Review` appears **in_progress** | ☐ |
| A3 | Wait for review to finish | Check Run completes; sticky **Swear Review Summary** comment appears on the PR conversation | ☐ |
| A4 | Verify **automatic FULL PR review** | Summary says `Mode: Full PR`; server log `review_mode: "full"`; DB `review_runs.mode = 'full'` | ☐ |
| A5 | Verify **native inline review comments** | Bug finding appears as a real inline PR review comment on the exact code line (not a plain comment) | ☐ |
| A6 | Verify **sticky summary** content | `Mode / Model: DeepSeek V4 Flash / OCR: v1.9.0 / Commit: <head> / N findings total / M inline comments / Status: ✅ Completed`; marker `<!-- swear-review-summary -->` present | ☐ |

### B. DeepSeek V4 Flash + concurrency 16 actually used

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| B1 | Server started with `OPENCODE_GO_KEY` set | Startup log: `"ocr":"1.9.0","model":"deepseek-v4-flash","concurrency":16` | ☐ |
| B2 | Check Run / summary output | Check output text contains `Model: deepseek-v4-flash`, `OCR: v1.9.0` | ☐ |
| B3 | OCR invocation proof | Server debug log (`LOG_LEVEL=debug`) shows `[mock-ocr]`-style line? No — for real runs: OCR manifest in `review_runs.ocr_version`; DB `review_runs.model = 'deepseek-v4-flash'`; `configured_concurrency` recorded = **16** | ☐ |
| B4 | Confirm the LLM provider is OpenCode Go | `OCR_LLM_URL=https://opencode.ai/zen/go/v1/chat/completions` is what the server passes (config `llm.url`); optionally check OpenCode dashboard usage for `deepseek-v4-flash` requests during the review | ☐ |

> Concurrency 16 is additionally covered by the automated pipeline test
> (Test F: `--concurrency 16` asserted on the OCR invocation) `(auto: PASS)`.

### C. Push again — full re-review + no spam

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| C1 | Push a second commit to the PR branch | `pull_request.synchronize` → new job; **ENTIRE PR re-reviewed** (`Mode: Full PR` again, new run row) | ☐ |
| C2 | Stale protection | If a review was still running when the push landed, its Check Run shows `cancelled`/superseded; its findings are **not** published (DB `review_runs.status = 'stale'` allowed) | ☐ |
| C3 | Duplicate suppression | The same bug finding is **not** re-posted as a new inline comment (fingerprint/location dedup); summary is **updated in place**, not duplicated | ☐ |
| C4 | Comment batching | If > 50 findings: multiple review batches (`batch 1/2`…); no single create-review with > 50 comments | ☐ |

### D. Manual commands

| # | Command | Expected | Result |
| --- | --- | --- | --- |
| D1 | `/swear-review full` (as OWNER/ADMIN/MAINTAIN/WRITE) | Full review queued; ack comment; new run `mode=full, trigger=manual` | ☐ |
| D2 | `/swear-review incremental` after a prior success | Only `last successful SHA → HEAD` reviewed (`Mode: Incremental`, base = last SHA) | ☐ |
| D3 | `/swear-review incremental` with no prior success | Falls back to full; ack explains fallback | ☐ |
| D4 | `/swear-review status` | Shows: current head, last reviewed, last successful full, job status, gate mode, OCR version, model | ☐ |
| D5 | `/swear-review` from a `read`/`none` user (public repo) | Denied; no job enqueued; denial reply; **no LLM spend** | ☐ |

### E. Merge gates

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| E1 | **gate=off** (default): PR with a bug finding | Inline comment posted; Check Run **success**; merge **unaffected** | ☐ |
| E2 | **gate=check** (config `gate.mode: check`): bug finding | Check Run **failure**; no ruleset changes; if user manually requires the check → merge blocked | ☐ |
| E3 | **gate=managed** (per-repo override) | Ruleset `Swear Review` created on the repo (Settings → Rules); bug/security finding → Check failure → **merge blocked** ("Required check \"Swear Review\" has failed") | ☐ |
| E4 | gate=managed, no bug/security findings | Check success → merge allowed | ☐ |
| E5 | Private repo + free plan (if applicable) | Ruleset API 403/404 → gate degrades gracefully: review + Check + comments still work; `/swear-review status` shows `ruleset: unavailable` | ☐ |

### F. Failure & cleanup

| # | Step | Expected | Result |
| --- | --- | --- | --- |
| F1 | Stop OpenCode access (bad key) and re-review | Check Run **failure** (fail-closed); summary `Status: ❌ Failed — review infrastructure/model failure`; no fake success | ☐ |
| F2 | `/swear-review status` after everything | Job status reflects last run; gate mode correct | ☐ |
| F3 | Cleanup | Remove test repo ruleset (if managed), uninstall app or keep — documented | ☐ |

## How to inspect state during the run

```bash
# server logs (structured JSON)
docker logs -f swear-review | jq 'select(.msg | contains("review"))'

# DB state (inside container or host)
sqlite3 /data/swear-review.db \
  "SELECT id, mode, base_sha, head_sha, status, finding_count, ocr_version, model
   FROM review_runs ORDER BY id DESC LIMIT 5;"
sqlite3 /data/swear-review.db \
  "SELECT path, start_line, end_line, category, severity, publish_state FROM findings ORDER BY id DESC LIMIT 10;"
```

## Acceptance gate

- [ ] **Every** checklist item above has a ✅ (or documented ⚠️ with a concrete reason).
- [ ] The test PR shows: inline comment on the buggy line, sticky summary, Check Run.
- [ ] A second push produced a second **full** review without duplicate comments.
- [ ] `gate=managed` blocked a merge on a bug/security finding (or the plan limitation was confirmed and documented).
- [ ] This file's status banner is updated to **EXECUTED** with the run date and test repo.
