#!/usr/bin/env node
// Mock OCR binary for tests. Emits the pinned v1.9.0-style JSON manifest and
// echoes the exact invocation args so tests can assert:
//   --from <immutable merge-base SHA>  --to <head SHA>  --concurrency 16  --format json
// Set MOCK_OCR_FAIL=1 to simulate an OCR/LLM infrastructure failure.

import { readFileSync } from 'node:fs';
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

const fixturePath =
  process.env.MOCK_OCR_FIXTURE ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'ocr-v1.9.0-positioned.json');

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
  status: 'complete',
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
      model: 'deepseek-v4-flash',
      configured_concurrency: concurrency ? Number(concurrency) : null,
    },
  },
};

process.stdout.write(JSON.stringify(out, null, 2));
// eslint-disable-next-line no-console
if (process.env.MOCK_OCR_VERBOSE) console.error(`[mock-ocr] from=${from} to=${to} concurrency=${concurrency} format=${format} repo=${repo} timeout=${timeout}`);
process.exit(0);
