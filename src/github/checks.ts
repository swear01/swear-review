import type { InstallationOctokit } from './app.js';
import type { Logger } from '../util/logger.js';
import type { CheckConclusion } from '../types.js';

export interface CheckOutput {
  title: string;
  summary: string;
  text?: string;
}

/** Creates an in-progress Check Run. Returns the check run id. */
export async function createCheckRun(
  octokit: InstallationOctokit,
  log: Logger,
  input: {
    owner: string;
    repo: string;
    headSha: string;
    name: string;
    output: CheckOutput;
  },
): Promise<number> {
  const res = await octokit.rest.checks.create({
    owner: input.owner,
    repo: input.repo,
    name: input.name,
    head_sha: input.headSha,
    status: 'in_progress',
    started_at: new Date().toISOString(),
    output: input.output,
  });
  return Number(res.data.id);
}

/** Completes a Check Run with a conclusion. */
export async function completeCheckRun(
  octokit: InstallationOctokit,
  log: Logger,
  input: {
    owner: string;
    repo: string;
    checkRunId: number;
    conclusion: CheckConclusion;
    output: CheckOutput;
    throwOnError?: boolean;
  },
): Promise<void> {
  try {
    await octokit.rest.checks.update({
      owner: input.owner,
      repo: input.repo,
      check_run_id: input.checkRunId,
      status: 'completed',
      completed_at: new Date().toISOString(),
      conclusion: input.conclusion,
      output: input.output,
    });
  } catch (err) {
    log.error({ err: (err as Error).message, checkRunId: input.checkRunId }, 'failed to complete check run');
    if (input.throwOnError) throw err;
  }
}

/** Renders the check output text per spec §22. */
export function renderCheckOutputText(input: {
  mode: string;
  model: string;
  ocrVersion: string;
  findingsCount: number;
  durationSec: number;
  counts: Record<string, number>;
  statusLine: string;
  extra?: string;
}): string {
  const lines = [
    `Swear Review ${input.statusLine}`,
    '',
    `Mode: ${input.mode}`,
    `Model: ${input.model}`,
    `OCR: ${input.ocrVersion}`,
    `Findings: ${input.findingsCount}`,
    `Duration: ${Math.round(input.durationSec)}s`,
    '',
    ...Object.entries(input.counts)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}: ${n}`),
  ];
  if (input.extra) lines.push('', input.extra);
  return lines.join('\n');
}
