import { describe, it, expect } from 'vitest';
import { parseConfig, resolveRepoConfig, defaultConfig } from '../../src/config/load.js';

describe('parseConfig', () => {
  it('applies safe defaults for empty config', () => {
    const c = parseConfig('');
    expect(c.ocr.version).toBe('1.9.0');
    expect(c.ocr.concurrency).toBe(16);
    expect(c.llm.model).toBe('deepseek-v4-flash');
    expect(c.llm.url).toBe('https://opencode.ai/zen/go/v1/chat/completions');
    expect(c.gate.mode).toBe('off');
    expect(c.gate.block_categories).toEqual(['bug', 'security']);
    expect(c.gate.fail_closed_on_review_error).toBe(true);
    expect(c.workers.max_review_jobs).toBe(2);
    expect(c.publication.comment_batch_size).toBe(50);
    expect(c.security.auto_review_external_prs).toBe(false);
  });

  it('rejects unknown gate modes', () => {
    expect(() => parseConfig('gate:\n  mode: sometimes')).toThrow();
  });

  it('parses full config', () => {
    const c = parseConfig(`
app:
  name: "Swear Review"
review:
  auto: false
  review_drafts: true
ocr:
  concurrency: 16
llm:
  model: deepseek-v4-flash
gate:
  mode: check
  block_categories: [bug]
security:
  auto_review_external_prs: true
`);
    expect(c.review.auto).toBe(false);
    expect(c.review.review_drafts).toBe(true);
    expect(c.ocr.concurrency).toBe(16);
    expect(c.gate.mode).toBe('check');
    expect(c.gate.block_categories).toEqual(['bug']);
    expect(c.security.auto_review_external_prs).toBe(true);
  });
});

describe('resolveRepoConfig (precedence)', () => {
  const base = defaultConfig();

  it('exact repository match wins over glob', () => {
    const c = parseConfig(`
gate:
  mode: off
repositories:
  "OWNER/production-*":
    gate:
      mode: managed
  "OWNER/production-api":
    review:
      auto: false
`);
    const exact = resolveRepoConfig(c, 'OWNER', 'production-api');
    expect(exact.review.auto).toBe(false);
    expect(exact.gate.mode).toBe('managed'); // glob still applies to gate
    const glob = resolveRepoConfig(c, 'OWNER', 'production-web');
    expect(glob.gate.mode).toBe('managed');
    expect(glob.review.auto).toBe(true);
    const other = resolveRepoConfig(c, 'OWNER', 'sandbox');
    expect(other.gate.mode).toBe('off');
  });

  it('does not mutate the original config', () => {
    const c = parseConfig(`
repositories:
  "a/b":
    gate:
      mode: managed
`);
    resolveRepoConfig(c, 'a', 'b');
    expect(c.gate.mode).toBe('off');
  });

  it('matches owner wildcards', () => {
    const c = parseConfig(`
repositories:
  "*/*":
    gate:
      mode: check
`);
    expect(resolveRepoConfig(c, 'anything', 'repo').gate.mode).toBe('check');
  });
});
