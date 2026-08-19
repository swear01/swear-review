import { describe, expect, it } from 'vitest';
import { observeCheckProvider, observeStatusProvider } from '../../src/gate/provider-gate.js';
import type { GateProvider } from '../../src/config/schema.js';

const checkProvider = (extra: Partial<GateProvider> = {}): GateProvider => ({
  name: 'Cursor Bugbot',
  type: 'check',
  check_name: 'Cursor Bugbot',
  ...extra,
});

const statusProvider = (extra: Partial<GateProvider> = {}): GateProvider => ({
  name: 'Gemini Review',
  type: 'status',
  context: 'Gemini Review',
  ...extra,
});

describe('provider observations', () => {
  it('recognizes a successful check from the configured app', () => {
    expect(observeCheckProvider(checkProvider({ app_id: 1210556 }), [{
      name: 'Cursor Bugbot',
      status: 'completed',
      conclusion: 'success',
      app: { id: 1210556, slug: 'cursor' },
    }])).toEqual({ name: 'Cursor Bugbot', status: 'passed', detail: 'success' });
  });

  it('does not accept a same-named check from another app', () => {
    expect(observeCheckProvider(checkProvider({ app_id: 1210556 }), [{
      name: 'Cursor Bugbot',
      status: 'completed',
      conclusion: 'success',
      app: { id: 15368, slug: 'github-actions' },
    }])).toEqual({ name: 'Cursor Bugbot', status: 'pending', detail: 'no matching check run' });
  });

  it('keeps a provider pending until its check completes', () => {
    expect(observeCheckProvider(checkProvider(), [{
      name: 'Cursor Bugbot',
      status: 'in_progress',
      conclusion: null,
      app: { id: 1210556, slug: 'cursor' },
    }])).toEqual({ name: 'Cursor Bugbot', status: 'pending', detail: 'in_progress' });
  });

  it('uses a newer queued check over an older successful check', () => {
    expect(observeCheckProvider(checkProvider(), [
      {
        id: 1,
        name: 'Cursor Bugbot',
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-08-19T00:00:00Z',
        app: { id: 1210556, slug: 'cursor' },
      },
      {
        id: 2,
        name: 'Cursor Bugbot',
        status: 'queued',
        conclusion: null,
        created_at: '2026-08-19T00:01:00Z',
        started_at: null,
        app: { id: 1210556, slug: 'cursor' },
      },
    ])).toEqual({ name: 'Cursor Bugbot', status: 'pending', detail: 'queued' });
  });

  it('maps a failed check to a failed provider', () => {
    expect(observeCheckProvider(checkProvider(), [{
      name: 'Cursor Bugbot',
      status: 'completed',
      conclusion: 'neutral',
      app: { id: 1210556, slug: 'cursor' },
    }])).toEqual({ name: 'Cursor Bugbot', status: 'failed', detail: 'neutral' });
  });

  it('maps a successful commit status to a passed provider', () => {
    expect(observeStatusProvider(statusProvider(), [{ context: 'Gemini Review', state: 'success' }])).toEqual({
      name: 'Gemini Review',
      status: 'passed',
      detail: 'success',
    });
  });

  it('does not treat a missing or pending commit status as a pass', () => {
    expect(observeStatusProvider(statusProvider(), [{ context: 'Gemini Review', state: 'pending' }])).toEqual({
      name: 'Gemini Review',
      status: 'pending',
      detail: 'pending',
    });
    expect(observeStatusProvider(statusProvider(), [])).toEqual({
      name: 'Gemini Review',
      status: 'pending',
      detail: 'no matching commit status',
    });
  });
});
