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

  private nextReviewId = 1;
  private nextCommentId = 1;
  private nextCheckId = 1;
  private nextRulesetId = 1;
  rulesets: Array<{ id: number; name: string }> = [];
  rulesetCreateError: Error | null = null;

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
            const comments = ((p.comments as Array<Record<string, unknown>>) ?? []).map((c) => ({
              id: self.nextReviewId++,
              path: c.path,
              line: c.line,
              start_line: c.start_line ?? null,
            }));
            return { data: { id: self.nextReviewId, comments } };
          }),
        },
        issues: {
          listComments: fakeEndpoint('issues.listComments', (n, p) => self.record(n, p), () => ({ data: [] })),
          createComment: fakeEndpoint('issues.createComment', (n, p) => self.record(n, p), () => ({ data: { id: self.nextCommentId++ } })),
          updateComment: fakeEndpoint('issues.updateComment', (n, p) => self.record(n, p), () => ({ data: { id: self.nextCommentId++ } })),
        },
        checks: {
          create: fakeEndpoint('checks.create', (n, p) => self.record(n, p), () => ({ data: { id: self.nextCheckId++ } })),
          update: fakeEndpoint('checks.update', (n, p) => self.record(n, p), () => ({ data: {} })),
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
        },
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
