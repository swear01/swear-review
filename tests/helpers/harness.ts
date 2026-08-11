import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../../src/db/database.js';
import { createLogger } from '../../src/util/logger.js';
import { Metrics } from '../../src/util/metrics.js';
import type { ServiceContext } from '../../src/context.js';
import type { AppConfig } from '../../src/config/schema.js';
import { Worker } from '../../src/review/worker.js';
import { Scheduler } from '../../src/review/scheduler.js';
import type { GitHubApi } from '../../src/github/app.js';

export interface TestHarness {
  ctx: ServiceContext;
  db: Database;
  worker: Worker;
  scheduler: Scheduler;
  github: GitHubApi;
  cleanup: () => void;
  workspaceDir: string;
}

/** Builds a full ServiceContext + Worker + Scheduler against temp dirs. */
export function createHarness(config: AppConfig, github: GitHubApi): TestHarness {
  const dbPath = path.join(mkdtempSync(path.join(os.tmpdir(), 'swear-db-')), 'test.db');
  const db = new Database(dbPath);
  const log = createLogger(process.env.LOG_LEVEL || 'silent');
  const metrics = new Metrics();
  const ctx: ServiceContext = {
    config,
    db,
    log,
    metrics,
    github,
    opencodeKey: 'test-opencode-key',
    worker: null,
  };
  const worker = new Worker(ctx);
  ctx.worker = worker;
  worker.start();
  const scheduler = new Scheduler(ctx);
  return {
    ctx,
    db,
    worker,
    scheduler,
    github,
    workspaceDir: config.workers.workspace_dir,
    cleanup: () => {
      worker.stop();
      db.close();
      rmSync(dbPath, { recursive: true, force: true });
      rmSync(config.workers.workspace_dir, { recursive: true, force: true });
    },
  };
}

export async function waitFor(fn: () => boolean, timeoutMs = 20_000, intervalMs = 150): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** PR payload factory for webhook tests. */
export function prEventPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'opened',
    number: 42,
    pull_request: {
      number: 42,
      state: 'open',
      draft: false,
      title: 'Test PR',
      user: { login: 'alice' },
      head: { sha: '1111111111111111111111111111111111111111', ref: 'feature' },
      base: { sha: '2222222222222222222222222222222222222222', ref: 'main' },
    },
    repository: {
      name: 'demo',
      full_name: 'test-owner/demo',
      owner: { login: 'test-owner' },
      private: false,
      default_branch: 'main',
    },
    installation: { id: 123, account: { login: 'test-owner', type: 'User' } },
    ...overrides,
  };
}
