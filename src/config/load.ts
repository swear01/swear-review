import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import micromatch from 'micromatch';
import { z } from 'zod';
import { AppConfigSchema, defaultConfig, type AppConfig, type RepoOverride } from './schema.js';

/**
 * Loads the central YAML config and resolves per-repository overrides.
 *
 * Precedence (lowest → highest):
 *   hardcoded safe defaults → global config → repository glob patterns → exact repository
 */
export function loadConfigFile(path: string): AppConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      // Config file is optional; safe defaults apply.
      return defaultConfig();
    }
    throw err;
  }
  return parseConfig(raw);
}

export function parseConfig(raw: string): AppConfig {
  let doc: unknown;
  try {
    doc = YAML.parse(raw);
  } catch (err) {
    throw new Error(`Invalid YAML config: ${(err as Error).message}`);
  }
  if (doc == null) return defaultConfig();
  const parsed = AppConfigSchema.safeParse(doc);
  if (!parsed.success) {
    throw new Error(`Invalid config schema: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** Returns the effective config for a specific repository, with overrides applied. */
export function resolveRepoConfig(config: AppConfig, owner: string, repo: string): AppConfig {
  const key = `${owner}/${repo}`;
  const matches = Object.entries(config.repositories)
    .filter(([pattern]) => pattern === key || micromatch.isMatch(key, pattern, { dot: true }))
    .sort(([a], [b]) => b.length - a.length); // exact / most specific first

  if (matches.length === 0) return config;

  const merged = structuredClone(config);
  const { repositories, ...rest } = merged;
  let result = rest as AppConfig & { repositories?: Record<string, RepoOverride> };
  for (const [, override] of matches) {
    if (override.review?.auto !== undefined) result.review.auto = override.review.auto;
    if (override.gate?.mode !== undefined) result.gate.mode = override.gate.mode;
    if (override.gate?.strategy !== undefined) result.gate.strategy = override.gate.strategy;
    if (override.gate?.check_name !== undefined) result.gate.check_name = override.gate.check_name;
    if (override.gate?.providers !== undefined) result.gate.providers = structuredClone(override.gate.providers);
  }
  return result as AppConfig;
}

export { defaultConfig };
