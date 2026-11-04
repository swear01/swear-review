import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareOcrRules } from '../../src/review/ocr-rules.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(files: string[] = []) {
  const root = mkdtempSync(path.join(tmpdir(), 'swear-review-rules-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  for (const file of files) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), 'source');
  }
  execFileSync('git', ['-C', repo, 'add', '.']);
  const configDir = path.join(repo, '.opencodereview');
  mkdirSync(configDir);
  return { repo, home, config: path.join(configDir, 'rule.json'), root };
}

describe('prepareOcrRules', () => {
  it('adds tracked CUDA/HIP with literal globs while retaining default exclusions', async () => {
    const { repo, home } = fixture([
      'src/kernel.cu', 'src/Header.CUH', 'src/ops.hip', 'src/a[1]*?.cu', 'src/main.cpp',
      'nested/vendor/x.cu', 'fixtures/x.cu', 'src/x.generated.cu', 'src/testdata/x.cuh',
    ]);
    const custom = JSON.parse(readFileSync(await prepareOcrRules(repo, home), 'utf8'));
    expect(custom).toEqual({ include: ['src/Header.CUH', 'src/a\\[1\\]\\*\\?.cu', 'src/kernel.cu', 'src/ops.hip'], exclude: [] });
    const global = JSON.parse(readFileSync(path.join(home, '.opencodereview', 'rule.json'), 'utf8'));
    expect(global).toMatchObject({ rules: [{ path: '**/*.{cu,cuh,hip}', merge_system_rule: true }] });
    expect(global.rules[0].rule).toContain('CUDA and HIP Kernel Review Principles');
    expect(global).not.toHaveProperty('include');
    expect(custom).not.toHaveProperty('rules');
  });

  it('preserves project filter overrides and leaves rule text and relative references in the repository', async () => {
    const { repo, home, config } = fixture(['fixtures/kernel.cu', 'src/kernel.cu']);
    const original = JSON.stringify({
      include: ['**/fixtures/**', '**/*.md'], exclude: ['src/kernel.cu'],
      rules: [{ path: '**/*.cu', rule: 'rules/team.md' }],
    });
    writeFileSync(config, original);
    const custom = JSON.parse(readFileSync(await prepareOcrRules(repo, home), 'utf8'));
    expect(custom).toEqual({ include: ['**/fixtures/**', '**/*.md'], exclude: ['src/kernel.cu'] });
    expect(readFileSync(config, 'utf8')).toBe(original);
    expect(custom).not.toHaveProperty('rules');
  });

  it('treats leading ! and extglob syntax literally like OCR', async () => {
    const { repo, home, config } = fixture([
      '!prefix/kernel.cu', '@(special)/kernel.cu', 'special/kernel.cu', 'src/kernel.cu',
    ]);
    writeFileSync(config, JSON.stringify({ exclude: ['!prefix/**', '@(special)/**'] }));
    const custom = JSON.parse(readFileSync(await prepareOcrRules(repo, home), 'utf8'));
    expect(custom).toEqual({ include: ['special/kernel.cu', 'src/kernel.cu'], exclude: ['!prefix/**', '@(special)/**'] });
  });

  it('leaves already included or excluded brace paths to the original project filters', async () => {
    const { repo, home, config } = fixture(['included/kernel{1}.cu', 'excluded/kernel{2}.cu', 'src/kernel.cu']);
    writeFileSync(config, JSON.stringify({ include: ['included/**'], exclude: ['excluded/**'] }));
    const custom = JSON.parse(readFileSync(await prepareOcrRules(repo, home), 'utf8'));
    expect(custom).toEqual({ include: ['included/**', 'src/kernel.cu'], exclude: ['excluded/**'] });
  });

  it('fails closed on git enumeration failure or cancellation', async () => {
    const { repo, home } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(prepareOcrRules(repo, home, controller.signal)).rejects.toThrow();
    rmSync(path.join(repo, '.git'), { recursive: true });
    await expect(prepareOcrRules(repo, home)).rejects.toThrow();
  });

  it.each([{ include: 'src/**' }, { exclude: [1] }, { include: null }, [], 'invalid'])('rejects malformed filter configuration %j', async (value) => {
    const { repo, home, config } = fixture();
    writeFileSync(config, JSON.stringify(value));
    await expect(prepareOcrRules(repo, home)).rejects.toThrow();
  });

  it('rejects escaping symlinks, dangling symlinks, directories, and malformed JSON', async () => {
    const { repo, home, config, root } = fixture();
    const outside = path.join(root, 'outside.json');
    writeFileSync(outside, '{}');
    symlinkSync(outside, config);
    await expect(prepareOcrRules(repo, home)).rejects.toThrow('regular file inside');
    rmSync(config);
    symlinkSync(path.join(root, 'missing.json'), config);
    await expect(prepareOcrRules(repo, home)).rejects.toThrow('regular file inside');
    rmSync(config);
    mkdirSync(config);
    await expect(prepareOcrRules(repo, home)).rejects.toThrow('regular file inside');
    rmSync(config, { recursive: true });
    writeFileSync(config, '{');
    await expect(prepareOcrRules(repo, home)).rejects.toThrow();
  });

  it('rejects a literal brace path rather than broadening its include glob', async () => {
    const { repo, home } = fixture(['src/kernel{1}.cu']);
    await expect(prepareOcrRules(repo, home)).rejects.toThrow('cannot contain braces');
  });
});
