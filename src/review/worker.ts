import { mkdirSync } from 'node:fs';
import type { ServiceContext } from '../context.js';
import type { JobRecord } from '../types.js';
import type { Logger } from '../util/logger.js';
import { checkoutRepository, cleanupWorkspace, buildGitEnv } from './checkout.js';
import { runOcr, createOcrHome } from './ocr-runner.js';
import { parseOcrOutput } from './ocr-adapter.js';
import { publishReviewResult } from './publisher.js';
import { computeGateDecision } from '../gate/policy.js';
import { reconcileGateForRepository } from '../gate/managed-gate.js';
import { reconcileProviderGate } from '../gate/provider-gate.js';
import { createCheckRun, completeCheckRun, renderCheckOutputText } from '../github/checks.js';
import { upsertStickySummary } from '../github/comments.js';
import { resolveRepoConfig } from '../config/load.js';
import { ReviewError } from '../util/errors.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Review worker: claims jobs from the SQLite queue and executes them with up
 * to `workers.max_review_jobs` concurrent PR-level jobs.
 *
 * Note: this is a *service* resource cap. It is NOT a model-concurrency
 * fallback — OCR keeps its fixed `--concurrency 16`.
 */
export class Worker {
  private active = new Map<number, AbortController>();
  private pendingCancel = new Set<number>();
  private running = false;
  private stopRequested = false;

  constructor(private readonly ctx: ServiceContext) {}

