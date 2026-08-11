import type { InstallationOctokit } from './app.js';
import type { Logger } from '../util/logger.js';

export const SUMMARY_MARKER = '<!-- swear-review-summary -->';

export const SUMMARY_HEADER = '## Swear Review';

/**
 * Upserts a single sticky summary comment on the PR conversation.
 * The marker makes the comment findable so we update instead of appending.
 */
export async function upsertStickySummary(
  octokit: InstallationOctokit,
  log: Logger,
  input: {
    owner: string;
    repo: string;
    prNumber: number;
    body: string;
  },
): Promise<number | null> {
  const { owner, repo, prNumber, body } = input;
  const fullBody = `${SUMMARY_HEADER}\n\n${body}\n\n${SUMMARY_MARKER}`;

  const comments = await octokit.rest.issues.listComments({ owner, repo, issue_number: prNumber, per_page: 100 });
  const existing = comments.data.find((c) => c.body?.includes(SUMMARY_MARKER));
  if (existing) {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: Number(existing.id), body: fullBody });
    return Number(existing.id);
  }
  const created = await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body: fullBody });
  return Number(created.data.id);
}

/** Posts a one-off bot reply comment (manual command acks, denials, errors). */
export async function postReply(
  octokit: InstallationOctokit,
  log: Logger,
  input: {
    owner: string;
    repo: string;
    prNumber: number;
    body: string;
  },
): Promise<void> {
  try {
    await octokit.rest.issues.createComment({
      owner: input.owner,
      repo: input.repo,
      issue_number: input.prNumber,
      body: input.body,
    });
  } catch (err) {
    log.error({ err: (err as Error).message, ...input }, 'failed to post reply comment');
  }
}
