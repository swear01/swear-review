import { describe, it, expect } from 'vitest';
import {
  fingerprintFinding,
  isDuplicate,
  locationsOverlap,
  textSimilarity,
  normalizeText,
  type PublishedCommentRow,
} from '../../src/review/dedup.js';

const ctx = { owner: 'o', repo: 'r', prNumber: 1 };

function row(partial: Partial<PublishedCommentRow>): PublishedCommentRow {
  return {
    path: 'src/a.ts',
    start_line: 10,
    end_line: 12,
    category: 'bug',
    fingerprint: 'fp',
    body: 'Null pointer dereference of input',
    ...partial,
  };
}

describe('normalizeText', () => {
  it('lowercases, trims, collapses whitespace, strips markdown chars', () => {
    expect(normalizeText('  **NULL** pointer  deref.  ')).toBe('null pointer deref.');
  });
});

describe('locationsOverlap', () => {
  it('detects overlapping ranges', () => {
    expect(locationsOverlap({ startLine: 10, endLine: 20 }, { startLine: 15, endLine: 25 })).toBe(true);
    expect(locationsOverlap({ startLine: 10, endLine: 12 }, { startLine: 12, endLine: 12 })).toBe(true);
  });
  it('rejects disjoint ranges', () => {
    expect(locationsOverlap({ startLine: 10, endLine: 12 }, { startLine: 13, endLine: 14 })).toBe(false);
    expect(locationsOverlap({ startLine: 10 }, { startLine: 20 })).toBe(false);
  });
  it('handles missing lines', () => {
    expect(locationsOverlap({ startLine: 10 }, {})).toBe(false);
  });
});

describe('textSimilarity', () => {
  it('measures token overlap', () => {
    expect(textSimilarity('null pointer deref', 'null pointer deref')).toBe(1);
    expect(textSimilarity('null pointer deref of input', 'null pointer deref of input')).toBe(1);
    expect(textSimilarity('null pointer deref', 'completely different topic')).toBeLessThan(0.6);
  });
});

describe('fingerprintFinding', () => {
  it('is stable for identical findings', () => {
    const a = fingerprintFinding({ ...ctx, path: 'a.ts', startLine: 5, endLine: 7, category: 'bug', message: 'Use after free' });
    const b = fingerprintFinding({ ...ctx, path: 'a.ts', startLine: 5, endLine: 7, category: 'bug', message: 'Use after free' });
    expect(a).toBe(b);
  });
  it('differs when location or text changes', () => {
    const a = fingerprintFinding({ ...ctx, path: 'a.ts', startLine: 5, endLine: 7, category: 'bug', message: 'Use after free' });
    const b = fingerprintFinding({ ...ctx, path: 'a.ts', startLine: 6, endLine: 7, category: 'bug', message: 'Use after free' });
    const c = fingerprintFinding({ ...ctx, path: 'a.ts', startLine: 5, endLine: 7, category: 'bug', message: 'Memory leak' });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('isDuplicate', () => {
  it('skips exact fingerprint matches', () => {
    const f = { path: 'src/a.ts', startLine: 10, endLine: 12, category: 'bug', message: 'Null pointer dereference of input' };
    const fp = fingerprintFinding({ ...ctx, ...f });
    expect(isDuplicate([row({ fingerprint: fp })], f, fp)).toBe(true);
  });

  it('skips overlapping location + same category + similar text', () => {
    const f = { path: 'src/a.ts', startLine: 11, endLine: 13, category: 'bug', message: 'Null pointer dereference of input' };
    const fp = fingerprintFinding({ ...ctx, ...f });
    const existing = [row({ start_line: 10, end_line: 12, category: 'bug', body: 'Null pointer deref of input' })];
    expect(isDuplicate(existing, f, fp)).toBe(true);
  });

  it('keeps different-category findings at the same location', () => {
    const f = { path: 'src/a.ts', startLine: 11, endLine: 13, category: 'performance', message: 'Null pointer dereference of input' };
    const fp = fingerprintFinding({ ...ctx, ...f });
    const existing = [row({ start_line: 10, end_line: 12, category: 'bug', body: 'Null pointer deref of input' })];
    expect(isDuplicate(existing, f, fp)).toBe(false);
  });

  it('keeps findings on different paths', () => {
    const f = { path: 'src/b.ts', startLine: 11, endLine: 13, category: 'bug', message: 'Null pointer dereference of input' };
    const fp = fingerprintFinding({ ...ctx, ...f });
    expect(isDuplicate([row({ start_line: 10, end_line: 12 })], f, fp)).toBe(false);
  });

  it('dedups same location + category even when LLM prose differs between runs', () => {
    // Regression from production E2E: OCR re-reports the same bug at the same
    // lines with entirely different wording on the next full review.
    const f = { path: 'src/a.ts', startLine: 11, endLine: 13, category: 'bug', message: 'The change adds `- 1` to the returned value, so average no longer returns the mean.' };
    const fp = fingerprintFinding({ ...ctx, ...f });
    const existing = [row({ start_line: 10, end_line: 12, category: 'bug', body: 'Due to operator precedence, total / values.length - 1 computes the average minus one.' })];
    expect(isDuplicate(existing, f, fp)).toBe(true);
  });
});
