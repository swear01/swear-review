import type { GateProvider } from '../config/schema.js';
import type { Database } from '../db/database.js';
import type { GitHubApi, InstallationOctokit } from '../github/app.js';
import { completeCheckRun, createCheckRun, type CheckOutput } from '../github/checks.js';
import type { Logger } from '../util/logger.js';
import { computeAnyProviderGate, type ProviderResult } from './provider-policy.js';

export interface CheckRunObservation {
  id?: number | null;
  name: string;
  status: string;
  conclusion?: string | null;
  app?: { id?: number | null; slug?: string | null } | null;
  started_at?: string | null;
  completed_at?: string | null;
  created_at?: string | null;
}

export interface CommitStatusObservation {
  context: string;
  state: string | null | undefined;
  updated_at?: string | null;
  creator?: { login?: string | null } | null;
}

export function observeCheckProvider(provider: GateProvider, runs: readonly CheckRunObservation[]): ProviderResult {
  const run = latestMatching(
    runs,
    (candidate) => candidate.name.toLowerCase() === provider.check_name?.toLowerCase()
      && (provider.app_id === undefined || candidate.app?.id === provider.app_id)
      && (provider.app_slug === undefined || candidate.app?.slug === provider.app_slug),
    (candidate) => candidate.created_at ?? candidate.completed_at ?? candidate.started_at,
    (candidate) => candidate.id,
  );

  if (!run) return { name: provider.name, status: 'pending', detail: 'no matching check run' };
  if (run.status !== 'completed') return { name: provider.name, status: 'pending', detail: run.status };
  if (run.conclusion === 'success') return { name: provider.name, status: 'passed', detail: 'success' };
  return { name: provider.name, status: 'failed', detail: run.conclusion ?? 'completed without success' };
}

export function observeStatusProvider(provider: GateProvider, statuses: readonly CommitStatusObservation[]): ProviderResult {
  const status = latestMatching(
    statuses,
    (candidate) => candidate.context === provider.context
      && (provider.creator_login === undefined || candidate.creator?.login === provider.creator_login),
    (candidate) => candidate.updated_at,
  );

  if (!status) return { name: provider.name, status: 'pending', detail: 'no matching commit status' };
  const state = typeof status.state === 'string' ? status.state.toLowerCase() : '';
  if (!state) return { name: provider.name, status: 'pending', detail: 'missing status state' };
  if (state === 'success') return { name: provider.name, status: 'passed', detail: state };
  if (state === 'pending') return { name: provider.name, status: 'pending', detail: state };
  return { name: provider.name, status: 'failed', detail: state };
}

export async function reconcileProviderGateForPullRequest(
  github: GitHubApi,
  db: Database,
  log: Logger,
  input: {
    installationId: number;
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    checkName: string;
    providers: readonly GateProvider[];
  },
): Promise<void> {
  const octokit = await github.getOctokit(input.installationId);
  await reconcileProviderGate(octokit, db, log, input);
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
    const results = await retryGateApi(
      () => readProviderResults(octokit, input.owner, input.repo, input.headSha, input.checkName, input.providers),
      log,
      'read provider results',
    );
    const decision = computeAnyProviderGate(results);
    const output = buildGateOutput(input.headSha, input.providers, results, decision.reason);
    const previous = db.getReviewGate(input.owner, input.repo, input.prNumber, input.headSha);

    // A completed GitHub check run is immutable. Reuse it only when the
    // persisted decision is unchanged; state changes get a fresh check run.
    if (previous?.status === 'completed' && previous.conclusion === decision.conclusion) return;

    let checkRunId = previous?.check_run_id ?? null;
    const needsNewCheckRun = checkRunId === null
      || previous?.status === 'legacy'
      || (previous?.status === 'completed' && decision.status === 'in_progress')
      || (previous?.status === 'completed' && decision.status === 'completed' && previous.conclusion !== decision.conclusion);

    let createdCheckRun = false;
    if (needsNewCheckRun) {
      checkRunId = await createCheckRun(octokit, log, {
        owner: input.owner,
        repo: input.repo,
        headSha: input.headSha,
        name: input.checkName,
        output,
      });
      createdCheckRun = true;
      try {
        db.setReviewGate(input.owner, input.repo, input.prNumber, input.headSha, checkRunId, { status: 'in_progress', conclusion: null });
      } catch (err) {
        await completeCheckRun(octokit, log, {
          owner: input.owner,
          repo: input.repo,
          checkRunId,
          conclusion: 'failure',
          output: { title: 'AI Review Gate persistence failed', summary: 'The gate state could not be persisted.' },
        });
        throw err;
      }
    }

    if (checkRunId === null) throw new Error('provider gate check run was not created');

    let completedCheckRun = false;
    try {
      let applied = false;
      for (let attempt = 0; attempt < 2 && !applied; attempt++) {
        try {
          if (decision.status === 'completed') {
            await completeCheckRun(octokit, log, {
              owner: input.owner,
              repo: input.repo,
              checkRunId,
              conclusion: decision.conclusion,
              output,
              throwOnError: true,
            });
            completedCheckRun = true;
          } else {
            await octokit.rest.checks.update({
              owner: input.owner,
              repo: input.repo,
              check_run_id: checkRunId,
              status: 'in_progress',
              output,
            });
          }
          applied = true;
        } catch (err) {
          if (attempt > 0) throw err;
          const current = await findCheckRun(octokit, input.owner, input.repo, input.headSha, checkRunId).catch(() => undefined);
          if (!current || current.status !== 'completed') throw err;
          if (decision.status === 'completed' && current.conclusion === decision.conclusion) {
            completedCheckRun = true;
            applied = true;
            continue;
          }
          checkRunId = await createCheckRun(octokit, log, {
            owner: input.owner,
            repo: input.repo,
            headSha: input.headSha,
            name: input.checkName,
            output,
          });
          createdCheckRun = true;
          db.setReviewGate(input.owner, input.repo, input.prNumber, input.headSha, checkRunId, { status: 'in_progress', conclusion: null });
        }
      }

      db.setReviewGate(
        input.owner,
        input.repo,
        input.prNumber,
        input.headSha,
        checkRunId,
        decision.status === 'completed'
          ? { status: 'completed', conclusion: decision.conclusion }
          : { status: 'in_progress', conclusion: null },
      );
    } catch (err) {
      if (createdCheckRun && decision.status === 'completed' && !completedCheckRun) {
        await completeCheckRun(octokit, log, {
          owner: input.owner,
          repo: input.repo,
          checkRunId,
          conclusion: 'failure',
          output: { title: 'AI Review Gate update failed', summary: 'The gate result could not be confirmed.' },
        });
      }
      throw err;
    }
  });
}

