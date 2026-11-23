import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { isLinearThreadPlaceholder } from "./webhook.mjs";

const execFileAsync = promisify(execFile);

class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, limit);
    this.active = 0;
    this.waiters = [];
  }

  async run(fn) {
    if (this.active >= this.limit) {
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.waiters.shift();
      if (next) next();
    }
  }
}

function buildSessionCallbackInstructions(sessionCallback) {
  if (!sessionCallback?.callbackUrl || !sessionCallback?.callbackToken) {
    return [];
  }
  const { agentSessionId, callbackUrl, callbackToken } = sessionCallback;
  return [
    "",
    "## Linear Agent Session Callback Protocol (Required)",
    `- Linear AgentSession (\`${agentSessionId}\`) is held \`active\` and handed off to you.`,
    `- **Callback URL**: \`${callbackUrl}\``,
    `- **Authorization Bearer Token**: \`${callbackToken}\` (scoped to this AgentSession only; never commit to git or PRs)`,
    "- Post progress updates via HTTPS POST at key milestones so Linear does not mark the session `stale` after 30 minutes:",
    `  - **Progress / keepalive (every 10-15 min on long runs)**: \`{"type":"thought","body":"..."}\` or \`{"type":"action","action":"...","parameter":"..."}\``,
    `  - **Ask for human input (moves session to \`awaitingInput\`)**: \`{"type":"elicitation","body":"..."}\``,
    `  - **Final completion (marks Linear AgentSession \`complete\`)**: \`{"type":"response","body":"Summary and PR link"}\``,
    `  - **Attach PR link**: include \`"prUrl":"https://github.com/owner/repo/pull/123"\` (or \`"externalUrls":[...]\`) in any Callback JSON to attach the PR card to Linear.`,
    `  - **Unrecoverable failure**: \`{"type":"error","body":"Failure reason"}\``,
    "- Example:",
    "  ```bash",
    `  curl -fsS -X POST "${callbackUrl}" \\`,
    `    -H "Authorization: Bearer ${callbackToken}" \\`,
    `    -H "Content-Type: application/json" \\`,
    `    -d '{"type":"thought","body":"Connected to remote workspace; investigating codebase."}'`,
    "  ```",
    "- **Scope note**: Use the Callback above for **AgentSession lifecycle** updates (`thought` / `action` / `elicitation` / final `response`). Use the cloud `linear` CLI (`/home/antigravity/.gemini/bin/linear`) if you also need to read upstream issue relations, move issue workflow states (`In Progress` / `In Review`), or post standalone issue comments.",
  ];
}

function buildCompactCallbackReminder(sessionCallback) {
  if (!sessionCallback?.callbackUrl || !sessionCallback?.callbackToken) {
    return [];
  }
  return [
    "",
    `> Callback (\`thought\` progress / final \`response\`): \`POST ${sessionCallback.callbackUrl}\` · \`Authorization: Bearer ${sessionCallback.callbackToken}\``,
  ];
}

function escapeXmlAttr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderFallbackIssueXml(issueContext) {
  const identifier = issueContext?.identifier || "UNKNOWN-ISSUE";
  const title = issueContext?.title || "(no title)";
  const description = String(issueContext?.description || "").trim();
  const teamName = issueContext?.team?.name || issueContext?.team?.key || "";
  const projectName = issueContext?.project?.name || "";
  const parent = issueContext?.parent;
  const labels = (issueContext?.labels?.nodes || []).map((l) => l?.name).filter(Boolean);

  const lines = [`<issue identifier="${escapeXmlAttr(identifier)}">`, `<title>${title}</title>`];
  if (description) {
    lines.push("<description>", description, "</description>");
  }
  if (teamName) {
    lines.push(`<team name="${escapeXmlAttr(teamName)}"/>`);
  }
  for (const label of labels) {
    lines.push(`<label>${label}</label>`);
  }
  if (projectName) {
    lines.push(`<project name="${escapeXmlAttr(projectName)}"/>`);
  }
  if (parent?.identifier) {
    const titleAttr = parent.title ? ` title="${escapeXmlAttr(parent.title)}"` : "";
    lines.push(`<parent identifier="${escapeXmlAttr(parent.identifier)}"${titleAttr}/>`);
  }
  lines.push("</issue>");
  return lines.join("\n");
}

