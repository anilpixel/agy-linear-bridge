import crypto from "node:crypto";

export const EDGE_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS kv_state (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_pr ON sessions(pr_repo, pr_number)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_suggested_branch ON sessions(suggested_branch_name)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_pr_branch ON sessions(pr_branch)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_issue_identifier ON sessions(issue_identifier)`,
  `CREATE TABLE IF NOT EXISTS runner_jobs (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_runner_jobs_claim ON runner_jobs(status, lease_until, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_runner_jobs_session ON runner_jobs(agent_session_id, status)`,
  `CREATE TABLE IF NOT EXISTS seen_deliveries (
    delivery_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
];

const schemaReadyByDb = new WeakMap();

export async function ensureEdgeSchema(db) {
  if (!db) {
    throw new Error("Missing Cloudflare D1 database binding (env.DB)");
  }
  let ready = schemaReadyByDb.get(db);
  if (!ready) {
    ready = db
      .batch(EDGE_SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)))
      .catch((err) => {
        schemaReadyByDb.delete(db);
        throw err;
      });
    schemaReadyByDb.set(db, ready);
  }
  await ready;
}

function sqlVal(value) {
  return value === undefined ? null : value;
}

function parseJsonSafe(raw, fallback) {
  if (typeof raw !== "string" || !raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

const SESSION_DIRECT_KEYS = new Set([
  "linearSessionId",
  "issueId",
  "issueIdentifier",
  "projectKey",
  "projectName",
  "remoteProject",
  "githubRepo",
  "suggestedBranchName",
  "agyConversationId",
  "aceUvmId",
  "prUrl",
  "prRepo",
  "prNumber",
  "prBranch",
  "status",
  "ciFixAttempts",
  "lastCiFixSha",
  "workflowPolicy",
  "externalUrls",
  "createdAt",
  "updatedAt",
]);

function rowToSession(row) {
  if (!row) {
    return null;
  }
  const extra = parseJsonSafe(row.extra_json, {});
  const workflowPolicy = parseJsonSafe(row.workflow_policy_json, undefined);
  const externalUrls = parseJsonSafe(row.external_urls_json, undefined);
  return {
    ...extra,
    linearSessionId: row.agent_session_id,
    issueId: row.issue_id ?? null,
    issueIdentifier: row.issue_identifier ?? null,
    projectKey: row.project_key ?? undefined,
    projectName: row.project_name ?? undefined,
    remoteProject: row.remote_project ?? undefined,
    githubRepo: row.github_repo ?? null,
    ...(row.suggested_branch_name ? { suggestedBranchName: row.suggested_branch_name } : {}),
    agyConversationId: row.agy_conversation_id ?? null,
    aceUvmId: row.ace_uvm_id ?? null,
    ...(row.pr_url ? { prUrl: row.pr_url } : {}),
    ...(row.pr_repo ? { prRepo: row.pr_repo } : {}),
    ...(row.pr_number !== null && row.pr_number !== undefined
      ? { prNumber: Number(row.pr_number) }
      : {}),
    ...(row.pr_branch ? { prBranch: row.pr_branch } : {}),
    status: row.status,
    ciFixAttempts: Number(row.ci_fix_attempts || 0),
    ...(row.last_ci_fix_sha ? { lastCiFixSha: row.last_ci_fix_sha } : {}),
    ...(workflowPolicy !== undefined ? { workflowPolicy } : {}),
    ...(externalUrls !== undefined ? { externalUrls } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * D1-backed OAuth token store compatible with `LinearTokenManager`.
 */
export class D1TokenStore {
  constructor(db, { nowFn = Date.now } = {}) {
    this.db = db;
    this.nowFn = nowFn;
  }

  async load() {
    await ensureEdgeSchema(this.db);
    const row = await this.db
      .prepare("SELECT value_json FROM kv_state WHERE key = ?")
      .bind("linear_oauth_token")
      .first();
    return row ? parseJsonSafe(row.value_json, null) : null;
  }

  async save(tokenData) {
    await ensureEdgeSchema(this.db);
    const now = this.nowFn();
    await this.db
      .prepare(
        `INSERT INTO kv_state (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`
      )
      .bind("linear_oauth_token", JSON.stringify(tokenData), now)
      .run();
    return tokenData;
  }

  async clear() {
    await ensureEdgeSchema(this.db);
    await this.db
      .prepare("DELETE FROM kv_state WHERE key = ?")
      .bind("linear_oauth_token")
      .run();
  }
}

/**
 * D1-backed single-use CSRF state store so OAuth callbacks work across Worker isolates.
 */
export class D1OAuthStateStore {
  constructor(db, { ttlMs = 10 * 60 * 1000, nowFn = Date.now } = {}) {
    this.db = db;
    this.ttlMs = ttlMs;
    this.nowFn = nowFn;
  }

  async create(metadata = {}) {
    await ensureEdgeSchema(this.db);
    const now = this.nowFn();
    const state = crypto.randomBytes(24).toString("hex");
    const payload = {
      metadata,
      expiresAt: now + this.ttlMs,
    };
    await this.db.batch([
      this.db
        .prepare("DELETE FROM kv_state WHERE key LIKE 'oauth_state:%' AND updated_at < ?")
        .bind(now - this.ttlMs),
      this.db
        .prepare("INSERT INTO kv_state (key, value_json, updated_at) VALUES (?, ?, ?)")
        .bind(`oauth_state:${state}`, JSON.stringify(payload), now),
    ]);
    return state;
  }

  async consume(state) {
    if (!state || typeof state !== "string") {
      return null;
    }
    await ensureEdgeSchema(this.db);
    const key = `oauth_state:${state}`;
    const row = await this.db
      .prepare("SELECT value_json FROM kv_state WHERE key = ?")
      .bind(key)
      .first();
    if (!row) {
      return null;
    }
    await this.db.prepare("DELETE FROM kv_state WHERE key = ?").bind(key).run();
    const parsed = parseJsonSafe(row.value_json, null);
    if (!parsed || parsed.expiresAt < this.nowFn()) {
      return null;
    }
    return parsed.metadata ?? {};
  }
}

/**
 * D1-backed persistence for sessions, outbound Runner jobs, webhook deduplication, and heartbeats.
 */
export class D1BridgeStore {
  constructor(db, { nowFn = Date.now } = {}) {
    this.db = db;
    this.nowFn = nowFn;
  }

  async getSession(agentSessionId) {
    if (!agentSessionId) return null;
    await ensureEdgeSchema(this.db);
    const row = await this.db
      .prepare("SELECT * FROM sessions WHERE agent_session_id = ?")
      .bind(String(agentSessionId))
      .first();
    return rowToSession(row);
  }

  async upsertSession(agentSessionId, patch = {}) {
    await ensureEdgeSchema(this.db);
    const id = String(agentSessionId);
    const nowIso = new Date(this.nowFn()).toISOString();
    const prev = (await this.getSession(id)) || {
      linearSessionId: id,
      createdAt: nowIso,
      status: "queued",
      ciFixAttempts: 0,
    };

    const merged = {
      ...prev,
      ...patch,
      linearSessionId: id,
      createdAt: prev.createdAt || nowIso,
      updatedAt: nowIso,
    };

    const extra = {};
    for (const [k, v] of Object.entries(merged)) {
      if (!SESSION_DIRECT_KEYS.has(k) && v !== undefined) {
        extra[k] = v;
      }
    }

    const prNumber =
      merged.prNumber !== null &&
      merged.prNumber !== undefined &&
      Number.isFinite(Number(merged.prNumber))
        ? Number(merged.prNumber)
        : null;

    await this.db
      .prepare(
        `INSERT INTO sessions (
          agent_session_id, issue_id, issue_identifier, project_key, project_name,
          remote_project, github_repo, suggested_branch_name, agy_conversation_id, ace_uvm_id,
          pr_url, pr_repo, pr_number, pr_branch, status, ci_fix_attempts, last_ci_fix_sha,
          workflow_policy_json, external_urls_json, extra_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_session_id) DO UPDATE SET
          issue_id = excluded.issue_id,
          issue_identifier = excluded.issue_identifier,
          project_key = excluded.project_key,
          project_name = excluded.project_name,
          remote_project = excluded.remote_project,
          github_repo = excluded.github_repo,
          suggested_branch_name = excluded.suggested_branch_name,
          agy_conversation_id = excluded.agy_conversation_id,
          ace_uvm_id = excluded.ace_uvm_id,
          pr_url = excluded.pr_url,
          pr_repo = excluded.pr_repo,
          pr_number = excluded.pr_number,
          pr_branch = excluded.pr_branch,
          status = excluded.status,
          ci_fix_attempts = excluded.ci_fix_attempts,
          last_ci_fix_sha = excluded.last_ci_fix_sha,
          workflow_policy_json = excluded.workflow_policy_json,
          external_urls_json = excluded.external_urls_json,
          extra_json = excluded.extra_json,
          updated_at = excluded.updated_at`
      )
      .bind(
        id,
        sqlVal(merged.issueId ?? null),
        sqlVal(merged.issueIdentifier ?? null),
        sqlVal(merged.projectKey ?? null),
        sqlVal(merged.projectName ?? null),
        sqlVal(merged.remoteProject ?? null),
        sqlVal(merged.githubRepo ?? null),
        sqlVal(merged.suggestedBranchName ?? null),
        sqlVal(merged.agyConversationId ?? null),
        sqlVal(merged.aceUvmId ?? null),
        sqlVal(merged.prUrl ?? null),
        sqlVal(merged.prRepo ?? null),
        prNumber,
        sqlVal(merged.prBranch ?? null),
        String(merged.status || "queued"),
        Number(merged.ciFixAttempts || 0),
        sqlVal(merged.lastCiFixSha ?? null),
        merged.workflowPolicy !== undefined ? JSON.stringify(merged.workflowPolicy) : null,
        merged.externalUrls !== undefined ? JSON.stringify(merged.externalUrls) : null,
        Object.keys(extra).length > 0 ? JSON.stringify(extra) : null,
        merged.createdAt,
        merged.updatedAt
      )
      .run();

    return merged;
  }

  async countSessions() {
    await ensureEdgeSchema(this.db);
    const row = await this.db
      .prepare("SELECT COUNT(*) AS cnt FROM sessions")
      .first();
    return Number(row?.cnt || 0);
  }

  async findByPullRequest({
    repo = "",
    prNumber = null,
    prNumbers = [],
    branch = "",
    issueIdentifiers = [],
  } = {}) {
    await ensureEdgeSchema(this.db);
    const res = await this.db
      .prepare(
        "SELECT * FROM sessions WHERE agy_conversation_id IS NOT NULL ORDER BY updated_at DESC LIMIT 200"
      )
      .all();
    const candidates = (res?.results || []).map(rowToSession).filter(Boolean);

    const normRepo = String(repo || "").trim().toLowerCase();
    const prNums = new Set();
    if (Number.isFinite(Number(prNumber)) && Number(prNumber) > 0) {
      prNums.add(Number(prNumber));
    }
    for (const n of Array.isArray(prNumbers) ? prNumbers : []) {
      const num = Number(n);
      if (Number.isFinite(num) && num > 0) {
        prNums.add(num);
      }
    }

    const normBranch = String(branch || "").trim().toLowerCase();
    const idSet = new Set(
      (Array.isArray(issueIdentifiers) ? issueIdentifiers : [])
        .map((id) => String(id || "").trim().toUpperCase())
        .filter(Boolean)
    );

    if (prNums.size > 0) {
      const tier1 = candidates.find((s) => {
        const sPr = Number(s.prNumber);
        if (!prNums.has(sPr)) return false;
        if (!normRepo) return true;
        const sPrRepo = String(s.prRepo || "").trim().toLowerCase();
        const sGhRepo = String(s.githubRepo || "").trim().toLowerCase();
        if (sPrRepo) return sPrRepo === normRepo;
        if (sGhRepo) return sGhRepo === normRepo;
        return true;
      });
      if (tier1) return tier1;
    }

    if (normBranch) {
      const tier2 = candidates.find((s) => {
        const repoCompatible =
          !normRepo ||
          ((!s.prRepo || String(s.prRepo).trim().toLowerCase() === normRepo) &&
            (!s.githubRepo || String(s.githubRepo).trim().toLowerCase() === normRepo));
        if (!repoCompatible) return false;
        const sPrBranch = String(s.prBranch || "").trim().toLowerCase();
        const sSuggested = String(s.suggestedBranchName || "").trim().toLowerCase();
        return sPrBranch === normBranch || sSuggested === normBranch;
      });
      if (tier2) return tier2;
    }

    if (idSet.size > 0) {
      const tier3 = candidates.find((s) => {
        const ident = String(s.issueIdentifier || "").trim().toUpperCase();
        if (!ident || !idSet.has(ident)) return false;
        if (!normRepo || !s.githubRepo) return true;
        return String(s.githubRepo).trim().toLowerCase() === normRepo;
      });
      if (tier3) return tier3;
    }

    return null;
  }

  async markDeliverySeen(deliveryId, source) {
    const clean = String(deliveryId || "").trim();
    if (!clean) {
      return true;
    }
    await ensureEdgeSchema(this.db);
    const now = this.nowFn();
    // Prune deliveries older than 24 hours opportunistically
    await this.db
      .prepare("DELETE FROM seen_deliveries WHERE created_at < ?")
      .bind(now - 86_400_000)
      .run();

    const res = await this.db
      .prepare(
        "INSERT OR IGNORE INTO seen_deliveries (delivery_id, source, created_at) VALUES (?, ?, ?)"
      )
      .bind(clean, String(source || "webhook"), now)
      .run();
    const changes = Number(res?.meta?.changes ?? res?.changes ?? 1);
    return changes > 0;
  }

  async enqueueJob({ agentSessionId, kind, payload }) {
    await ensureEdgeSchema(this.db);
    const now = this.nowFn();
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO runner_jobs (
          id, agent_session_id, kind, status, payload_json, attempts,
          claimed_by, lease_until, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', ?, 0, NULL, NULL, NULL, ?, ?)`
      )
      .bind(id, String(agentSessionId), String(kind), JSON.stringify(payload ?? {}), now, now)
      .run();
    return { id, agentSessionId: String(agentSessionId), kind: String(kind) };
  }

  async cancelPendingJobsForSession(agentSessionId) {
    await ensureEdgeSchema(this.db);
    const now = this.nowFn();
    await this.db
      .prepare(
        `UPDATE runner_jobs
         SET status = 'cancelled', updated_at = ?
         WHERE agent_session_id = ? AND status = 'pending'`
      )
      .bind(now, String(agentSessionId))
      .run();
  }

  async claimJobs({ runnerId, maxJobs = 2, leaseMs = 300_000 }) {
    await ensureEdgeSchema(this.db);
    const now = this.nowFn();
    const limit = Math.max(1, Math.min(10, Number(maxJobs) || 2));
    const candidatesRes = await this.db
      .prepare(
        `SELECT * FROM runner_jobs
         WHERE status = 'pending' OR (status = 'claimed' AND lease_until < ?)
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .bind(now, limit * 2)
      .all();

    const claimed = [];
    for (const row of candidatesRes?.results || []) {
      if (claimed.length >= limit) {
        break;
      }
      if (Number(row.attempts || 0) >= 5) {
        await this.db
          .prepare(
            "UPDATE runner_jobs SET status = 'failed', last_error = 'Exceeded max claim attempts', updated_at = ? WHERE id = ?"
          )
          .bind(now, row.id)
          .run();
        continue;
      }

      const leaseUntil = now + leaseMs;
      const upd = await this.db
        .prepare(
          `UPDATE runner_jobs
           SET status = 'claimed',
               claimed_by = ?,
               lease_until = ?,
               attempts = attempts + 1,
               updated_at = ?
           WHERE id = ? AND (status = 'pending' OR (status = 'claimed' AND lease_until < ?))`
        )
        .bind(String(runnerId || "runner"), leaseUntil, now, row.id, now)
        .run();

      const changes = Number(upd?.meta?.changes ?? upd?.changes ?? 0);
      if (changes > 0) {
        claimed.push({
          id: row.id,
          agentSessionId: row.agent_session_id,
          kind: row.kind,
          attempts: Number(row.attempts || 0) + 1,
          payload: parseJsonSafe(row.payload_json, {}),
          createdAt: row.created_at,
        });
      }
    }

    return claimed;
  }

  async completeJob(jobId, { status = "completed", lastError = null } = {}) {
    await ensureEdgeSchema(this.db);
    const now = this.nowFn();
    const finalStatus = status === "failed" ? "failed" : "completed";
    await this.db
      .prepare(
        `UPDATE runner_jobs
         SET status = ?, lease_until = NULL, last_error = ?, updated_at = ?
         WHERE id = ?`
      )
      .bind(finalStatus, sqlVal(lastError), now, String(jobId))
      .run();
  }

  async countPendingJobs() {
    await ensureEdgeSchema(this.db);
    const row = await this.db
      .prepare(
        "SELECT COUNT(*) AS cnt FROM runner_jobs WHERE status IN ('pending', 'claimed')"
      )
      .first();
    return Number(row?.cnt || 0);
  }

  async recordRunnerHeartbeat({ runnerId, activeWatchers = 0, projectsCount = 0 }) {
    await ensureEdgeSchema(this.db);
    const now = this.nowFn();
    const value = {
      runnerId: String(runnerId || "runner"),
      lastSeenAt: new Date(now).toISOString(),
      lastSeenMs: now,
      activeWatchers: Number(activeWatchers || 0),
      projectsCount: Number(projectsCount || 0),
    };
    await this.db
      .prepare(
        `INSERT INTO kv_state (key, value_json, updated_at)
         VALUES ('runner_heartbeat', ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`
      )
      .bind(JSON.stringify(value), now)
      .run();
    return value;
  }

  async getRunnerStatus({ maxAgeMs = 45_000 } = {}) {
    await ensureEdgeSchema(this.db);
    const row = await this.db
      .prepare("SELECT value_json, updated_at FROM kv_state WHERE key = 'runner_heartbeat'")
      .first();
    if (!row) {
      return {
        online: false,
        runnerId: null,
        lastSeenAt: null,
        activeWatchers: 0,
        projectsCount: 0,
      };
    }
    const parsed = parseJsonSafe(row.value_json, {});
    const lastMs = Number(parsed?.lastSeenMs || row.updated_at || 0);
    const online = lastMs > 0 && this.nowFn() - lastMs <= maxAgeMs;
    return {
      online,
      runnerId: parsed?.runnerId || null,
      lastSeenAt: parsed?.lastSeenAt || null,
      activeWatchers: Number(parsed?.activeWatchers || 0),
      projectsCount: Number(parsed?.projectsCount || 0),
    };
  }
}
