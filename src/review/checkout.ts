import { execFile } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import type { Logger } from '../util/logger.js';

const execFileAsync = promisify(execFile);

export interface CheckoutResult {
  workspaceDir: string;
  repoDir: string;
  /** merge-base(baseSha, headSha) for full reviews */
  mergeBase: string;
}

export interface CheckoutInput {
  installationToken: string;
  owner: string;
  repo: string;
  baseSha: string;
  headSha: string;
  workspaceRoot: string;
  jobId: number;
  cloneUrlTemplate?: string;
  partialClone?: boolean;
  log: Logger;
  signal?: AbortSignal;
}

/**
 * Fresh per-job clone with:
 *  - hooks disabled (core.hooksPath=/dev/null) — PR code is never executed
 *  - blob:none partial clone (history + trees, blobs fetched lazily at checkout)
 *  - auth via http.extraHeader passed through the environment (never argv)
 *  - merge-base computed between base and head for full-PR semantics
 */
export async function checkoutRepository(input: CheckoutInput): Promise<CheckoutResult> {
  const workspaceDir = path.join(input.workspaceRoot, `job-${input.jobId}`);
  const repoDir = path.join(workspaceDir, 'repo');
  mkdirSync(workspaceDir, { recursive: true });

  const gitEnv = buildGitEnv(input.installationToken);
  const template = input.cloneUrlTemplate ?? 'https://github.com/{owner}/{repo}.git';
  const cloneUrl = template.replace('{owner}', input.owner).replace('{repo}', input.repo);
  const cloneArgs = ['clone', '-c', 'core.hooksPath=/dev/null', '--no-checkout', '--quiet'];
  const usePartialClone = input.partialClone !== false && cloneUrl.startsWith('https://');
  if (usePartialClone) cloneArgs.push('--filter=blob:none');
  cloneArgs.push(cloneUrl, repoDir);

  await runGit(cloneArgs, { cwd: workspaceDir, env: gitEnv, signal: input.signal, log: input.log, context: 'clone' });

  await runGit(
    ['fetch', '--quiet', 'origin', input.baseSha, input.headSha],
    { cwd: repoDir, env: gitEnv, signal: input.signal, log: input.log, context: 'fetch shas' },
  );

  let mergeBase = '';
  try {
    const res = await runGit(
      ['merge-base', input.baseSha, input.headSha],
      { cwd: repoDir, env: gitEnv, signal: input.signal, log: input.log, context: 'merge-base', capture: true },
    );
    mergeBase = res.stdout.trim();
  } catch {
    mergeBase = '';
  }

  // Deepen if merge-base is unknown (shallow boundary). Loop a few times.
  for (let attempt = 0; mergeBase === '' && attempt < 3; attempt++) {
    await runGit(
      ['fetch', '--deepen=200', '--quiet', 'origin'],
      { cwd: repoDir, env: gitEnv, signal: input.signal, log: input.log, context: `deepen ${attempt + 1}` },
    );
    try {
      const res = await runGit(
        ['merge-base', input.baseSha, input.headSha],
        { cwd: repoDir, env: gitEnv, signal: input.signal, log: input.log, context: 'merge-base retry', capture: true },
      );
      mergeBase = res.stdout.trim();
    } catch {
      mergeBase = '';
    }
  }

  if (mergeBase === '') {
    throw new Error(`Unable to compute merge-base between ${input.baseSha} and ${input.headSha}`);
  }

  await runGit(
    ['-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '--detach', input.headSha],
    { cwd: repoDir, env: gitEnv, signal: input.signal, log: input.log, context: 'checkout head' },
  );

  return { workspaceDir, repoDir, mergeBase };
}

export function cleanupWorkspace(workspaceDir: string): void {
  try {
    rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/**
 * Auth is injected through git config environment variables so the
 * installation token never appears in argv or process listings.
 * GitHub's git smart-HTTP accepts `AUTHORIZATION: basic <base64(x-access-token:TOKEN)>`
 * (the GitHub Actions pattern); `Bearer` is rejected by git endpoints.
 *
 * Also returned to callers so the OCR process (and its git subprocesses, which
 * lazy-fetch blobs in a partial clone) inherits the same auth.
 */
export function buildGitEnv(token: string): NodeJS.ProcessEnv {
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_CONFIG_KEY_1: 'http.version',
    GIT_CONFIG_VALUE_1: 'HTTP/1.1',
    GIT_CONFIG_KEY_2: 'protocol.version',
    GIT_CONFIG_VALUE_2: '2',
  };
}

interface RunGitOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  log: Logger;
  context: string;
  capture?: boolean;
}

async function runGit(args: string[], opts: RunGitOptions): Promise<{ stdout: string }> {
  if (opts.signal?.aborted) {
    throw new Error('aborted');
  }
  try {
    const res = await execFileAsync('git', args, {
      cwd: opts.cwd,
      env: opts.env,
      signal: opts.signal,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout: res.stdout ?? '' };
  } catch (err) {
    const e = err as { code?: number | string; killed?: boolean; stdout?: string; stderr?: string };
    if (opts.signal?.aborted || e.killed) {
      throw new Error(`git ${opts.context} aborted`);
    }
    opts.log.warn(
      { context: opts.context, args: args.slice(0, 3).join(' '), code: e.code, stderr: (e.stderr ?? '').slice(-500) },
      'git command failed',
    );
    throw new Error(`git ${opts.context} failed: ${e.stderr ?? e.code ?? 'unknown error'}`);
  }
}
