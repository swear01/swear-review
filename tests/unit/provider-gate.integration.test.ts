import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../../src/config/schema.js';
import { Database } from '../../src/db/database.js';
import { createLogger } from '../../src/util/logger.js';
import { reconcileProviderGate } from '../../src/gate/provider-gate.js';
import { FakeGitHubApi } from '../helpers/fake-github.js';

const log = createLogger('silent');

describe('reconcileProviderGate', () => {
  it('does not reuse a successful provider result from an older head', async () => {
    const github = new FakeGitHubApi();
    github.checkRuns = [{
      name: 'Cursor Bugbot',
      status: 'completed',
      conclusion: 'success',
      head_sha: 'head-old',
      app: { id: 1210556, slug: 'cursor' },
    }];
    const db = new Database(':memory:');
    try {
      const octokit = await github.getOctokit(1);
      await reconcileProviderGate(octokit, db, log, {
        owner: 'owner',
        repo: 'repo',
        prNumber: 7,
        headSha: 'head-new',
        checkName: 'AI Review Gate',
        providers: [{ name: 'Cursor Bugbot', type: 'check', check_name: 'Cursor Bugbot', app_id: 1210556 }],
      });
      expect(github.callsTo('checks.update')[0]!.params.status).toBe('in_progress');
      expect(github.callsTo('checks.update')[0]!.params.conclusion).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('rejects completing a fake check run without a conclusion', async () => {
    const github = new FakeGitHubApi();
    const octokit = await github.getOctokit(1);
    await octokit.rest.checks.create({
      owner: 'owner',
      repo: 'repo',
      name: 'AI Review Gate',
      head_sha: 'head-a',
      status: 'in_progress',
      output: { title: 'test', summary: 'test' },
    });
    await expect(octokit.rest.checks.update({
      owner: 'owner',
      repo: 'repo',
      check_run_id: 1,
      status: 'completed',
      output: { title: 'test', summary: 'test' },
    })).rejects.toThrow('conclusion');
  });

  it('terminates a newly created gate after a permanent update failure', async () => {
    const github = new FakeGitHubApi();
    github.checksUpdateError = Object.assign(new Error('unprocessable'), { status: 422 });
    const db = new Database(':memory:');
    try {
      const octokit = await github.getOctokit(1);
      await expect(reconcileProviderGate(octokit, db, log, {
        owner: 'owner',
        repo: 'repo',
        prNumber: 7,
        headSha: 'head-a',
        checkName: 'AI Review Gate',
        providers: [{ name: 'Cursor Bugbot', type: 'check', check_name: 'Cursor Bugbot', app_id: 1210556 }],
      })).rejects.toThrow('unprocessable');
      expect(github.callsTo('checks.update')).toHaveLength(2);
      expect(github.callsTo('checks.update').map((call) => call.params.check_run_id)).toEqual([1, 1]);
    } finally {
      db.close();
    }
  });

  it('recovers when an existing gate run was completed externally', async () => {
    const github = new FakeGitHubApi();
    const db = new Database(':memory:');
    const input = {
      owner: 'owner',
      repo: 'repo',
      prNumber: 7,
      headSha: 'head-a',
      checkName: 'AI Review Gate',
      providers: [{ name: 'Cursor Bugbot', type: 'check' as const, check_name: 'Cursor Bugbot', app_id: 1210556 }],
    };
    try {
      const octokit = await github.getOctokit(1);
      await reconcileProviderGate(octokit, db, log, input);
      const gateRun = github.checkRuns.find((run) => run.name === 'AI Review Gate')!;
      gateRun.status = 'completed';
      gateRun.conclusion = 'success';
      github.checkRuns.push({
        name: 'Cursor Bugbot',
        status: 'completed',
        conclusion: 'success',
        head_sha: 'head-a',
        app: { id: 1210556, slug: 'cursor' },
      });
      github.checksUpdateError = Object.assign(new Error('already completed'), { status: 422 });
      github.checksUpdateErrorForId = gateRun.id!;

      await reconcileProviderGate(octokit, db, log, input);
      expect(db.getReviewGate('owner', 'repo', 7, 'head-a')).toEqual({
        check_run_id: gateRun.id,
        status: 'completed',
        conclusion: 'success',
      });
    } finally {
      db.close();
    }
  });

  it('accepts exactly the provider pagination limit', async () => {
    const github = new FakeGitHubApi();
    github.checkRuns = Array.from({ length: 1000 }, (_, index) => ({
      id: index + 1,
      name: `unrelated-${index}`,
      status: 'completed',
      conclusion: 'success',
      head_sha: 'head-a',
    }));
    const db = new Database(':memory:');
    try {
      const octokit = await github.getOctokit(1);
      await reconcileProviderGate(octokit, db, log, {
        owner: 'owner',
        repo: 'repo',
        prNumber: 7,
        headSha: 'head-a',
        checkName: 'AI Review Gate',
        providers: [{ name: 'Cursor Bugbot', type: 'check', check_name: 'Cursor Bugbot', app_id: 1210556 }],
      });
      expect(github.callsTo('checks.listForRef')).toHaveLength(11);
    } finally {
      db.close();
    }
  });

  it('rejects provider pagination overflow even with a short extra page', async () => {
    const github = new FakeGitHubApi();
    github.checkRuns = Array.from({ length: 1001 }, (_, index) => ({
      id: index + 1,
      name: `unrelated-${index}`,
      status: 'completed',
      conclusion: 'success',
      head_sha: 'head-a',
    }));
    const db = new Database(':memory:');
    try {
      const octokit = await github.getOctokit(1);
      await expect(reconcileProviderGate(octokit, db, log, {
        owner: 'owner',
        repo: 'repo',
        prNumber: 7,
        headSha: 'head-a',
        checkName: 'AI Review Gate',
        providers: [{ name: 'Cursor Bugbot', type: 'check', check_name: 'Cursor Bugbot', app_id: 1210556 }],
      })).rejects.toThrow('exceeded 1000');
    } finally {
      db.close();
    }
  });

  it('recreates the gate check run after a completed result becomes pending again', async () => {
    const github = new FakeGitHubApi();
    const db = new Database(':memory:');
    const provider = { name: 'Cursor Bugbot', type: 'check' as const, check_name: 'Cursor Bugbot', app_id: 1210556 };
    try {
      const octokit = await github.getOctokit(1);
      const input = {
        owner: 'owner',
        repo: 'repo',
        prNumber: 7,
        headSha: 'head-a',
        checkName: 'AI Review Gate',
        providers: [provider],
      };

      await reconcileProviderGate(octokit, db, log, input);
      expect(db.getReviewGate('owner', 'repo', 7, 'head-a')).toEqual({
        check_run_id: 1,
        status: 'in_progress',
        conclusion: null,
      });

      github.checkRuns.push({
        name: 'Cursor Bugbot',
        status: 'completed',
        conclusion: 'failure',
        head_sha: 'head-a',
        app: { id: 1210556, slug: 'cursor' },
      });
      await reconcileProviderGate(octokit, db, log, input);
      expect(db.getReviewGate('owner', 'repo', 7, 'head-a')).toEqual({
        check_run_id: 1,
        status: 'completed',
        conclusion: 'failure',
      });

      github.checkRuns.find((run) => run.name === 'Cursor Bugbot')!.status = 'in_progress';
      github.checkRuns.find((run) => run.name === 'Cursor Bugbot')!.conclusion = null;
      await reconcileProviderGate(octokit, db, log, input);
      expect(db.getReviewGate('owner', 'repo', 7, 'head-a')).toEqual({
        check_run_id: 2,
        status: 'in_progress',
        conclusion: null,
      });
      expect(github.callsTo('checks.create')).toHaveLength(2);
      expect(github.callsTo('checks.update').map((call) => call.params.check_run_id)).toEqual([1, 1, 2]);

      github.checkRuns.find((run) => run.name === 'Cursor Bugbot')!.status = 'completed';
      github.checkRuns.find((run) => run.name === 'Cursor Bugbot')!.conclusion = 'success';
      await reconcileProviderGate(octokit, db, log, input);
      expect(db.getReviewGate('owner', 'repo', 7, 'head-a')).toEqual({
        check_run_id: 2,
        status: 'completed',
        conclusion: 'success',
      });
    } finally {
      db.close();
    }
  });

  it('publishes success when any configured provider passed for the exact head', async () => {
    const github = new FakeGitHubApi();
    github.checkRuns = [{
      name: 'Cursor Bugbot',
      status: 'completed',
      conclusion: 'success',
      head_sha: 'head-a',
      app: { id: 1210556, slug: 'cursor' },
    }];
    const db = new Database(':memory:');
    const config = defaultConfig();
    config.gate.providers = [{ name: 'Cursor Bugbot', type: 'check', check_name: 'Cursor Bugbot', app_id: 1210556 }];

    try {
      const octokit = await github.getOctokit(1);
      await reconcileProviderGate(octokit, db, log, {
        owner: 'owner',
        repo: 'repo',
        prNumber: 7,
        headSha: 'head-a',
        checkName: 'AI Review Gate',
        providers: config.gate.providers,
      });

      expect(github.callsTo('checks.create')[0]!.params.name).toBe('AI Review Gate');
      expect(github.callsTo('checks.update')[0]!.params.conclusion).toBe('success');
    } finally {
      db.close();
    }
  });
});
