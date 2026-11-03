import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../src/db/database.js';
import { Scheduler } from '../../src/review/scheduler.js';
import { createLogger } from '../../src/util/logger.js';
import { Metrics } from '../../src/util/metrics.js';
import { FakeGitHubApi } from '../helpers/fake-github.js';

describe('check run re-request', () => {
  let db: Database;
  let github: FakeGitHubApi;
  let scheduler: Scheduler;
  let originalJobId: number;

  beforeEach(() => {
    db = new Database(':memory:');
    github = new FakeGitHubApi();
    github.prHeadSha = 'head';
    github.prBaseSha = 'pr-base';
    scheduler = new Scheduler({
      db, github, config: FakeGitHubApi.config(),
      log: createLogger('silent'), metrics: new Metrics(), opencodeKey: 'test', worker: null,
    });
    originalJobId = db.enqueueJob({
      installationId: 123, owner: 'test-owner', repo: 'demo', prNumber: 42,
      baseSha: 'last-reviewed', headSha: 'head', mode: 'incremental', trigger: 'synchronize',
    });
    db.setJobStatus(originalJobId, 'completed', { checkRunId: 456, finished: true });
  });

  afterEach(() => db.close());

  const rerun = () => ({ action: 'rerequested', check_run: { id: 456, name: 'Swear Review' } });

  it('reruns an incremental check over the full PR range', async () => {
    await scheduler.handleEvent('check_run', rerun());
    expect(db.getLatestJob('test-owner', 'demo', 42)).toMatchObject({
      mode: 'full', base_sha: 'pr-base', head_sha: 'head', trigger: 'check_run.rerequested',
    });
  });

  it.each(['new-head', 'closed'])('ignores a check for a PR with %s', async (change) => {
    if (change === 'new-head') github.prHeadSha = 'new-head';
    else github.prState = 'closed';
    await scheduler.handleEvent('check_run', rerun());
    expect(db.getLatestJob('test-owner', 'demo', 42)?.id).toBe(originalJobId);
  });
});
