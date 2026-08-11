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
      const rules = created[0]!.params.rules as Array<{ type: string; parameters: { required_status_checks: Array<{ context: string }> } }>;
      expect(rules.some((r) => r.type === 'required_status_checks' && r.parameters.required_status_checks.some((c) => c.context === 'Swear Review'))).toBe(true);
      // summary reports merge blocked
      const summary = github.callsTo('issues.createComment').find((c) => String(c.params.body).includes('swear-review-summary'));
      expect(String(summary?.params.body)).toContain('Merge blocked');
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
});
