import fs from "node:fs";
import path from "node:path";

/**
 * Atomically write JSON to disk with restrictive permissions (default 0o600).
 */
export function writeJsonAtomic(filePath, data, mode = 0o600) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  try {
    const serialized = `${JSON.stringify(data, null, 2)}\n`;
    fs.writeFileSync(tmpPath, serialized, { encoding: "utf8", mode });
    fs.chmodSync(tmpPath, mode);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Ignore cleanup failure
    }
    throw err;
  }
}

/**
 * Read JSON from disk, returning `fallback` when the file does not exist.
 */
export function readJsonSafe(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return fallback;
    }
    throw err;
  }
}

/**
 * Persistent OAuth / client_credentials token storage.
 */
export class TokenStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  load() {
    return readJsonSafe(this.filePath, null);
  }

  save(tokenData) {
    writeJsonAtomic(this.filePath, tokenData, 0o600);
    return tokenData;
  }

  clear() {
    try {
      fs.unlinkSync(this.filePath);
    } catch (err) {
      if (!err || err.code !== "ENOENT") {
        throw err;
      }
    }
  }
}

/**
 * Persistent mapping from `linearSessionId` to remote Antigravity conversation metadata.
 */
export class SessionStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  _readMap() {
    const data = readJsonSafe(this.filePath, { sessions: {} });
    return data && typeof data.sessions === "object" && data.sessions !== null
      ? data.sessions
      : {};
  }

  get(linearSessionId) {
    if (!linearSessionId) return null;
    const sessions = this._readMap();
    return sessions[linearSessionId] || null;
  }

  upsert(linearSessionId, patch) {
    const sessions = this._readMap();
    const now = new Date().toISOString();
    const prev = sessions[linearSessionId] || {
      linearSessionId,
      createdAt: now,
    };
    const next = {
      ...prev,
      ...patch,
      linearSessionId,
      updatedAt: now,
    };
    sessions[linearSessionId] = next;
    writeJsonAtomic(this.filePath, { sessions }, 0o600);
    return next;
  }

  list() {
    return Object.values(this._readMap());
  }

  count() {
    return Object.keys(this._readMap()).length;
  }

  findByPullRequest({
    repo = "",
    prNumber = null,
    prNumbers = [],
    branch = "",
    issueIdentifiers = [],
  } = {}) {
    const candidates = Object.values(this._readMap())
      .filter((s) => s && s.agyConversationId)
      .sort(
        (a, b) =>
          (Date.parse(b.updatedAt || b.createdAt || "") || 0) -
          (Date.parse(a.updatedAt || a.createdAt || "") || 0)
      );

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
}

/**
 * Per-key FIFO async serializer so events for the same session never race.
 */
export class KeyedQueue {
  constructor() {
    this.chains = new Map();
  }

  enqueue(key, task) {
    const prev = this.chains.get(key) || Promise.resolve();
    const run = prev.then(
      () => task(),
      () => task()
    );
    const tail = run.finally(() => {
      if (this.chains.get(key) === tail) {
        this.chains.delete(key);
      }
    });
    this.chains.set(key, tail);
    return run;
  }
}
