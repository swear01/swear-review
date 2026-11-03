import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
  toolsFile?: string;
  repoDir: string;
  /** isolated HOME for the OCR process (sessions, update state) */
  homeDir: string;
  ocrEnv: Record<string, string>;
  chatgpt?: { auth_dir: string; model?: string };
  signal?: AbortSignal;
  log: Logger;
}

/**
 * Runs `ocr review --from <base> --to <head> --concurrency 16 --format json`.
 *
 * OCR implements its own SDK retry loop (LLM client with MaxRetries). Swear
 * Review only retries once with opt-in ChatGPT after verified gateway quota
 * exhaustion. It never changes concurrency or retries other failures.
 */
export async function runOcr(input: OcrRunInput): Promise<OcrProcessResult> {
  input.signal?.throwIfAborted();
  if (input.chatgpt) prepareChatGptHome(input.homeDir, input.repoDir, input.chatgpt.auth_dir);
  const backgroundFile = repositoryBackgroundFile(input.repoDir);
  const args = [
    'review',
    '--from', input.baseSha,
    '--to', input.headSha,
    '--concurrency', String(input.concurrency),
    '--format', 'json',
    '--audience', 'agent',
    '--timeout', String(input.timeoutMinutes),
    '--repo', input.repoDir,
    ...(input.toolsFile ? ['--tools', input.toolsFile] : []),
    ...(backgroundFile ? ['--background-file', backgroundFile] : []),
    ...(input.chatgpt ? ['--provider', 'chatgpt', ...(input.chatgpt.model ? ['--model', input.chatgpt.model] : [])] : []),
  ];

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OCR_NO_UPDATE: '1',
    NO_COLOR: '1',
    ...input.ocrEnv,
    // Last: ocrEnv may carry process.env (buildGitEnv), whose HOME would send
    // OCR sessions to the service user's real ~/.opencodereview.
    HOME: input.homeDir,
  };
  if (input.chatgpt) {
    for (const key of ['OCR_LLM_URL', 'OCR_LLM_TOKEN', 'OCR_LLM_MODEL', 'OCR_USE_ANTHROPIC', 'OCR_LLM_PROTOCOL', 'OCR_LLM_AUTH_HEADER', 'OCR_LLM_EXTRA_HEADERS']) delete env[key];
  } else {
    const extraHeaders = env.OCR_LLM_EXTRA_HEADERS ?? '';
    if (/(?:^|,)\s*x-opencode-session\s*=/i.test(extraHeaders.replace(/"[^"]*"/g, ''))) {
      throw new Error('x-opencode-session is managed per review; remove it from OCR_LLM_EXTRA_HEADERS');
    }
    env.OCR_LLM_EXTRA_HEADERS = [extraHeaders, `x-opencode-session=${randomUUID()}`].filter(Boolean).join(',');
  }

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

function prepareChatGptHome(homeDir: string, repoDir: string, authDir: string): void {
  const directory = realpathSync(authDir);
  mkdirSync(path.dirname(homeDir), { recursive: true, mode: 0o700 });
  for (const root of [repoDir, path.dirname(homeDir)]) {
    const relative = path.relative(realpathSync(root), directory);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('ChatGPT auth_dir must be outside the review workspace');
    }
  }
  for (const file of [directory, path.join(directory, 'accounts.json'), path.join(directory, 'host.json')]) {
    const info = lstatSync(file);
    if (info.isSymbolicLink() || (file === directory ? !info.isDirectory() : !info.isFile())
      || (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) {
      throw new Error('ChatGPT auth store must contain private files owned by the service user');
    }
  }
  const configDir = path.join(homeDir, '.opencodereview');
  mkdirSync(path.join(configDir, 'auth'), { recursive: true, mode: 0o700 });
  // Share the whole auth store: OCR atomically rotates tokens under its own lock.
  symlinkSync(directory, path.join(configDir, 'auth', 'chatgpt'), 'dir');
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ providers: { chatgpt: {} } }), { mode: 0o600 });
}

function repositoryBackgroundFile(repoDir: string): string | undefined {
  const file = path.join(repoDir, '.opencodereview', 'background.md');
  try {
    lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  let resolved: string;
  try {
    resolved = realpathSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('OCR background must be a regular file inside the reviewed repository');
    }
    throw err;
  }
  const relative = path.relative(realpathSync(repoDir), resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !statSync(resolved).isFile()) {
    throw new Error('OCR background must be a regular file inside the reviewed repository');
  }
  return resolved;
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
