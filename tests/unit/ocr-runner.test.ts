import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  it('passes repository background to OCR and rejects paths outside the checkout', async () => {
    const repoDir = mkdtempSync(path.join(root, 'background-'));
    const binary = path.join(repoDir, 'args.mjs');
    writeFileSync(binary, '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
    const input = {
      baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), concurrency: 2,
      timeoutMinutes: 15, hardTimeoutMinutes: 1, binary,
      repoDir, homeDir: root, ocrEnv: {}, log: createLogger('silent'),
    };
    expect(JSON.parse((await runOcr(input)).stdout)).not.toContain('--background-file');
    const directory = path.join(repoDir, '.opencodereview');
    mkdirSync(directory);
    const file = path.join(directory, 'background.md');
    writeFileSync(file, '# Requirements\nOutput y equals input a.\n');
    const args = JSON.parse((await runOcr(input)).stdout) as string[];
    expect(args.slice(args.indexOf('--background-file'), args.indexOf('--background-file') + 2)).toEqual(['--background-file', realpathSync(file)]);
    rmSync(file);
    mkdirSync(file);
    await expect(runOcr(input)).rejects.toThrow('regular file inside');
    rmSync(file, { recursive: true });
    const outside = path.join(root, 'outside.md');
    writeFileSync(outside, 'Must not be sent to OCR');
    symlinkSync(outside, file);
    await expect(runOcr(input)).rejects.toThrow('regular file inside');
    rmSync(directory, { recursive: true });
    symlinkSync(root, directory, 'dir');
    writeFileSync(path.join(root, 'background.md'), 'Outside parent directory');
    await expect(runOcr(input)).rejects.toThrow('regular file inside');
  });

  it('passes an optional tool definition file to OCR', async () => {
    const binary = path.join(root, 'args.mjs');
    writeFileSync(binary, '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
    const toolsFile = path.join(root, 'tools.json');
    const result = await runOcr({
      baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), concurrency: 2,
      timeoutMinutes: 15, hardTimeoutMinutes: 1, binary, toolsFile,
      repoDir: root, homeDir: root, ocrEnv: {}, log: createLogger('silent'),
    });
    const args = JSON.parse(result.stdout) as string[];
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', toolsFile]);
  });

  it('gives each OCR process a stable, distinct session header while preserving extra headers', async () => {
    const binary = path.join(root, 'headers.mjs');
    writeFileSync(binary, '#!/usr/bin/env node\nconsole.log(process.env.OCR_LLM_EXTRA_HEADERS); console.log(process.env.OCR_LLM_EXTRA_HEADERS);\n', { mode: 0o755 });
    const input = {
      baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), concurrency: 4,
      timeoutMinutes: 10, hardTimeoutMinutes: 1, binary, repoDir: root, homeDir: root,
      ocrEnv: { OCR_LLM_EXTRA_HEADERS: 'X-Custom="one,x-opencode-session=two"' }, log: createLogger('silent'),
    };
    const runs = await Promise.all([runOcr(input), runOcr(input)]);
    for (const run of runs) {
      expect(run.exitCode).toBe(0);
      const [first, second] = run.stdout.trim().split('\n');
      expect(first).toBe(second);
      expect(first).toMatch(/^X-Custom="one,x-opencode-session=two",x-opencode-session=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    expect(runs[0].stdout).not.toBe(runs[1].stdout);
    await expect(runOcr({ ...input, ocrEnv: { OCR_LLM_EXTRA_HEADERS: 'X-Custom=yes, X-OpenCode-Session=shared' } }))
      .rejects.toThrow('managed per review');
  });

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
        hardTimeoutMinutes: abort ? 1 : 0.05,
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
      expect(result.stdout).toContain('started');
      expect(Date.now() - startedAt).toBeLessThan(abort ? 1000 : 4000);
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
