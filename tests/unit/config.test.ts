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
    expect(c.gate.strategy).toBe('single');
    expect(c.gate.check_name).toBe('AI Review Gate');
    expect(c.gate.providers).toEqual([]);
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

  it('rejects an any-provider gate without providers', () => {
    expect(() => parseConfig('gate:\n  strategy: any')).toThrow();
  });

  it('rejects a provider without an explicit source', () => {
    expect(() => parseConfig(`
gate:
  strategy: any
  providers:
    - name: Unpinned
      type: check
      check_name: Unpinned
`)).toThrow();
  });

  it('trims provider and gate matching strings', () => {
    const c = parseConfig(`
gate:
  check_name: ' AI Review Gate '
  strategy: any
  providers:
    - name: ' Cursor '
      type: check
      check_name: ' Cursor Bugbot '
      app_slug: ' cursor '
    - name: ' Status '
      type: status
      context: ' CI '
      creator_login: ' github-actions[bot] '
`);
    expect(c.gate.check_name).toBe('AI Review Gate');
    expect(c.gate.providers[0]).toMatchObject({ name: 'Cursor', check_name: 'Cursor Bugbot', app_slug: 'cursor' });
    expect(c.gate.providers[1]).toMatchObject({ name: 'Status', context: 'CI', creator_login: 'github-actions[bot]' });
  });

  it('rejects unknown provider fields', () => {
    expect(() => parseConfig(`
 gate:
  strategy: any
  providers:
    - name: Cursor Bugbot
      type: check
      check_name: Cursor Bugbot
      app_slug: cursor
      appId: 1210556
`)).toThrow();
  });

  it('rejects duplicate provider names', () => {
    expect(() => parseConfig(`
 gate:
  strategy: any
  providers:
    - name: Duplicate
      type: check
      check_name: First
      app_slug: first
    - name: Duplicate
      type: check
      check_name: Second
      app_slug: second
`)).toThrow();
  });

  it('rejects duplicate provider identities', () => {
    expect(() => parseConfig(`
gate:
  strategy: any
  providers:
    - name: Cursor One
      type: check
      check_name: Cursor Bugbot
      app_slug: cursor
    - name: Cursor Two
      type: check
      check_name: cursor bugbot
      app_slug: cursor
`)).toThrow();
  });

  it('parses an any-provider gate', () => {
    const c = parseConfig(`
 gate:
  mode: managed
  strategy: any
  check_name: AI Review Gate
  providers:
    - name: Swear Review
      type: check
      check_name: Swear Review
      app_slug: swear-review
    - name: Cursor Bugbot
      type: check
      check_name: Cursor Bugbot
      app_id: 1210556
    - name: Gemini Review
      type: status
      context: Gemini Review
      creator_login: github-actions[bot]
`);
    expect(c.gate.strategy).toBe('any');
    expect(c.gate.check_name).toBe('AI Review Gate');
    expect(c.gate.providers).toHaveLength(3);
    expect(c.gate.providers[1]!.app_id).toBe(1210556);
    expect(c.gate.providers[2]!.context).toBe('Gemini Review');
  });
});

describe('defaultConfig', () => {
  it('does not share mutable gate defaults between parses', () => {
    const first = defaultConfig();
    const second = defaultConfig();
    first.gate.providers.push({ name: 'One', type: 'check', check_name: 'One', app_slug: 'one' });
    first.gate.block_categories.push('custom');
    expect(second.gate.providers).toEqual([]);
    expect(second.gate.block_categories).toEqual(['bug', 'security']);
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
    gate:
      mode: check
    review:
      auto: false
`);
    const exact = resolveRepoConfig(c, 'OWNER', 'production-api');
    expect(exact.gate.mode).toBe('check');
    expect(exact.review.auto).toBe(false);
    const glob = resolveRepoConfig(c, 'OWNER', 'production-web');
    expect(glob.gate.mode).toBe('managed');
    expect(glob.review.auto).toBe(true);
    const other = resolveRepoConfig(c, 'OWNER', 'sandbox');
    expect(other.gate.mode).toBe('off');
  });

  it('applies exact overrides after longer wildcard patterns', () => {
    const c = parseConfig(`
repositories:
  "org/repo*":
    gate:
      mode: managed
  "org/repo":
    gate:
      mode: check
`);
    expect(resolveRepoConfig(c, 'org', 'repo').gate.mode).toBe('check');
  });

  it('rejects a provider that collides with the aggregate gate check name', () => {
    expect(() => parseConfig(`
gate:
  strategy: any
  check_name: AI Review Gate
  providers:
    - name: Aggregate
      type: check
      check_name: AI Review Gate
      app_slug: example
`)).toThrow();
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

  it('rejects an any-provider override without effective providers at load time', () => {
    expect(() => parseConfig(`
repositories:
  a/b:
    gate:
      strategy: any
`)).toThrow();
  });

  it('applies any-provider gate overrides without mutating the base', () => {
    const c = parseConfig(`
repositories:
  "a/b":
    gate:
      strategy: any
      check_name: AI Review Gate
      providers:
        - name: Cursor Bugbot
          type: check
          check_name: Cursor Bugbot
          app_id: 1210556
`);
    const resolved = resolveRepoConfig(c, 'a', 'b');
    expect(resolved.gate.strategy).toBe('any');
    expect(resolved.gate.check_name).toBe('AI Review Gate');
    expect(resolved.gate.providers[0]!.name).toBe('Cursor Bugbot');
    expect(c.gate.strategy).toBe('single');
  });
});
