import { describe, expect, it } from 'vitest';
import { computeAnyProviderGate, type ProviderResult } from '../../src/gate/provider-policy.js';

const provider = (name: string, status: ProviderResult['status']): ProviderResult => ({ name, status });

describe('computeAnyProviderGate', () => {
  it('passes as soon as one provider passes', () => {
    const decision = computeAnyProviderGate([
      provider('Swear Review', 'failed'),
      provider('Codex Review', 'pending'),
      provider('Cursor Bugbot', 'passed'),
    ]);

    expect(decision).toEqual({
      status: 'completed',
      conclusion: 'success',
      reason: 'Cursor Bugbot passed',
    });
  });

  it('stays in progress while no provider has passed and one is pending', () => {
    const decision = computeAnyProviderGate([
      provider('Swear Review', 'failed'),
      provider('Gemini Review', 'pending'),
    ]);

    expect(decision.status).toBe('in_progress');
    expect(decision.conclusion).toBeUndefined();
    expect(decision.reason).toContain('Gemini Review');
  });

  it('fails only when every configured provider has failed', () => {
    const decision = computeAnyProviderGate([
      provider('Swear Review', 'failed'),
      provider('Codex Review', 'failed'),
    ]);

    expect(decision).toEqual({
      status: 'completed',
      conclusion: 'failure',
      reason: 'No review provider passed',
    });
  });

  it('fails closed when no providers are configured', () => {
    expect(computeAnyProviderGate([])).toEqual({
      status: 'completed',
      conclusion: 'failure',
      reason: 'No review providers configured',
    });
  });
});
