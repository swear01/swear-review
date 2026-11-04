import { execFile } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import micromatch from 'micromatch';
import { z } from 'zod';

const filters = z.object({
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
});
const execFileAsync = promisify(execFile);
const matchOptions = { nonegate: true, noext: true, nocase: true, dot: true };
// Doublestar treats parentheses and pipes literally; micromatch still parses them with noext.
const matcher = (pattern: string) => micromatch.matcher(pattern.replace(/\\.|[()|]/g,
  (value) => value.startsWith('\\') ? value : `\\${value}`), matchOptions);
const defaultExcludes = (JSON.parse(readFileSync(new URL('../../config/ocr-default-excludes.json', import.meta.url), 'utf8')) as string[])
  .map(matcher);
const cudaRules = readFileSync(new URL('../../config/ocr-cuda-hip.md', import.meta.url), 'utf8');

export async function prepareOcrRules(repoDir: string, homeDir: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const project = projectFilters(repoDir);
  const projectIncludes = project.include.map(matcher);
  const projectExcludes = project.exclude.map(matcher);
  const { stdout: tracked } = await execFileAsync('git', ['-C', repoDir, 'ls-files', '-z'], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 30_000, signal,
  });
  signal?.throwIfAborted();
  const include = tracked.split('\0').filter((file) => /\.(?:cu|cuh|hip)$/i.test(file)
    && !projectExcludes.some((matches) => matches(file))
    && !projectIncludes.some((matches) => matches(file))
    && !defaultExcludes.some((matches) => matches(file)))
    .map((file) => {
      // shortcut: brace paths fail closed until OCR supports literal brace escaping.
      if (/[{}]/.test(file)) throw new Error('OCR CUDA file paths cannot contain braces');
      return file.replace(/[\\*?\[\]]/g, '\\$&');
    });
  const directory = path.join(homeDir, '.opencodereview');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Keep untrusted project rules in their native layer so OCR confines their file references.
  writeFileSync(path.join(directory, 'rule.json'), JSON.stringify({ rules: [{
    path: '**/*.{cu,cuh,hip}', rule: cudaRules, merge_system_rule: true,
  }] }), { mode: 0o600 });
  const customFile = path.join(directory, 'swear-review-filter.json');
  writeFileSync(customFile, JSON.stringify({ include: [...project.include, ...include], exclude: project.exclude }), { mode: 0o600 });
  return customFile;
}

function projectFilters(repoDir: string): z.infer<typeof filters> {
  const file = path.join(repoDir, '.opencodereview', 'rule.json');
  try {
    lstatSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return filters.parse({});
    throw err;
  }
  let resolved: string;
  try {
    resolved = realpathSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('OCR rules must be a regular file inside the reviewed repository');
    }
    throw err;
  }
  const relative = path.relative(realpathSync(repoDir), resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !statSync(resolved).isFile()) {
    throw new Error('OCR rules must be a regular file inside the reviewed repository');
  }
  return filters.parse(JSON.parse(readFileSync(resolved, 'utf8')));
}