async function readProviderResults(
  octokit: InstallationOctokit,
  owner: string,
  repo: string,
  headSha: string,
  gateCheckName: string,
  providers: readonly GateProvider[],
): Promise<ProviderResult[]> {
  const checkProviders = providers.filter((provider) => provider.type === 'check');
  const statusProviders = providers.filter((provider) => provider.type === 'status');
  const [checkRuns, statuses] = await Promise.all([
    checkProviders.length > 0
      ? listCheckRuns(octokit, owner, repo, headSha)
      : Promise.resolve([] as CheckRunObservation[]),
    statusProviders.length > 0
      ? listCommitStatuses(octokit, owner, repo, headSha)
      : Promise.resolve([] as CommitStatusObservation[]),
  ]);

  const observations = checkRuns.filter((run) => run.name !== gateCheckName);
  const statusObservations = statuses;

  return providers.map((provider) => provider.type === 'check'
    ? observeCheckProvider(provider, observations)
    : observeStatusProvider(provider, statusObservations));
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

function isRetryableGateError(error: unknown): boolean {
  const status = (error as { status?: unknown }).status;
  if (status === 408 || status === 425 || status === 429 || (typeof status === 'number' && status >= 500)) return true;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH'].includes(code);
}

async function retryGateApi<T>(operation: () => Promise<T>, log: Logger, description: string, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !isRetryableGateError(err)) break;
      log.warn({ attempt, err: (err as Error).message, description }, 'retrying provider gate GitHub API call');
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
  throw lastError;
}

const MAX_PROVIDER_PAGES = 10;

async function listCheckRuns(
  octokit: InstallationOctokit,
  owner: string,
  repo: string,
  headSha: string,
): Promise<CheckRunObservation[]> {
  const runs: CheckRunObservation[] = [];
  for (let page = 1; page <= MAX_PROVIDER_PAGES + 1; page++) {
    const response = await octokit.rest.checks.listForRef({ owner, repo, ref: headSha, filter: 'all', per_page: 100, page });
    const pageRuns = response.data.check_runs;
    if (page <= MAX_PROVIDER_PAGES) {
      runs.push(...pageRuns.map((run) => ({
        id: Number(run.id),
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        app: run.app,
        started_at: run.started_at,
        completed_at: run.completed_at,
      })));
    }
    if (pageRuns.length < 100) {
      if (page <= MAX_PROVIDER_PAGES || pageRuns.length === 0) return runs;
      throw new Error(`provider check runs exceeded ${MAX_PROVIDER_PAGES * 100} records for ${headSha}`);
    }
  }
  throw new Error(`provider check runs exceeded ${MAX_PROVIDER_PAGES * 100} records for ${headSha}`);
}

async function findCheckRun(
  octokit: InstallationOctokit,
  owner: string,
  repo: string,
  headSha: string,
  checkRunId: number,
): Promise<CheckRunObservation | undefined> {
  return (await listCheckRuns(octokit, owner, repo, headSha)).find((run) => run.id === checkRunId);
}

async function listCommitStatuses(
  octokit: InstallationOctokit,
  owner: string,
  repo: string,
  headSha: string,
): Promise<CommitStatusObservation[]> {
  const statuses: CommitStatusObservation[] = [];
  for (let page = 1; page <= MAX_PROVIDER_PAGES + 1; page++) {
    const response = await octokit.rest.repos.listCommitStatusesForRef({ owner, repo, ref: headSha, per_page: 100, page });
    const pageStatuses = response.data;
    if (page <= MAX_PROVIDER_PAGES) {
      statuses.push(...pageStatuses.map((status) => ({
        context: status.context,
        state: status.state,
        updated_at: status.updated_at,
        creator: status.creator,
      })));
    }
    if (pageStatuses.length < 100) {
      if (page <= MAX_PROVIDER_PAGES || pageStatuses.length === 0) return statuses;
      throw new Error(`provider commit statuses exceeded ${MAX_PROVIDER_PAGES * 100} records for ${headSha}`);
    }
  }
  throw new Error(`provider commit statuses exceeded ${MAX_PROVIDER_PAGES * 100} records for ${headSha}`);
}

function latestMatching<T>(
  values: readonly T[],
  matches: (value: T) => boolean,
  timestamp: (value: T) => string | null | undefined,
  order: (value: T) => number | null | undefined = () => undefined,
): T | undefined {
  return values
    .filter(matches)
    .sort((a, b) => {
      const aOrder = order(a);
      const bOrder = order(b);
      if (aOrder !== null && aOrder !== undefined && bOrder !== null && bOrder !== undefined && aOrder !== bOrder) {
        return bOrder - aOrder;
      }
      return String(timestamp(b) ?? '').localeCompare(String(timestamp(a) ?? ''));
    })[0];
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
