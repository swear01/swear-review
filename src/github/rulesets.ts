import type { InstallationOctokit } from './app.js';
import type { Logger } from '../util/logger.js';

export const RULESET_NAME = 'Swear Review';

export type RulesetState = 'ok' | 'degraded' | 'unavailable' | 'unmanaged';

/**
 * Managed Gate Mode: ensures a repository ruleset that requires the
 * "Swear Review" status check to pass before merging.
 *
 * Repository rulesets require `Administration: write` and — for private repos —
 * a paid GitHub plan. Every failure must degrade gracefully: review + check
 * functionality stay active even if ruleset management is unavailable.
 */
export async function reconcileManagedGate(
  octokit: InstallationOctokit,
  log: Logger,
  input: { owner: string; repo: string; checkName: string },
): Promise<{ state: RulesetState; rulesetId: number | null }> {
  const { owner, repo, checkName } = input;
  try {
    const list = await octokit.rest.repos.getRepoRulesets({ owner, repo });
    const existing = list.data.find((r) => r.name === RULESET_NAME);

    const payload = {
      name: RULESET_NAME,
      enforcement: 'active' as const,
      conditions: {
        ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] },
      },
      rules: [
        {
          type: 'required_status_checks' as const,
          parameters: {
            strict_required_status_checks_policy: false,
            required_status_checks: [{ context: checkName }],
          },
        },
      ],
    };

    if (existing) {
      await octokit.rest.repos.updateRepoRuleset({
        owner,
        repo,
        ruleset_id: Number(existing.id),
        ...payload,
      });
      log.info({ owner, repo, rulesetId: existing.id }, 'managed gate ruleset updated');
      return { state: 'ok', rulesetId: Number(existing.id) };
    }

    const created = await octokit.rest.repos.createRepoRuleset({ owner, repo, ...payload });
    log.info({ owner, repo, rulesetId: created.data.id }, 'managed gate ruleset created');
    return { state: 'ok', rulesetId: Number(created.data.id) };
  } catch (err) {
    const status = (err as { status?: number }).status;
    const msg = (err as Error).message;
    log.warn({ owner, repo, status, err: msg }, 'managed gate ruleset reconciliation failed; degrading');
    if (status === 403 || status === 404) {
      // 404: rulesets feature unavailable on this plan; 403: no permission.
      return { state: 'unavailable', rulesetId: null };
    }
    return { state: 'degraded', rulesetId: null };
  }
}

/** Removes the managed ruleset (e.g. when gate mode is turned off). Best-effort. */
export async function removeManagedGate(
  octokit: InstallationOctokit,
  log: Logger,
  input: { owner: string; repo: string },
): Promise<void> {
  try {
    const list = await octokit.rest.repos.getRepoRulesets({ owner: input.owner, repo: input.repo });
    const existing = list.data.find((r) => r.name === RULESET_NAME);
    if (existing) {
      await octokit.rest.repos.deleteRepoRuleset({ owner: input.owner, repo: input.repo, ruleset_id: Number(existing.id) });
      log.info({ owner: input.owner, repo: input.repo, rulesetId: existing.id }, 'managed gate ruleset removed');
    }
  } catch (err) {
    log.warn({ err: (err as Error).message, owner: input.owner, repo: input.repo }, 'failed to remove managed gate ruleset');
  }
}
