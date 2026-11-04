// Real OCR selection and prompt smoke test; never calls a model.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const app = path.resolve(process.argv[2] ?? '.');
const { prepareOcrRules } = await import(pathToFileURL(path.join(app, 'dist/review/ocr-rules.js')));
const root = mkdtempSync(path.join(tmpdir(), 'swear-cuda-smoke-'));
const repo = path.join(root, 'repo');
const home = path.join(root, 'home');
mkdirSync(repo);
mkdirSync(home);
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
try {
  git('init', '-q');
  git('config', 'user.name', 'CUDA smoke');
  git('config', 'user.email', 'cuda-smoke@example.invalid');
  const gpuFiles = ['src/kernel.cu', 'src/kernel.cuh', 'src/kernel.hip', '!prefix/kernel.cu'];
  const files = [...gpuFiles, 'src/main.cpp', 'fixtures/kernel.cu'];
  for (const file of files) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), 'int value = 0;\n');
  }
  git('add', '.');
  git('commit', '-qm', 'base');
  for (const file of files) writeFileSync(path.join(repo, file), 'int value = 1;\n');
  git('commit', '-qam', 'change');
  const env = { ...process.env, HOME: home, OCR_NO_UPDATE: '1', NO_COLOR: '1' };
  const ocr = (...args) => execFileSync('ocr', args, { cwd: repo, env, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL' });
  const preview = (...extra) => JSON.parse(ocr('review', '--preview', '--format', 'json', '--from', 'HEAD~1', '--to', 'HEAD', '--repo', repo, ...extra));
  assert.equal(preview().reviewable_count, 1);
  const rules = await prepareOcrRules(repo, home);
  const result = preview('--rule', rules);
  assert.equal(result.reviewable_count, 5);
  assert.deepEqual(result.files.filter(f => f.will_review).map(f => f.path).sort(), files.filter(f => !f.startsWith('fixtures/')).sort());
  for (const file of gpuFiles) {
    assert.match(ocr('rules', 'check', '--repo', repo, '--rule', rules, file), /CUDA and HIP Kernel Review Principles/);
  }
  assert.ok(ocr('rules', 'check', '--repo', repo, '--rule', rules, 'src/main.cpp').includes('Pattern: **/*.{cpp,cc,cxx,hpp,hxx}'));
  assert.equal(git('status', '--porcelain'), '');
  console.log('CUDA/HIP: 4 GPU files selected with upstream rules; C++ and fixture exclusions preserved. No model calls.');
} finally {
  rmSync(root, { recursive: true, force: true });
}
