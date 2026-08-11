import type { ServiceContext } from '../context.js';
import { ReviewQueue } from './queue.js';
import { resolveRepoConfig } from '../config/load.js';
import { parseSwearCommand, isAllowedRole } from '../commands/parser.js';
import { postReply } from '../github/comments.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WebhookPayload = any;

/**
 * Ingests GitHub webhook events and translates them into review jobs.
 * All policy decisions (drafts, external PRs, triggers, auto on/off) live here.
 */
export class Scheduler {
  private readonly queue: ReviewQueue;

  constructor(private readonly ctx: ServiceContext) {
    this.queue = new ReviewQueue(ctx.db);
  }

  /** Entry point for verified webhook events. */
  async handleEvent(eventName: string, payload: WebhookPayload): Promise<void> {
    switch (eventName) {
      case 'pull_request':
        return this.onPullRequest(payload);
      case 'issue_comment':
        return this.onIssueComment(payload);
      case 'check_run':
        return this.onCheckRun(payload);
      case 'installation':
        return this.onInstallation(payload);
      case 'installation_repositories':
        return this.onInstallationRepositories(payload);
      case 'repository':
        return this.onRepository(payload);
      default:
        this.ctx.log.debug({ eventName }, 'ignoring unsubscribed webhook event');
    }
  }

  // ---- pull_request ----------------------------------------------------------

  private async onPullRequest(payload: WebhookPayload): Promise<void> {
    const action: string = payload.action;
    const config = this.ctx.config;
    const trigger = config.review.triggers[action as keyof typeof config.review.triggers];
    if (!trigger) {
      this.ctx.log.debug({ action }, 'ignoring pull_request action');
      return;
    }

    const repo = payload.repository;
    const pr = payload.pull_request;
    const installationId: number = payload.installation?.id;
    if (!installationId) {
      this.ctx.log.warn({ action }, 'missing installation id; ignoring');
      return;
    }
    const owner: string = repo.owner.login;
    const name: string = repo.name;
    const prNumber: number = pr.number;
    const headSha: string = pr.head.sha;
    const baseSha: string = pr.base.sha;
    const draft: boolean = !!pr.draft;

    // Real pull_request payloads may omit installation.account (only id/node_id).
    const instAccount = payload.installation?.account;
    this.ctx.db.upsertInstallation(
      installationId,
      instAccount?.login ?? owner,
      instAccount?.type ?? 'User',
    );
    this.ctx.db.upsertRepository(owner, name, installationId, !!repo.private, repo.default_branch);
    this.ctx.db.upsertPullRequest(owner, name, prNumber, headSha, baseSha, draft, pr.state);

    const resolved = resolveRepoConfig(config, owner, name);

    if (draft && !resolved.review.review_drafts) {
      this.ctx.log.info({ repo: `${owner}/${name}`, pr: prNumber }, 'draft PR: auto review off');
      return;
    }

    if (!resolved.review.auto) {
      this.ctx.log.info({ repo: `${owner}/${name}`, pr: prNumber }, 'auto review disabled for repository');
      return;
    }

    // Public repo abuse protection: auto review only trusted collaborators.
    if (!repo.private && !resolved.security.auto_review_external_prs) {
      const octokit = await this.ctx.github.getOctokit(installationId);
      const permission = await this.getPermission(octokit, owner, name, pr.user.login);
      if (!isAllowedRole(permission)) {
        this.ctx.log.info(
          { repo: `${owner}/${name}`, pr: prNumber, author: pr.user.login, permission },
          'external PR author lacks write permission; auto review skipped (manual /swear-review allowed)',
        );
        return;
      }
    }

    const { jobId, cancelledRunningJobIds } = this.queue.enqueue({
      installationId,
      owner,
      repo: name,
      prNumber,
      baseSha,
      headSha,
      mode: 'full',
      trigger: action,
    });
    this.ctx.metrics.jobsSuperseded.inc({ repo: `${owner}/${name}` }, cancelledRunningJobIds.length > 0 ? 1 : 0);
    for (const id of cancelledRunningJobIds) this.ctx.worker?.requestCancel(id);
    this.ctx.log.info({ jobId, repo: `${owner}/${name}`, pr: prNumber, headSha: headSha.slice(0, 7), action }, 'auto review job enqueued (full)');
  }

  // ---- issue_comment ---------------------------------------------------------

