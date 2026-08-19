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
