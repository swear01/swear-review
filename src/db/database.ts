import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './migrations.js';
import type { JobRecord, JobStatus, RunRecord, RunStatus, ReviewMode } from '../types.js';

/**
 * Thin persistence layer on top of node:sqlite (synchronous — safe for the
 * single-process worker model).
 */
export class Database {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    const existing = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
      .get();
    let version = 0;
    if (existing) {
      version = (this.db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v;
    }
    for (let i = version; i < MIGRATIONS.length; i++) {
      this.db.exec(MIGRATIONS[i]!);
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- installations / repositories --------------------------------------

  upsertInstallation(id: number, login: string, type: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO installations (id, account_login, account_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET account_login=excluded.account_login, account_type=excluded.account_type, updated_at=excluded.updated_at`
      )
      .run(id, login, type, now, now);
  }

  removeInstallation(id: number): void {
    this.db.prepare('DELETE FROM installations WHERE id = ?').run(id);
  }

  upsertRepository(owner: string, name: string, installationId: number, isPrivate: boolean, defaultBranch?: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO repositories (owner, name, installation_id, private, default_branch, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner, name) DO UPDATE SET
           installation_id=excluded.installation_id,
           private=excluded.private,
           default_branch=excluded.default_branch,
           updated_at=excluded.updated_at`
      )
      .run(owner, name, installationId, isPrivate ? 1 : 0, defaultBranch ?? null, now, now);
  }

  removeRepository(owner: string, name: string): void {
    this.db.prepare('DELETE FROM repositories WHERE owner = ? AND name = ?').run(owner, name);
  }

  // ---- pull requests -------------------------------------------------------

  upsertPullRequest(
    owner: string,
    name: string,
    prNumber: number,
    headSha: string,
    baseSha: string,
    draft: boolean,
    state: string,
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO pull_requests (repo_owner, repo_name, pr_number, head_sha, base_sha, draft, state, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_owner, repo_name, pr_number) DO UPDATE SET
           head_sha=excluded.head_sha,
           base_sha=excluded.base_sha,
           draft=excluded.draft,
           state=excluded.state,
           updated_at=excluded.updated_at`
      )
      .run(owner, name, prNumber, headSha, baseSha, draft ? 1 : 0, state, now);
  }

  getPullRequest(owner: string, name: string, prNumber: number): {
    head_sha: string | null;
    last_reviewed_sha: string | null;
    last_successful_review_sha: string | null;
    last_full_review_sha: string | null;
  } | null {
    const row = this.db
      .prepare(
        `SELECT head_sha, last_reviewed_sha, last_successful_review_sha, last_full_review_sha
         FROM pull_requests WHERE repo_owner = ? AND repo_name = ? AND pr_number = ?`
      )
      .get(owner, name, prNumber);
    return (row as ReturnType<Database['getPullRequest']>) ?? null;
  }

  setPullRequestReviewed(owner: string, name: string, prNumber: number, headSha: string, mode: ReviewMode, success: boolean): void {
    const now = new Date().toISOString();
    const row = this.getPullRequest(owner, name, prNumber);
    const lastReviewed = headSha;
    const lastSuccessful = success ? headSha : (row?.last_successful_review_sha ?? null);
    const lastFull = mode === 'full' ? headSha : (row?.last_full_review_sha ?? null);
    this.db
      .prepare(
        `INSERT INTO pull_requests (repo_owner, repo_name, pr_number, head_sha, last_reviewed_sha, last_successful_review_sha, last_full_review_sha, draft, state, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'open', ?)
         ON CONFLICT(repo_owner, repo_name, pr_number) DO UPDATE SET
           head_sha=COALESCE(excluded.head_sha, pull_requests.head_sha),
           last_reviewed_sha=excluded.last_reviewed_sha,
           last_successful_review_sha=excluded.last_successful_review_sha,
           last_full_review_sha=COALESCE(excluded.last_full_review_sha, pull_requests.last_full_review_sha),
           updated_at=excluded.updated_at`
      )
      .run(owner, name, prNumber, headSha, lastReviewed, lastSuccessful, lastFull, now);
  }

  // ---- repository state ----------------------------------------------------

  getRepositoryState(owner: string, name: string): {
    gate_mode: string;
    ruleset_id: number | null;
    ruleset_state: string;
    last_successful_review_sha: string | null;
  } {
    const row = this.db
      .prepare('SELECT gate_mode, ruleset_id, ruleset_state, last_successful_review_sha FROM repository_state WHERE repo_owner = ? AND repo_name = ?')
      .get(owner, name);
    if (!row) {
      return { gate_mode: 'off', ruleset_id: null, ruleset_state: 'unmanaged', last_successful_review_sha: null };
    }
    return row as ReturnType<Database['getRepositoryState']>;
  }

  setRepositoryGateState(owner: string, name: string, gateMode: string, rulesetId: number | null, rulesetState: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO repository_state (repo_owner, repo_name, gate_mode, ruleset_id, ruleset_state, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_owner, repo_name) DO UPDATE SET
           gate_mode=excluded.gate_mode, ruleset_id=excluded.ruleset_id,
           ruleset_state=excluded.ruleset_state, updated_at=excluded.updated_at`
      )
      .run(owner, name, gateMode, rulesetId, rulesetState, now);
  }

  setRepositoryReviewed(owner: string, name: string, headSha: string, mode: ReviewMode, success: boolean): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO repository_state (repo_owner, repo_name, last_full_review_sha, last_successful_review_sha, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(repo_owner, repo_name) DO UPDATE SET
           last_full_review_sha = COALESCE(excluded.last_full_review_sha, repository_state.last_full_review_sha),
           last_successful_review_sha = COALESCE(excluded.last_successful_review_sha, repository_state.last_successful_review_sha),
           updated_at = excluded.updated_at`
      )
      .run(owner, name, mode === 'full' ? headSha : null, success ? headSha : null, now);
  }

  // ---- jobs ----------------------------------------------------------------

  enqueueJob(job: {
    installationId: number;
    owner: string;
    repo: string;
    prNumber: number;
    baseSha: string;
    headSha: string;
    mode: ReviewMode;
    trigger: string;
  }): number {
    const now = new Date().toISOString();
    const res = this.db
      .prepare(
        `INSERT INTO review_jobs (installation_id, repo_owner, repo_name, pr_number, base_sha, head_sha, mode, status, trigger, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`
      )
      .run(job.installationId, job.owner, job.repo, job.prNumber, job.baseSha, job.headSha, job.mode, job.trigger, now);
    return Number(res.lastInsertRowid);
  }

  /** Supersede queued jobs and request cancellation of the running job for a repo+PR. */
  supersedeForPullRequest(owner: string, repo: string, prNumber: number, newJobId: number): { cancelledJobIds: number[] } {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE review_jobs SET status='superseded', superseded_by=?, finished_at=?
         WHERE repo_owner=? AND repo_name=? AND pr_number=? AND status='queued' AND id != ?`
      )
      .run(newJobId, now, owner, repo, prNumber, newJobId);
    const running = this.db
      .prepare(
        `SELECT id FROM review_jobs WHERE repo_owner=? AND repo_name=? AND pr_number=? AND status='running'`
      )
      .all(owner, repo, prNumber) as Array<{ id: number }>;
    this.db
      .prepare(
        `UPDATE review_jobs SET status='cancelling', superseded_by=?
         WHERE repo_owner=? AND repo_name=? AND pr_number=? AND status='running'`
      )
      .run(newJobId, owner, repo, prNumber);
    return { cancelledJobIds: running.map((r) => r.id) };
  }

  claimNextJob(maxConcurrent: number): JobRecord | null {
    // Count running jobs; pick oldest queued if under cap.
    const running = (this.db.prepare(`SELECT COUNT(*) AS c FROM review_jobs WHERE status IN ('running','cancelling')`).get() as { c: number }).c;
    if (running >= maxConcurrent) return null;
    const row = this.db.prepare(`SELECT * FROM review_jobs WHERE status='queued' ORDER BY id ASC LIMIT 1`).get();
    if (!row) return null;
    const job = row as unknown as JobRecord;
    const now = new Date().toISOString();
    const res = this.db
      .prepare(`UPDATE review_jobs SET status='running', started_at=? WHERE id=? AND status='queued'`)
      .run(now, job.id);
    if (res.changes === 0) return null; // lost race
    return { ...job, status: 'running', started_at: now };
  }

  getJob(id: number): JobRecord | null {
    const row = this.db.prepare('SELECT * FROM review_jobs WHERE id = ?').get(id);
    return (row as unknown as JobRecord) ?? null;
  }

  getJobByCheckRunId(checkRunId: number): JobRecord | null {
    const row = this.db.prepare('SELECT * FROM review_jobs WHERE check_run_id = ? ORDER BY id DESC LIMIT 1').get(checkRunId);
    return (row as unknown as JobRecord) ?? null;
  }

  getLatestJob(owner: string, repo: string, prNumber: number): JobRecord | null {
    const row = this.db
      .prepare('SELECT * FROM review_jobs WHERE repo_owner=? AND repo_name=? AND pr_number=? ORDER BY id DESC LIMIT 1')
      .get(owner, repo, prNumber);
    return (row as unknown as JobRecord) ?? null;
  }

  /** Resets jobs left running/cancelling by a crash so they can re-run. */
  recoverStaleJobs(): void {
    this.db
      .prepare(`UPDATE review_jobs SET status='queued', started_at=NULL WHERE status IN ('running','cancelling')`)
      .run();
    this.db
      .prepare(
        `UPDATE review_runs SET status='failed', completed_at=?, error_message='interrupted by service restart' WHERE status='running'`,
      )
      .run(new Date().toISOString());
  }

  getQueuedJobs(): JobRecord[] {
    const rows = this.db.prepare(`SELECT * FROM review_jobs WHERE status='queued' ORDER BY id ASC`).all();
    return rows as unknown as JobRecord[];
  }

  setJobStatus(id: number, status: JobStatus, extra?: { checkRunId?: number; reviewRunId?: number; finished?: boolean }): void {
    const finishedAt = extra?.finished ? new Date().toISOString() : null;
    this.db
      .prepare(
        `UPDATE review_jobs SET status=?, check_run_id=COALESCE(?, check_run_id), review_run_id=COALESCE(?, review_run_id), finished_at=COALESCE(?, finished_at) WHERE id=?`
      )
      .run(status, extra?.checkRunId ?? null, extra?.reviewRunId ?? null, finishedAt, id);
  }

  // ---- runs ----------------------------------------------------------------

  createRun(input: {
    installationId: number;
    owner: string;
    repo: string;
    prNumber: number;
    mode: ReviewMode;
    baseSha: string;
    headSha: string;
    checkRunId: number | null;
  }): number {
    const now = new Date().toISOString();
    const res = this.db
      .prepare(
        `INSERT INTO review_runs (installation_id, repo_owner, repo_name, pr_number, mode, base_sha, head_sha, started_at, status, check_run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`
      )
      .run(input.installationId, input.owner, input.repo, input.prNumber, input.mode, input.baseSha, input.headSha, now, input.checkRunId);
    return Number(res.lastInsertRowid);
  }

  completeRun(
    id: number,
    status: RunStatus,
    findingCount: number,
    errorMessage: string | null,
    meta?: { ocrVersion?: string | null; model?: string | null },
  ): void {
    this.db
      .prepare(
        `UPDATE review_runs SET status=?, completed_at=?, finding_count=?, error_message=?, ocr_version=COALESCE(?, ocr_version), model=COALESCE(?, model) WHERE id=?`
      )
      .run(status, new Date().toISOString(), findingCount, errorMessage, meta?.ocrVersion ?? null, meta?.model ?? null, id);
  }

  getRun(id: number): RunRecord | null {
    const row = this.db.prepare('SELECT * FROM review_runs WHERE id = ?').get(id);
    return (row as unknown as RunRecord) ?? null;
  }

  getLastSuccessfulRun(owner: string, repo: string, prNumber: number): RunRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM review_runs WHERE repo_owner=? AND repo_name=? AND pr_number=? AND status='completed' ORDER BY id DESC LIMIT 1`
      )
      .get(owner, repo, prNumber);
    return (row as unknown as RunRecord) ?? null;
  }

  // ---- findings / published comments ---------------------------------------

  insertFindings(runId: number, findings: Array<{ path: string; startLine?: number; endLine?: number; category?: string; severity?: string; message: string; fingerprint: string }>): number[] {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO findings (review_run_id, path, start_line, end_line, category, severity, message, fingerprint, publish_state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    );
    const ids: number[] = [];
    for (const f of findings) {
      const res = stmt.run(runId, f.path, f.startLine ?? null, f.endLine ?? null, f.category ?? null, f.severity ?? null, f.message, f.fingerprint, now);
      ids.push(Number(res.lastInsertRowid));
    }
    return ids;
  }

  listPublishedForPullRequest(owner: string, repo: string, prNumber: number): Array<{
    path: string;
    start_line: number | null;
    end_line: number | null;
    category: string | null;
    fingerprint: string;
    body: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT path, start_line, end_line, category, fingerprint, body FROM published_comments WHERE repo_owner=? AND repo_name=? AND pr_number=?`
      )
      .all(owner, repo, prNumber);
    return rows as Array<{
      path: string;
      start_line: number | null;
      end_line: number | null;
      category: string | null;
      fingerprint: string;
      body: string;
    }>;
  }

  insertPublishedComment(input: {
    owner: string;
    repo: string;
    prNumber: number;
    runId: number;
    findingId: number | null;
    githubCommentId: number | null;
    path: string;
    startLine?: number;
    endLine?: number;
    category?: string;
    fingerprint: string;
    body: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO published_comments (repo_owner, repo_name, pr_number, review_run_id, finding_id, github_comment_id, path, start_line, end_line, category, fingerprint, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.owner, input.repo, input.prNumber, input.runId, input.findingId ?? null,
        input.githubCommentId ?? null, input.path, input.startLine ?? null, input.endLine ?? null,
        input.category ?? null, input.fingerprint, input.body, new Date().toISOString(),
      );
  }

  hasJobForPullRequest(owner: string, repo: string, prNumber: number, statuses: JobStatus[]): boolean {
    const placeholders = statuses.map(() => '?').join(',');
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM review_jobs WHERE repo_owner=? AND repo_name=? AND pr_number=? AND status IN (${placeholders})`
      )
      .get(owner, repo, prNumber, ...statuses) as { c: number };
    return row.c > 0;
  }
}
