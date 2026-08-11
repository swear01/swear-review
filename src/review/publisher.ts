import type { ServiceContext } from '../context.js';
import type { JobRecord, ReviewMode, Finding } from '../types.js';
import { buildCommentBody, findingToInlineComment, postInlineComments, type PublishedInlineComment } from '../github/reviews.js';
import { upsertStickySummary } from '../github/comments.js';
import { fingerprintFinding, isDuplicate, type PublishedCommentRow } from './dedup.js';
import { countByCategory } from '../gate/policy.js';
import { ReviewError } from '../util/errors.js';
import type { OcrResult } from '../types.js';

export interface PublishResult {
  stale: boolean;
  totalFindings: number;
  deduped: number;
  inlinePublished: number;
  inlineFailed: number;
  routedToSummary: number;
  counts: Record<string, number>;
  summaryCommentId: number | null;
}

export interface PublishInput {
  job: JobRecord;
  runId: number;
  ocr: OcrResult;
  mode: ReviewMode;
  gateMode: string;
  blocking: boolean;
  blockReason: string;
  checkName: string;
}

/**
 * GitHub publication:
 *   1. stale-SHA protection (never publish results for an outdated head)
 *   2. finding dedup (exact fingerprint + location-overlap)
 *   3. inline review comments in batches (MAX_REVIEW_COMMENTS_PER_BATCH = 50)
 *   4. sticky summary upsert (single comment, updated in place)
 */
export async function publishReviewResult(ctx: ServiceContext, input: PublishInput): Promise<PublishResult> {
  const { config, db, log, metrics, github } = ctx;
  const { job, runId, ocr } = input;
  const owner = job.repo_owner;
  const repo = job.repo_name;
  const prNumber = job.pr_number;
  const octokit = await github.getOctokit(job.installation_id);

  // ---- 1. stale-SHA protection ---------------------------------------------
  let currentHead: string;
  try {
    const pr = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
    currentHead = pr.data.head.sha;
  } catch (err) {
    throw new ReviewError('github', `Failed to fetch current PR head: ${(err as Error).message}`);
  }
  if (currentHead !== job.head_sha) {
    log.info({ currentHead: currentHead.slice(0, 7), expectedHead: job.head_sha.slice(0, 7) }, 'stale review result discarded');
    metrics.reviewsStale.inc({ repo: `${owner}/${repo}` });
    return { stale: true, totalFindings: 0, deduped: 0, inlinePublished: 0, inlineFailed: 0, routedToSummary: 0, counts: {}, summaryCommentId: null };
  }

  const findings = ocr.comments;
  const counts = countByCategory(findings);

  // ---- 2. dedup ------------------------------------------------------------
  const existing = config.publication.deduplicate
    ? db.listPublishedForPullRequest(owner, repo, prNumber)
    : ([] as PublishedCommentRow[]);

  const toPublish: Array<{ finding: Finding; fingerprint: string }> = [];
  let deduped = 0;
  for (const f of findings) {
    const fingerprint = fingerprintFinding({ owner, repo, prNumber, path: f.path, startLine: f.startLine, endLine: f.endLine, category: f.category, message: f.message });
    if (isDuplicate(existing, f, fingerprint)) {
      deduped++;
      metrics.dedupSkipped.inc({ repo: `${owner}/${repo}` });
      continue;
    }
    toPublish.push({ finding: f, fingerprint });
  }

  // record findings (before publication so we can attach comment ids)
  const findingIds = db.insertFindings(
    runId,
    toPublish.map(({ finding: f, fingerprint }) => ({
      path: f.path,
      startLine: f.startLine,
      endLine: f.endLine,
      category: f.category,
      severity: f.severity,
      message: f.message,
      fingerprint,
    })),
  );

  // ---- 3. inline comments ---------------------------------------------------
  const inlineItems: Array<{ finding: Finding; fingerprint: string; index: number }> = [];
  const routedToSummary: Array<{ finding: Finding; index: number; reason: string }> = [];

  toPublish.forEach((item, index) => {
    const c = findingToInlineComment(item.finding);
    if (!c) {
      routedToSummary.push({ finding: item.finding, index, reason: 'no line position' });
      return;
    }
    inlineItems.push({ finding: item.finding, fingerprint: item.fingerprint, index });
  });

  const { published, failed } = await postInlineComments(octokit, log, {
    owner,
    repo,
    prNumber,
    headSha: job.head_sha,
    comments: inlineItems.map((i) => ({
      path: i.finding.path,
      line: inlineItemLine(i.finding),
      startLine: i.finding.startLine,
      body: buildCommentBody(i.finding),
    })),
    batchSize: config.publication.comment_batch_size,
    mode: input.mode,
    ocrVersion: ocr.ocrVersion ?? config.ocr.version,
    model: ocr.model ?? config.llm.model,
  });

  // record published comments
  for (const p of published) {
    const item = inlineItems.find(
      (i) => i.finding.path === p.path && (inlineItemLine(i.finding) === p.line),
    );
    const findingIndex = item?.index;
    const findingId = findingIndex !== undefined ? findingIds[findingIndex] ?? null : null;
    const fingerprint = item?.fingerprint ?? '';
    db.insertPublishedComment({
      owner,
      repo,
      prNumber,
      runId,
      findingId,
      githubCommentId: p.githubCommentId,
      path: p.path,
      startLine: p.startLine ?? undefined,
      endLine: undefined,
      category: item?.finding.category,
      fingerprint,
      body: item?.finding.message ?? '',
    });
  }

  const inlineFailedCount = failed.length;
  for (const f of failed) {
    const item = inlineItems.find((i) => i.finding.path === f.path && inlineItemLine(i.finding) === f.line);
    routedToSummary.push({ finding: item?.finding ?? { path: f.path, message: f.body }, index: item?.index ?? -1, reason: 'inline publication failed' });
  }

  // ---- 4. sticky summary -----------------------------------------------------
  let summaryCommentId: number | null = null;
  if (config.publication.sticky_summary) {
    const body = buildSummaryBody({
      mode: input.mode,
      model: ocr.model ?? config.llm.model,
      ocrVersion: ocr.ocrVersion ?? config.ocr.version,
      headSha: job.head_sha,
      counts,
      total: findings.length,
      inlinePublished: published.length,
      routedToSummary: routedToSummary.length,
      routedFindings: routedToSummary.map((r) => r.finding),
      status: 'Completed',
      gateMode: input.gateMode,
      blocking: input.blocking,
      blockReason: input.blockReason,
    });
    try {
      summaryCommentId = await upsertStickySummary(octokit, log, { owner, repo, prNumber, body });
    } catch (err) {
      metrics.githubPublishFailures.inc({ repo: `${owner}/${repo}`, what: 'sticky_summary' });
      log.error({ err: (err as Error).message, owner, repo, prNumber }, 'failed to upsert sticky summary');
    }
  }

  const result: PublishResult = {
    stale: false,
    totalFindings: findings.length,
    deduped,
    inlinePublished: published.length,
    inlineFailed: inlineFailedCount,
    routedToSummary: routedToSummary.length,
    counts,
    summaryCommentId,
  };
  log.info(
    { ...result, repo: `${owner}/${repo}`, pr: prNumber, headSha: job.head_sha.slice(0, 7) },
    'review published to GitHub',
  );
  return result;
}

