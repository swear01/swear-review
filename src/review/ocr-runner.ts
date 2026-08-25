import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { Logger } from '../util/logger.js';

export interface OcrProcessResult {
  stdout: string;
  stderrTail: string;
  exitCode: number | null;
  timedOut: boolean;
  killed: boolean;
  signalName: string | null;
}

export interface OcrRunInput {
  baseSha: string;
  headSha: string;
  concurrency: number;
  timeoutMinutes: number;
  hardTimeoutMinutes: number;
  binary: string;
  repoDir: string;
  /** isolated HOME for the OCR process (sessions, update state) */
  homeDir: string;
  ocrEnv: Record<string, string>;
  signal?: AbortSignal;
  log: Logger;
}

/**
 * Runs `ocr review --from <base> --to <head> --concurrency 16 --format json`.
 *
 * OCR implements its own SDK retry loop (LLM client with MaxRetries). Swear
 * Review deliberately adds NO outer retry and NO concurrency fallback to avoid
 * retry amplification.
 */
export async function runOcr(input: OcrRunInput): Promise<OcrProcessResult> {
  const args = [
    'review',
    '--from', input.baseSha,
    '--to', input.headSha,
    '--concurrency', String(input.concurrency),
    '--format', 'json',
    '--audience', 'agent',
    '--timeout', String(input.timeoutMinutes),
    '--repo', input.repoDir,
  ];

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: input.homeDir,
    OCR_NO_UPDATE: '1',
    NO_COLOR: '1',
    ...input.ocrEnv,
  };

  let child: ChildProcess;
  try {
    child = spawn(input.binary, args, {
      cwd: input.repoDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
  } catch (err) {
    throw new Error(`Failed to spawn OCR binary "${input.binary}": ${(err as Error).message}`);
  }

  let stdout = '';
  let stderr = '';
  const stdoutCap = 64 * 1024 * 1024;
  const stderrCap = 2 * 1024 * 1024;

  child.stdout?.on('data', (chunk: Buffer) => {
    if (stdout.length < stdoutCap) stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < stderrCap) stderr += chunk.toString('utf8');
  });

  let timedOut = false;
  let killedBySignal = false;
  let forceKill: NodeJS.Timeout | undefined;
  child.once('exit', () => {
    if (timedOut || killedBySignal) {
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
    if (forceKill && !processGroupExists(child)) clearTimeout(forceKill);
  });
  const hardKill = setTimeout(() => {
    timedOut = true;
    killProcessGroup(child, 'SIGKILL');
  }, input.hardTimeoutMinutes * 60_000);
  hardKill.unref();

  const abortHandler = () => {
    killedBySignal = true;
    killProcessGroup(child, 'SIGTERM');
    forceKill = setTimeout(() => {
      killProcessGroup(child, 'SIGKILL');
    }, 5000).unref();
  };
  input.signal?.addEventListener('abort', abortHandler, { once: true });

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('close', (code, signal) => {
      resolve(code ?? (signal ? null : null));
      void signal;
    });
    child.on('error', (err) => {
      input.log.error({ err: err.message, binary: input.binary }, 'OCR process error');
      resolve(-1);
    });
  });

  clearTimeout(hardKill);
  input.signal?.removeEventListener('abort', abortHandler);

  const result: OcrProcessResult = {
    stdout,
    stderrTail: stderr.slice(-4096),
    exitCode,
    timedOut,
    killed: killedBySignal || timedOut,
    signalName: child.signalCode,
  };

  input.log.debug(
    { exitCode, timedOut, killed: result.killed, stdoutBytes: stdout.length, stderrBytes: stderr.length, base: input.baseSha.slice(0, 7), head: input.headSha.slice(0, 7) },
    'ocr process finished',
  );
  return result;
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return;
    }
  }
  child.kill(signal);
}

function processGroupExists(child: ChildProcess): boolean {
  if (process.platform === 'win32' || !child.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export function createOcrHome(workspaceDir: string): string {
  return path.join(workspaceDir, 'ocr-home');
}
