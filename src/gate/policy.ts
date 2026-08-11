import type { CheckConclusion, Finding } from '../types.js';

export type GateMode = 'off' | 'check' | 'managed';

export interface GatePolicyInput {
  gateMode: GateMode;
  blockCategories: string[];
  findings: Finding[];
  reviewError: boolean;
  failClosedOnReviewError: boolean;
}

export interface GateDecision {
  /** true when a blocking category is present in the findings */
  blocking: boolean;
  conclusion: CheckConclusion;
  /** human-readable explanation for check output / summary */
  reason: string;
}

/**
 * Deterministic blocking policy driven only by OCR structured findings —
 * never by comment text grepping or a second LLM.
 *
 *   off     → Check success (unless review infrastructure failed + fail-closed)
 *   check   → failure when a block category is present; no ruleset changes
 *   managed → same as check, plus ruleset reconciliation (handled separately)
 */
export function computeGateDecision(input: GatePolicyInput): GateDecision {
  const { gateMode, blockCategories, findings, reviewError, failClosedOnReviewError } = input;

  if (reviewError) {
    if (failClosedOnReviewError) {
      return {
        blocking: false,
        conclusion: 'failure',
        reason: 'Review infrastructure/model failure (fail-closed)',
      };
    }
    return {
      blocking: false,
      conclusion: 'neutral',
      reason: 'Review infrastructure/model failure (fail-open)',
    };
  }

  const normalizedBlocks = blockCategories.map((c) => c.toLowerCase());
  const blockingFindings = findings.filter((f) => {
    const cat = (f.category ?? '').toLowerCase();
    return normalizedBlocks.includes(cat);
  });

  if (gateMode === 'off') {
    return {
      blocking: false,
      conclusion: 'success',
      reason: `Review completed with ${findings.length} finding(s); gate mode is off`,
    };
  }

  if (blockingFindings.length > 0) {
    return {
      blocking: true,
      conclusion: 'failure',
      reason: `${blockingFindings.length} blocking finding(s) (${[...new Set(blockingFindings.map((f) => f.category))].join(', ')})`,
    };
  }

  return {
    blocking: false,
    conclusion: 'success',
    reason: 'No blocking findings',
  };
}

/** Counts findings by category (lowercased). */
export function countByCategory(findings: Finding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of findings) {
    const key = (f.category ?? 'other').toLowerCase();
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