function inlineItemLine(f: Finding): number {
  return (f.endLine && f.endLine > 0 ? f.endLine : f.startLine) ?? 0;
}

/** Sticky summary body (spec §15). */
export function buildSummaryBody(input: {
  mode: ReviewMode;
  model: string;
  ocrVersion: string;
  headSha: string;
  counts: Record<string, number>;
  total: number;
  inlinePublished: number;
  routedToSummary: number;
  routedFindings: Finding[];
  status: 'Completed' | 'Failed' | 'Cancelled' | 'Superseded';
  statusDetail?: string;
  gateMode?: string;
  blocking?: boolean;
  blockReason?: string;
}): string {
  const lines: string[] = [];
  lines.push(`Mode: ${input.mode === 'full' ? 'Full PR' : 'Incremental'}`);
  lines.push(`Model: ${input.model}`);
  lines.push(`OCR: ${input.ocrVersion}`);
  lines.push(`Commit: ${input.headSha.slice(0, 7)}`);
  lines.push('');
  lines.push('Findings:');
  const counts = Object.entries(input.counts).filter(([, n]) => n > 0);
  if (counts.length === 0) {
    lines.push('- _none_');
  } else {
    for (const [cat, n] of counts) {
      lines.push(`- ${capitalize(cat)}: ${n}`);
    }
  }
  lines.push('');
  lines.push(`${input.total} findings total`);
  lines.push(`${input.inlinePublished} inline comments`);
  if (input.routedToSummary > 0) {
    lines.push(`${input.routedToSummary} finding(s) routed to summary`);
    if (input.routedFindings.length > 0) {
      lines.push('');
      lines.push('Routed to summary:');
      for (const f of input.routedFindings.slice(0, 20)) {
        const loc = f.startLine ? `${f.path}:${f.startLine}` : f.path;
        lines.push(`- \`${loc}\` — ${f.message.split('\n')[0]}`);
      }
      if (input.routedFindings.length > 20) lines.push('- …');
    }
  }
  lines.push('');
  if (input.status === 'Completed') {
    lines.push(`Status: ✅ Completed`);
  } else {
    lines.push(`Status: ❌ ${input.status}`);
  }
  if (input.statusDetail) {
    lines.push(input.statusDetail);
  }
  if (input.gateMode && input.gateMode !== 'off') {
    lines.push('');
    if (input.blocking) {
      lines.push(`❌ Merge blocked — ${input.blockReason}`);
    } else {
      lines.push('✅ No blocking findings');
    }
  }
  return lines.join('\n');
}

function capitalize(s: string): string {
  return s.length ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export type { PublishedInlineComment };
