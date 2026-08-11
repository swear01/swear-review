import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import { WebhookVerifier } from '../../src/github/webhooks.js';
import { buildServer } from '../../src/server.js';
import { createHarness, prEventPayload, waitFor } from '../helpers/harness.js';
import { FakeGitHubApi } from '../helpers/fake-github.js';

const SECRET = 'test-secret';

/** GitHub webhook HMAC-SHA256 signature (x-hub-signature-256). */
async function sign(secret: string, payload: string): Promise<string> {
  return 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
}

describe('webhook endpoint', () => {
  let harness: ReturnType<typeof createHarness>;
  let github: FakeGitHubApi;
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    github = new FakeGitHubApi();
    github.permission = 'admin';
    github.prHeadSha = '1111111111111111111111111111111111111111';
    harness = createHarness(FakeGitHubApi.config({ binary: 'false' }), github);
    app = buildServer({
      context: harness.ctx,
      scheduler: harness.scheduler,
      verifier: new WebhookVerifier(SECRET),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    harness.cleanup();
  });

  it('health endpoints respond', async () => {
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().db).toBe(true);
  });

  it('rejects requests with a bad signature (401)', async () => {
    const payload = JSON.stringify(prEventPayload());
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-1',
        'x-hub-signature-256': 'sha256=deadbeef',
      },
      payload,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects missing event header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts a validly signed pull_request.opened and enqueues a full review job', async () => {
    const body = JSON.stringify(prEventPayload());
    const signature = await sign(SECRET, body);
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-2',
        'x-hub-signature-256': signature,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    // wait for the async dispatch + worker pickup
    await waitFor(() => harness.db.getLatestJob('test-owner', 'demo', 42) !== null);
    const job = harness.db.getLatestJob('test-owner', 'demo', 42)!;
    expect(job.mode).toBe('full');
    expect(job.trigger).toBe('opened');
    expect(job.head_sha).toBe('1111111111111111111111111111111111111111');
    // private-repo-style permission check only happens for public repos
    expect(github.callsTo('repos.getCollaboratorPermissionLevel').length).toBe(1);
  });
});
