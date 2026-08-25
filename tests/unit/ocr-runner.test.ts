import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runOcr } from '../../src/review/ocr-runner.js';
import { createLogger } from '../../src/util/logger.js';

const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'helpers', 'stubborn-ocr.mjs');
let root: string;

beforeAll(() => {
  chmodSync(helper, 0o755);
  root = mkdtempSync(path.join(tmpdir(), 'swear-review-ocr-runner-'));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('runOcr', () => {
  it.each([
    ['aborted', true],
    ['hard timeout expires', false],
  ])('terminates the OCR process group promptly when %s', async (_reason, abort) => {
    const controller = new AbortController();
    const pidFile = path.join(root, `grandchild-${abort}.pid`);
    let grandchildPid = 0;
    const startedAt = Date.now();
    try {
      const run = runOcr({
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        concurrency: 4,
        timeoutMinutes: 10,
        hardTimeoutMinutes: abort ? 1 : 0.01,
        binary: helper,
        repoDir: root,
        homeDir: root,
        ocrEnv: { STUBBORN_PID_FILE: pidFile },
        signal: controller.signal,
        log: createLogger('silent'),
      });
      while (!existsSync(pidFile) && Date.now() - startedAt < 1000) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      grandchildPid = Number(readFileSync(pidFile, 'utf8'));
      if (abort) controller.abort();
      const result = await run;

      expect(result.killed).toBe(true);
      expect(result.timedOut).toBe(!abort);
      expect(Date.now() - startedAt).toBeLessThan(1000);
      if (process.platform !== 'win32') {
        const killDeadline = Date.now() + 6000;
        while (Date.now() < killDeadline) {
          try {
            process.kill(grandchildPid, 0);
            await new Promise((resolve) => setTimeout(resolve, 25));
          } catch {
            break;
          }
        }
        expect(() => process.kill(grandchildPid, 0)).toThrow();
      }
    } finally {
      if (grandchildPid > 0) {
        try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
  });
});
