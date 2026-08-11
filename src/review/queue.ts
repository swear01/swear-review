import type { Database } from '../db/database.js';
import type { JobRecord, ReviewMode } from '../types.js';

/**
 * SQLite-backed job queue. One active review per (repo, PR):
 *  - queued jobs for the same PR are superseded
 *  - the running job for the same PR is sent a cancellation request
 */
export class ReviewQueue {
  constructor(private readonly db: Database) {}

  enqueue(input: {
    installationId: number;
    owner: string;
    repo: string;
    prNumber: number;
    baseSha: string;
    headSha: string;
    mode: ReviewMode;
    trigger: string;
  }): { jobId: number; cancelledRunningJobIds: number[] } {
    const jobId = this.db.enqueueJob(input);
    const { cancelledJobIds } = this.db.supersedeForPullRequest(input.owner, input.repo, input.prNumber, jobId);
    return { jobId, cancelledRunningJobIds: cancelledJobIds };
  }

  claimNext(maxConcurrent: number): JobRecord | null {
    return this.db.claimNextJob(maxConcurrent);
  }

  hasActiveOrQueued(owner: string, repo: string, prNumber: number): boolean {
    return this.db.hasJobForPullRequest(owner, repo, prNumber, ['queued', 'running', 'cancelling']);
  }
}
