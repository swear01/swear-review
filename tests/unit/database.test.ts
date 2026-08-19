import { describe, expect, it } from 'vitest';
import { Database } from '../../src/db/database.js';

describe('review gate persistence', () => {
  it('stores gate check runs by pull-request head SHA', () => {
    const db = new Database(':memory:');
    try {
      expect(db.getReviewGate('owner', 'repo', 7, 'head-a')).toBeNull();
      db.setReviewGate('owner', 'repo', 7, 'head-a', 123, { status: 'in_progress', conclusion: null });
      expect(db.getReviewGate('owner', 'repo', 7, 'head-a')).toEqual({
        check_run_id: 123,
        status: 'in_progress',
        conclusion: null,
      });
      db.setReviewGate('owner', 'repo', 7, 'head-a', 124, { status: 'completed', conclusion: 'failure' });
      expect(db.getReviewGate('owner', 'repo', 7, 'head-a')).toEqual({
        check_run_id: 124,
        status: 'completed',
        conclusion: 'failure',
      });
      expect(db.getReviewGate('owner', 'repo', 7, 'head-b')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('finds open pull requests by exact head SHA for status events', () => {
    const db = new Database(':memory:');
    try {
      db.upsertInstallation(1, 'owner', 'User');
      db.upsertRepository('owner', 'repo', 1, false, 'main');
      db.upsertPullRequest('owner', 'repo', 7, 'head-a', 'base', false, 'open');
      db.upsertPullRequest('owner', 'repo', 8, 'head-a', 'base', false, 'closed');
      expect(db.listOpenPullRequestsByHeadSha('owner', 'repo', 'head-a')).toEqual([
        { pr_number: 7, installation_id: 1 },
      ]);
    } finally {
      db.close();
    }
  });
});
