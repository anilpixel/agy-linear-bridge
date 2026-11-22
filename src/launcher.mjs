import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

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
    "## Linear Agent Session 接管与回写协议（必须遵守）",
    `- 该工单的 Linear AgentSession（\`${agentSessionId}\`）已由桥接器保持 \`active\` 状态并完整移交给你。`,
    `- **Callback URL**: \`${callbackUrl}\``,
    `- **Authorization Bearer Token**: \`${callbackToken}\`（仅限当前 AgentSession 使用，请勿写入代码库或 PR）`,
    "- 关键阶段务必通过 HTTPS POST 上报进度，否则 Linear 会停在思考中或 30 分钟后转为 `stale`：",
    `  - **开始排查 / 进展保活（长任务建议每 10~15 分钟一次）**：\`{"type":"thought","body":"..."}\` 或 \`{"type":"action","action":"...","parameter":"..."}\``,
    `  - **需要人工澄清/确认（会让会话进入 \`awaitingInput\` 等用户回复）**：\`{"type":"elicitation","body":"..."}\``,
    `  - **最终交付结单（会把 Linear AgentSession 正式置为 \`complete\`）**：\`{"type":"response","body":"最终总结与 PR 链接"}\``,
    `  - **附带 PR 外部链接**：创建或更新 GitHub PR 时，可在 Callback JSON 中附带 \`"prUrl":"https://github.com/owner/repo/pull/123"\`（或 \`"externalUrls":[...]\`），桥接器会自动把 PR 链接绑定到 Linear AgentSession 卡片。`,
    `  - **不可恢复失败**：\`{"type":"error","body":"失败原因"}\``,
    "- 调用示例：",
    "  ```bash",
    `  curl -fsS -X POST "${callbackUrl}" \\`,
    `    -H "Authorization: Bearer ${callbackToken}" \\`,
    `    -H "Content-Type: application/json" \\`,
    `    -d '{"type":"thought","body":"已进入云端环境，开始排查代码"}'` ,
    "  ```",
    "- **职责区分**：上面的 Callback 用于更新 Linear **AgentSession 生命周期**（思考/动作/提问/最终 `response` 结单）；读取上下游工单依赖、更新工单状态（如 `In Progress` / `In Review`）或补充持久工单评论，仍请使用云端 `linear` CLI（`/home/antigravity/.gemini/bin/linear`）。",
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
  const commentBody = String(comment?.body || "").trim();
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
    project?.extraInstructions ? `\n## 项目额外约束\n${project.extraInstructions}` : null,
    "",
    "## Git 分支、PR 自动关联与回写要求",
    branchName
      ? `1. **Git 分支与 PR 自动关联**：凡涉及代码修改，必须直接使用上方的 \`Suggested branch name\`（\`git checkout -B "${branchName}"\`；若远端已存在同名分支则拉取续作），不要另起 \`feat/...\` 或 \`perf/...\` 等其他分支名；提交 PR 时请在 PR 标题中保留 \`${identifier}\`，以触发 GitHub ↔ Linear 分支/PR 自动关联与状态流转。若工单明确属于只读调研或方案设计类任务，请勿改动代码也无需创建分支。`
      : `1. **Git 分支与 PR 自动关联**：凡涉及代码修改，请创建包含工单号 \`${identifier}\` 的分支并在 PR 标题中保留 \`${identifier}\`，以触发 GitHub ↔ Linear 自动关联与状态流转；若工单属于只读调研或方案设计类任务，请勿改动代码也无需创建分支。`,
    workflowBody
      ? "2. **独立推进与验证**：请在当前云端 Remote Project 环境中独立完成该工单；如有代码改动，严格遵循上方 Repository Workflow Policy 与仓库规范运行检查并提交 PR。"
      : "2. **独立推进与验证**：请在当前云端 Remote Project 环境中独立完成该工单；若仓库根目录存在 `WORKFLOW.md`，请优先读取并遵循其中的工作流与验证规范；如有代码改动，按仓库规范运行检查并提交 PR。",
    `3. **Linear CLI 回写**：云端环境已配置 \`linear\` CLI（\`/home/antigravity/.gemini/bin/linear\`）与 \`linear\` skill，可用其读取完整上下游依赖/评论、更新工单状态（如 \`In Progress\` / \`In Review\`）或通过 \`linear issue comment add ${identifier}\` 补充持久评论。`,
    "4. **自主推进**：不要等待本地终端交互，请一次性自主推进到阶段性交付或通过 `elicitation` 明确提问。",
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
  const commentBody = String(comment?.body || "").trim();
  const guidanceText = formatGuidance(guidance);

  return [
    `Follow-up on Linear issue ${cleanIdentifier || "UNKNOWN-ISSUE"}:`,
    cleanBranch ? `Suggested branch name: ${cleanBranch}` : null,
    "",
    commentBody && !isTextAlreadyIncluded(commentBody, rawPromptContext)
      ? `## Triggering Comment\n${commentBody}`
      : null,
    rawPromptContext ? `\n## Linear Prompt Context\n${rawPromptContext}` : null,
    guidanceText ? `\n## Linear Guidance\n${guidanceText}` : null,
    "",
    `请结合当前会话上下文继续处理${cleanBranch ? `（涉及代码改动请继续使用分支 \`${cleanBranch}\`）` : ""}，并通过云端 \`linear\` CLI 或下方 AgentSession Callback 回写进展与最终 \`response\` 结单。`,
    ...buildSessionCallbackInstructions(sessionCallback),
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
      `请基于分支 \`${cleanBranch || "当前 PR 分支"}\` 拉取并定位上述 CI 失败原因（可通过 \`gh run view\` / \`gh pr checks\` 查看详细日志），完成修复并在本地验证后直接 push 到同一分支。`,
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
      `请在分支 \`${cleanBranch || "当前 PR 分支"}\` 上评估并处理上述 Review 意见；完成修改并本地验证后直接 push 到同一分支，必要时通过 \`gh\` 回复评论并更新 Linear。`,
    ];
  }

  lines.push(
    "完成后请通过下方 AgentSession Callback 回写结果，并确保发送最终 `response` 结单。",
    ...buildSessionCallbackInstructions(sessionCallback)
  );

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
