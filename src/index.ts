#!/usr/bin/env node

import { loadEnv } from './env.js';
import { createLogger } from './util/logger.js';
import { Metrics } from './util/metrics.js';
import { loadConfigFile } from './config/load.js';
import { Database } from './db/database.js';
import { RealGitHubApi } from './github/app.js';
import { WebhookVerifier } from './github/webhooks.js';
import { Scheduler } from './review/scheduler.js';
import { Worker } from './review/worker.js';
import { buildServer } from './server.js';
import type { ServiceContext } from './context.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger(env.logLevel);
  const metrics = new Metrics();
  const config = loadConfigFile(env.configPath);
  if (env.ocrBinary) config.ocr.binary = env.ocrBinary;
  const db = new Database(env.databasePath);
  const github = new RealGitHubApi(env.githubAppId, env.githubAppPrivateKey, log);

  const ctx: ServiceContext = {
    config,
    db,
    log,
    metrics,
    github,
    opencodeKey: env.opencodeGoKey,
    worker: null,
  };

  const worker = new Worker(ctx);
  ctx.worker = worker;
  worker.start();

  const scheduler = new Scheduler(ctx);
  const verifier = new WebhookVerifier(env.githubWebhookSecret);
  const server = buildServer({ context: ctx, scheduler, verifier });

  await server.listen({ port: env.port, host: '0.0.0.0' });
  log.info(
    { port: env.port, config: env.configPath, db: env.databasePath, ocr: config.ocr.version, model: config.llm.model, concurrency: config.ocr.concurrency },
    'Swear Review started',
  );

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'shutting down');
    worker.stop();
    await server.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => log.error({ err: (err as Error).message }, 'unhandledRejection'));
  process.on('uncaughtException', (err) => log.error({ err: (err as Error).message }, 'uncaughtException'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[swear-review] fatal:', err);
  process.exit(1);
});
