-- Initial Cloudflare D1 schema for agy-linear-bridge Edge Gateway

CREATE TABLE IF NOT EXISTS kv_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  agent_session_id TEXT PRIMARY KEY,
  issue_id TEXT,
  issue_identifier TEXT,
  project_key TEXT,
  project_name TEXT,
  remote_project TEXT,
  github_repo TEXT,
  suggested_branch_name TEXT,
  agy_conversation_id TEXT,
  ace_uvm_id TEXT,
  pr_url TEXT,
  pr_repo TEXT,
  pr_number INTEGER,
  pr_branch TEXT,
  status TEXT NOT NULL,
  ci_fix_attempts INTEGER NOT NULL DEFAULT 0,
  last_ci_fix_sha TEXT,
  workflow_policy_json TEXT,
  external_urls_json TEXT,
  extra_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_pr
  ON sessions(pr_repo, pr_number);

CREATE INDEX IF NOT EXISTS idx_sessions_suggested_branch
  ON sessions(suggested_branch_name);

CREATE INDEX IF NOT EXISTS idx_sessions_pr_branch
  ON sessions(pr_branch);

CREATE INDEX IF NOT EXISTS idx_sessions_issue_identifier
  ON sessions(issue_identifier);

CREATE TABLE IF NOT EXISTS runner_jobs (
  id TEXT PRIMARY KEY,
  agent_session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT,
  lease_until INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runner_jobs_claim
  ON runner_jobs(status, lease_until, created_at);

CREATE INDEX IF NOT EXISTS idx_runner_jobs_session
  ON runner_jobs(agent_session_id, status);

CREATE TABLE IF NOT EXISTS seen_deliveries (
  delivery_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
