import type { GitHubApi, InstallationOctokit } from '../../src/github/app.js';
import { defaultConfig } from '../../src/config/schema.js';

type Call = { params: Record<string, unknown> };

function fakeEndpoint(endpointName: string, record: (name: string, params: Record<string, unknown>) => void, handler: (params: Record<string, unknown>) => unknown) {
  return async (params: Record<string, unknown>) => {
    record(endpointName, params);
    return handler(params);
  };
}

/**
 * Fake GitHub API for tests. Records every REST call and returns canned data.
 */
export class FakeGitHubApi implements GitHubApi {
  /** all recorded calls: endpoint -> list of params */
  calls = new Map<string, Call[]>();

  /** current PR head returned by pulls.get (used to simulate stale pushes) */
  prHeadSha = '1111111111111111111111111111111111111111';
  prBaseSha = '2222222222222222222222222222222222222222';
  prState = 'open';
  /** permission returned for collaborator checks */
  permission = 'admin';
  /** if set, pulls.get throws */
  pullsGetError: Error | null = null;
  /** if set, createReview throws */
  createReviewError: Error | null = null;
  /** mimic real GitHub: createReview response omits the comments array */
  omitReviewComments = true;
  /** comments returned by listCommentsForReview (matched by review id) */

  private nextReviewId = 1;
  private nextCommentId = 1;
  private nextCheckId = 1;
  private nextRulesetId = 1;
  createdCheckApp: { id?: number; slug?: string } | null = null;
  checkRuns: Array<{
    id?: number;
    name: string;
    status: string;
    conclusion: string | null;
    head_sha: string;
    app?: { id?: number; slug?: string } | null;
    started_at?: string | null;
    completed_at?: string | null;
    created_at?: string | null;
  }> = [];
  commitStatuses: Array<{ context: string; state: string; sha?: string; updated_at?: string; creator?: { login?: string } }> = [];
  rulesets: Array<{ id: number; name: string }> = [];
  rulesetCreateError: Error | null = null;
  /** repo-level review comments (mirrors GET /pulls/{n}/comments) */
  reviewComments: Array<{ id: number; review_id: number; path: string; line: number | null; start_line: number | null; original_line: number | null }> = [];

  record(name: string, params: Record<string, unknown>): void {
    const list = this.calls.get(name) ?? [];
    list.push({ params });
    this.calls.set(name, list);
  }

  callsTo(name: string): Call[] {
    return this.calls.get(name) ?? [];
  }

  async getInstallationToken(_installationId: number): Promise<string> {
    return 'fake-installation-token';
  }

  async getOctokit(_installationId: number): Promise<InstallationOctokit> {
    return this.octokit as unknown as InstallationOctokit;
  }

