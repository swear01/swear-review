# Swear Review — Real-World E2E Checklist

> ## ✅ STATUS: EXECUTED
>
> **Executed 2026-08-11** against the real GitHub App (`swear-review`, App ID APP_ID_REDACTED,
> installed on personal account `example-owner`) with the real OpenCode Go credential and
> real `deepseek-v4-flash` traffic. Test repository: `example-owner/swear-review-e2e` (private).
>
> Results below are from live observations (service structured logs, GitHub API,
> GitHub UI). Automated-suite items are marked `(auto: PASS)` where the unit /
> integration / Docker suites already cover them.

## Environment used

| Item | Value |
| --- | --- |
| GitHub account | `example-owner` |
| GitHub App name / slug | Swear Review / `swear-review` |
| App ID | APP_ID_REDACTED |
| Installation | INSTALLATION_ID_REDACTED → `repository_selection: all` (after E2E) |
| Webhook URL | `https://your-server.example.com/webhooks` (Cloudflare quick tunnel → local Docker service) |
| Service | production Docker image (`node:24-trixie-slim`, git 2.47.3, OCR 1.9.0) |
| LLM | OpenCode Go `https://opencode.ai/zen/go/v1/chat/completions` · `deepseek-v4-flash` |
| Config | `gate: off` global; `gate: managed` for `example-owner/swear-review-e2e` during the gate test |

## Checklist results

### A. Installation & auto review

| # | Step | Result |
| --- | --- | --- |
| A1 | App installed on personal account | ✅ `repository_selection: all`; no target-repo files |
| A2 | PR with intentional bugs triggers auto review | ✅ `pull_request.synchronize` → `auto review job enqueued (full)` |
| A3 | Review completes | ✅ Check Run `Swear Review` created + completed |
| A4 | Automatic review is FULL PR | ✅ `review_mode: "full"`, OCR range = merge-base `e1996cf` → head |
| A5 | Native inline review comments | ✅ 5–7 `swear-review[bot]` inline comments per review, correct path/line |
| A6 | Sticky summary | ✅ single comment (id 5250764404) updated in place: Mode/Model/OCR/Commit/counts/Status |

### B. Model + concurrency actually used

| # | Item | Result |
| --- | --- | --- |
| B1 | Startup log | ✅ `"ocr":"1.9.0","model":"deepseek-v4-flash","concurrency":16` |
| B2 | OCR invocation concurrency | ✅ `configured_concurrency: 16` in OCR manifest (real run) |
| B3 | Model confirmed | ✅ `model: deepseek-v4-flash` in every review run + Check output |
| B4 | Endpoint | ✅ OpenCode Go `https://opencode.ai/zen/go/v1/chat/completions` (HTTP 200 smoke test + real OCR runs) |

### C. Push again — full re-review + no spam

| # | Item | Result |
| --- | --- | --- |
| C1 | Second push → entire PR re-reviewed | ✅ `review_mode: full`, full merge-base range each time |
| C2 | Stale protection | ✅ live: mid-review push cancelled the running review (`review job cancelled`, run `cancelled`); no stale comments |
| C3 | Duplicate suppression | ✅ second full review: `deduped: 4–5, inlinePublished: 1` (only genuinely new findings posted) |
| C4 | Comment batching | ✅ single batch used (`batch 1/1`); batching code path covered by unit/integration tests |

### D. Manual commands

| # | Command | Result |
| --- | --- | --- |
| D1 | `/swear-review full` | ✅ `trigger: manual`, full review, deduped: 5, no duplicates |
| D2 | `/swear-review incremental` | ✅ `trigger: manual-incremental`, range `9304b02 (last success) → 716a252 (HEAD)` |
| D3 | `/swear-review incremental` fallback | ✅ code path covered by integration test (`manual-incremental-fallback`) |
| D4 | `/swear-review status` | ✅ full state reply: head/last-reviewed/last-successful/job/gate/OCR/model |
| D5 | Permission denial | ✅ integration test `(auto: PASS)` — no external account created (would need a second GitHub account) |

### E. Merge gates

| # | Item | Result |
| --- | --- | --- |
| E1 | gate=off with bug findings | ✅ Check **success** ("Review completed with N finding(s); gate mode is off"), merge unaffected |
| E2 | gate=check | ✅ same conclusion logic; no ruleset changes `(auto: PASS)` |
| E3 | gate=managed with bug findings | ✅ ruleset `Swear Review` created (id 20686471, active, `~DEFAULT_BRANCH`, required status check `Swear Review`); Check **failure** ("5 blocking finding(s) (bug)"); PR `mergeable_state: "blocked"` |
| E4 | gate=managed, no blocking findings | ✅ `(auto: PASS)` — computeGateDecision unit test |
| E5 | Plan limitation degradation | ✅ code path handled (403/404 → `unavailable`, review continues) `(auto: PASS)`; account plan allowed rulesets |

### F. Failure & cleanup

| # | Item | Result |
| --- | --- | --- |
| F1 | OCR/provider failure → fail-closed | ✅ `(auto: PASS)` integration test: Check failure, summary `Status: ❌ Failed`, no fake success |
| F2 | Status after everything | ✅ `/swear-review status` reflects last run |
| F3 | Cleanup | ✅ test repo left private + intact; secrets removed from temp dirs; `.e2e/` gitignored |

## Real OCR quality (baseline, untuned)

Planted bugs in `src/calc.ts` / `src/extra.ts`:

| Bug | Caught? | Category | Positioning |
| --- | --- | --- | --- |
| `average`: `total / values.length - 1` (operator precedence) | ✅ (most runs) | bug/high | exact line |
| `firstOrNull` returns `values[1]` instead of `values[0]` | ⚠️ caught in some runs, missed in others | bug/high | — |
| `clamp` ignores `min` bound | ⚠️ caught in the pre-E2E probe, missed in later runs | bug/high | — |
| `indexOfFirstPositive`: `>= 0` instead of `> 0` | ✅ consistently | bug/high | exact line |
| `firstPositive`: `>= 0` boundary | ✅ | bug/high | exact line |
| `latestOrNull`: `items[length - 2]` | ✅ | bug/high | exact line |
| `isEven`: `n % 2 === 1` inverted logic | ✅ | bug/high | exact line + range |
| `toSlug`: no space→hyphen replacement | ✅ | bug/high | exact line |

- Latency per full PR review: ~56–123 s for a 2–3 file PR (LLM-dominated).
- No 429 / rate-limit / provider errors observed across all runs (OCR internal retry never needed).
- LLM output is non-deterministic: finding sets and wording vary between runs (dedup handles this via location+category).

## Production E2E acceptance

- [x] Real GitHub App exists under the personal account (id APP_ID_REDACTED)
- [x] Real App installed; installation targets **All repositories**
- [x] Real webhook delivery succeeds (30/30 → HTTP 200); HMAC validation enabled
- [x] Real OpenCode Go credential loaded; never committed/exposed
- [x] Real `deepseek-v4-flash` request succeeds (HTTP 200 smoke + real OCR runs)
- [x] Real private test repo + PR created
- [x] PR event triggers automatic review; automatic review is FULL PR
- [x] OCR real invocation uses concurrency 16; OCR 1.9.0; model deepseek-v4-flash
- [x] Native inline PR review comments, sticky summary, Check Run
- [x] Second push → another FULL PR review; publication dedup works; stale protection works
- [x] `/swear-review status|full|incremental` work
- [x] gate=off works; gate=managed works (ruleset + failed required check + merge blocked)
- [x] Full regression suite green (62 tests), TypeScript clean, Docker build + smoke pass
- [x] Test repository left available for inspection
