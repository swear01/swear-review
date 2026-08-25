import { z } from 'zod';
import type { Finding, OcrResult } from '../types.js';

/**
 * Contract for OCR `--format json` output, validated against a real
 * v1.9.0 capture (tests/fixtures/ocr-v1.9.0.json).
 *
 * If OCR ships an incompatible schema, parsing fails loudly here — Swear
 * Review never silently forwards an unknown structure to GitHub.
 */

const OcrCommentSchema = z.object({
  path: z.string(),
  content: z.string(),
  title: z.string().optional(),
  suggestion_code: z.string().optional(),
  existing_code: z.string().optional(),
  start_line: z.number().int().nonnegative().optional(),
  end_line: z.number().int().nonnegative().optional(),
  category: z.string().optional(),
  severity: z.string().optional(),
});

const OcrFailureClassSchema = z.enum([
  'provider',
  'timeout',
  'cancelled',
  'configuration',
  'input',
  'budget',
  'panic',
  'unknown',
]);

const OcrManifestSchema = z
  .object({
    schema_version: z.string().optional(),
    run_id: z.string().optional(),
    operation: z.string().optional(),
    terminal_state: z.string().optional(),
    input: z
      .object({
        mode: z.string().optional(),
        requested_from: z.string().optional(),
        requested_head: z.string().optional(),
        resolved_base: z.string().optional(),
        resolved_head: z.string().optional(),
      })
      .optional(),
    execution: z
      .object({
        ocr_version: z.string().optional(),
        model: z.string().optional(),
        configured_concurrency: z.number().optional(),
      })
      .optional(),
    coverage: z
      .object({
        selected: z.array(z.object({ path: z.string() })).optional(),
        completed: z.array(z.object({ path: z.string() })).optional(),
        reused: z.array(z.object({ path: z.string() })).optional(),
        failed: z.array(z.object({
          path: z.string(),
          classification: OcrFailureClassSchema.default('unknown'),
          reason: z.string().optional(),
        })).optional(),
        waived: z.array(z.object({ path: z.string() })).optional(),
      })
      .optional(),
    elapsed_ms: z.number().optional(),
  })
  .optional();

const OcrResultSchema = z.object({
  status: z.string(),
  llm: z.object({ model: z.string().optional() }).optional(),
  message: z.string().optional(),
  summary: z
    .object({
      files_reviewed: z.number().optional(),
      comments: z.number().optional(),
      total_tokens: z.number().optional(),
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
      elapsed: z.string().optional(),
    })
    .optional(),
  comments: z.array(OcrCommentSchema).nullish(),
  session_id: z.string().optional(),
  tool_calls: z
    .object({ total: z.number().optional(), by_tool: z.record(z.string(), z.number()).optional() })
    .optional(),
  manifest: OcrManifestSchema,
});

const VALID_STATUSES = new Set(['complete', 'success', 'failed', 'partial', 'cancelled', 'skipped']);

export class OcrSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OcrSchemaError';
  }
}

/** Parses and normalizes OCR JSON output. Throws OcrSchemaError on incompatible output. */
export function parseOcrOutput(raw: string): OcrResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new OcrSchemaError(`OCR output is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = OcrResultSchema.safeParse(json);
  if (!parsed.success) {
    throw new OcrSchemaError(`Unsupported OCR output schema: ${z.prettifyError(parsed.error)}`);
  }
  const d = parsed.data;

  if (!VALID_STATUSES.has(d.status)) {
    throw new OcrSchemaError(`Unknown OCR status "${d.status}" — refusing to publish. This may indicate an OCR upgrade with a new schema.`);
  }

  // `skipped` (OCR >= 1.9.0): no files were selected for review — e.g. a
  // docs-only PR whose diff contains no code files. It is a benign, empty
  // review (comments: []), not a failure: Swear Review publishes the empty
  // result so the check passes instead of failing the PR.

  const findings: Finding[] = (d.comments ?? []).map((c) => ({
    path: c.path,
    startLine: c.start_line && c.start_line > 0 ? c.start_line : undefined,
    endLine: c.end_line && c.end_line > 0 ? c.end_line : undefined,
    title: c.title,
    message: c.content,
    category: c.category?.toLowerCase(),
    severity: c.severity?.toLowerCase(),
    suggestionCode: c.suggestion_code,
    existingCode: c.existing_code,
  }));

  const coverage = d.manifest?.coverage;
  return {
    status: d.status,
    model: d.llm?.model ?? d.manifest?.execution?.model,
    message: d.message,
    summary: d.summary
      ? {
          filesReviewed: d.summary.files_reviewed ?? 0,
          comments: d.summary.comments ?? 0,
          totalTokens: d.summary.total_tokens,
          inputTokens: d.summary.input_tokens,
          outputTokens: d.summary.output_tokens,
          elapsed: d.summary.elapsed,
        }
      : undefined,
    comments: findings,
    sessionId: d.session_id,
    ocrVersion: d.manifest?.execution?.ocr_version,
    configuredConcurrency: d.manifest?.execution?.configured_concurrency,
    coverage: coverage
      ? {
          selected: coverage.selected?.length ?? 0,
          completed: coverage.completed?.length ?? 0,
          reused: coverage.reused?.length ?? 0,
          failed: coverage.failed?.length ?? 0,
          waived: coverage.waived?.length ?? 0,
          failures: coverage.failed ?? [],
        }
      : undefined,
    elapsedMs: d.manifest?.elapsed_ms,
    toolCalls: d.tool_calls
      ? { total: d.tool_calls.total ?? 0, byTool: d.tool_calls.by_tool ?? {} }
      : undefined,
  };
}

export { OcrResultSchema };
