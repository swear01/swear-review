import type { InstallationOctokit } from './app.js';
import type { Logger } from '../util/logger.js';
import type { Finding } from '../types.js';

export interface PublishedInlineComment {
  githubCommentId: number | null;
  path: string;
  line: number;
  startLine: number | null;
}

interface InlineCommentInput {
  path: string;
  line: number;
  startLine?: number;
  body: string;
}

/**
 * Converts a finding into a GitHub review-comment payload.
 * GitHub inline comments require the line to exist in the PR diff; findings
 * without a usable line are routed to the summary by the caller.
 */
export function findingToInlineComment(f: Finding): InlineCommentInput | null {
  if (!f.startLine || f.startLine <= 0) return null;
  const start = f.startLine;
  const end = f.endLine && f.endLine > f.startLine ? f.endLine : f.startLine;
  const body = buildCommentBody(f);
  return { path: f.path, line: end, startLine: start < end ? start : undefined, body };
}

export function buildCommentBody(f: Finding): string {
  const lines: string[] = [];
  if (f.title) lines.push(`**${f.title}**`);
  lines.push(f.message);
  if (f.suggestionCode) {
    lines.push('', '```suggestion', f.suggestionCode.replace(/```/g, '``\u200b`'), '```');
  }
  if (f.category || f.severity) {
    lines.push('', `_${[f.severity, f.category].filter(Boolean).join(' · ')}_`);
  }
  lines.push('', '— *Swear Review*');
  return lines.join('\n');
}

/**
 * Publishes inline review comments in batches of `batchSize`.
 * Falls back to per-comment posting when a batch fails (e.g. a 422 because a
 * line is not in the diff) and routes failed comments to the returned `failed` list.
 */
export async function postInlineComments(
  octokit: InstallationOctokit,
  log: Logger,
  input: {
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    comments: InlineCommentInput[];
    batchSize: number;
    mode: string;
    ocrVersion: string;
    model: string;
  },
): Promise<{ published: PublishedInlineComment[]; failed: InlineCommentInput[] }> {
  const published: PublishedInlineComment[] = [];
  const failed: InlineCommentInput[] = [];
  const batches: InlineCommentInput[][] = [];
  for (let i = 0; i < input.comments.length; i += input.batchSize) {
    batches.push(input.comments.slice(i, i + input.batchSize));
  }

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b]!;
    const reviewBody = `Swear Review — ${input.mode === 'full' ? 'Full PR' : 'Incremental'} review · batch ${b + 1}/${batches.length} · OCR ${input.ocrVersion} · ${input.model}`;
    try {
      const res = await octokit.rest.pulls.createReview({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.prNumber,
        commit_id: input.headSha,
        event: 'COMMENT',
        body: reviewBody,
        comments: batch.map((c) => ({
          path: c.path,
          line: c.line,
          ...(c.startLine !== undefined ? { start_line: c.startLine, start_side: 'RIGHT' as const } : {}),
          side: 'RIGHT' as const,
          body: c.body,
        })),
      });
      const reviewComments = (res.data as unknown as { comments?: Array<{ id: number | bigint; path?: string | null; line?: number | null; start_line?: number | null }> }).comments ?? [];
      for (const rc of reviewComments) {
        published.push({
          githubCommentId: Number(rc.id),
          path: rc.path ?? '',
          line: rc.line ?? 0,
          startLine: rc.start_line ?? null,
        });
      }
    } catch (err) {
      log.warn(
        { err: (err as Error).message, batchSize: batch.length, batch: b + 1 },
        'review batch failed; falling back to per-comment posting',
      );
      for (const c of batch) {
        try {
          const res = await octokit.rest.pulls.createReview({
            owner: input.owner,
            repo: input.repo,
            pull_number: input.prNumber,
            commit_id: input.headSha,
            event: 'COMMENT',
            body: reviewBody,
            comments: [
              {
                path: c.path,
                line: c.line,
                ...(c.startLine !== undefined ? { start_line: c.startLine, start_side: 'RIGHT' as const } : {}),
                side: 'RIGHT' as const,
                body: c.body,
              },
            ],
          });
          const rc = (res.data as unknown as { comments?: Array<{ id: number | bigint; path?: string | null; line?: number | null; start_line?: number | null }> }).comments?.[0];
          if (rc) {
            published.push({ githubCommentId: Number(rc.id), path: rc.path ?? '', line: rc.line ?? 0, startLine: rc.start_line ?? null });
          }
        } catch (err2) {
          log.warn({ err: (err2 as Error).message, path: c.path, line: c.line }, 'inline comment failed; routing to summary');
          failed.push(c);
        }
      }
    }
  }
  return { published, failed };
}