  private get octokit() {
    const self = this;
    return {
      rest: {
        pulls: {
          get: fakeEndpoint('pulls.get', (n, p) => self.record(n, p), () => {
            if (self.pullsGetError) throw self.pullsGetError;
            return {
              data: {
                head: { sha: self.prHeadSha, ref: 'feature' },
                base: { sha: self.prBaseSha, ref: 'main' },
                state: self.prState,
                title: 'Test PR',
              },
            };
          }),
          createReview: fakeEndpoint('pulls.createReview', (n, p) => self.record(n, p), (p) => {
            if (self.createReviewError) throw self.createReviewError;
            const reviewId = self.nextReviewId++;
            for (const c of (p.comments as Array<Record<string, unknown>>) ?? []) {
              self.reviewComments.push({
                id: self.nextCommentId++,
                review_id: reviewId,
                path: String(c.path ?? ''),
                line: (c.line as number) ?? null,
                start_line: (c.start_line as number) ?? null,
                original_line: (c.line as number) ?? null,
              });
            }
            if (self.omitReviewComments) {
              // real GitHub: response has no comments array
              return { data: { id: reviewId } };
            }
            return {
              data: {
                id: reviewId,
                comments: self.reviewComments.filter((c) => c.review_id === reviewId).map((c) => ({ id: c.id, path: c.path, line: c.line, start_line: c.start_line })),
              },
            };
          }),
          listCommentsForReview: fakeEndpoint('pulls.listCommentsForReview', (n, p) => self.record(n, p), (p) => {
            const reviewId = Number(p.review_id);
            // real GitHub returns no line positions from this endpoint
            return { data: self.reviewComments.filter((c) => c.review_id === reviewId).map((c) => ({ id: c.id, path: c.path })) };
          }),
          listReviewCommentsForRepo: fakeEndpoint('pulls.listReviewCommentsForRepo', (n, p) => self.record(n, p), () => {
            const sorted = [...self.reviewComments].sort((a, b) => b.id - a.id);
            return { data: sorted.map((c) => ({ id: c.id, path: c.path, line: c.line, original_line: c.original_line, start_line: c.start_line })) };
          }),
        },
        issues: {
          listComments: fakeEndpoint('issues.listComments', (n, p) => self.record(n, p), () => ({ data: [] })),
          createComment: fakeEndpoint('issues.createComment', (n, p) => self.record(n, p), () => ({ data: { id: self.nextCommentId++ } })),
          updateComment: fakeEndpoint('issues.updateComment', (n, p) => self.record(n, p), () => ({ data: { id: self.nextCommentId++ } })),
        },
        checks: {
          create: fakeEndpoint('checks.create', (n, p) => self.record(n, p), (p) => {
            const id = self.nextCheckId++;
            self.checkRuns.push({
              id,
              name: String(p.name),
              status: String(p.status),
              conclusion: null,
              head_sha: String(p.head_sha),
              app: self.createdCheckApp,
              started_at: (p.started_at as string | undefined) ?? null,
              created_at: new Date().toISOString(),
            });
            return { data: { id } };
          }),
          update: fakeEndpoint('checks.update', (n, p) => self.record(n, p), (p) => {
            const run = self.checkRuns.find((r) => r.id === Number(p.check_run_id));
            if (!run) throw Object.assign(new Error(`check run ${String(p.check_run_id)} not found`), { status: 404 });
            run.status = String(p.status);
            run.conclusion = (p.conclusion as string | null | undefined) ?? run.conclusion;
            if (p.completed_at !== undefined) run.completed_at = String(p.completed_at);
            return { data: {} };
          }),
          listForRef: fakeEndpoint('checks.listForRef', (n, p) => self.record(n, p), (p) => {
            const page = Number(p.page ?? 1);
            const perPage = Number(p.per_page ?? 100);
            const all = self.checkRuns.filter((r) => r.head_sha === String(p.ref));
            return { data: { check_runs: all.slice((page - 1) * perPage, page * perPage) } };
          }),
        },
        repos: {
          getCollaboratorPermissionLevel: fakeEndpoint('repos.getCollaboratorPermissionLevel', (n, p) => self.record(n, p), () => ({ data: { permission: self.permission } })),
          getRepoRulesets: fakeEndpoint('repos.getRepoRulesets', (n, p) => self.record(n, p), () => ({ data: self.rulesets })),
          createRepoRuleset: fakeEndpoint('repos.createRepoRuleset', (n, p) => self.record(n, p), () => {
            if (self.rulesetCreateError) throw self.rulesetCreateError;
            const rs = { id: self.nextRulesetId++, name: (p.name as string) ?? 'unknown' };
            self.rulesets.push(rs);
            return { data: rs };
          }),
          updateRepoRuleset: fakeEndpoint('repos.updateRepoRuleset', (n, p) => self.record(n, p), () => ({ data: {} })),
          deleteRepoRuleset: fakeEndpoint('repos.deleteRepoRuleset', (n, p) => self.record(n, p), () => ({ data: {} })),
          listCommitStatusesForRef: fakeEndpoint('repos.listCommitStatusesForRef', (n, p) => self.record(n, p), (p) => {
            const page = Number(p.page ?? 1);
            const perPage = Number(p.per_page ?? 100);
            const all = self.commitStatuses.filter((s) => !s.sha || s.sha === String(p.ref));
            return { data: all.slice((page - 1) * perPage, page * perPage) };
          }),
        },
      },
      paginate: async (
        endpoint: (params: Record<string, unknown>) => Promise<{ data: unknown }>,
        params: Record<string, unknown>,
      ) => {
        const response = await endpoint(params);
        const data = response.data as { check_runs?: unknown[] } | unknown[];
        return Array.isArray(data) ? data : data.check_runs ?? [];
      },
    };
  }

  /** Builds a test ServiceContext config with the mock OCR wired in. */
  static config(overrides?: {
    concurrency?: number;
    binary?: string;
    workspaceDir?: string;
    cloneTemplate?: string;
    partialClone?: boolean;
    gateMode?: string;
    blockCategories?: string[];
  }) {
    const config = defaultConfig();
    config.ocr.concurrency = overrides?.concurrency ?? 16;
    config.ocr.binary = overrides?.binary ?? (process.env.MOCK_OCR_BIN ?? '');
    config.workers.workspace_dir = overrides?.workspaceDir ?? '/tmp/swear-review-test';
    config.workers.clone_url_template = overrides?.cloneTemplate ?? 'file:///tmp/swear-review-test-repos/{owner}-{repo}.git';
    config.workers.partial_clone = overrides?.partialClone ?? false;
    config.workers.poll_interval_ms = 200;
    if (overrides?.gateMode) config.gate.mode = overrides.gateMode as typeof config.gate.mode;
    if (overrides?.blockCategories) config.gate.block_categories = overrides.blockCategories;
    return config;
  }
}
