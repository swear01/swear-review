export type ProviderStatus = 'pending' | 'passed' | 'failed';

export interface ProviderResult {
  name: string;
  status: ProviderStatus;
  detail?: string;
}

export interface ProviderGateDecision {
  status: 'in_progress' | 'completed';
  conclusion?: 'success' | 'failure';
  reason: string;
}

/** OR gate: one successful provider is enough to allow merging. */
export function computeAnyProviderGate(results: readonly ProviderResult[]): ProviderGateDecision {
  const passed = results.find((result) => result.status === 'passed');
  if (passed) {
    return {
      status: 'completed',
      conclusion: 'success',
      reason: `${passed.name} passed`,
    };
  }

  if (results.length === 0) {
    return {
      status: 'completed',
      conclusion: 'failure',
      reason: 'No review providers configured',
    };
  }

  const pending = results.filter((result) => result.status === 'pending').map((result) => result.name);
  if (pending.length > 0) {
    return {
      status: 'in_progress',
      reason: `Waiting for review provider(s): ${pending.join(', ')}`,
    };
  }

  return {
    status: 'completed',
    conclusion: 'failure',
    reason: 'No review provider passed',
  };
}
