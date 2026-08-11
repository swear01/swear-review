import { describe, it, expect, beforeEach } from 'vitest';
import { Database } from '../../src/db/database.js';
import { ReviewQueue } from '../../src/review/queue.js';

describe('ReviewQueue superseding', () => {
  let db: Database;
  let queue: ReviewQueue;

  beforeEach(() => {
    db = new Database(':memory:');
    queue = new ReviewQueue(db);
  });

  function enqueue(head: string, mode: 'full' | 'incremental' = 'full') {
    return queue.enqueue({
      installationId: 1,
      owner: 'o',
      repo: 'r',
      prNumber: 7,
      baseSha: 'base',
      headSha: head,
      mode,
      trigger: 'synchronize',
    });
  }

  it('supersedes queued jobs for the same PR', () => {
    const first = enqueue('aaaa');
    const second = enqueue('bbbb');
    expect(first.jobId).not.toBe(second.jobId);
    const j1 = db.getJob(first.jobId)!;
    expect(j1.status).toBe('superseded');
    expect(j1.superseded_by).toBe(second.jobId);
    const j2 = db.getJob(second.jobId)!;
    expect(j2.status).toBe('queued');
  });

  it('requests cancellation of a running job and enqueues the new one', () => {
    const first = enqueue('aaaa');
    const claimed = db.claimNextJob(2)!;
    expect(claimed.id).toBe(first.jobId);
    const second = enqueue('bbbb');
    expect(second.cancelledRunningJobIds).toContain(first.jobId);
    const j1 = db.getJob(first.jobId)!;
    expect(j1.status).toBe('cancelling');
  });

  it('jobs for different PRs are not superseded', () => {
    const a = queue.enqueue({ installationId: 1, owner: 'o', repo: 'r', prNumber: 7, baseSha: 'b', headSha: 'aaaa', mode: 'full', trigger: 'x' });
    const b = queue.enqueue({ installationId: 1, owner: 'o', repo: 'r', prNumber: 8, baseSha: 'b', headSha: 'bbbb', mode: 'full', trigger: 'x' });
    expect(db.getJob(a.jobId)!.status).toBe('queued');
    expect(db.getJob(b.jobId)!.status).toBe('queued');
  });

  it('claim caps concurrency at maxReviewJobs', () => {
    const enq = (prNumber: number, head: string) =>
      queue.enqueue({ installationId: 1, owner: 'o', repo: 'r', prNumber, baseSha: 'b', headSha: head, mode: 'full', trigger: 'x' });
    enq(1, 'aaaa');
    enq(2, 'bbbb');
    enq(3, 'cccc');
    const j1 = db.claimNextJob(2)!;
    const j2 = db.claimNextJob(2)!;
    expect(j1).not.toBeNull();
    expect(j2).not.toBeNull();
    expect(db.claimNextJob(2)).toBeNull();
  });

  it('recoverStaleJobs resets running jobs to queued', () => {
    enqueue('aaaa');
    const claimed = db.claimNextJob(2)!;
    expect(db.getJob(claimed.id)!.status).toBe('running');
    db.recoverStaleJobs();
    expect(db.getJob(claimed.id)!.status).toBe('queued');
  });
});
