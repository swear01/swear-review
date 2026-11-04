#!/usr/bin/env node
// Mock OCR binary for tests. Emits a v1.9.0-style JSON manifest and
// echoes the exact invocation args so tests can assert:
//   --from <immutable merge-base SHA>  --to <head SHA>  --concurrency 16  --format json
// Set MOCK_OCR_FAIL=1 to simulate an OCR/LLM infrastructure failure.
// Set MOCK_OCR_SESSION=1 to write a session file under $HOME like real OCR.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const args = process.argv.slice(2);
const get = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const from = get('--from');
const to = get('--to');
const concurrency = get('--concurrency');
const format = get('--format');
const repo = get('--repo');
const timeout = get('--timeout');
const chatgpt = get('--provider') === 'chatgpt';
if (process.env.MOCK_OCR_ATTEMPTS_FILE) appendFileSync(process.env.MOCK_OCR_ATTEMPTS_FILE, JSON.stringify({ from, to, concurrency, timeout, chatgpt, model: get('--model') }) + '\n');
const delay = Number(chatgpt ? process.env.MOCK_OCR_FALLBACK_SLEEP_MS : process.env.MOCK_OCR_PRIMARY_SLEEP_MS);
if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
if (chatgpt && process.env.MOCK_OCR_FALLBACK_SKIP === '1') {
  process.stdout.write(JSON.stringify({ status: 'skipped', llm: { model: 'chatgpt-test' }, comments: [], manifest: { coverage: { selected: [], completed: [], failed: [] } } }));
  process.exit(0);
}

if ((!chatgpt && process.env.MOCK_OCR_QUOTA === '1') || (chatgpt && process.env.MOCK_OCR_FALLBACK_FAIL === '1')) {
  const partial = !chatgpt && process.env.MOCK_OCR_PARTIAL_QUOTA === '1';
  process.stdout.write(JSON.stringify({
    status: partial ? 'partial' : 'failed', llm: { model: chatgpt ? 'chatgpt-test' : 'deepseek-v4-flash' },
    comments: partial ? [{ path: 'src/primary.ts', content: 'Useful primary finding', end_line: 1, category: 'bug' }] : [],
    message: 'Review failed: provider or subtask request failed',
    manifest: { coverage: {
      selected: [{ path: 'src/main.ts' }, ...(partial ? [{ path: 'src/primary.ts' }] : [])],
      completed: partial ? [{ path: 'src/primary.ts' }] : [],
      failed: [{ path: 'src/main.ts', classification: process.env.MOCK_OCR_FAILURE_CLASS ?? 'provider', reason: 'provider or subtask request failed' }],
    } },
    retry_report: { schema_version: 'ocr.llm-retry-report/v1', requests: [{ outcome: 'failed', attempts: [1, 2].map(() => ({
      status_code: Number(process.env.MOCK_OCR_HTTP_STATUS ?? 429),
      error_class: process.env.MOCK_OCR_ERROR_CLASS ?? 'rate_limited', failure_phase: 'http',
    })) }] },
  }));
  process.exit(1);
}

if (process.env.MOCK_OCR_SESSION === '1') {
  const sessionDir = path.join(homedir(), '.opencodereview', 'sessions', repo.replace(/[^A-Za-z0-9]+/g, '-'));
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(path.join(sessionDir, 'mock.jsonl'), '{}\n');
}

const fixturePath =
  process.env.MOCK_OCR_FIXTURE ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'ocr-v1.9.0-positioned.json');

if (process.env.MOCK_OCR_SKIP === '1') {
  const skippedFixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'ocr-v1.9.0-skipped.json');
  process.stdout.write(readFileSync(skippedFixturePath, 'utf8'));
  process.exit(0);
}

if (process.env.MOCK_OCR_FAIL === '1') {
  process.stdout.write(
    JSON.stringify({
      status: 'failed',
      llm: { model: 'deepseek-v4-flash' },
      message: 'mock: all file review(s) failed',
      summary: { files_reviewed: 1, comments: 0 },
      comments: null,
      session_id: 'mock-fail-session',
    }),
  );
  process.exit(1);
}

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

const out = {
  ...fixture,
  llm: { ...fixture.llm, model: chatgpt ? (get('--model') ?? 'chatgpt-test') : 'deepseek-v4-flash' },
  manifest: {
    ...(fixture.manifest ?? {}),
    input: {
      mode: 'range',
      requested_from: from,
      requested_head: to,
      resolved_base: from,
      resolved_head: to,
      exact_range: `${from}..${to}`,
    },
    execution: {
      ocr_version: 'v1.9.0',
      model: chatgpt ? (get('--model') ?? 'chatgpt-test') : 'deepseek-v4-flash',
      configured_concurrency: concurrency ? Number(concurrency) : null,
    },
    ...(chatgpt && process.env.MOCK_OCR_PARTIAL_QUOTA === '1' ? { coverage: {
      ...fixture.manifest.coverage,
      selected: [...fixture.manifest.coverage.selected, { path: 'src/primary.ts' }],
      completed: [...fixture.manifest.coverage.completed, { path: 'src/primary.ts' }],
    } } : {}),
  },
};

process.stdout.write(JSON.stringify(out, null, 2));
// eslint-disable-next-line no-console
if (process.env.MOCK_OCR_VERBOSE) console.error(`[mock-ocr] from=${from} to=${to} concurrency=${concurrency} format=${format} repo=${repo} timeout=${timeout}`);
process.exit(Number(process.env.MOCK_OCR_EXIT_CODE ?? 0));
