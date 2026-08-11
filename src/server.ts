import Fastify, { type FastifyInstance } from 'fastify';
import type { ServiceContext } from './context.js';
import type { Scheduler } from './review/scheduler.js';
import type { WebhookVerifier } from './github/webhooks.js';
import type { Metrics } from './util/metrics.js';

export interface ServerOptions {
  context: ServiceContext;
  scheduler: Scheduler;
  verifier: WebhookVerifier;
}

/**
 * Fastify HTTP server: webhook receiver + health/metrics endpoints.
 * All webhook events are signature-verified before dispatch.
 */
export function buildServer(opts: ServerOptions): FastifyInstance {
  const { context, scheduler, verifier } = opts;
  const { log, metrics } = context;

  const fastify = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });

  // Keep the raw body for signature verification.
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  fastify.get('/healthz', async () => ({ status: 'ok', uptime: process.uptime() }));
  fastify.get('/readyz', async () => {
    try {
      context.db.db.prepare('SELECT 1').get();
      return { status: 'ok', db: true };
    } catch (err) {
      log.error({ err: (err as Error).message }, 'readyz failed');
      return { status: 'error', db: false };
    }
  });
  fastify.get('/metrics', async (_req, reply) => {
    reply.type('text/plain; version=0.0.4').send(renderMetrics(metrics));
  });

  fastify.post('/webhooks', async (req, reply) => {
    metrics.webhooksReceived.inc({ event: String(req.headers['x-github-event'] ?? 'unknown') });
    const rawBody = (req.body as Buffer | undefined)?.toString('utf8') ?? '';
    const signature = (req.headers['x-hub-signature-256'] as string | undefined) ?? (req.headers['x-hub-signature'] as string | undefined);
    const eventName = req.headers['x-github-event'] as string | undefined;
    const deliveryId = (req.headers['x-github-delivery'] as string | undefined) ?? 'unknown';

    if (!eventName) {
      return reply.code(400).send({ error: 'missing x-github-event header' });
    }

    try {
      await verifier.verify(rawBody, signature);
    } catch (err) {
      metrics.webhookSignatureFailures.inc({ event: eventName });
      log.warn({ deliveryId, err: (err as Error).message }, 'webhook signature verification failed');
      return reply.code(401).send({ error: 'invalid signature' });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return reply.code(400).send({ error: 'invalid JSON payload' });
    }

    // Dispatch asynchronously; the webhook response must be fast. Events are
    // re-deliverable by GitHub if the service is down.
    void scheduler
      .handleEvent(eventName, payload)
      .catch((err) => log.error({ deliveryId, eventName, err: (err as Error).message }, 'webhook handler failed'));

    return reply.code(200).send({ ok: true, deliveryId });
  });

  return fastify;
}

export function renderMetrics(metrics: Metrics): string {
  return metrics.render();
}
