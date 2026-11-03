import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness, prEventPayload, waitFor } from '../helpers/harness.js';
import { createLocalRepo, cleanupLocalRepo, type LocalRepo } from '../helpers/local-repo.js';
import { FakeGitHubApi } from '../helpers/fake-github.js';

const binary = path.join(path.dirname(fileURLToPath(import.meta.url)), '../helpers/mock-ocr.mjs');
let repo: LocalRepo;
beforeAll(() => { repo = createLocalRepo(); });
afterAll(() => cleanupLocalRepo(repo));

describe('ChatGPT quota fallback', () => {
  it.each([
    ['disabled', false, {}, 'failed', 1],
    ['primary success', true, { MOCK_OCR_QUOTA: '0' }, 'completed', 1],
    ['quota exhausted', true, {}, 'completed', 2],
    ['authentication failure', true, { MOCK_OCR_HTTP_STATUS: '401', MOCK_OCR_ERROR_CLASS: 'authentication' }, 'failed', 1],
    ['provider overload', true, { MOCK_OCR_HTTP_STATUS: '503', MOCK_OCR_ERROR_CLASS: 'overloaded' }, 'failed', 1],
    ['token budget failure', true, { MOCK_OCR_FAILURE_CLASS: 'budget' }, 'failed', 1],
    ['fallback fails once', true, { MOCK_OCR_FALLBACK_FAIL: '1' }, 'failed', 2],
    ['partial quota', true, { MOCK_OCR_PARTIAL_QUOTA: '1' }, 'completed', 2],
    ['partial quota and fallback failure', true, { MOCK_OCR_PARTIAL_QUOTA: '1', MOCK_OCR_FALLBACK_FAIL: '1' }, 'failed', 2],
    ['fallback skips selected files', true, { MOCK_OCR_FALLBACK_SKIP: '1' }, 'failed', 2],
    ['cancel during fallback', true, { MOCK_OCR_FALLBACK_SLEEP_MS: '3000' }, 'cancelled', 2],
    ['primary timeout', true, { MOCK_OCR_PRIMARY_SLEEP_MS: '3000' }, 'cancelled', 1],
    ['shared hard deadline', true, { MOCK_OCR_PRIMARY_SLEEP_MS: '250', MOCK_OCR_FALLBACK_SLEEP_MS: '3000' }, 'cancelled', 2],
    ['partial quota and fallback timeout', true, { MOCK_OCR_PARTIAL_QUOTA: '1', MOCK_OCR_FALLBACK_SLEEP_MS: '3000' }, 'failed', 2],
  ] as const)('%s', async (_name, enabled, extraEnv, status, expectedAttempts) => {
    const root = mkdtempSync(path.join(tmpdir(), 'swear-chatgpt-'));
    const authDir = path.join(root, 'auth');
    mkdirSync(authDir, { mode: 0o700 });
    for (const file of ['accounts.json', 'host.json']) writeFileSync(path.join(authDir, file), '{}', { mode: 0o600 });
    const attemptsFile = path.join(root, 'attempts.jsonl');
    const config = FakeGitHubApi.config({ binary, workspaceDir: path.join(root, 'ws'), cloneTemplate: `file://${repo.bareDir}` });
    config.gate.mode = 'check';
    config.ocr.extra_env = { MOCK_OCR_QUOTA: '1', MOCK_OCR_ATTEMPTS_FILE: attemptsFile, ...extraEnv };
    if (['primary timeout', 'shared hard deadline', 'partial quota and fallback timeout'].includes(_name)) config.ocr.hard_timeout_minutes = 0.01;
    if (enabled) config.llm.chatgpt_fallback = { auth_dir: authDir, model: 'chatgpt-test' };
    const github = new FakeGitHubApi();
    github.prBaseSha = repo.baseSha;
    github.prHeadSha = repo.headSha;
    const harness = createHarness(config, github);
    try {
      const event = prEventPayload();
      event.pull_request = { ...(event.pull_request as object), head: { sha: repo.headSha }, base: { sha: repo.baseSha } };
      await harness.scheduler.handleEvent('pull_request', event);
      if (_name === 'cancel during fallback') {
        await waitFor(() => existsSync(attemptsFile) && readFileSync(attemptsFile, 'utf8').trim().split('\n').length === 2);
        harness.worker.requestCancel(harness.db.getLatestJob('test-owner', 'demo', 42)!.id);
      }
      await waitFor(() => ['completed', 'failed', 'cancelled'].includes(harness.db.getLatestJob('test-owner', 'demo', 42)?.status ?? ''));
      const job = harness.db.getLatestJob('test-owner', 'demo', 42)!;
      expect(job.status).toBe(status);
      if (status !== 'completed') expect(harness.db.getPullRequest('test-owner', 'demo', 42)?.last_successful_review_sha).toBeNull();
      const attempts = readFileSync(attemptsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(attempts).toHaveLength(expectedAttempts);
      if (expectedAttempts === 2) {
        expect(attempts[1]).toMatchObject({ from: attempts[0].from, to: attempts[0].to, concurrency: attempts[0].concurrency, timeout: attempts[0].timeout, chatgpt: true, model: 'chatgpt-test' });
        if (status !== 'cancelled') {
          expect(harness.db.getRun(job.review_run_id!)!.model).toContain('chatgpt-test');
          expect(github.callsTo('issues.createComment').some((call) => String(call.params.body).includes('chatgpt-test'))).toBe(true);
        }
      }
      if ('MOCK_OCR_PARTIAL_QUOTA' in extraEnv) {
        expect(github.callsTo('issues.createComment').some((call) => String(call.params.body).includes('Useful primary finding'))).toBe(true);
      }
      expect(readFileSync(path.join(authDir, 'host.json'), 'utf8')).toBe('{}');
      expect(existsSync(authDir)).toBe(true);
    } finally {
      harness.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
