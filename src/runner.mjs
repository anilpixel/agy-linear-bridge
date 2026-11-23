import os from "node:os";
import { getProjectsConfig } from "./config.mjs";
import {
  buildDispatchPrompt,
  buildFollowUpPrompt,
  buildGitHubFeedbackPrompt,
  RemoteAgentLauncher,
} from "./launcher.mjs";
import { routeIssue } from "./router.mjs";
import { RemoteStreamWatcher } from "./watcher.mjs";
import { WorkflowLoader } from "./workflow.mjs";

const ANTIGRAVITY_EXTERNAL_URL = {
  label: "Antigravity Remote",
  url: "https://antigravity.google.com",
};

/**
 * Lightweight in-memory session mirror so `RemoteStreamWatcher` operates identically on the Runner.
 */
class RunnerSessionMirror {
  constructor() {
    this.map = new Map();
  }

  get(linearSessionId) {
    return this.map.get(String(linearSessionId)) || null;
  }

  upsert(linearSessionId, patch = {}) {
    const id = String(linearSessionId);
    const now = new Date().toISOString();
    const prev = this.map.get(id) || { linearSessionId: id, createdAt: now };
    const next = { ...prev, ...patch, linearSessionId: id, updatedAt: now };
    this.map.set(id, next);
    return next;
  }

  list() {
    return Array.from(this.map.values());
  }
}

/**
 * Proxies `RemoteStreamWatcher` Linear updates through the Cloudflare Edge Worker
 * so the local Runner never needs Linear OAuth tokens on disk.
 */
export class EdgeLinearProxy {
  constructor({ edgeBaseUrl, runnerSecret, sessionMirror, fetchImpl = fetch }) {
    this.edgeBaseUrl = String(edgeBaseUrl || "").replace(/\/+$/, "");
    this.runnerSecret = String(runnerSecret || "").trim();
    this.sessionMirror = sessionMirror;
    this.fetchImpl = (...args) => fetchImpl(...args);
  }

  async _postSessionUpdate(agentSessionId, payload) {
    const res = await this.fetchImpl(
      `${this.edgeBaseUrl}/api/runner/sessions/${encodeURIComponent(agentSessionId)}/activity`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.runnerSecret}`,
        },
        body: JSON.stringify(payload),
      }
    );
    if (res.status === 409) {
      this.sessionMirror?.upsert(agentSessionId, { status: "stopped" });
      return { ok: false, stopped: true };
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Edge proxy HTTP ${res.status}: ${txt}`);
    }
    return res.json();
  }

  async createAgentActivity({ agentSessionId, content, ephemeral }) {
    const sessionPatch =
      content?.type === "response"
        ? { status: "complete", lastActivityType: "watcher_fallback_response" }
        : undefined;
    const out = await this._postSessionUpdate(agentSessionId, {
      activity: { content, ephemeral },
      ...(sessionPatch ? { sessionPatch } : {}),
    });
    return {
      success: Boolean(out?.ok),
      agentActivity: out?.agentActivityId ? { id: out.agentActivityId } : null,
    };
  }

  async updateAgentSession({ id, externalUrls, plan, summary }) {
    const mirrored = this.sessionMirror?.get(id);
    const sessionPatch = {};
    if (externalUrls !== undefined) sessionPatch.externalUrls = externalUrls;
    if (mirrored?.prUrl) {
      sessionPatch.prUrl = mirrored.prUrl;
      sessionPatch.prRepo = mirrored.prRepo;
      sessionPatch.prNumber = mirrored.prNumber;
    }
    const out = await this._postSessionUpdate(id, {
      sessionUpdate: { externalUrls, plan, summary },
      ...(Object.keys(sessionPatch).length > 0 ? { sessionPatch } : {}),
    });
    return { success: Boolean(out?.ok) };
  }
}

/**
 * Zero-port outbound Runner that polls jobs from the Cloudflare Edge Gateway and spawns `agy --remote-agent`.
 */
export class EdgeRunner {
  constructor({
    config,
    launcher = new RemoteAgentLauncher({ config }),
    workflowLoader = null,
    routeIssueFn = routeIssue,
    watcher = null,
    fetchImpl = fetch,
    logger = console,
  }) {
    this.config = config;
    this.edgeBaseUrl = String(config.edge?.baseUrl || config.publicBaseUrl || "").replace(
      /\/+$/,
      ""
    );
    this.runnerSecret = String(config.edge?.runnerSecret || "").trim();
    this.runnerId =
      config.edge?.runnerId || `${os.hostname()}-${process.pid}`;
    this.pollIntervalMs = Math.max(500, Number(config.edge?.pollIntervalMs || 3_000));
    this.launcher = launcher;
    this.logger = logger;
    this.fetchImpl = (...args) => fetchImpl(...args);
    this.routeIssueFn = routeIssueFn;
    this.workflowLoader = workflowLoader || new WorkflowLoader({ config, logger });
    this.sessionMirror = new RunnerSessionMirror();
    this.linearProxy = new EdgeLinearProxy({
      edgeBaseUrl: this.edgeBaseUrl,
      runnerSecret: this.runnerSecret,
      sessionMirror: this.sessionMirror,
      fetchImpl,
    });
    this.watcher =
      watcher ||
      new RemoteStreamWatcher({
        config,
        linearClient: this.linearProxy,
        sessionStore: this.sessionMirror,
        logger,
      });
    this.running = false;
    this._timer = null;
  }

