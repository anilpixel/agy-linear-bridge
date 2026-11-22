import crypto from "node:crypto";

const PR_URL_RE = /https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)/gi;
const ISSUE_ID_RE = /\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g;

/**
 * Extract unique canonical GitHub Pull Request references from arbitrary text.
 */
export function extractPullRequestUrls(text) {
  const input = String(text || "");
  if (!input) {
    return [];
  }

  const seen = new Set();
  const results = [];
  for (const match of input.matchAll(PR_URL_RE)) {
    const owner = match[1];
    const repoName = match[2];
    const prNumber = Number(match[3]);
    if (!Number.isFinite(prNumber) || prNumber <= 0) {
      continue;
    }
    const repo = `${owner}/${repoName}`;
    const url = `https://github.com/${repo}/pull/${prNumber}`;
    const key = url.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push({ url, repo, prNumber });
  }
  return results;
}

/**
 * Merge external URL objects (`{ label, url }`) while deduplicating by case-insensitive URL.
 */
export function mergeExternalUrls(existingUrls = [], additions = []) {
  const merged = [];
  const indexByUrl = new Map();

  const addEntry = (item) => {
    if (!item || typeof item !== "object") {
      return;
    }
    const url = String(item.url || "").trim();
    if (!url) {
      return;
    }
    const label = String(item.label || url).trim() || url;
    const key = url.toLowerCase();
    if (indexByUrl.has(key)) {
      const idx = indexByUrl.get(key);
      if (label !== url && merged[idx].label === merged[idx].url) {
        merged[idx] = { label, url };
      }
      return;
    }
    indexByUrl.set(key, merged.length);
    merged.push({ label, url });
  };

  for (const item of Array.isArray(existingUrls) ? existingUrls : []) {
    addEntry(item);
  }
  for (const item of Array.isArray(additions) ? additions : []) {
    addEntry(item);
  }
  return merged;
}

/**
 * Extract unique uppercase Linear-style issue identifiers (e.g. `ENG-101`) from text.
 */
export function extractIssueIdentifiers(text) {
  const input = String(text || "");
  if (!input) {
    return [];
  }
  const seen = new Set();
  for (const match of input.matchAll(ISSUE_ID_RE)) {
    seen.add(match[1].toUpperCase());
  }
  return Array.from(seen);
}

/**
 * Verify GitHub HMAC-SHA256 webhook signature (`X-Hub-Signature-256`).
 */
export function verifyGitHubWebhook({ rawBody, signature256Header, webhookSecret }) {
  if (!webhookSecret) {
    return { ok: false, status: 500, reason: "GITHUB_WEBHOOK_SECRET is not configured" };
  }

  const header = Array.isArray(signature256Header) ? signature256Header[0] : signature256Header;
  if (!header || typeof header !== "string") {
    return { ok: false, status: 401, reason: "Missing X-Hub-Signature-256 header" };
  }

  const match = header.trim().match(/^sha256=([0-9a-f]{64})$/i);
  if (!match) {
    return { ok: false, status: 401, reason: "Malformed X-Hub-Signature-256 header" };
  }

  const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""), "utf8");
  const expectedHex = crypto
    .createHmac("sha256", String(webhookSecret))
    .update(bodyBuffer)
    .digest("hex");

  const sigBuf = Buffer.from(match[1].toLowerCase(), "hex");
  const expectedBuf = Buffer.from(expectedHex, "hex");
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return { ok: false, status: 401, reason: "Invalid X-Hub-Signature-256" };
  }

  return { ok: true };
}

function isIgnoredActor(user, ignoredSet) {
  if (!user || typeof user !== "object") {
    return false;
  }
  const login = String(user.login || "").trim().toLowerCase();
  const type = String(user.type || "").trim().toLowerCase();
  if (type === "bot" || /\[bot\]$/i.test(login)) {
    return true;
  }
  return Boolean(login && ignoredSet.has(login));
}

function extractBranchIssueIdentifiers(branch) {
  const clean = String(branch || "");
  if (!clean) {
    return [];
  }
  const out = [];
  for (const match of clean.matchAll(/(?:^|[/_-])([A-Za-z][A-Za-z0-9]{1,9}-\d+)(?=$|[-_/.])/g)) {
    out.push(match[1].toUpperCase());
  }
  return out;
}

/**
 * Normalize supported GitHub webhook payloads into dispatcher events (or `null` when ignored).
 */
