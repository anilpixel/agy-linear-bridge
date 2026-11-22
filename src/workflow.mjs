import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function unquoteScalar(raw) {
  const trimmed = String(raw || "").trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseScalar(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    return "";
  }
  const isQuoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"));
  const unquoted = unquoteScalar(trimmed);
  if (isQuoted) {
    return unquoted;
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isFinite(num)) {
      return num;
    }
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((part) => unquoteScalar(part));
  }
  return unquoted;
}

/**
 * Parse a Symphony-style `WORKFLOW.md` document into `{ frontmatter, body }`.
 */
export function parseWorkflowDocument(rawContent, { maxBodyChars = 12_000 } = {}) {
  const clean = String(rawContent || "").replace(/^\uFEFF/, "");
  const fmMatch = clean.match(/^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)([\s\S]*)$/);

  const frontmatter = {};
  let rawBody = clean;

  if (fmMatch) {
    const yamlBlock = fmMatch[1] || "";
    rawBody = fmMatch[2] || "";
    let currentListKey = null;

    for (const rawLine of yamlBlock.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const listMatch = rawLine.match(/^\s*-\s+(.+)$/);
      if (listMatch && currentListKey) {
        if (!Array.isArray(frontmatter[currentListKey])) {
          frontmatter[currentListKey] = [];
        }
        frontmatter[currentListKey].push(unquoteScalar(listMatch[1]));
        continue;
      }

      const kvMatch = rawLine.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
      if (kvMatch) {
        const key = kvMatch[1].trim();
        const rhs = kvMatch[2].trim();
        if (rhs === "") {
          frontmatter[key] = [];
          currentListKey = key;
        } else {
          frontmatter[key] = parseScalar(rhs);
          currentListKey = null;
        }
      } else {
        currentListKey = null;
      }
    }
  }

  let body = rawBody.trim();
  if (Number.isFinite(maxBodyChars) && maxBodyChars > 0 && body.length > maxBodyChars) {
    body = `${body.slice(0, maxBodyChars).trimEnd()}\n\n...[truncated]`;
  }

  return { frontmatter, body };
}

/**
 * Loads per-project `WORKFLOW.md` policies from a local checkout or via `gh api`, with TTL caching.
 */
export class WorkflowLoader {
  constructor({ config = {}, execFileImpl = execFileAsync, logger = console, nowFn = () => Date.now() } = {}) {
    this.config = config;
    this.execFileImpl = execFileImpl;
    this.logger = logger;
    this.nowFn = nowFn;
    this.cache = new Map();
  }

  async load(project) {
    if (!project || this.config?.workflow?.enabled === false) {
      return null;
    }

    const workflowPath = String(project.workflowPath || "WORKFLOW.md").trim() || "WORKFLOW.md";
    const localPath = String(project.localPath || "").trim();

    if (localPath) {
      const fullPath = path.resolve(localPath, workflowPath);
      try {
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          const raw = fs.readFileSync(fullPath, "utf8");
          const parsed = parseWorkflowDocument(raw);
          return {
            path: workflowPath,
            source: "local",
            repo: String(project.githubRepo || "").trim() || null,
            ...parsed,
          };
        }
      } catch (err) {
        this.logger.warn?.(`[workflow] Failed reading local ${fullPath}: ${err.message}`);
      }
    }

    const githubRepo = String(project.githubRepo || "").trim();
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(githubRepo)) {
      return null;
    }

    const cacheTtlMs =
      Number.isFinite(this.config?.workflow?.cacheTtlMs) && this.config.workflow.cacheTtlMs >= 0
        ? this.config.workflow.cacheTtlMs
        : 300_000;
    const timeoutMs =
      Number.isFinite(this.config?.workflow?.timeoutMs) && this.config.workflow.timeoutMs > 0
        ? this.config.workflow.timeoutMs
        : 8_000;
    const ghBin = this.config?.workflow?.ghBin || "gh";

    const cacheKey = `${githubRepo}:${workflowPath}`;
    const now = this.nowFn();
    const cached = this.cache.get(cacheKey);
    if (cacheTtlMs > 0 && cached && cached.expiresAt > now) {
      return cached.value;
    }

    const encodedPath = workflowPath
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");

    try {
      const { stdout } = await this.execFileImpl(
        ghBin,
        ["api", `repos/${githubRepo}/contents/${encodedPath}`],
        { timeout: timeoutMs }
      );
      const payload = JSON.parse(String(stdout || "{}"));
      if (!payload?.content) {
        if (cacheTtlMs > 0) {
          this.cache.set(cacheKey, { expiresAt: now + cacheTtlMs, value: null });
        }
        return null;
      }

      const rawMarkdown =
        payload.encoding === "base64" || payload.encoding === undefined
          ? Buffer.from(String(payload.content).replace(/\s+/g, ""), "base64").toString("utf8")
          : String(payload.content);

      const parsed = parseWorkflowDocument(rawMarkdown);
      const doc = {
        path: workflowPath,
        source: "github",
        repo: githubRepo,
        ...parsed,
      };
      if (cacheTtlMs > 0) {
        this.cache.set(cacheKey, { expiresAt: now + cacheTtlMs, value: doc });
      }
      return doc;
    } catch (err) {
      const errText = `${err?.stderr || ""} ${err?.message || ""}`;
      if (/\b404\b|Not Found/i.test(errText)) {
        if (cacheTtlMs > 0) {
          this.cache.set(cacheKey, { expiresAt: now + cacheTtlMs, value: null });
        }
        return null;
      }
      this.logger.warn?.(
        `[workflow] Failed fetching ${githubRepo}/${workflowPath}: ${err.message}`
      );
      return null;
    }
  }
}
