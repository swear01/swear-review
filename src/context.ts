import type { AppConfig } from './config/schema.js';
import type { Database } from './db/database.js';
import type { GitHubApi } from './github/app.js';
import type { Worker } from './review/worker.js';
import type { Logger } from './util/logger.js';
import type { Metrics } from './util/metrics.js';

/** Shared context wired together in index.ts (overridable in tests). */
export interface ServiceContext {
  config: AppConfig;
  db: Database;
  log: Logger;
  metrics: Metrics;
  github: GitHubApi;
  /** OpenCode Go key — lives only in server env, injected into OCR env. */
  opencodeKey: string;
  worker: Worker | null;
}
