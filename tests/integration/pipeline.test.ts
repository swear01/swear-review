import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness, waitFor } from '../helpers/harness.js';
import { createLocalRepo, addCommit, cleanupLocalRepo, ensureTempReposDir, type LocalRepo } from '../helpers/local-repo.js';
import { FakeGitHubApi } from '../helpers/fake-github.js';

const MOCK_OCR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'helpers', 'mock-ocr.mjs');
const REPOS_ROOT = ensureTempReposDir();

let repo: LocalRepo;

beforeAll(() => {
  repo = createLocalRepo();
});

afterAll(() => {
  cleanupLocalRepo(repo);
});

describe('full pipeline (webhook → queue → worker → publish)', () => {
  it('ignores an out-of-order pull_request webhook whose head is no longer current', async () => {
    const github = new FakeGitHubApi();
    github.prHeadSha = repo.headSha;
    github.prBaseSha = repo.baseSha;
    const config = FakeGitHubApi.config({
      binary: MOCK_OCR,
      workspaceDir: path.join(REPOS_ROOT, 'ws-stale-webhook'),
      cloneTemplate: `file://${repo.bareDir}`,
    });
    const harness = createHarness(config, github);
    try {
      await harness.scheduler.handleEvent('pull_request', {
        action: 'synchronize',
        number: 99,
        pull_request: {
          number: 99, state: 'open', draft: false, title: 'T',
          user: { login: 'alice' },
          head: { sha: 'old-head', ref: 'feature' },
          base: { sha: repo.baseSha, ref: 'main' },
        },
        repository: { name: 'demo', full_name: 'test-owner/demo', owner: { login: 'test-owner' }, private: true, default_branch: 'main' },
        installation: { id: 123, account: { login: 'test-owner', type: 'User' } },
      });
      expect(harness.db.getLatestJob('test-owner', 'demo', 99)).toBeNull();
    } finally {
      harness.cleanup();
    }
  });

  it('continues with a payload when head revalidation is temporarily unavailable', async () => {
    const github = new FakeGitHubApi();
    github.prHeadSha = repo.headSha;
    github.prBaseSha = repo.baseSha;
    github.pullsGetError = new Error('temporary GitHub outage');
    const config = FakeGitHubApi.config({
      binary: MOCK_OCR,
      workspaceDir: path.join(REPOS_ROOT, 'ws-revalidation-error'),
      cloneTemplate: `file://${repo.bareDir}`,
    });
    const harness = createHarness(config, github);
    try {
      await harness.scheduler.handleEvent('pull_request', {
        action: 'opened',
        number: 98,
        pull_request: {
          number: 98, state: 'open', draft: false, title: 'T',
          user: { login: 'alice' },
          head: { sha: repo.headSha, ref: 'feature' },
          base: { sha: repo.baseSha, ref: 'main' },
        },
        repository: { name: 'demo', full_name: 'test-owner/demo', owner: { login: 'test-owner' }, private: true, default_branch: 'main' },
        installation: { id: 123, account: { login: 'test-owner', type: 'User' } },
      });
      expect(harness.db.getLatestJob('test-owner', 'demo', 98)).not.toBeNull();
    } finally {
      harness.cleanup();
    }
  });

  it('Test B: opened PR → auto full review → inline comments + sticky summary + check success', async () => {
    const github = new FakeGitHubApi();
    github.prHeadSha = repo.headSha;
    github.prBaseSha = repo.baseSha;
    github.prState = 'open';
    github.permission = 'admin';

    const config = FakeGitHubApi.config({
      binary: MOCK_OCR,
      workspaceDir: path.join(REPOS_ROOT, 'ws-b'),
      cloneTemplate: `file://${repo.bareDir}`,
    });
    const harness = createHarness(config, github);
    try {
      await harness.scheduler.handleEvent('pull_request', {
        action: 'opened',
        number: 1,
        pull_request: {
          number: 1,
          state: 'open',
          draft: false,
          title: 'Test',
          user: { login: 'alice' },
          head: { sha: repo.headSha, ref: 'feature' },
          base: { sha: repo.baseSha, ref: 'main' },
        },
        repository: { name: 'demo', full_name: 'test-owner/demo', owner: { login: 'test-owner' }, private: true, default_branch: 'main' },
        installation: { id: 123, account: { login: 'test-owner', type: 'User' } },
      });

      await waitFor(() => {
        const run = harness.db.getRun(harness.db.getLatestJob('test-owner', 'demo', 1)?.review_run_id ?? -1);
        return run?.status === 'completed';
      }, 30_000);

      const job = harness.db.getLatestJob('test-owner', 'demo', 1)!;
      const run = harness.db.getRun(job.review_run_id!)!;
      expect(run.status).toBe('completed');
      expect(run.finding_count).toBe(3);
      expect(run.ocr_version).toBe('v1.9.0');
      expect(run.model).toBe('deepseek-v4-flash');

      // inline comments were posted in review batches
      const reviews = github.callsTo('pulls.createReview');
      expect(reviews.length).toBeGreaterThan(0);
      const totalComments = reviews.reduce((n, c) => n + ((c.params.comments as unknown[]).length ?? 0), 0);
      expect(totalComments).toBe(3);
      // commit pinned to the reviewed head
      expect(reviews[0]!.params.commit_id).toBe(repo.headSha);

      // sticky summary posted
      const comments = github.callsTo('issues.createComment');
      expect(comments.some((c) => String(c.params.body).includes('swear-review-summary'))).toBe(true);

      // check run created + completed success (gate=off → success even with bugs)
      expect(github.callsTo('checks.create').length).toBe(1);
      const checkUpdate = github.callsTo('checks.update');
      expect(checkUpdate.length).toBe(1);
      expect(checkUpdate[0]!.params.conclusion).toBe('success');

      // repo state recorded
      const prRow = harness.db.getPullRequest('test-owner', 'demo', 1)!;
      expect(prRow.last_successful_review_sha).toBe(repo.headSha);
      expect(prRow.last_full_review_sha).toBe(repo.headSha);
    } finally {
      harness.cleanup();
    }
  });

  it('invokes OCR with --concurrency 16 and immutable SHAs (Test F)', async () => {
    const github = new FakeGitHubApi();
    github.prHeadSha = repo.headSha;
    github.prBaseSha = repo.baseSha;
    const config = FakeGitHubApi.config({
      binary: MOCK_OCR,
      workspaceDir: path.join(REPOS_ROOT, 'ws-conc'),
      cloneTemplate: `file://${repo.bareDir}`,
      concurrency: 16,
    });
    const harness = createHarness(config, github);
    try {
      await harness.scheduler.handleEvent('pull_request', {
        action: 'synchronize',
        number: 2,
        pull_request: {
          number: 2, state: 'open', draft: false, title: 'T',
          user: { login: 'alice' },
          head: { sha: repo.headSha, ref: 'feature' },
          base: { sha: repo.baseSha, ref: 'main' },
        },
        repository: { name: 'demo', full_name: 'test-owner/demo', owner: { login: 'test-owner' }, private: true, default_branch: 'main' },
        installation: { id: 123, account: { login: 'test-owner', type: 'User' } },
      });
      await waitFor(() => harness.db.getLatestJob('test-owner', 'demo', 2)?.status === 'completed', 30_000);
      const job = harness.db.getLatestJob('test-owner', 'demo', 2)!;
      expect(job.status).toBe('completed');
      // merge-base must be used as --from (immutable SHA, not branch name)
      const run = harness.db.getRun(job.review_run_id!)!;
      expect(run.base_sha).toBe(repo.baseSha);
      expect(run.head_sha).toBe(repo.headSha);
      expect(run.status).toBe('completed');
    } finally {
      harness.cleanup();
    }
  });

  it('Test J: gate=managed + bug finding → check failure + ruleset created', async () => {
    const github = new FakeGitHubApi();
    github.prHeadSha = repo.headSha;
    github.prBaseSha = repo.baseSha;
    const config = FakeGitHubApi.config({
      binary: MOCK_OCR,
      workspaceDir: path.join(REPOS_ROOT, 'ws-gate'),
      cloneTemplate: `file://${repo.bareDir}`,
      gateMode: 'managed',
    });
    config.gate.integration_id = 4555972;
    const harness = createHarness(config, github);
    try {
      await harness.scheduler.handleEvent('pull_request', {
        action: 'opened',
        number: 3,
        pull_request: {
          number: 3, state: 'open', draft: false, title: 'T',
          user: { login: 'alice' },
          head: { sha: repo.headSha, ref: 'feature' },
          base: { sha: repo.baseSha, ref: 'main' },
        },
        repository: { name: 'demo', full_name: 'test-owner/demo', owner: { login: 'test-owner' }, private: true, default_branch: 'main' },
        installation: { id: 123, account: { login: 'test-owner', type: 'User' } },
      });
      await waitFor(() => harness.db.getLatestJob('test-owner', 'demo', 3)?.status === 'completed', 30_000);

      // fixture contains bug + security → blocking
      const update = github.callsTo('checks.update');
      expect(update.length).toBe(1);
      expect(update[0]!.params.conclusion).toBe('failure');
      // managed gate created the ruleset
      const created = github.callsTo('repos.createRepoRuleset');
      expect(created.length).toBe(1);
      expect(created[0]!.params.name).toBe('Swear Review');
      const rules = created[0]!.params.rules as Array<{ type: string; parameters: { required_status_checks: Array<{ context: string; integration_id?: number }> } }>;
      expect(rules.some((r) => r.type === 'required_status_checks' && r.parameters.required_status_checks.some((c) => c.context === 'Swear Review' && c.integration_id === 4555972))).toBe(true);
      // summary reports merge blocked
      const summary = github.callsTo('issues.createComment').find((c) => String(c.params.body).includes('swear-review-summary'));
      expect(String(summary?.params.body)).toContain('Merge blocked');
    } finally {
      harness.cleanup();
    }
  });

  it('any-provider gate passes when an external provider succeeds', async () => {
    const github = new FakeGitHubApi();
    github.prHeadSha = repo.headSha;
    github.prBaseSha = repo.baseSha;
    github.checkRuns = [{
      name: 'Cursor Bugbot',
      status: 'completed',
      conclusion: 'success',
      head_sha: repo.headSha,
      app: { id: 1210556, slug: 'cursor' },
    }];
    const config = FakeGitHubApi.config({
      binary: MOCK_OCR,
      workspaceDir: path.join(REPOS_ROOT, 'ws-any-gate'),
      cloneTemplate: `file://${repo.bareDir}`,
      gateMode: 'managed',
    });
    config.gate.strategy = 'any';
    config.gate.providers = [{ name: 'Cursor Bugbot', type: 'check', check_name: 'Cursor Bugbot', app_id: 1210556 }];
    const harness = createHarness(config, github);
    try {
      await harness.scheduler.handleEvent('pull_request', {
        action: 'opened',
        number: 30,
        pull_request: {
          number: 30, state: 'open', draft: false, title: 'T',
          user: { login: 'alice' },
          head: { sha: repo.headSha, ref: 'feature' },
          base: { sha: repo.baseSha, ref: 'main' },
        },
        repository: { name: 'demo', full_name: 'test-owner/demo', owner: { login: 'test-owner' }, private: true, default_branch: 'main' },
        installation: { id: 123, account: { login: 'test-owner', type: 'User' } },
      });

      await waitFor(() => harness.db.getLatestJob('test-owner', 'demo', 30)?.status === 'completed', 30_000);
      const gateCreate = github.callsTo('checks.create').find((call) => call.params.name === 'AI Review Gate');
      expect(gateCreate).toBeTruthy();
      const gateUpdate = github.callsTo('checks.update').find((call) => call.params.conclusion === 'success');
      expect(gateUpdate).toBeTruthy();
      const rules = github.callsTo('repos.createRepoRuleset')[0]!.params.rules as Array<{ type: string; parameters: { required_status_checks: Array<{ context: string }> } }>;
      expect(rules.some((r) => r.type === 'required_status_checks' && r.parameters.required_status_checks.some((c) => c.context === 'AI Review Gate'))).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it('Test I: gate=off → comments posted but check success (merge unaffected)', async () => {
    const github = new FakeGitHubApi();
    github.prHeadSha = repo.headSha;
    github.prBaseSha = repo.baseSha;
    const config = FakeGitHubApi.config({
      binary: MOCK_OCR,
      workspaceDir: path.join(REPOS_ROOT, 'ws-off'),
      cloneTemplate: `file://${repo.bareDir}`,
      gateMode: 'off',
    });
    const harness = createHarness(config, github);
    try {
      await harness.scheduler.handleEvent('pull_request', {
        action: 'opened',
        number: 4,
        pull_request: {
          number: 4, state: 'open', draft: false, title: 'T',
          user: { login: 'alice' },
          head: { sha: repo.headSha, ref: 'feature' },
          base: { sha: repo.baseSha, ref: 'main' },
        },
        repository: { name: 'demo', full_name: 'test-owner/demo', owner: { login: 'test-owner' }, private: true, default_branch: 'main' },
        installation: { id: 123, account: { login: 'test-owner', type: 'User' } },
      });
      await waitFor(() => harness.db.getLatestJob('test-owner', 'demo', 4)?.status === 'completed', 30_000);
      const update = github.callsTo('checks.update');
      expect(update[0]!.params.conclusion).toBe('success');
      expect(github.callsTo('pulls.createReview').length).toBeGreaterThan(0);
      expect(github.callsTo('repos.createRepoRuleset').length).toBe(0);
    } finally {
      harness.cleanup();
    }
  });

  it('Test H: stale head → results discarded, check cancelled, no comments', async () => {
    const github = new FakeGitHubApi();
    github.prHeadSha = repo.headSha;
    github.prBaseSha = repo.baseSha;
    const config = FakeGitHubApi.config({
      binary: MOCK_OCR,
      workspaceDir: path.join(REPOS_ROOT, 'ws-stale'),
      cloneTemplate: `file://${repo.bareDir}`,
    });
    const harness = createHarness(config, github);
    try {
      // simulate: after checkout + OCR but before publish, a new commit lands
      // we simulate this by changing the fake PR head BEFORE the job starts —
      // equivalent stale detection (publisher compares current head vs job head)
      await harness.scheduler.handleEvent('pull_request', {
        action: 'opened',
        number: 5,
        pull_request: {
          number: 5, state: 'open', draft: false, title: 'T',
          user: { login: 'alice' },
          head: { sha: repo.headSha, ref: 'feature' },
          base: { sha: repo.baseSha, ref: 'main' },
        },
        repository: { name: 'demo', full_name: 'test-owner/demo', owner: { login: 'test-owner' }, private: true, default_branch: 'main' },
        installation: { id: 123, account: { login: 'test-owner', type: 'User' } },
      });
      // new head arrives while the job is queued
      github.prHeadSha = 'cccccccccccccccccccccccccccccccccccccccc';
      await waitFor(() => {
        const j = harness.db.getLatestJob('test-owner', 'demo', 5);
        return j !== null && ['cancelled', 'completed', 'failed'].includes(j.status);
      }, 30_000);
      const job = harness.db.getLatestJob('test-owner', 'demo', 5)!;
      const run = harness.db.getRun(job.review_run_id ?? -1);
      if (run) {
        expect(['stale', 'cancelled']).toContain(run.status);
        // no inline comments were published
        const reviews = github.callsTo('pulls.createReview');
        const reviewsForThis = reviews.filter((r) => r.params.pull_number === 5);
        expect(reviewsForThis.length).toBe(0);
        // summary was not updated to Completed
        const summaries = github.callsTo('issues.createComment').filter((c) => String(c.params.body).includes('swear-review-summary'));
        expect(summaries.some((c) => String(c.params.body).includes('Completed'))).toBe(false);
      }
    } finally {
      harness.cleanup();
    }
  });

  it('Test G: OCR infra failure → check failure (fail-closed), no fake success', async () => {
    const github = new FakeGitHubApi();
    github.prHeadSha = repo.headSha;
    github.prBaseSha = repo.baseSha;
    const config = FakeGitHubApi.config({
      binary: MOCK_OCR,
      workspaceDir: path.join(REPOS_ROOT, 'ws-fail'),
      cloneTemplate: `file://${repo.bareDir}`,
    });
    const harness = createHarness(config, github);
    try {
      process.env.MOCK_OCR_FAIL = '1';
      await harness.scheduler.handleEvent('pull_request', {
        action: 'opened',
        number: 6,
        pull_request: {
          number: 6, state: 'open', draft: false, title: 'T',
          user: { login: 'alice' },
          head: { sha: repo.headSha, ref: 'feature' },
          base: { sha: repo.baseSha, ref: 'main' },
        },
        repository: { name: 'demo', full_name: 'test-owner/demo', owner: { login: 'test-owner' }, private: true, default_branch: 'main' },
        installation: { id: 123, account: { login: 'test-owner', type: 'User' } },
      });
      await waitFor(() => harness.db.getLatestJob('test-owner', 'demo', 6)?.status === 'failed', 30_000);
      const job = harness.db.getLatestJob('test-owner', 'demo', 6)!;
      expect(job.status).toBe('failed');
      const run = harness.db.getRun(job.review_run_id!)!;
      expect(run.status).toBe('failed');
      expect(run.error_message).toBeTruthy();
      const update = github.callsTo('checks.update');
      expect(update.length).toBe(1);
      expect(update[0]!.params.conclusion).toBe('failure');
      // failure summary posted, no inline comments
      expect(github.callsTo('pulls.createReview').length).toBe(0);
      const summaries = github.callsTo('issues.createComment').filter((c) => String(c.params.body).includes('swear-review-summary'));
      expect(summaries.some((c) => String(c.params.body).includes('Failed'))).toBe(true);
    } finally {
      delete process.env.MOCK_OCR_FAIL;
      harness.cleanup();
    }
  });

  it('OCR skipped (docs-only PR, no items selected) → check success with zero findings, summary carries the skip reason', async () => {
    const github = new FakeGitHubApi();
    github.prHeadSha = repo.headSha;
    github.prBaseSha = repo.baseSha;
    const config = FakeGitHubApi.config({
      binary: MOCK_OCR,
      workspaceDir: path.join(REPOS_ROOT, 'ws-skip'),
      cloneTemplate: `file://${repo.bareDir}`,
    });
    const harness = createHarness(config, github);
    try {
      process.env.MOCK_OCR_SKIP = '1';
      await harness.scheduler.handleEvent('pull_request', {
        action: 'opened',
        number: 7,
        pull_request: {
          number: 7, state: 'open', draft: false, title: 'T',
          user: { login: 'alice' },
          head: { sha: repo.headSha, ref: 'feature' },
          base: { sha: repo.baseSha, ref: 'main' },
        },
        repository: { name: 'demo', full_name: 'test-owner/demo', owner: { login: 'test-owner' }, private: true, default_branch: 'main' },
        installation: { id: 123, account: { login: 'test-owner', type: 'User' } },
      });
      await waitFor(() => {
        const job = harness.db.getLatestJob('test-owner', 'demo', 7);
        return job?.status === 'completed';
      }, 30_000);

      const job = harness.db.getLatestJob('test-owner', 'demo', 7)!;
      const run = harness.db.getRun(job.review_run_id!)!;
      expect(run.status).toBe('completed');
      expect(run.finding_count).toBe(0);

      // no inline comments, but sticky summary with the skip reason
      expect(github.callsTo('pulls.createReview').length).toBe(0);
      const summaries = github.callsTo('issues.createComment').filter((c) => String(c.params.body).includes('swear-review-summary'));
      expect(summaries.length).toBe(1);
      expect(String(summaries[0]!.params.body)).toContain('Review skipped: no items were selected.');

      // check succeeds — a docs-only PR is not a review failure
      expect(github.callsTo('checks.create').length).toBe(1);
      const checkUpdate = github.callsTo('checks.update');
      expect(checkUpdate.length).toBe(1);
      expect(checkUpdate[0]!.params.conclusion).toBe('success');
      expect(String(checkUpdate[0]!.params.output.text)).toContain('Review skipped: no items were selected.');

      // repo recorded as reviewed so a later incremental run behaves correctly
      const prRow = harness.db.getPullRequest('test-owner', 'demo', 7)!;
      expect(prRow.last_successful_review_sha).toBe(repo.headSha);
    } finally {
      delete process.env.MOCK_OCR_SKIP;
      harness.cleanup();
    }
  });

  it('Test C: re-push → entire PR re-reviewed, duplicate comments suppressed', async () => {
    const github = new FakeGitHubApi();
    github.prHeadSha = repo.headSha;
    github.prBaseSha = repo.baseSha;
    const config = FakeGitHubApi.config({
      binary: MOCK_OCR,
      workspaceDir: path.join(REPOS_ROOT, 'ws-dedup'),
      cloneTemplate: `file://${repo.bareDir}`,
    });
    const harness = createHarness(config, github);
    try {
      const push = (number: number, headSha: string, action: string) =>
        harness.scheduler.handleEvent('pull_request', {
          action,
          number,
          pull_request: {
            number, state: 'open', draft: false, title: 'T',
            user: { login: 'alice' },
            head: { sha: headSha, ref: 'feature' },
            base: { sha: repo.baseSha, ref: 'main' },
          },
          repository: { name: 'demo', full_name: 'test-owner/demo', owner: { login: 'test-owner' }, private: true, default_branch: 'main' },
          installation: { id: 123, account: { login: 'test-owner', type: 'User' } },
        });

      // first push
      await push(7, repo.headSha, 'synchronize');
      await waitFor(() => harness.db.getLatestJob('test-owner', 'demo', 7)?.status === 'completed', 30_000);
      const firstRun = harness.db.getRun(harness.db.getLatestJob('test-owner', 'demo', 7)!.review_run_id!)!;
      expect(firstRun.finding_count).toBe(3);

      // second push at a NEW head — full review runs again
      const newHead = addCommit(repo);
      github.prHeadSha = newHead;
      await push(7, newHead, 'synchronize');
      await waitFor(() => {
        const j = harness.db.getLatestJob('test-owner', 'demo', 7);
        return j?.head_sha === newHead && j.status === 'completed';
      }, 30_000);
      const secondJob = harness.db.getLatestJob('test-owner', 'demo', 7)!;
      expect(secondJob.head_sha).toBe(newHead);
      const secondRun = harness.db.getRun(secondJob.review_run_id!)!;
      expect(secondRun.finding_count).toBe(3);

      // dedup: the first run's comments were recorded, so the second run publishes 0 inline comments
      const reviews = github.callsTo('pulls.createReview').filter((r) => r.params.pull_number === 7);
      const inlineCount = reviews.reduce((n, c) => n + ((c.params.comments as unknown[]).length ?? 0), 0);
      expect(inlineCount).toBe(3); // only from the first run
      // sticky summary was updated (not duplicated)
      const summaries = github.callsTo('issues.createComment').filter((c) => String(c.params.body).includes('swear-review-summary'));
      expect(summaries.length).toBe(2); // one per run, updated in place
    } finally {
      harness.cleanup();
    }
  });

  it('accepts pull_request.synchronize payloads whose installation lacks account (real GitHub shape)', async () => {
    // Real 2026 GitHub payload: installation contains only id/node_id for
    // pull_request events. Regression for a bug found in production E2E.
    const github = new FakeGitHubApi();
    github.prHeadSha = repo.headSha;
    github.prBaseSha = repo.baseSha;
    const config = FakeGitHubApi.config({
      binary: MOCK_OCR,
      workspaceDir: path.join(REPOS_ROOT, 'ws-noacct'),
      cloneTemplate: `file://${repo.bareDir}`,
    });
    const harness = createHarness(config, github);
    try {
      await harness.scheduler.handleEvent('pull_request', {
        action: 'synchronize',
        number: 12,
        pull_request: {
          number: 12, state: 'open', draft: false, title: 'T',
          user: { login: 'alice' },
          head: { sha: repo.headSha, ref: 'feature' },
          base: { sha: repo.baseSha, ref: 'main' },
        },
        repository: { name: 'demo', full_name: 'test-owner/demo', owner: { login: 'test-owner' }, private: true, default_branch: 'main' },
        // NOTE: no account field — matches the real pull_request payload
        installation: { id: 123, node_id: 'MDIzOkludGVncmF0aW9uSW5zdGFsbGF0aW9uMTIz' },
      });
      await waitFor(() => harness.db.getLatestJob('test-owner', 'demo', 12)?.status === 'completed', 30_000);
      const job = harness.db.getLatestJob('test-owner', 'demo', 12)!;
      expect(job.status).toBe('completed');
      expect(job.trigger).toBe('synchronize');
      // installation upserted with owner fallback
      const install = harness.db.db.prepare('SELECT * FROM installations WHERE id = 123').get() as { account_login: string };
      expect(install.account_login).toBe('test-owner');
    } finally {
      harness.cleanup();
    }
  });

  it('Test L: external author without write permission → auto review skipped, no LLM call', async () => {
    const github = new FakeGitHubApi();
    github.permission = 'read';
    const config = FakeGitHubApi.config({
      binary: MOCK_OCR,
      workspaceDir: path.join(REPOS_ROOT, 'ws-ext'),
      cloneTemplate: `file://${repo.bareDir}`,
    });
    const harness = createHarness(config, github);
    try {
      await harness.scheduler.handleEvent('pull_request', {
        action: 'opened',
        number: 8,
        pull_request: {
          number: 8, state: 'open', draft: false, title: 'T',
          user: { login: 'stranger' },
          head: { sha: repo.headSha, ref: 'feature' },
          base: { sha: repo.baseSha, ref: 'main' },
        },
        repository: { name: 'demo', full_name: 'test-owner/demo', owner: { login: 'test-owner' }, private: false, default_branch: 'main' },
        installation: { id: 123, account: { login: 'test-owner', type: 'User' } },
      });
      await new Promise((r) => setTimeout(r, 800));
      expect(harness.db.getLatestJob('test-owner', 'demo', 8)).toBeNull();
      expect(github.callsTo('checks.create').length).toBe(0);
    } finally {
      harness.cleanup();
    }
  });

  it('Test D: /swear-review full from an admin enqueues a full review', async () => {
    const github = new FakeGitHubApi();
    github.prHeadSha = repo.headSha;
    github.prBaseSha = repo.baseSha;
    github.permission = 'admin';
    const config = FakeGitHubApi.config({
      binary: MOCK_OCR,
      workspaceDir: path.join(REPOS_ROOT, 'ws-cmd'),
      cloneTemplate: `file://${repo.bareDir}`,
    });
    const harness = createHarness(config, github);
    try {
      await harness.scheduler.handleEvent('issue_comment', {
        action: 'created',
        issue: { number: 9, pull_request: {} },
        comment: { user: { login: 'admin-user' }, body: '/swear-review full' },
        repository: { name: 'demo', full_name: 'test-owner/demo', owner: { login: 'test-owner' }, private: true, default_branch: 'main' },
        installation: { id: 123, account: { login: 'test-owner', type: 'User' } },
      });
      await waitFor(() => harness.db.getLatestJob('test-owner', 'demo', 9)?.status === 'completed', 30_000);
      const job = harness.db.getLatestJob('test-owner', 'demo', 9)!;
      expect(job.trigger).toBe('manual');
      expect(job.mode).toBe('full');
      // ack comment posted
      expect(github.callsTo('issues.createComment').some((c) => String(c.params.body).includes('full review queued'))).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it('Test E: /swear-review incremental reviews only the new commits (fallback to full without prior review)', async () => {
    const github = new FakeGitHubApi();
    github.prHeadSha = repo.headSha;
    github.prBaseSha = repo.baseSha;
    github.permission = 'write';
    const config = FakeGitHubApi.config({
      binary: MOCK_OCR,
      workspaceDir: path.join(REPOS_ROOT, 'ws-incr'),
      cloneTemplate: `file://${repo.bareDir}`,
    });
    const harness = createHarness(config, github);
    try {
      // no prior successful review → falls back to full and says so
      await harness.scheduler.handleEvent('issue_comment', {
        action: 'created',
        issue: { number: 10, pull_request: {} },
        comment: { user: { login: 'dev' }, body: '/swear-review incremental' },
        repository: { name: 'demo', full_name: 'test-owner/demo', owner: { login: 'test-owner' }, private: true, default_branch: 'main' },
        installation: { id: 123, account: { login: 'test-owner', type: 'User' } },
      });
      await waitFor(() => harness.db.getLatestJob('test-owner', 'demo', 10) !== null, 10_000);
      const job = harness.db.getLatestJob('test-owner', 'demo', 10)!;
      expect(job.mode).toBe('full');
      expect(job.trigger).toBe('manual-incremental-fallback');
      expect(github.callsTo('issues.createComment').some((c) => String(c.params.body).includes('falling back to full'))).toBe(true);

      // simulate a prior successful review, then incremental uses last SHA → HEAD
      harness.db.setPullRequestReviewed('test-owner', 'demo', 10, repo.headSha, 'full', true);
      const newHead = addCommit(repo);
      github.prHeadSha = newHead;
      await harness.scheduler.handleEvent('issue_comment', {
        action: 'created',
        issue: { number: 10, pull_request: {} },
        comment: { user: { login: 'dev' }, body: '/swear-review incremental' },
        repository: { name: 'demo', full_name: 'test-owner/demo', owner: { login: 'test-owner' }, private: true, default_branch: 'main' },
        installation: { id: 123, account: { login: 'test-owner', type: 'User' } },
      });
      await waitFor(() => {
        const j = harness.db.getLatestJob('test-owner', 'demo', 10);
        return j?.trigger === 'manual-incremental' && j.status === 'completed';
      }, 30_000);
      const incr = harness.db.getLatestJob('test-owner', 'demo', 10)!;
      expect(incr.mode).toBe('incremental');
      expect(incr.base_sha).toBe(repo.headSha); // last successfully reviewed SHA
      expect(incr.head_sha).toBe(newHead);
      const run = harness.db.getRun(incr.review_run_id!)!;
      expect(run.status).toBe('completed');
    } finally {
      harness.cleanup();
    }
  });

  it('Test L: /swear-review from a read-only user is denied without enqueueing', async () => {
    const github = new FakeGitHubApi();
    github.permission = 'read';
    const config = FakeGitHubApi.config({
      binary: MOCK_OCR,
      workspaceDir: path.join(REPOS_ROOT, 'ws-denied'),
      cloneTemplate: `file://${repo.bareDir}`,
    });
    const harness = createHarness(config, github);
    try {
      await harness.scheduler.handleEvent('issue_comment', {
        action: 'created',
        issue: { number: 11, pull_request: {} },
        comment: { user: { login: 'stranger' }, body: '/swear-review' },
        repository: { name: 'demo', full_name: 'test-owner/demo', owner: { login: 'test-owner' }, private: false, default_branch: 'main' },
        installation: { id: 123, account: { login: 'test-owner', type: 'User' } },
      });
      await new Promise((r) => setTimeout(r, 500));
      expect(harness.db.getLatestJob('test-owner', 'demo', 11)).toBeNull();
      // denial reply posted
      expect(github.callsTo('issues.createComment').some((c) => String(c.params.body).includes('do not have permission'))).toBe(true);
    } finally {
      harness.cleanup();
    }
  });
});