export function parseGitHubEvent({
  eventName,
  deliveryId = "",
  payload,
  ignoredActors = [],
}) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const event = String(eventName || "").trim().toLowerCase();
  const action = String(payload.action || "").trim().toLowerCase();
  const repo = String(payload.repository?.full_name || "").trim();
  const ignoredSet = new Set(
    (Array.isArray(ignoredActors) ? ignoredActors : [])
      .map((a) => String(a || "").trim().toLowerCase())
      .filter(Boolean)
  );

  if (event === "pull_request") {
    if (!["opened", "reopened", "synchronize"].includes(action)) {
      return null;
    }
    const pr = payload.pull_request;
    const prNumber = Number(pr?.number);
    if (!repo || !pr || !Number.isFinite(prNumber) || prNumber <= 0) {
      return null;
    }
    const branch = String(pr.head?.ref || "").trim();
    const title = String(pr.title || "").trim();
    const prUrl = String(pr.html_url || `https://github.com/${repo}/pull/${prNumber}`).trim();
    const issueIdentifiers = Array.from(
      new Set([
        ...extractIssueIdentifiers(`${title}\n${pr.body || ""}`),
        ...extractBranchIssueIdentifiers(branch),
      ])
    );
    return {
      kind: "pr_sync",
      deliveryId: String(deliveryId || ""),
      repo,
      prNumber,
      prUrl,
      branch,
      title,
      headSha: String(pr.head?.sha || "").trim(),
      issueIdentifiers,
    };
  }

  if (event === "check_run") {
    const cr = payload.check_run;
    const conclusion = String(cr?.conclusion || "").trim().toLowerCase();
    if (
      action !== "completed" ||
      !repo ||
      !cr ||
      !["failure", "timed_out", "action_required"].includes(conclusion)
    ) {
      return null;
    }
    const prNumbers = (Array.isArray(cr.pull_requests) ? cr.pull_requests : [])
      .map((p) => Number(p?.number))
      .filter((n) => Number.isFinite(n) && n > 0);
    const branch = String(
      cr.pull_requests?.[0]?.head?.ref || cr.check_suite?.head_branch || ""
    ).trim();
    const summary = [cr.output?.title, cr.output?.summary]
      .filter((s) => typeof s === "string" && s.trim())
      .map((s) => s.trim())
      .join("\n\n")
      .slice(0, 2000);
    return {
      kind: "ci_failure",
      source: "check_run",
      deliveryId: String(deliveryId || ""),
      repo,
      name: String(cr.name || "GitHub Check").trim(),
      conclusion,
      detailsUrl: String(cr.html_url || cr.details_url || "").trim(),
      headSha: String(cr.head_sha || "").trim(),
      branch,
      prNumbers,
      summary,
    };
  }

  if (event === "workflow_run") {
    const wr = payload.workflow_run;
    const conclusion = String(wr?.conclusion || "").trim().toLowerCase();
    if (action !== "completed" || !repo || !wr || !["failure", "timed_out"].includes(conclusion)) {
      return null;
    }
    const prNumbers = (Array.isArray(wr.pull_requests) ? wr.pull_requests : [])
      .map((p) => Number(p?.number))
      .filter((n) => Number.isFinite(n) && n > 0);
    const branch = String(wr.head_branch || wr.pull_requests?.[0]?.head?.ref || "").trim();
    const summary = [wr.display_title, wr.html_url ? `Run URL: ${wr.html_url}` : ""]
      .filter((s) => typeof s === "string" && s.trim())
      .map((s) => s.trim())
      .join("\n")
      .slice(0, 2000);
    return {
      kind: "ci_failure",
      source: "workflow_run",
      deliveryId: String(deliveryId || ""),
      repo,
      name: String(wr.name || payload.workflow?.name || "GitHub Workflow").trim(),
      conclusion,
      detailsUrl: String(wr.html_url || "").trim(),
      headSha: String(wr.head_sha || "").trim(),
      branch,
      prNumbers,
      summary,
    };
  }

  if (event === "pull_request_review") {
    const review = payload.review;
    const pr = payload.pull_request;
    const prNumber = Number(pr?.number);
    if (action !== "submitted" || !repo || !review || !pr || !Number.isFinite(prNumber) || prNumber <= 0) {
      return null;
    }
    if (isIgnoredActor(review.user, ignoredSet)) {
      return null;
    }
    const state = String(review.state || "").trim().toLowerCase();
    const body = String(review.body || "").trim();
    if (state !== "changes_requested" && !(state === "commented" && body)) {
      return null;
    }
    const branch = String(pr.head?.ref || "").trim();
    const issueIdentifiers = Array.from(
      new Set([
        ...extractIssueIdentifiers(`${pr.title || ""}\n${pr.body || ""}`),
        ...extractBranchIssueIdentifiers(branch),
      ])
    );
    return {
      kind: "pr_review",
      deliveryId: String(deliveryId || ""),
      repo,
      prNumber,
      prUrl: String(pr.html_url || `https://github.com/${repo}/pull/${prNumber}`).trim(),
      branch,
      reviewer: String(review.user?.login || "reviewer").trim(),
      state,
      body: body.slice(0, 4000),
      reviewUrl: String(review.html_url || pr.html_url || "").trim(),
      issueIdentifiers,
    };
  }

  if (event === "pull_request_review_comment") {
    const comment = payload.comment;
    const pr = payload.pull_request;
    const prNumber = Number(pr?.number);
    if (action !== "created" || !repo || !comment || !pr || !Number.isFinite(prNumber) || prNumber <= 0) {
      return null;
    }
    if (isIgnoredActor(comment.user, ignoredSet)) {
      return null;
    }
    const body = String(comment.body || "").trim();
    if (!body) {
      return null;
    }
    const branch = String(pr.head?.ref || "").trim();
    const issueIdentifiers = Array.from(
      new Set([
        ...extractIssueIdentifiers(`${pr.title || ""}\n${pr.body || ""}`),
        ...extractBranchIssueIdentifiers(branch),
      ])
    );
    const rawLine = comment.line ?? comment.original_line ?? null;
    const line = Number.isFinite(Number(rawLine)) && Number(rawLine) > 0 ? Number(rawLine) : null;
    return {
      kind: "pr_review_comment",
      deliveryId: String(deliveryId || ""),
      repo,
      prNumber,
      prUrl: String(pr.html_url || `https://github.com/${repo}/pull/${prNumber}`).trim(),
      branch,
      reviewer: String(comment.user?.login || "reviewer").trim(),
      filePath: String(comment.path || "").trim(),
      line,
      body: body.slice(0, 4000),
      commentUrl: String(comment.html_url || pr.html_url || "").trim(),
      issueIdentifiers,
    };
  }

  return null;
}
