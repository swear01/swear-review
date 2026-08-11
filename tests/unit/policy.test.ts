import { describe, it, expect } from 'vitest';
import { computeGateDecision, countByCategory } from '../../src/gate/policy.js';

const bug = { path: 'a.ts', startLine: 1, message: 'x', category: 'bug' };
const security = { path: 'a.ts', startLine: 2, message: 'y', category: 'security' };
const style = { path: 'a.ts', startLine: 3, message: 'z', category: 'style' };

describe('computeGateDecision', () => {
  describe('gate=off (default)', () => {
    it('returns success even with blocking-category findings (Test I)', () => {
      const d = computeGateDecision({ gateMode: 'off', blockCategories: ['bug', 'security'], findings: [bug], reviewError: false, failClosedOnReviewError: true });
      expect(d.conclusion).toBe('success');
      expect(d.blocking).toBe(false);
    });
    it('returns failure on review error when fail-closed', () => {
      const d = computeGateDecision({ gateMode: 'off', blockCategories: ['bug'], findings: [], reviewError: true, failClosedOnReviewError: true });
      expect(d.conclusion).toBe('failure');
    });
    it('returns neutral on review error when fail-open', () => {
      const d = computeGateDecision({ gateMode: 'off', blockCategories: ['bug'], findings: [], reviewError: true, failClosedOnReviewError: false });
      expect(d.conclusion).toBe('neutral');
    });
  });

  describe('gate=check / managed', () => {
    it('fails when a bug finding exists (Test J)', () => {
      const d = computeGateDecision({ gateMode: 'managed', blockCategories: ['bug', 'security'], findings: [bug], reviewError: false, failClosedOnReviewError: true });
      expect(d.blocking).toBe(true);
      expect(d.conclusion).toBe('failure');
      expect(d.reason).toContain('1 blocking finding');
    });

    it('fails on security too', () => {
      const d = computeGateDecision({ gateMode: 'check', blockCategories: ['bug', 'security'], findings: [security], reviewError: false, failClosedOnReviewError: true });
      expect(d.blocking).toBe(true);
      expect(d.conclusion).toBe('failure');
    });

    it('non-blocking categories do not block', () => {
      const d = computeGateDecision({ gateMode: 'managed', blockCategories: ['bug', 'security'], findings: [style], reviewError: false, failClosedOnReviewError: true });
      expect(d.blocking).toBe(false);
      expect(d.conclusion).toBe('success');
    });

    it('no findings → success (Test K)', () => {
      const d = computeGateDecision({ gateMode: 'managed', blockCategories: ['bug', 'security'], findings: [], reviewError: false, failClosedOnReviewError: true });
      expect(d.blocking).toBe(false);
      expect(d.conclusion).toBe('success');
    });
  });

  it('blocking is deterministic: only category matters, severity ignored', () => {
    const lowBug = { ...bug, severity: 'low' };
    const highBug = { ...bug, severity: 'critical' };
    expect(computeGateDecision({ gateMode: 'managed', blockCategories: ['bug'], findings: [lowBug], reviewError: false, failClosedOnReviewError: true }).blocking).toBe(true);
    expect(computeGateDecision({ gateMode: 'managed', blockCategories: ['bug'], findings: [highBug], reviewError: false, failClosedOnReviewError: true }).blocking).toBe(true);
  });
});

describe('countByCategory', () => {
  it('counts lowercased categories', () => {
    const counts = countByCategory([bug, security, style, { ...bug, category: 'Bug' }]);
    expect(counts).toEqual({ bug: 2, security: 1, style: 1 });
  });
});
