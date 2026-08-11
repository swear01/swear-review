/** Shared domain types for Swear Review. */

/** A normalized review finding produced by the OCR adapter. */
export interface Finding {
  path: string;
  startLine?: number;
  endLine?: number;
  title?: string;
  message: string;
  category?: string;
  severity?: string;
  suggestionCode?: string;
  existingCode?: string;
}

export type ReviewMode = 'full' | 'incremental';

export type JobStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'cancelled'
  | 'superseded'
  | 'completed'
  | 'failed';

export type RunStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'stale';

export type CheckConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required';

/** Parsed + validated OCR review result (see tests/fixtures/ocr-v1.9.0.json). */
export interface OcrResult {
  status: string;
  model?: string;
  message?: string;
  summary?: {
    filesReviewed: number;
    comments: number;
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    elapsed?: string;
  };
  comments: Finding[];
  sessionId?: string;
  ocrVersion?: string;
  configuredConcurrency?: number;
  coverage?: {
    selected: number;
    completed: number;
    reused: number;
    failed: number;
    waived: number;
  };
  elapsedMs?: number;
  toolCalls?: { total: number; byTool: Record<string, number> };
}

/** A job row from the SQLite queue. */
export interface JobRecord {
  id: number;
  installation_id: number;
  repo_owner: string;
  repo_name: string;
  pr_number: number;
  base_sha: string;
  head_sha: string;
  mode: ReviewMode;
  status: JobStatus;
  trigger: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  superseded_by: number | null;
  check_run_id: number | null;
  review_run_id: number | null;
}

/** A review run row. */
export interface RunRecord {
  id: number;
  installation_id: number;
  repo_owner: string;
  repo_name: string;
  pr_number: number;
  mode: ReviewMode;
  base_sha: string;
  head_sha: string;
  ocr_version: string | null;
  model: string | null;
  started_at: string;
  completed_at: string | null;
  status: RunStatus;
  finding_count: number;
  check_run_id: number | null;
  error_message: string | null;
}

export interface GitHubPullRequestInfo {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  baseSha: string;
  headRef: string;
  baseRef: string;
  draft: boolean;
  repoPrivate: boolean;
  authorLogin: string;
  installationId: number;
  repoId?: number;
  title?: string;
}