  /** Called by the scheduler when a newer commit supersedes a running job. */
  requestCancel(jobId: number): void {
    const ac = this.active.get(jobId);
    if (ac) {
      ac.abort();
    } else {
      this.pendingCancel.add(jobId);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.ctx.db.recoverStaleJobs();
    void this.loop();
  }

  stop(): void {
    this.stopRequested = true;
    for (const ac of this.active.values()) ac.abort();
  }

  private async loop(): Promise<void> {
    const maxJobs = this.ctx.config.workers.max_review_jobs;
    const poll = this.ctx.config.workers.poll_interval_ms;
    while (!this.stopRequested) {
      let claimed = 0;
      while (claimed < maxJobs) {
        const job = this.ctx.db.claimNextJob(maxJobs);
        if (!job) break;
        claimed++;
        void this.processJob(job).catch((err) => {
          this.ctx.log.error({ err: (err as Error).message, jobId: job.id }, 'unhandled job processing error');
        });
      }
      await sleep(poll);
    }
  }

  private async processJob(job: JobRecord): Promise<void> {
    const log = this.ctx.log.child({
      job_id: job.id,
      installation_id: job.installation_id,
      repo: `${job.repo_owner}/${job.repo_name}`,
      pr: job.pr_number,
      head_sha: job.head_sha,
      review_mode: job.mode,
      trigger: job.trigger,
    });
    const ac = new AbortController();
    this.active.set(job.id, ac);
    let runId: number | null = null;
    let checkRunId: number | null = null;
    let workspaceDir: string | null = null;
    const startedAt = Date.now();

    try {
      // Cancellation requested before this job registered its controller.
      if (this.pendingCancel.has(job.id)) {
        this.pendingCancel.delete(job.id);
        await this.cancelJob(job, null, null, ac, 'cancelled before start', log);
        return;
      }
      // Re-check DB status — may have been superseded concurrently.
      const fresh = this.ctx.db.getJob(job.id);
      if (!fresh || fresh.status !== 'running') {
        await this.cancelJob(job, null, null, ac, 'superseded before start', log);
        return;
      }

      this.ctx.metrics.reviewsTotal.inc({ repo: `${job.repo_owner}/${job.repo_name}`, mode: job.mode });
      const resolved = resolveRepoConfig(this.ctx.config, job.repo_owner, job.repo_name);
      const octokit = await this.ctx.github.getOctokit(job.installation_id);

      // Check Run — always created (spec §22).
      checkRunId = await createCheckRun(octokit, log, {
        owner: job.repo_owner,
        repo: job.repo_name,
        headSha: job.head_sha,
        name: resolved.app.check_name,
        output: {
          title: 'Swear Review in progress',
          summary: `Reviewing ${job.mode === 'full' ? 'full PR diff' : 'incremental diff'} at ${job.head_sha.slice(0, 7)}`,
        },
      });
      this.ctx.db.setJobStatus(job.id, 'running', { checkRunId });

      runId = this.ctx.db.createRun({
        installationId: job.installation_id,
        owner: job.repo_owner,
        repo: job.repo_name,
        prNumber: job.pr_number,
        mode: job.mode,
        baseSha: job.base_sha,
        headSha: job.head_sha,
        checkRunId,
      });
      this.ctx.db.setJobStatus(job.id, 'running', { reviewRunId: runId });
      log.info({ runId }, 'review job started');

      throwIfAborted(ac.signal);

      // ---- checkout --------------------------------------------------------
      const token = await this.ctx.github.getInstallationToken(job.installation_id);
      const checkout = await checkoutRepository({
        installationToken: token,
        owner: job.repo_owner,
        repo: job.repo_name,
        baseSha: job.base_sha,
        headSha: job.head_sha,
        workspaceRoot: this.ctx.config.workers.workspace_dir,
        jobId: job.id,
        cloneUrlTemplate: this.ctx.config.workers.clone_url_template,
        partialClone: this.ctx.config.workers.partial_clone,
        log,
        signal: ac.signal,
      });
      workspaceDir = checkout.workspaceDir;
      const fromSha = job.mode === 'full' ? checkout.mergeBase : job.base_sha;
      log.info({ fromSha: fromSha.slice(0, 7), toSha: job.head_sha.slice(0, 7) }, 'checkout complete');

      throwIfAborted(ac.signal);

      // ---- OCR -------------------------------------------------------------
      const homeDir = createOcrHome(checkout.workspaceDir);
      mkdirSync(homeDir, { recursive: true });
      const proc = await runOcr({
        baseSha: fromSha,
        headSha: job.head_sha,
        concurrency: resolved.ocr.concurrency,
        timeoutMinutes: resolved.ocr.timeout_minutes,
        hardTimeoutMinutes: resolved.ocr.hard_timeout_minutes,
        binary: this.ctx.config.ocr.binary || 'ocr',
        repoDir: checkout.repoDir,
        homeDir,
        ocrEnv: {
          // OCR's git subprocesses lazy-fetch blobs in a partial clone;
          // without this auth the diff resolution fails with 0 selected files.
          ...buildGitEnv(token),
          OCR_LLM_URL: resolved.llm.url,
          OCR_LLM_TOKEN: this.ctx.opencodeKey,
          OCR_LLM_MODEL: resolved.llm.model,
          OCR_USE_ANTHROPIC: String(resolved.llm.use_anthropic),
          ...resolved.ocr.extra_env,
        },
        signal: ac.signal,
        log,
      });

      if (ac.signal.aborted || proc.killed) {
        await this.cancelJob(job, runId, checkRunId, ac, proc.timedOut ? 'timed out' : 'superseded (cancelled)', log);
        return;
      }

      let ocr;
      try {
        ocr = parseOcrOutput(proc.stdout);
      } catch (err) {
        this.ctx.metrics.ocrProcessFailures.inc({ repo: `${job.repo_owner}/${job.repo_name}` });
        throw new ReviewError('parse', (err as Error).message);
      }

      if (ocr.status === 'failed') {
        this.ctx.metrics.ocrProcessFailures.inc({ repo: `${job.repo_owner}/${job.repo_name}` });
        throw new ReviewError('ocr', `OCR review failed: ${ocr.message ?? 'unknown error'}`);
      }
      if (ocr.status === 'skipped') {
        // OCR selected no files (e.g. docs-only PR): benign empty review.
        log.info({ message: ocr.message }, 'OCR skipped (no items selected)');
      }
      if (ocr.configuredConcurrency !== undefined && ocr.configuredConcurrency !== resolved.ocr.concurrency) {
        log.warn({ ocrConcurrency: ocr.configuredConcurrency, expected: resolved.ocr.concurrency }, 'OCR reported unexpected concurrency');
      }

      const findings = ocr.comments;
      this.ctx.metrics.findingsTotal.inc({ repo: `${job.repo_owner}/${job.repo_name}` }, findings.length);
      log.info(
        {
          findingCount: findings.length,
          ocrVersion: ocr.ocrVersion ?? resolved.ocr.version,
          model: ocr.model ?? resolved.llm.model,
          elapsedMs: ocr.elapsedMs,
          coverage: ocr.coverage,
        },
        'OCR review complete',
      );

      throwIfAborted(ac.signal);

      // ---- gate --------------------------------------------------------------
      const gateDecision = computeGateDecision({
        gateMode: resolved.gate.mode,
        blockCategories: resolved.gate.block_categories,
        findings,
        reviewError: false,
        failClosedOnReviewError: resolved.gate.fail_closed_on_review_error,
      });

      if (resolved.gate.mode === 'managed' && resolved.gate.strategy !== 'any') {
        // Ruleset reconciliation must never kill the review.
        await reconcileGateForRepository(this.ctx.github, this.ctx.db, log, {
          installationId: job.installation_id,
          owner: job.repo_owner,
          repo: job.repo_name,
          gateMode: resolved.gate.mode,
          checkName: resolved.app.check_name,
          integrationId: resolved.gate.integration_id,
        }).catch((err) => log.warn({ err: (err as Error).message }, 'managed gate reconciliation failed (degraded)'));
      }

      // ---- publish -----------------------------------------------------------
      const publish = await publishReviewResult(this.ctx, {
        job,
        runId,
        ocr,
        mode: job.mode,
        gateMode: resolved.gate.mode,
        blocking: gateDecision.blocking,
        blockReason: gateDecision.reason,
        checkName: resolved.app.check_name,
      });

      if (publish.stale) {
        await this.markStale(job, runId, checkRunId, log);
        return;
      }

      const durationSec = (Date.now() - startedAt) / 1000;

      await completeCheckRun(octokit, log, {
        owner: job.repo_owner,
        repo: job.repo_name,
        checkRunId,
        conclusion: gateDecision.conclusion,
        output: {
          title: gateDecision.conclusion === 'success' ? 'Swear Review completed' : 'Swear Review failed',
          summary: gateDecision.reason,
          text: renderCheckOutputText({
            mode: job.mode === 'full' ? 'Full' : 'Incremental',
            model: ocr.model ?? resolved.llm.model,
            ocrVersion: ocr.ocrVersion ?? resolved.ocr.version,
            findingsCount: publish.totalFindings,
            durationSec,
            counts: publish.counts,
            statusLine: gateDecision.conclusion === 'success' ? 'completed' : gateDecision.conclusion,
            extra: ocr.status === 'skipped'
              ? ocr.message
              : gateDecision.blocking
                ? `Blocking categories: ${resolved.gate.block_categories.join(', ')}`
                : undefined,
          }),
        },
      });
      await this.reconcileAnyProviderGate(job, resolved, log);

      this.ctx.db.completeRun(runId, 'completed', publish.totalFindings, null, {
        ocrVersion: ocr.ocrVersion ?? resolved.ocr.version,
        model: ocr.model ?? resolved.llm.model,
      });
      this.ctx.db.setJobStatus(job.id, 'completed', { finished: true });
      this.ctx.db.setPullRequestReviewed(job.repo_owner, job.repo_name, job.pr_number, job.head_sha, job.mode, true);
      this.ctx.db.setRepositoryReviewed(job.repo_owner, job.repo_name, job.head_sha, job.mode, true);

      this.ctx.metrics.reviewsSuccess.inc({ repo: `${job.repo_owner}/${job.repo_name}`, mode: job.mode });
      this.ctx.metrics.reviewDurationSeconds.observe(durationSec, { repo: `${job.repo_owner}/${job.repo_name}` });

      log.info(
        {
          exit_status: 'success',
          duration: Math.round(durationSec),
          finding_count: publish.totalFindings,
          inline: publish.inlinePublished,
          deduped: publish.deduped,
          routed: publish.routedToSummary,
          conclusion: gateDecision.conclusion,
          ocrVersion: ocr.ocrVersion ?? resolved.ocr.version,
          model: ocr.model ?? resolved.llm.model,
        },
        'review completed',
      );
    } catch (err) {
      if (ac.signal.aborted) {
        await this.cancelJob(job, runId, checkRunId, ac, 'superseded (cancelled)', log);
        return;
      }
      await this.failJob(job, runId, checkRunId, err as Error, log, startedAt);
    } finally {
      if (workspaceDir) cleanupWorkspace(workspaceDir);
      this.active.delete(job.id);
      this.pendingCancel.delete(job.id);
    }
  }

  private async cancelJob(job: JobRecord, runId: number | null, checkRunId: number | null, ac: AbortController, reason: string, log: Logger): Promise<void> {
    void ac;
    const duration = 0;
    if (runId != null) this.ctx.db.completeRun(runId, 'cancelled', 0, reason);
    if (checkRunId != null) {
      try {
        const octokit = await this.ctx.github.getOctokit(job.installation_id);
        await completeCheckRun(octokit, log, {
          owner: job.repo_owner,
          repo: job.repo_name,
          checkRunId,
          conclusion: 'cancelled',
          output: { title: 'Swear Review cancelled', summary: reason },
        });
      } catch {
        /* best-effort */
      }
    }
    this.ctx.db.setJobStatus(job.id, 'cancelled', { finished: true });
    this.ctx.metrics.reviewsCancelled.inc({ repo: `${job.repo_owner}/${job.repo_name}` });
    log.info({ reason, duration }, 'review job cancelled');
  }

  private async markStale(job: JobRecord, runId: number | null, checkRunId: number | null, log: Logger): Promise<void> {
    if (runId != null) this.ctx.db.completeRun(runId, 'stale', 0, 'head sha changed before publication');
    if (checkRunId != null) {
      try {
        const octokit = await this.ctx.github.getOctokit(job.installation_id);
        await completeCheckRun(octokit, log, {
          owner: job.repo_owner,
          repo: job.repo_name,
          checkRunId,
          conclusion: 'cancelled',
          output: { title: 'Swear Review superseded', summary: 'A newer commit was pushed; this review result was discarded.' },
        });
        await upsertStickySummary(octokit, log, {
          owner: job.repo_owner,
          repo: job.repo_name,
          prNumber: job.pr_number,
          body: `Mode: ${job.mode === 'full' ? 'Full PR' : 'Incremental'}\nCommit: ${job.head_sha.slice(0, 7)}\n\nStatus: ❌ Superseded — a newer commit was pushed before this review finished.`,
        }).catch(() => undefined);
      } catch {
        /* best-effort */
      }
    }
    this.ctx.db.setJobStatus(job.id, 'cancelled', { finished: true });
    this.ctx.metrics.reviewsCancelled.inc({ repo: `${job.repo_owner}/${job.repo_name}` });
    log.info({}, 'stale review discarded');
  }

  private async reconcileAnyProviderGate(job: JobRecord, resolved: ReturnType<typeof resolveRepoConfig>, log: Logger): Promise<void> {
    if (resolved.gate.mode === 'off' || resolved.gate.strategy !== 'any') return;
    try {
      const octokit = await this.ctx.github.getOctokit(job.installation_id);
      await reconcileProviderGate(octokit, this.ctx.db, log, {
        owner: job.repo_owner,
        repo: job.repo_name,
        prNumber: job.pr_number,
        headSha: job.head_sha,
        checkName: resolved.gate.check_name,
        providers: resolved.gate.providers,
      });
    } catch (gateErr) {
      log.warn({ err: (gateErr as Error).message }, 'provider gate refresh failed');
    }

    if (resolved.gate.mode === 'managed') {
      try {
        await reconcileGateForRepository(this.ctx.github, this.ctx.db, log, {
          installationId: job.installation_id,
          owner: job.repo_owner,
          repo: job.repo_name,
          gateMode: resolved.gate.mode,
          checkName: resolved.gate.check_name,
          integrationId: resolved.gate.integration_id,
        });
      } catch (gateErr) {
        log.warn({ err: (gateErr as Error).message }, 'managed gate refresh failed');
      }
    }
  }

  private async failJob(job: JobRecord, runId: number | null, checkRunId: number | null, err: Error, log: Logger, startedAt: number): Promise<void> {
    const duration = (Date.now() - startedAt) / 1000;
    const kind = err instanceof ReviewError ? err.kind : 'unknown';
    if (kind === 'ocr' || kind === 'parse') {
      this.ctx.metrics.ocrProcessFailures.inc({ repo: `${job.repo_owner}/${job.repo_name}` });
    }
    const resolved = resolveRepoConfig(this.ctx.config, job.repo_owner, job.repo_name);
    const failClosed = resolved.gate.fail_closed_on_review_error;

    if (runId != null) {
      this.ctx.db.completeRun(runId, 'failed', 0, err.message.slice(0, 2000));
    }
    if (checkRunId != null) {
      try {
        const octokit = await this.ctx.github.getOctokit(job.installation_id);
        await completeCheckRun(octokit, log, {
          owner: job.repo_owner,
          repo: job.repo_name,
          checkRunId,
          conclusion: failClosed ? 'failure' : 'neutral',
          output: {
            title: 'Swear Review failed',
            summary: 'Review infrastructure/model failure',
            text: `Mode: ${job.mode}\nModel: ${resolved.llm.model}\nOCR: ${resolved.ocr.version}\n\nReview failed (${kind}): ${err.message.slice(0, 2000)}`,
          },
        });
        await upsertStickySummary(octokit, log, {
          owner: job.repo_owner,
          repo: job.repo_name,
          prNumber: job.pr_number,
          body: `Mode: ${job.mode === 'full' ? 'Full PR' : 'Incremental'}\nModel: ${resolved.llm.model}\nOCR: ${resolved.ocr.version}\n\nStatus: ❌ Failed — review infrastructure/model failure.\nReason: ${err.message.slice(0, 500)}\n\nYou can retry with \`/swear-review full\`.`,
        }).catch(() => undefined);
      } catch {
        /* best-effort */
      }
    }
    await this.reconcileAnyProviderGate(job, resolved, log);
    this.ctx.db.setJobStatus(job.id, 'failed', { finished: true });
    this.ctx.metrics.reviewsFailed.inc({ repo: `${job.repo_owner}/${job.repo_name}`, kind });
    log.error(
      { exit_status: 'failure', duration: Math.round(duration), kind, err: err.message.slice(0, 500) },
      'review job failed',
    );
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ReviewError('unknown', 'aborted');
}
