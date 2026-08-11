import { z } from 'zod';

/**
 * Central configuration schema. The ONLY configuration source for Swear Review.
 * Target repositories never carry any configuration file.
 */

export const GateModeSchema = z.enum(['off', 'check', 'managed']);

export const TRIGGER_DEFAULTS = {
  opened: true,
  synchronize: true,
  reopened: true,
  ready_for_review: true,
} as const;

const TriggerSchema = z.object({
  opened: z.boolean().default(true),
  synchronize: z.boolean().default(true),
  reopened: z.boolean().default(true),
  ready_for_review: z.boolean().default(true),
});

const ReviewConfigSchema = z
  .object({
    auto: z.boolean().default(true),
    default_mode: z.enum(['full', 'incremental']).default('full'),
    review_drafts: z.boolean().default(false),
    triggers: TriggerSchema.default({ ...TRIGGER_DEFAULTS }),
  })
  .default({ auto: true, default_mode: 'full', review_drafts: false, triggers: { ...TRIGGER_DEFAULTS } });

const OcrConfigSchema = z
  .object({
    /** Pinned OCR release. Do not change without contract tests. */
    version: z.string().default('1.9.0'),
    /** Fixed OCR concurrency. No adaptive fallback. */
    concurrency: z.number().int().min(1).default(16),
    /** OCR binary name/path. Defaults to `ocr` on PATH. */
    binary: z.string().default('ocr'),
    /** Per-task timeout in minutes passed to `ocr review --timeout`. */
    timeout_minutes: z.number().int().min(1).default(10),
    /** Overall process kill timeout in minutes (guard against hangs). */
    hard_timeout_minutes: z.number().int().min(1).default(45),
    /** Extra env vars passed to the OCR process (no secrets here). */
    extra_env: z.record(z.string(), z.string()).default({}),
  })
  .default({ version: '1.9.0', concurrency: 16, binary: 'ocr', timeout_minutes: 10, hard_timeout_minutes: 45, extra_env: {} });

const LlmConfigSchema = z
  .object({
    url: z.string().default('https://opencode.ai/zen/go/v1/chat/completions'),
    model: z.string().default('deepseek-v4-flash'),
    use_anthropic: z.boolean().default(false),
  })
  .default({ url: 'https://opencode.ai/zen/go/v1/chat/completions', model: 'deepseek-v4-flash', use_anthropic: false });

const PublicationConfigSchema = z
  .object({
    deduplicate: z.boolean().default(true),
    sticky_summary: z.boolean().default(true),
    comment_batch_size: z.number().int().min(1).default(50),
  })
  .default({ deduplicate: true, sticky_summary: true, comment_batch_size: 50 });

const WorkersConfigSchema = z
  .object({
    max_review_jobs: z.number().int().min(1).default(2),
    poll_interval_ms: z.number().int().min(100).default(1000),
    workspace_dir: z.string().default('/tmp/swear-review'),
    /** Clone URL template. {owner} and {repo} are substituted. */
    clone_url_template: z.string().default('https://github.com/{owner}/{repo}.git'),
    /** Partial clone (blob:none). Disabled automatically for non-https URLs. */
    partial_clone: z.boolean().default(true),
  })
  .default({ max_review_jobs: 2, poll_interval_ms: 1000, workspace_dir: '/tmp/swear-review', clone_url_template: 'https://github.com/{owner}/{repo}.git', partial_clone: true });

const SecurityConfigSchema = z
  .object({
    auto_review_external_prs: z.boolean().default(false),
  })
  .default({ auto_review_external_prs: false });

const GateConfigSchema = z
  .object({
    mode: GateModeSchema.default('off'),
    block_categories: z.array(z.string()).default(['bug', 'security']),
    fail_closed_on_review_error: z.boolean().default(true),
  })
  .default({ mode: 'off', block_categories: ['bug', 'security'], fail_closed_on_review_error: true });

const RepoOverrideSchema = z.object({
  gate: z.object({ mode: GateModeSchema.optional() }).optional(),
  review: z.object({ auto: z.boolean().optional() }).optional(),
});

const AppConfigSchema = z
  .object({
    app: z
      .object({
        name: z.string().default('Swear Review'),
        check_name: z.string().default('Swear Review'),
      })
      .default({ name: 'Swear Review', check_name: 'Swear Review' }),
    review: ReviewConfigSchema,
    ocr: OcrConfigSchema,
    llm: LlmConfigSchema,
    publication: PublicationConfigSchema,
    workers: WorkersConfigSchema,
    security: SecurityConfigSchema,
    gate: GateConfigSchema,
    repositories: z.record(z.string(), RepoOverrideSchema).default({}),
  })
  .default({
    app: { name: 'Swear Review', check_name: 'Swear Review' },
    review: { auto: true, default_mode: 'full', review_drafts: false, triggers: { ...TRIGGER_DEFAULTS } },
    ocr: { version: '1.9.0', concurrency: 16, binary: 'ocr', timeout_minutes: 10, hard_timeout_minutes: 45, extra_env: {} },
    llm: { url: 'https://opencode.ai/zen/go/v1/chat/completions', model: 'deepseek-v4-flash', use_anthropic: false },
    publication: { deduplicate: true, sticky_summary: true, comment_batch_size: 50 },
    workers: { max_review_jobs: 2, poll_interval_ms: 1000, workspace_dir: '/tmp/swear-review', clone_url_template: 'https://github.com/{owner}/{repo}.git', partial_clone: true },
    security: { auto_review_external_prs: false },
    gate: { mode: 'off', block_categories: ['bug', 'security'], fail_closed_on_review_error: true },
    repositories: {},
  });

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type RepoOverride = z.infer<typeof RepoOverrideSchema>;

export const KNOWN_CATEGORIES = [
  'bug',
  'security',
  'performance',
  'maintainability',
  'test',
  'style',
  'documentation',
  'other',
] as const;

export function defaultConfig(): AppConfig {
  return AppConfigSchema.parse({});
}

export { AppConfigSchema, RepoOverrideSchema, TriggerSchema };
