import type { GateProvider } from '../config/schema.js';
import type { Database } from '../db/database.js';
import type { InstallationOctokit } from '../github/app.js';
import { completeCheckRun, createCheckRun, type CheckOutput } from '../github/checks.js';
import type { Logger } from '../util/logger.js';
import { computeAnyProviderGate, type ProviderResult } from './provider-policy.js';

export interface CheckRunObservation {
  name: string;
  status: string;
  conclusion?: string | null;
  app?: { id?: number | null; slug?: string | null } | null;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface CommitStatusObservation {
  context: string;
  state: string;
  updated_at?: string | null;
  creator?: { login?: string | null } | null;
}

export function observeCheckProvider(provider: GateProvider, runs: readonly CheckRunObservation[]): ProviderResult {
  const matching = runs
    .filter((run) => run.name === provider.check_name)
    .filter((run) => provider.app_id === undefined || run.app?.id === provider.app_id)
    .filter((run) => provider.app_slug === undefined || run.app?.slug === provider.app_slug)
    .sort((a, b) => observationTime(b).localeCompare(observationTime(a)));
  const run = matching[0];

  if (!run) return { name: provider.name, status: 'pending', detail: 'no matching check run' };
  if (run.status !== 'completed') return { name: provider.name, status: 'pending', detail: run.status };
  if (run.conclusion === 'success') return { name: provider.name, status: 'passed', detail: 'success' };
  return { name: provider.name, status: 'failed', detail: run.conclusion ?? 'completed without success' };
}

export function observeStatusProvider(provider: GateProvider, statuses: readonly CommitStatusObservation[]): ProviderResult {
  const matching = statuses
    .filter((status) => status.context === provider.context)
    .filter((status) => provider.creator_login === undefined || status.creator?.login === provider.creator_login)
    .sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')));
  const status = matching[0];

  if (!status) return { name: provider.name, status: 'pending', detail: 'no matching commit status' };
  const state = status.state.toLowerCase();
  if (state === 'success') return { name: provider.name, status: 'passed', detail: state };
  if (state === 'pending') return { name: provider.name, status: 'pending', detail: state };
  return { name: provider.name, status: 'failed', detail: state };
}

export async function reconcileProviderGate(
  octokit: InstallationOctokit,
  db: Database,
  log: Logger,
  input: {
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    checkName: string;
    providers: readonly GateProvider[];
  },
): Promise<void> {
  const key = `${input.owner}/${input.repo}#${input.prNumber}@${input.headSha}`;
  await withGateLock(key, async () => {
    const results = await readProviderResults(octokit, input.owner, input.repo, input.headSha, input.providers);
    const decision = computeAnyProviderGate(results);
    const output = buildGateOutput(input.headSha, input.providers, results, decision.reason);
    let checkRunId = db.getReviewGate(input.owner, input.repo, input.prNumber, input.headSha)?.check_run_id ?? null;

    if (checkRunId === null) {
      checkRunId = await createCheckRun(octokit, log, {
        owner: input.owner,
        repo: input.repo,
        headSha: input.headSha,
        name: input.checkName,
        output,
      });
      db.setReviewGate(input.owner, input.repo, input.prNumber, input.headSha, checkRunId);
    }

    if (decision.status === 'completed') {
      await completeCheckRun(octokit, log, {
        owner: input.owner,
        repo: input.repo,
        checkRunId,
        conclusion: decision.conclusion!,
        output,
      });
      return;
    }

    try {
      await octokit.rest.checks.update({
        owner: input.owner,
        repo: input.repo,
        check_run_id: checkRunId,
        status: 'in_progress',
        output,
      });
    } catch (err) {
      log.error({ err: (err as Error).message, checkRunId }, 'failed to update provider gate');
    }
  });
}

async function readProviderResults(
  octokit: InstallationOctokit,
  owner: string,
  repo: string,
  headSha: string,
  providers: readonly GateProvider[],
): Promise<ProviderResult[]> {
  const checkProviders = providers.filter((provider) => provider.type === 'check');
  const statusProviders = providers.filter((provider) => provider.type === 'status');
  const [checkRuns, statuses] = await Promise.all([
    checkProviders.length > 0
      ? (await octokit.rest.checks.listForRef({ owner, repo, ref: headSha, filter: 'all', per_page: 100 })).data.check_runs
      : [],
    statusProviders.length > 0
      ? (await octokit.rest.repos.listCommitStatusesForRef({ owner, repo, ref: headSha, per_page: 100 })).data
      : [],
  ]);

  return providers.map((provider) => provider.type === 'check'
    ? observeCheckProvider(provider, checkRuns as CheckRunObservation[])
    : observeStatusProvider(provider, statuses as CommitStatusObservation[]));
}

function buildGateOutput(
  headSha: string,
  providers: readonly GateProvider[],
  results: readonly ProviderResult[],
  reason: string,
): CheckOutput {
  const lines = results.map((result) => `- ${result.name}: ${result.status}${result.detail ? ` (${result.detail})` : ''}`);
  return {
    title: reason,
    summary: `Any-provider review gate for ${headSha.slice(0, 7)} — one passing provider is enough to merge.`,
    text: [reason, '', ...lines, '', `Configured providers: ${providers.length}`].join('\n'),
  };
}

function observationTime(observation: CheckRunObservation): string {
  return String(observation.completed_at ?? observation.started_at ?? '');
}

const gateLocks = new Map<string, Promise<void>>();

async function withGateLock(key: string, task: () => Promise<void>): Promise<void> {
  const previous = gateLocks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  gateLocks.set(key, current);
  try {
    await current;
  } finally {
    if (gateLocks.get(key) === current) gateLocks.delete(key);
  }
}