  private async onIssueComment(payload: WebhookPayload): Promise<void> {
    if (payload.action !== 'created') return;
    const issue = payload.issue;
    // Only PR conversations (comments on issues are not PRs).
    if (!issue?.pull_request) return;

    const comment = payload.comment;
    const command = parseSwearCommand(comment.body ?? '');
    if (command.kind === 'none') return;

    const repo = payload.repository;
    const installationId: number = payload.installation?.id;
    if (!installationId) return;
    const owner: string = repo.owner.login;
    const name: string = repo.name;
    const prNumber: number = issue.number;

    this.ctx.db.upsertInstallation(installationId, payload.installation.account?.login ?? owner, payload.installation.account?.type ?? 'User');
    this.ctx.db.upsertRepository(owner, name, installationId, !!repo.private, repo.default_branch);
    this.ctx.metrics.commandsReceived.inc({ repo: `${owner}/${name}`, command: command.kind });

    const octokit = await this.ctx.github.getOctokit(installationId);
    const permission = await this.getPermission(octokit, owner, name, comment.user.login);
    if (!isAllowedRole(permission)) {
      this.ctx.metrics.commandsDenied.inc({ repo: `${owner}/${name}` });
      this.ctx.log.info({ repo: `${owner}/${name}`, pr: prNumber, author: comment.user.login, permission }, 'manual command denied');
      await postReply(octokit, this.ctx.log, {
        owner,
        repo: name,
        prNumber,
        body: 'Swear Review: you do not have permission to trigger reviews (requires write/admin/maintain).',
      });
      return;
    }

    const pr = await octokit.rest.pulls.get({ owner, repo: name, pull_number: prNumber });
    if (pr.data.state !== 'open') {
      await postReply(octokit, this.ctx.log, { owner, repo: name, prNumber, body: 'Swear Review: PR is not open.' });
      return;
    }
    const headSha: string = pr.data.head.sha;
    const baseSha: string = pr.data.base.sha;
    this.ctx.db.upsertPullRequest(owner, name, prNumber, headSha, baseSha, !!pr.data.draft, pr.data.state);

    switch (command.kind) {
      case 'full':
      case 'help': {
        const { jobId, cancelledRunningJobIds } = this.queue.enqueue({
          installationId,
          owner,
          repo: name,
          prNumber,
          baseSha,
          headSha,
          mode: 'full',
          trigger: 'manual',
        });
        for (const id of cancelledRunningJobIds) this.ctx.worker?.requestCancel(id);
        await postReply(octokit, this.ctx.log, {
          owner,
          repo: name,
          prNumber,
          body: command.kind === 'help'
            ? 'Swear Review: usage\n- `/swear-review` / `/swear-review full` — full PR review\n- `/swear-review incremental` — review only new commits since last successful review\n- `/swear-review status` — current review state'
            : `Swear Review: full review queued (job #${jobId}).`,
        });
        break;
      }
      case 'incremental': {
        const last = this.ctx.db.getPullRequest(owner, name, prNumber)?.last_successful_review_sha ?? null;
        if (!last || last === headSha) {
          const { jobId, cancelledRunningJobIds } = this.queue.enqueue({
            installationId, owner, repo: name, prNumber, baseSha, headSha, mode: 'full', trigger: 'manual-incremental-fallback',
          });
          for (const id of cancelledRunningJobIds) this.ctx.worker?.requestCancel(id);
          await postReply(octokit, this.ctx.log, {
            owner, repo: name, prNumber,
            body: last
              ? `Swear Review: HEAD already reviewed (${headSha.slice(0, 7)}); no incremental review needed.`
              : `Swear Review: no prior successful review found; falling back to full review (job #${jobId}).`,
          });
          break;
        }
        const { jobId, cancelledRunningJobIds } = this.queue.enqueue({
          installationId, owner, repo: name, prNumber, baseSha: last, headSha, mode: 'incremental', trigger: 'manual-incremental',
        });
        for (const id of cancelledRunningJobIds) this.ctx.worker?.requestCancel(id);
        await postReply(octokit, this.ctx.log, {
          owner, repo: name, prNumber,
          body: `Swear Review: incremental review queued (${last.slice(0, 7)} → ${headSha.slice(0, 7)}, job #${jobId}).`,
        });
        break;
      }
      case 'status': {
        const prRow = this.ctx.db.getPullRequest(owner, name, prNumber);
        const latestJob = this.ctx.db.getLatestJob(owner, name, prNumber);
        const repoState = this.ctx.db.getRepositoryState(owner, name);
        const resolved = resolveRepoConfig(this.ctx.config, owner, name);
        const lines = [
          'Swear Review — status',
          '',
          `Current head SHA: \`${headSha.slice(0, 7)}\``,
          `Last reviewed SHA: ${prRow?.last_reviewed_sha ? `\`${prRow.last_reviewed_sha.slice(0, 7)}\`` : '—'}`,
          `Last successful full review: ${prRow?.last_full_review_sha ? `\`${prRow.last_full_review_sha.slice(0, 7)}\`` : '—'}`,
          `Last successful review (any): ${prRow?.last_successful_review_sha ? `\`${prRow.last_successful_review_sha.slice(0, 7)}\`` : '—'}`,
          `Current job status: ${latestJob?.status ?? 'none'}`,
          `Gate mode: ${resolved.gate.mode}${repoState.ruleset_state !== 'unmanaged' ? ` (ruleset: ${repoState.ruleset_state})` : ''}`,
          `OCR version: ${resolved.ocr.version}`,
          `Concurrency: ${resolved.ocr.concurrency}`,
          `Model: ${resolved.llm.model}`,
        ];
        await postReply(octokit, this.ctx.log, { owner, repo: name, prNumber, body: lines.join('\n') });
        break;
      }
      default:
        break;
    }
  }

  // ---- check_run ---------------------------------------------------------------

  private async onCheckRun(payload: WebhookPayload): Promise<void> {
    if (payload.action !== 'rerequested') return;
    const checkRun = payload.check_run;
    if (!checkRun || checkRun.name !== this.ctx.config.app.check_name) return;
    const job = this.ctx.db.getJobByCheckRunId(checkRun.id);
    if (!job) {
      this.ctx.log.info({ checkRunId: checkRun.id }, 'no job found for re-requested check run');
      return;
    }
    const { jobId, cancelledRunningJobIds } = this.queue.enqueue({
      installationId: job.installation_id,
      owner: job.repo_owner,
      repo: job.repo_name,
      prNumber: job.pr_number,
      baseSha: job.base_sha,
      headSha: job.head_sha,
      mode: 'full',
      trigger: 'check_run.rerequested',
    });
    for (const id of cancelledRunningJobIds) this.ctx.worker?.requestCancel(id);
    this.ctx.log.info({ jobId, repo: `${job.repo_owner}/${job.repo_name}`, pr: job.pr_number }, 're-review enqueued from check run UI');
  }

  // ---- installation / repository events ------------------------------------------

  private onInstallation(payload: WebhookPayload): void {
    const installation = payload.installation;
    const id: number = installation.id;
    const login: string = installation.account?.login ?? 'unknown';
    const type: string = installation.account?.type ?? 'unknown';
    if (payload.action === 'deleted' || payload.action === 'removed') {
      this.ctx.db.removeInstallation(id);
      this.ctx.log.info({ installationId: id }, 'installation removed');
      return;
    }
    this.ctx.db.upsertInstallation(id, login, type);
    this.ctx.log.info({ installationId: id, login, type }, 'installation upserted');
  }

  private onInstallationRepositories(payload: WebhookPayload): void {
    const installationId: number = payload.installation?.id;
    if (!installationId) return;
    for (const r of payload.repositories ?? []) {
      const [owner, name] = (r.full_name ?? '').split('/');
      if (!owner || !name) continue;
      if (payload.action === 'removed') {
        this.ctx.db.removeRepository(owner, name);
        continue;
      }
      this.ctx.db.upsertRepository(owner, name, installationId, !!r.private, r.default_branch);
    }
  }

  private onRepository(payload: WebhookPayload): void {
    const r = payload.repository;
    const installationId: number = payload.installation?.id;
    if (!r || !installationId) return;
    const [owner, name] = (r.full_name ?? '').split('/');
    if (!owner || !name) return;
    this.ctx.db.upsertRepository(owner, name, installationId, !!r.private, r.default_branch);
  }

  // ---- helpers --------------------------------------------------------------------

  private async getPermission(
    octokit: Awaited<ReturnType<ServiceContext['github']['getOctokit']>>,
    owner: string,
    repo: string,
    username: string,
  ): Promise<string | undefined> {
    try {
      const res = await octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username });
      return res.data.permission;
    } catch (err) {
      this.ctx.log.warn({ err: (err as Error).message, owner, repo, username }, 'permission check failed');
      return undefined;
    }
  }
}