function formatGuidance(guidance) {
  if (!guidance) {
    return "";
  }
  if (typeof guidance === "string") {
    return guidance.trim();
  }
  if (Array.isArray(guidance)) {
    return guidance
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (item && typeof item === "object") {
          return String(item.body ?? item.content ?? "").trim();
        }
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  if (typeof guidance === "object") {
    return String(guidance.body ?? guidance.content ?? "").trim();
  }
  return "";
}

function isTextAlreadyIncluded(snippet, container) {
  const cleanSnippet = String(snippet || "").trim();
  const cleanContainer = String(container || "");
  if (!cleanSnippet || !cleanContainer) {
    return false;
  }
  if (cleanContainer.includes(cleanSnippet)) {
    return true;
  }
  if (cleanSnippet.length >= 12) {
    const normalizedContainer = cleanContainer.replace(/\s+/g, " ");
    const normalizedSnippet = cleanSnippet.replace(/\s+/g, " ");
    if (normalizedContainer.includes(normalizedSnippet)) {
      return true;
    }
  }
  return false;
}

export function buildDispatchPrompt({
  issueContext,
  comment,
  promptContext,
  guidance = null,
  creator = null,
  project,
  workflow = null,
  sessionCallback = null,
}) {
  const identifier = issueContext?.identifier || "UNKNOWN-ISSUE";
  const branchName = String(issueContext?.branchName || "").trim();
  const url = String(issueContext?.url || "").trim();
  const stateName = String(issueContext?.state?.name || "").trim();
  const priorityLabel = String(issueContext?.priorityLabel || "").trim();
  const parent = issueContext?.parent;
  const triggerUser = String(creator?.displayName || creator?.name || "").trim();
  const rawPromptContext = String(promptContext || "").trim();
  const hasIssueXml = /<issue\b/i.test(rawPromptContext);
  const rawCommentBody = String(comment?.body || "").trim();
  const commentBody = isLinearThreadPlaceholder(rawCommentBody) ? "" : rawCommentBody;
  const guidanceText = formatGuidance(guidance);
  const workflowBody = String(workflow?.body || "").trim();

  const statusParts = [
    stateName ? `State: ${stateName}` : null,
    priorityLabel ? `Priority: ${priorityLabel}` : null,
  ].filter(Boolean);

  const parentLine =
    parent?.identifier && !rawPromptContext.includes(parent.identifier)
      ? `Parent issue: ${parent.identifier}${parent.title ? ` (${parent.title})` : ""}`
      : null;

  const lines = [
    `Work on Linear issue ${identifier}:`,
    "",
    branchName ? `Suggested branch name: ${branchName}` : null,
    url ? `Issue URL: ${url}` : null,
    statusParts.length ? statusParts.join(" | ") : null,
    parentLine,
    triggerUser ? `Triggered by: ${triggerUser}` : null,
    project?.name ? `Target project: ${project.name}` : null,
    "",
    hasIssueXml ? rawPromptContext : renderFallbackIssueXml(issueContext),
    !hasIssueXml && rawPromptContext ? `\n## Linear Prompt Context\n${rawPromptContext}` : null,
    commentBody && !isTextAlreadyIncluded(commentBody, rawPromptContext)
      ? `\n## Triggering Comment\n${commentBody}`
      : null,
    guidanceText ? `\n## Linear Guidance\n${guidanceText}` : null,
    workflowBody
      ? `\n## Repository Workflow Policy (${workflow.path || "WORKFLOW.md"})\n${workflowBody}`
      : null,
    project?.extraInstructions ? `\n## Project Instructions\n${project.extraInstructions}` : null,
    "",
    "## Git Branch, PR Linking & Execution Guidelines",
    branchName
      ? `1. **Git Branch & Linear PR Auto-Linking**: Whenever making code changes, use the exact \`Suggested branch name\` above (\`git checkout -B "${branchName}"\`, or pull & continue if the remote branch already exists) instead of inventing \`feat/...\` or \`fix/...\` branch names. Keep \`${identifier}\` in the PR title so GitHub <-> Linear auto-linking and workflow transitions trigger cleanly. For read-only research or design-only tickets, do not modify code or create branches.`
      : `1. **Git Branch & Linear PR Auto-Linking**: Whenever making code changes, include \`${identifier}\` in both the branch name and PR title so GitHub <-> Linear auto-linking and workflow transitions trigger cleanly. For read-only research or design-only tickets, do not modify code or create branches.`,
    workflowBody
      ? "2. **Autonomous Execution & Verification**: Complete the issue autonomously inside this cloud Remote Project; when changing code, follow the Repository Workflow Policy above and run required checks before opening a PR."
      : "2. **Autonomous Execution & Verification**: Complete the issue autonomously inside this cloud Remote Project; if a root `WORKFLOW.md` exists in the repository, read and follow its verification gates before opening a PR.",
    `3. **Linear CLI**: If configured in the remote environment (\`/home/antigravity/.gemini/bin/linear\`), you can inspect issue relations/comments, update workflow states (\`In Progress\` / \`In Review\`), or add comments via \`linear issue comment add ${identifier}\`.`,
    "4. **Unattended Run**: Do not wait for interactive local terminal prompts; drive the task to completion or send an explicit `elicitation` callback if blocked on human input.",
    ...buildSessionCallbackInstructions(sessionCallback),
  ];

  return lines.filter((line) => line !== null).join("\n");
}

export function buildFollowUpPrompt({
  issueIdentifier,
  branchName = "",
  comment,
  promptContext,
  guidance = null,
  sessionCallback = null,
}) {
  const cleanIdentifier = String(issueIdentifier || "").trim();
  const cleanBranch = String(branchName || "").trim();
  const rawPromptContext = String(promptContext || "").trim();
  const rawCommentBody = String(comment?.body || "").trim();
  const commentBody = isLinearThreadPlaceholder(rawCommentBody) ? "" : rawCommentBody;
  const guidanceText = formatGuidance(guidance);

  return [
    `Follow-up on Linear issue ${cleanIdentifier || "UNKNOWN-ISSUE"}:`,
    cleanBranch ? `Suggested branch name: ${cleanBranch}` : null,
    commentBody && !isTextAlreadyIncluded(commentBody, rawPromptContext)
      ? `\n${commentBody}`
      : null,
    rawPromptContext ? `\n${rawPromptContext}` : null,
    guidanceText ? `\n## Linear Guidance\n${guidanceText}` : null,
    ...buildCompactCallbackReminder(sessionCallback),
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export function buildGitHubFeedbackPrompt({
  issueIdentifier = "",
  branchName = "",
  feedback,
  sessionCallback = null,
}) {
  const cleanIdentifier = String(issueIdentifier || "").trim() || "UNKNOWN-ISSUE";
  const cleanBranch = String(branchName || feedback?.branch || "").trim();

  let lines;
  if (feedback?.kind === "ci_failure") {
    lines = [
      `GitHub CI check failed for Linear issue ${cleanIdentifier}:`,
      cleanBranch ? `Branch: ${cleanBranch}` : null,
      feedback.repo ? `Repository: ${feedback.repo}` : null,
      feedback.name ? `Failing check/workflow: ${feedback.name}` : null,
      feedback.conclusion ? `Conclusion: ${feedback.conclusion}` : null,
      feedback.headSha ? `Commit SHA: ${feedback.headSha}` : null,
      feedback.detailsUrl ? `Details URL: ${feedback.detailsUrl}` : null,
      feedback.summary ? `\n## Failure Summary\n${feedback.summary}` : null,
      "",
      `Pull branch \`${cleanBranch || "the current PR branch"}\`, inspect the failing CI logs (via \`gh run view\` / \`gh pr checks\`), fix the root cause, verify locally, and push to the same branch.`,
    ];
  } else {
    const fileLoc = feedback?.filePath
      ? `${feedback.filePath}${feedback.line ? `:${feedback.line}` : ""}`
      : "";
    lines = [
      `GitHub Pull Request review feedback received for Linear issue ${cleanIdentifier}:`,
      cleanBranch ? `Branch: ${cleanBranch}` : null,
      feedback?.repo ? `Repository: ${feedback.repo}` : null,
      feedback?.prNumber ? `PR: #${feedback.prNumber}` : null,
      feedback?.prUrl ? `PR URL: ${feedback.prUrl}` : null,
      feedback?.reviewer ? `Reviewer: @${feedback.reviewer}` : null,
      feedback?.state ? `Review State: ${feedback.state}` : null,
      fileLoc ? `Location: ${fileLoc}` : null,
      feedback?.commentUrl || feedback?.reviewUrl
        ? `Comment URL: ${feedback.commentUrl || feedback.reviewUrl}`
        : null,
      feedback?.body ? `\n## Review Comment\n${feedback.body}` : null,
      "",
      `Evaluate and address the review feedback on branch \`${cleanBranch || "the current PR branch"}\`, verify locally, push to the same branch, and reply on the PR via \`gh\` if appropriate.`,
    ];
  }

  lines.push(...buildCompactCallbackReminder(sessionCallback));

  return lines.filter((line) => line !== null).join("\n");
}

/**
 * Spawns isolated `agy --remote-agent` cloud sessions via `scripts/launch_remote_agent.py`.
 */
export class RemoteAgentLauncher {
  constructor({ config, execFileImpl = execFileAsync }) {
    this.config = config;
    this.execFileImpl = execFileImpl;
    this.semaphore = new Semaphore(config.launcher.maxConcurrentLaunches);
  }

  async launchNew({ remoteProject, mode, issueIdentifier, prompt }) {
    return this._runLauncher({
      remoteProject,
      mode: mode || this.config.launcher.remoteMode,
      tag: issueIdentifier || "dispatch",
      prompt,
    });
  }

  async resume({ conversationId, mode, issueIdentifier, prompt }) {
    return this._runLauncher({
      conversationId,
      mode: mode || this.config.launcher.remoteMode,
      tag: issueIdentifier || "resume",
      prompt,
    });
  }

  async cancel({ conversationId }) {
    const cancelScript = this.config?.paths?.cancelScript;
    if (!conversationId || !cancelScript) {
      return { ok: false, error: "Missing conversationId or cancelScript" };
    }
    const args = [
      cancelScript,
      "--agy-bin",
      this.config.launcher.agyBin,
      "--conversation",
      conversationId,
      "--cwd",
      this.config.rootDir || process.cwd(),
    ];
    try {
      const res = await this.execFileImpl(this.config.launcher.pythonBin, args, {
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });
      const lines = String(res?.stdout || "")
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
      const lastLine = lines[lines.length - 1] || "{}";
      return JSON.parse(lastLine);
    } catch (err) {
      const lines = String(err?.stdout || "")
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
      const lastLine = lines[lines.length - 1] || "";
      if (lastLine.startsWith("{")) {
        try {
          return JSON.parse(lastLine);
        } catch {
          // Fall through
        }
      }
      return { ok: false, error: err.message };
    }
  }

  async _runLauncher({ remoteProject = "", conversationId = "", mode, tag, prompt }) {
    return this.semaphore.run(async () => {
      const logsDir = this.config.paths.logsDir;
      fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });

      const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      const safeTag = String(tag || "job").replace(/[^A-Za-z0-9._-]+/g, "_");
      const promptFile = path.join(logsDir, `prompt-${safeTag}-${stamp}.txt`);
      const logFile = path.join(logsDir, `agy-${safeTag}-${stamp}.log`);

      fs.writeFileSync(promptFile, prompt, { encoding: "utf8", mode: 0o600 });

      const args = [
        this.config.paths.launchScript,
        "--agy-bin",
        this.config.launcher.agyBin,
        "--prompt-file",
        promptFile,
        "--log-file",
        logFile,
      ];

      if (mode) {
        args.push("--mode", mode);
      }
      if (conversationId) {
        args.push("--conversation", conversationId);
      } else if (remoteProject) {
        args.push("--project", remoteProject);
      }

      if (this.config.launcher.detachMode) {
        args.push("--detach");
      } else {
        args.push("--wait-idle");
      }

      try {
        let stdoutText = "";
        try {
          const res = await this.execFileImpl(this.config.launcher.pythonBin, args, {
            timeout: 420_000,
            maxBuffer: 4 * 1024 * 1024,
          });
          stdoutText = String(res?.stdout || "");
        } catch (execErr) {
          stdoutText = String(execErr?.stdout || "");
          const lines = stdoutText.trim().split(/\r?\n/).filter(Boolean);
          const lastLine = lines[lines.length - 1] || "";
          if (lastLine.startsWith("{")) {
            const parsedErr = JSON.parse(lastLine);
            if (parsedErr?.error) {
              throw new Error(parsedErr.error);
            }
          }
          throw execErr;
        }
        const lines = stdoutText
          .trim()
          .split(/\r?\n/)
          .filter(Boolean);
        const lastLine = lines[lines.length - 1] || "{}";
        const parsed = JSON.parse(lastLine);
        if (!parsed.ok) {
          throw new Error(parsed.error || "Remote agent launcher failed");
        }
        return parsed;
      } finally {
        try {
          if (fs.existsSync(promptFile)) {
            fs.unlinkSync(promptFile);
          }
        } catch {
          // Ignore temp prompt cleanup failure
        }
      }
    });
  }
}