  _headers() {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.runnerSecret}`,
    };
  }

  async pollOnce() {
    if (!this.edgeBaseUrl || !this.runnerSecret) {
      throw new Error("EDGE_BASE_URL (or PUBLIC_BASE_URL) and RUNNER_SHARED_SECRET are required");
    }

    const projectsConfig = getProjectsConfig(this.config);
    const activeSessionIds = this.sessionMirror
      .list()
      .filter((s) => s.status === "active")
      .map((s) => s.linearSessionId);

    const res = await this.fetchImpl(`${this.edgeBaseUrl}/api/runner/poll`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({
        runnerId: this.runnerId,
        maxJobs: this.config.launcher?.maxConcurrentLaunches || 2,
        activeWatchers: this.watcher.activeCount(),
        projectsCount: projectsConfig.projects.length,
        activeSessionIds,
      }),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Runner poll failed (${res.status}): ${txt}`);
    }

    const data = await res.json();
    for (const stopId of Array.isArray(data.stopWatcherSessionIds)
      ? data.stopWatcherSessionIds
      : []) {
      this.sessionMirror.upsert(stopId, { status: "complete" });
      this.watcher.stop(stopId);
    }

    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    await Promise.all(jobs.map((job) => this._executeJob(job)));
    return jobs.length;
  }

  async _executeJob(job) {
    const { id: jobId, agentSessionId, kind, payload = {}, session } = job;
    try {
      if (kind === "stop_session") {
        await this._handleStopJob(jobId, agentSessionId, payload);
        return;
      }

      if (session?.status === "stopped") {
        await this._reportJobComplete(jobId, {
          status: "completed",
          agentSessionId,
        });
        return;
      }

      if (kind === "dispatch_linear") {
        await this._handleLinearDispatchJob(jobId, agentSessionId, payload, session);
        return;
      }

      if (kind === "github_feedback") {
        await this._handleGitHubFeedbackJob(jobId, agentSessionId, payload, session);
        return;
      }

      await this._reportJobComplete(jobId, {
        status: "failed",
        agentSessionId,
        lastError: `Unsupported job kind: ${kind}`,
      });
    } catch (err) {
      this.logger.error?.(
        `[runner] Job ${jobId} (${kind}) failed for session=${agentSessionId}:`,
        err
      );
      await this._reportJobComplete(jobId, {
        status: "failed",
        agentSessionId,
        lastError: err.message,
        sessionPatch: { status: "error", lastError: err.message },
        linearActivity: {
          content: { type: "error", body: `❌ Runner execution failed: ${err.message}` },
        },
      }).catch((reportErr) => {
        this.logger.error?.(`[runner] Failed reporting job failure: ${reportErr.message}`);
      });
    }
  }

  async _handleStopJob(jobId, agentSessionId, payload) {
    this.sessionMirror.upsert(agentSessionId, { status: "stopped" });
    this.watcher.stop(agentSessionId);

    if (payload.conversationId && typeof this.launcher.cancel === "function") {
      try {
        await this.launcher.cancel({
          conversationId: payload.conversationId,
          issueIdentifier: payload.issueIdentifier || agentSessionId,
        });
      } catch (err) {
        this.logger.warn?.(
          `[runner] Cloud cancel warning for session=${agentSessionId}: ${err.message}`
        );
      }
    }

    await this._reportJobComplete(jobId, {
      status: "completed",
      agentSessionId,
    });
  }

  async _handleLinearDispatchJob(jobId, agentSessionId, payload, existing) {
    const { event = {}, issueContext = {}, sessionCallback = null } = payload;
    const isFollowUp = Boolean(event.action === "prompted" && existing?.agyConversationId);

    if (isFollowUp) {
      const issueIdentifier = existing.issueIdentifier || issueContext?.identifier || "";
      const comment = event.promptBody
        ? { body: event.promptBody }
        : event.comment || null;
      const prompt = buildFollowUpPrompt({
        issueIdentifier,
        branchName: existing.suggestedBranchName || "",
        comment,
        promptContext: event.promptContext,
        guidance: event.guidance,
        sessionCallback,
      });

      this.watcher.stop(agentSessionId);
      const launchResult = await this.launcher.resume({
        conversationId: existing.agyConversationId,
        mode: this.config.launcher.remoteMode,
        issueIdentifier: issueIdentifier || agentSessionId,
        prompt,
      });

      const convId = launchResult.conversationId || existing.agyConversationId;
      const sessionPatch = {
        agyConversationId: convId,
        ...(launchResult.aceUvmId ? { aceUvmId: launchResult.aceUvmId } : {}),
        status: sessionCallback ? "active" : "resumed",
        lastError: null,
      };

      const completeResp = await this._reportJobComplete(jobId, {
        status: "completed",
        agentSessionId,
        sessionPatch,
        linearActivity: {
          content: {
            type: sessionCallback ? "thought" : "response",
            body: [
              `Forwarded follow-up to cloud Remote Agent session.`,
              `- Resume/attach: \`agy --remote-agent --conversation=${convId}\``,
              `- Live progress and final \`response\` will be reported via Cloudflare Edge.`,
            ].join("\n"),
          },
        },
      });

      if (!completeResp?.sessionStopped && sessionCallback && convId) {
        this.sessionMirror.upsert(agentSessionId, { ...existing, ...sessionPatch });
        this.watcher.start({
          agentSessionId,
          conversationId: convId,
          issueIdentifier,
          isResume: true,
        });
      }
      return;
    }

    const projectsConfig = getProjectsConfig(this.config);
    const decision = await this.routeIssueFn({
      issueContext,
      promptContext: [event.promptContext, event.comment?.body, event.promptBody]
        .filter(Boolean)
        .join("\n\n"),
      projectsConfig,
      routerConfig: this.config.router,
      agyBin: this.config.launcher.agyBin,
    });

    if (decision.action === "elicit") {
      await this._reportJobComplete(jobId, {
        status: "completed",
        agentSessionId,
        sessionPatch: {
          issueId: issueContext?.id || event.issue?.id || null,
          issueIdentifier: issueContext?.identifier || event.issue?.identifier || null,
          status: "awaiting_clarification",
          lastError: null,
        },
        linearActivity: {
          content: {
            type: "elicitation",
            body: decision.clarifyingQuestion,
          },
        },
      });
      return;
    }

    const remoteProject =
      decision.remoteProject ||
      decision.project?.remoteProject ||
      projectsConfig.defaultRemoteProject;

    if (!remoteProject) {
      throw new Error(
        `No target Remote Project configured for matched route (${decision.project?.name || decision.project?.key || "unknown"})`
      );
    }

    let workflow = null;
    if (this.workflowLoader?.load) {
      try {
        workflow = await this.workflowLoader.load(decision.project);
      } catch (err) {
        this.logger.warn?.(
          `[runner] Failed loading WORKFLOW.md for project=${decision.project?.key || "-"}: ${err.message}`
        );
      }
    }

    const fm = workflow?.frontmatter || {};
    const workflowPolicy = {};
    if (typeof fm.ciAutoFix === "boolean") workflowPolicy.ciAutoFix = fm.ciAutoFix;
    if (typeof fm.reviewAutoResume === "boolean") {
      workflowPolicy.reviewAutoResume = fm.reviewAutoResume;
    }
    if (Number.isFinite(Number(fm.maxCiFixRounds))) {
      workflowPolicy.maxCiFixRounds = Math.max(0, Number(fm.maxCiFixRounds));
    }

    const suggestedBranchName = String(issueContext?.branchName || "").trim() || null;
    const prompt = buildDispatchPrompt({
      issueContext,
      comment: event.promptBody
        ? { body: event.promptBody }
        : event.comment || null,
      promptContext: event.promptContext,
      guidance: event.guidance,
      creator: event.creator,
      project: decision.project,
      workflow,
      sessionCallback,
    });

    const resolvedMode =
      (typeof fm.mode === "string" && fm.mode.trim()) ||
      decision.project?.mode ||
      this.config.launcher.remoteMode;

    const launchResult = await this.launcher.launchNew({
      remoteProject,
      mode: resolvedMode,
      issueIdentifier: issueContext?.identifier || agentSessionId,
      prompt,
    });

    const convId = launchResult.conversationId || null;
    const initialExternalUrls = [ANTIGRAVITY_EXTERNAL_URL];
    const sessionPatch = {
      issueId: issueContext?.id || event.issue?.id || null,
      issueIdentifier: issueContext?.identifier || event.issue?.identifier || null,
      projectKey: decision.project?.key || "default",
      projectName: decision.project?.name || remoteProject,
      remoteProject,
      githubRepo: decision.project?.githubRepo || null,
      ...(Object.keys(workflowPolicy).length > 0 ? { workflowPolicy } : {}),
      ...(suggestedBranchName ? { suggestedBranchName } : {}),
      agyConversationId: convId,
      localProxyId: launchResult.localProxyId || null,
      aceUvmId: launchResult.aceUvmId || null,
      externalUrls: initialExternalUrls,
      matchedBy: decision.matchedBy,
      status: sessionCallback ? "active" : "dispatched",
      lastError: null,
    };

    const branchLine = suggestedBranchName ? `- Suggested branch: \`${suggestedBranchName}\`` : null;
    const handoffLines = [
      `🚀 Routed to **${decision.project?.name || remoteProject}** (matched by \`${decision.matchedBy}\`) and launched cloud Remote Agent via Cloudflare Edge:`,
      branchLine,
      convId
        ? `- Resume/attach: \`agy --remote-agent --conversation=${convId}\``
        : `- Launch log: \`${launchResult.logFile}\``,
      `- Cloud session reports progress and final \`response\` directly to Cloudflare Edge.`,
    ].filter(Boolean);

    const completeResp = await this._reportJobComplete(jobId, {
      status: "completed",
      agentSessionId,
      sessionPatch,
      sessionUpdate: { externalUrls: initialExternalUrls },
      linearActivity: {
        content: {
          type: sessionCallback ? "thought" : "response",
          body: handoffLines.join("\n"),
        },
      },
    });

    if (!completeResp?.sessionStopped && sessionCallback && convId) {
      this.sessionMirror.upsert(agentSessionId, sessionPatch);
      this.watcher.start({
        agentSessionId,
        conversationId: convId,
        issueIdentifier: sessionPatch.issueIdentifier || "",
      });
    }
  }

  async _handleGitHubFeedbackJob(jobId, agentSessionId, payload, existing) {
    if (!existing?.agyConversationId) {
      await this._reportJobComplete(jobId, {
        status: "failed",
        agentSessionId,
        lastError: "Missing agyConversationId on session for GitHub feedback resume",
      });
      return;
    }

    const { ghEvent, sessionCallback = null } = payload;
    const branchName =
      ghEvent?.branch || existing.prBranch || existing.suggestedBranchName || "";
    const prompt = buildGitHubFeedbackPrompt({
      issueIdentifier: existing.issueIdentifier,
      branchName,
      feedback: ghEvent,
      sessionCallback,
    });

    this.watcher.stop(agentSessionId);
    const launchResult = await this.launcher.resume({
      conversationId: existing.agyConversationId,
      mode: this.config.launcher.remoteMode,
      issueIdentifier: existing.issueIdentifier || agentSessionId,
      prompt,
    });

    const convId = launchResult.conversationId || existing.agyConversationId;
    const sessionPatch = {
      agyConversationId: convId,
      ...(launchResult.aceUvmId ? { aceUvmId: launchResult.aceUvmId } : {}),
      ...(branchName ? { prBranch: branchName } : {}),
      status: sessionCallback ? "active" : "resumed",
      lastError: null,
    };

    const completeResp = await this._reportJobComplete(jobId, {
      status: "completed",
      agentSessionId,
      sessionPatch,
    });

    if (!completeResp?.sessionStopped && sessionCallback && convId) {
      this.sessionMirror.upsert(agentSessionId, { ...existing, ...sessionPatch });
      this.watcher.start({
        agentSessionId,
        conversationId: convId,
        issueIdentifier: existing.issueIdentifier || "",
        isResume: true,
      });
    }
  }

  async _reportJobComplete(jobId, body) {
    const res = await this.fetchImpl(
      `${this.edgeBaseUrl}/api/runner/jobs/${encodeURIComponent(jobId)}/complete`,
      {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify({ runnerId: this.runnerId, ...body }),
      }
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Failed completing job ${jobId} (${res.status}): ${txt}`);
    }
    return res.json();
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    let consecutiveErrors = 0;

    const loop = async () => {
      if (!this.running) return;
      let delay = this.pollIntervalMs;
      try {
        const count = await this.pollOnce();
        consecutiveErrors = 0;
        if (count > 0) {
          delay = 250;
        }
      } catch (err) {
        consecutiveErrors += 1;
        delay = Math.min(30_000, this.pollIntervalMs * 2 ** Math.min(4, consecutiveErrors));
        this.logger.warn?.(`[runner] Poll warning (retry in ${delay}ms): ${err.message}`);
      }
      if (this.running) {
        this._timer = setTimeout(loop, delay);
      }
    };

    loop();
  }

  stop() {
    this.running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this.watcher.stopAll();
  }
}
