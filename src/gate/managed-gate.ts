import type { Database } from '../db/database.js';
import type { GitHubApi } from '../github/app.js';
import { reconcileManagedGate, type RulesetState } from '../github/rulesets.js';
import type { Logger } from '../util/logger.js';

/**
 * Managed Gate Mode reconciliation. Best-effort: if the GitHub plan or
 * permissions do not allow rulesets, review functionality stays active and the
 * gate degrades to `check`-like behavior (Check Run conclusion still blocks if
 * the check is manually required).
 */
export async function reconcileGateForRepository(
  github: GitHubApi,
  db: Database,
  log: Logger,
  input: {
    installationId: number;
    owner: string;
    repo: string;
    gateMode: string;
    checkName: string;
    integrationId?: number;
  },
): Promise<{ state: RulesetState; rulesetId: number | null }> {
  const { owner, repo } = input;
  if (input.gateMode !== 'managed') {
    const current = db.getRepositoryState(owner, repo);
    if (current.ruleset_state === 'ok' && current.ruleset_id != null) {
      // Gate was turned off but a ruleset exists → leave it (manual cleanup).
      log.info({ owner, repo, rulesetId: current.ruleset_id }, 'gate mode off; existing ruleset left in place');
    }
    return { state: 'unmanaged', rulesetId: null };
  }

  const octokit = await github.getOctokit(input.installationId);
  const result = await reconcileManagedGate(octokit, log, {
    owner,
    repo,
    checkName: input.checkName,
    integrationId: input.integrationId,
  });
  db.setRepositoryGateState(owner, repo, 'managed', result.rulesetId, result.state);
  return result;
}
