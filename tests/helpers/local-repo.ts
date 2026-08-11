import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export interface LocalRepo {
  dir: string; // working repo with branches
  bareDir: string; // bare clone used as the "remote"
  baseSha: string;
  headSha: string;
}
const git = (args: string[], cwd: string) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * Creates a local git repository with a base commit on `main` and a feature
 * commit on `feature`, plus a bare clone to act as the remote.
 */
export function createLocalRepo(opts?: { featureFile?: string }): LocalRepo {
  const root = mkdtempSync(path.join(os.tmpdir(), 'swear-repo-'));
  const dir = path.join(root, 'repo');
  mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  mkdirSync(path.join(dir, 'src'), { recursive: true });

  writeFileSync(path.join(dir, 'src/main.ts'), [
    'export function process(input: string | null): string {',
    '  const trimmed = input.trim();',
    '  return trimmed.toUpperCase();',
    '}',
    '',
  ].join('\n'));
  git(['add', '.'], dir);
  git(['commit', '-qm', 'base'], dir);
  const baseSha = git(['rev-parse', 'HEAD'], dir).trim();

  git(['checkout', '-qb', 'feature'], dir);
  const extra = opts?.featureFile ?? '';
  writeFileSync(path.join(dir, 'src/main.ts'), [
    'export function process(input: string | null): string {',
    '  const trimmed = input.trim();',
    '  return trimmed.toUpperCase();',
    '}',
    '',
    'export function loadItems(ids: number[]): string[] {',
    '  const out: string[] = [];',
    '  for (const id of ids) {',
    '    out.push(fetchItem(id));',
    '  }',
    '  return out;',
    '}',
    '',
    'function fetchItem(id: number): string { return String(id); }',
    extra,
    '',
  ].join('\n'));
  git(['add', '.'], dir);
  git(['commit', '-qm', 'feature'], dir);
  const headSha = git(['rev-parse', 'HEAD'], dir).trim();

  const bareDir = path.join(root, 'remote.git');
  git(['clone', '-q', '--bare', dir, bareDir], root);
  git(['remote', 'add', 'origin', bareDir], dir);
  git(['push', '-q', 'origin', 'main', 'feature'], dir);

  return { dir, bareDir, baseSha, headSha };
}

/** Creates an additional commit on the feature branch and pushes it. */
export function addCommit(repo: LocalRepo, content?: string): string {
  const n = Date.now();
  const extra = content ?? `
export function extraFunction${n}(): number {
  return ${n};
}`;
  const p = path.join(repo.dir, `src/extra-${n}.ts`);
  writeFileSync(p, extra);
  git(['add', '.'], repo.dir);
  git(['commit', '-qm', `feature2-${n}`], repo.dir);
  const sha = git(['rev-parse', 'HEAD'], repo.dir).trim();
  git(['push', '-q', 'origin', 'feature'], repo.dir);
  return sha;
}

export function cleanupLocalRepo(repo: LocalRepo): void {
  rmSync(path.dirname(repo.bareDir), { recursive: true, force: true });
  rmSync(repo.dir, { recursive: true, force: true });
}

export function ensureTempReposDir(): string {
  const dir = '/tmp/swear-review-test-repos';
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
