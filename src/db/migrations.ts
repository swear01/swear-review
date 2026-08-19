/** SQLite schema (SQL) and versioned migrations. Uses node:sqlite (built into Node >= 24). */

export const SCHEMA_VERSION = 3;

export const MIGRATIONS: string[] = [
  // v1 — initial schema
  `
  CREATE TABLE IF NOT EXISTS installations (
    id INTEGER PRIMARY KEY,
    account_login TEXT NOT NULL,
    account_type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS repositories (
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    installation_id INTEGER NOT NULL,
    private INTEGER NOT NULL DEFAULT 0,
    default_branch TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner, name)
  );

  CREATE TABLE IF NOT EXISTS pull_requests (
    repo_owner TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    head_sha TEXT,
    base_sha TEXT,
    last_reviewed_sha TEXT,
    last_successful_review_sha TEXT,
    last_full_review_sha TEXT,
    draft INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'open',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (repo_owner, repo_name, pr_number)
  );

  CREATE TABLE IF NOT EXISTS repository_state (
    repo_owner TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    last_full_review_sha TEXT,
    last_successful_review_sha TEXT,
    gate_mode TEXT NOT NULL DEFAULT 'off',
    ruleset_id INTEGER,
    ruleset_state TEXT NOT NULL DEFAULT 'unmanaged',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (repo_owner, repo_name)
  );

  CREATE TABLE IF NOT EXISTS review_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    installation_id INTEGER NOT NULL,
    repo_owner TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    base_sha TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'full',
    status TEXT NOT NULL DEFAULT 'queued',
    trigger TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    superseded_by INTEGER,
    check_run_id INTEGER,
    review_run_id INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_review_jobs_status ON review_jobs(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_review_jobs_repo_pr ON review_jobs(repo_owner, repo_name, pr_number, status);

  CREATE TABLE IF NOT EXISTS review_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    installation_id INTEGER NOT NULL,
    repo_owner TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    mode TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    ocr_version TEXT,
    model TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',
    finding_count INTEGER NOT NULL DEFAULT 0,
    check_run_id INTEGER,
    error_message TEXT
  );

  CREATE TABLE IF NOT EXISTS findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    review_run_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    start_line INTEGER,
    end_line INTEGER,
    category TEXT,
    severity TEXT,
    message TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    published_comment_id INTEGER,
    publish_state TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_findings_run ON findings(review_run_id);

  CREATE TABLE IF NOT EXISTS published_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_owner TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    review_run_id INTEGER NOT NULL,
    finding_id INTEGER,
    github_comment_id INTEGER,
    path TEXT NOT NULL,
    start_line INTEGER,
    end_line INTEGER,
    category TEXT,
    fingerprint TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_published_repo_pr ON published_comments(repo_owner, repo_name, pr_number);

  CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO schema_version (version) VALUES (1);
  `,

  // v2 — one-of-many provider gate state
  `
  CREATE TABLE IF NOT EXISTS review_gates (
    repo_owner TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    check_run_id INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (repo_owner, repo_name, pr_number, head_sha)
  );
  CREATE INDEX IF NOT EXISTS idx_review_gates_repo_pr ON review_gates(repo_owner, repo_name, pr_number, updated_at);

  INSERT OR IGNORE INTO schema_version (version) VALUES (2);
  `,

  // v3 — persist provider gate lifecycle state so completed check runs are never reopened
  `
  ALTER TABLE review_gates ADD COLUMN status TEXT NOT NULL DEFAULT 'completed';
  ALTER TABLE review_gates ADD COLUMN conclusion TEXT;

  INSERT OR IGNORE INTO schema_version (version) VALUES (${SCHEMA_VERSION});
  `,
];
