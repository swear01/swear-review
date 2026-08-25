import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOcrOutput, OcrSchemaError } from '../../src/review/ocr-adapter.js';

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'ocr-v1.9.0.json');
const skippedFixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'ocr-v1.9.0-skipped.json');

describe('parseOcrOutput', () => {
  it('parses the real v1.9.0 fixture (contract test)', () => {
    const raw = readFileSync(fixturePath, 'utf8');
    const result = parseOcrOutput(raw);
    expect(result.status).toBe('complete');
    expect(result.ocrVersion).toBe('v1.9.0');
    expect(result.comments.length).toBe(3);
    const first = result.comments[0]!;
    expect(first.path).toBe('src/main.ts');
    expect(first.category).toBe('bug');
    expect(first.severity).toBe('high');
    expect(first.message).toContain('null dereference');
    expect(result.coverage?.selected).toBe(1);
    expect(result.coverage?.completed).toBe(1);
  });

  it('maps zero start_line to undefined (unpositioned finding)', () => {
    const raw = JSON.stringify({
      status: 'complete',
      comments: [{ path: 'x.ts', content: 'note', start_line: 0, end_line: 0, category: 'style' }],
    });
    const result = parseOcrOutput(raw);
    expect(result.comments[0]!.startLine).toBeUndefined();
    expect(result.comments[0]!.endLine).toBeUndefined();
  });

  it('fails loudly on non-JSON output', () => {
    expect(() => parseOcrOutput('not json at all')).toThrow(OcrSchemaError);
  });

  it('fails loudly on unsupported schema (missing status)', () => {
    expect(() => parseOcrOutput('{"hello": "world"}')).toThrow(OcrSchemaError);
  });

  it('fails loudly on unknown status', () => {
    expect(() => parseOcrOutput('{"status": "quantum", "comments": []}')).toThrow(/Unknown OCR status/);
  });

  it('accepts failed status and exposes message', () => {
    const result = parseOcrOutput('{"status": "failed", "message": "provider down", "comments": null}');
    expect(result.status).toBe('failed');
    expect(result.message).toBe('provider down');
    expect(result.comments).toEqual([]);
  });

  it('preserves per-file provider, timeout, budget, and panic failures', () => {
    const failures = [
      { path: 'provider.ts', classification: 'provider', reason: 'provider unavailable' },
      { path: 'timeout.ts', classification: 'timeout', reason: 'task deadline exceeded' },
      { path: 'budget.ts', classification: 'budget', reason: 'token budget exhausted' },
      { path: 'panic.ts', classification: 'panic', reason: 'review worker panicked' },
    ];
    const result = parseOcrOutput(JSON.stringify({
      status: 'partial',
      comments: [],
      manifest: { coverage: { selected: failures, completed: [], failed: failures } },
    }));

    expect(result.coverage?.failures).toEqual(failures);
  });

  it('classifies legacy failures without a classification as unknown', () => {
    const result = parseOcrOutput(JSON.stringify({
      status: 'partial',
      comments: [],
      manifest: { coverage: { failed: [{ path: 'legacy.ts', reason: 'old OCR output' }] } },
    }));

    expect(result.coverage?.failures).toEqual([
      { path: 'legacy.ts', classification: 'unknown', reason: 'old OCR output' },
    ]);
  });

  it('accepts the real v1.9.0 skipped fixture (docs-only PR, no items selected)', () => {
    const raw = readFileSync(skippedFixturePath, 'utf8');
    const result = parseOcrOutput(raw);
    expect(result.status).toBe('skipped');
    expect(result.message).toBe('Review skipped: no items were selected.');
    expect(result.comments).toEqual([]);
    expect(result.summary?.comments).toBe(0);
    expect(result.summary?.filesReviewed).toBe(0);
  });
});
