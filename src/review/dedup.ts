import { createHash } from 'node:crypto';
import type { Finding } from '../types.js';

export interface PublishedCommentRow {
  path: string;
  start_line: number | null;
  end_line: number | null;
  category: string | null;
  fingerprint: string;
  body: string;
}

/** Normalizes finding text for comparison: lowercase, collapse whitespace. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[`*_#>|]/g, '')
    .trim();
}

function lineOr(a: number | undefined | null, b: number | undefined | null): number | undefined {
  return a ?? b ?? undefined;
}

/** True when two line ranges intersect (missing ranges = no overlap). */
export function locationsOverlap(
  a: { startLine?: number; endLine?: number },
  b: { startLine?: number; endLine?: number },
): boolean {
  const aStart = lineOr(a.startLine, a.endLine);
  const aEnd = lineOr(a.endLine, a.startLine);
  const bStart = lineOr(b.startLine, b.endLine);
  const bEnd = lineOr(b.endLine, b.startLine);
  if (aStart === undefined || bStart === undefined) return false;
  return aStart <= bEnd! && bStart <= aEnd!;
}

/** Token Jaccard similarity between two normalized strings (0..1). */
export function textSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeText(a).split(' ').filter(Boolean));
  const tb = new Set(normalizeText(b).split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

const SIMILARITY_THRESHOLD = 0.6;

/**
 * Publication dedup key: repository + PR + path + line range + category +
 * normalized text. Exact fingerprint matches are always skipped.
 */
export function fingerprintFinding(input: {
  owner: string;
  repo: string;
  prNumber: number;
  path: string;
  startLine?: number;
  endLine?: number;
  category?: string;
  message: string;
}): string {
  const start = lineOr(input.startLine, input.endLine) ?? 0;
  const end = lineOr(input.endLine, input.startLine) ?? 0;
  const text = normalizeText(input.message);
  const payload = [
    input.owner,
    input.repo,
    String(input.prNumber),
    input.path,
    String(start),
    String(end),
    input.category?.toLowerCase() ?? '',
    text,
  ].join('|');
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Dedup decision (spec §13: full compute + deduplicated publication):
 *  1. exact fingerprint match → duplicate
 *  2. same path + overlapping lines + same category → duplicate
 *
 * Text similarity is intentionally NOT required: LLM prose varies between runs
 * for the same underlying issue, so (path, line range, category) overlap is the
 * reliable anti-spam signal — matching the OCR Action's own publication policy.
 */
export function isDuplicate(
  existing: PublishedCommentRow[],
  f: Finding,
  fingerprint: string,
): boolean {
  if (existing.some((e) => e.fingerprint === fingerprint)) return true;
  for (const e of existing) {
    if (e.path !== f.path) continue;
    if (e.category && f.category && e.category.toLowerCase() !== f.category.toLowerCase()) continue;
    if (!locationsOverlap(
      { startLine: e.start_line ?? undefined, endLine: e.end_line ?? undefined },
      { startLine: f.startLine, endLine: f.endLine },
    )) continue;
    return true;
  }
  return false;
}
