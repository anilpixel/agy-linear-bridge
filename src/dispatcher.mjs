import { getProjectsConfig } from "./config.mjs";
import { mergeExternalUrls } from "./github-webhook.mjs";
import {
  buildDispatchPrompt,
  buildFollowUpPrompt,
  buildGitHubFeedbackPrompt,
} from "./launcher.mjs";
import { routeIssue } from "./router.mjs";
import { KeyedQueue } from "./store.mjs";
import { createSessionCallbackToken } from "./webhook.mjs";
import { WorkflowLoader } from "./workflow.mjs";

export { mergeExternalUrls };

const ANTIGRAVITY_EXTERNAL_URL = {
  label: "Antigravity Remote",
  url: "https://antigravity.google.com",
};

/**
 * Coordinates Linear AgentSessionEvent ack, routing, GitHub closed-loop feedback, and isolated Remote Agent launches.
 */
export class EventDispatcher {
  constructor({
    config,
    linearClient,
    sessionStore,
    launcher,
    watcher = null,
    workflowLoader = null,
    routeIssueFn = routeIssue,
    logger = console,
  }) {
    this.config = config;
    this.linearClient = linearClient;
    this.sessionStore = sessionStore;
    this.launcher = launcher;
    this.watcher = watcher;
    this.workflowLoader = workflowLoader || new WorkflowLoader({ config, logger });
    this.routeIssueFn = routeIssueFn;
    this.logger = logger;
    this.queue = new KeyedQueue();
    this.stopRequested = new Set();
  }

  enqueue(event) {
    if (event?.isStopSignal && event.agentSessionId) {
      this.stopRequested.add(event.agentSessionId);
      this.watcher?.stop(event.agentSessionId);
    }
    return this.queue.enqueue(event.agentSessionId, () => this.handleEvent(event));
  }

  async handleEvent(event) {
    const { agentSessionId, action } = event;
    if (event?.isStopSignal) {
      try {
        await this._handleStopSignal(event);
      } catch (err) {
        this.logger.error(
          `[dispatcher] Failed processing stop signal session=${agentSessionId}:`,
          err
        );
      }
      return;
    }

    const issueLabel = event.issue?.identifier || event.issue?.title || agentSessionId;

    // Immediately satisfy Linear's 10-second initial activity requirement.
    await this._safeSendActivity({
      agentSessionId,
      content: {
        type: "thought",
        body:
          action === "prompted"
            ? `Received follow-up — locating cloud session for ${issueLabel}...`
            : `Accepted ${issueLabel} — routing issue and launching isolated Antigravity Remote Agent...`,
      },
      ephemeral: true,
    });

    try {
      const existing = this.sessionStore.get(agentSessionId);
      if (action === "prompted" && existing?.agyConversationId) {
        await this._handleFollowUp(event, existing);
        return;
      }

      await this._handleNewOrClarifiedDispatch(event);
    } catch (err) {
      this.logger.error(
        `[dispatcher] Failed processing session=${agentSessionId}:`,
        err
      );
      this.sessionStore.upsert(agentSessionId, {
        issueId: event.issue?.id || null,
        issueIdentifier: event.issue?.identifier || null,
        status: "error",
        lastError: err.message,
      });
      await this._safeSendActivity({
        agentSessionId,
        content: {
          type: "error",
          body: `❌ Dispatch failed: ${err.message}`,
        },
      });
    }
  }

  async _handleStopSignal(event) {
    const { agentSessionId } = event;
    this.watcher?.stop(agentSessionId);
    const existing = this.sessionStore.get(agentSessionId);
    const issueIdentifier = existing?.issueIdentifier || event.issue?.identifier || "";

    const alreadyCancelledConv =
      existing?.agyConversationId &&
      existing?.cancelledDuringLaunchConvId === existing.agyConversationId;

    this.sessionStore.upsert(agentSessionId, {
      issueId: existing?.issueId || event.issue?.id || null,
      issueIdentifier: issueIdentifier || null,
      status: "stopped",
      stoppedAt: new Date().toISOString(),
      lastError: null,
    });

    let cancelResult = existing?.cancelledDuringLaunchResult || null;
    if (
      existing?.agyConversationId &&
      !alreadyCancelledConv &&
      typeof this.launcher?.cancel === "function"
    ) {
      try {
        cancelResult = await this.launcher.cancel({
          conversationId: existing.agyConversationId,
          issueIdentifier: issueIdentifier || agentSessionId,
        });
      } catch (err) {
        this.logger.warn?.(
          `[dispatcher] Cloud cancel failed session=${agentSessionId}: ${err.message}`
        );
      }
    }

    this.stopRequested.delete(agentSessionId);

    const lines = [
      `🛑 Received Linear stop signal. Stream watcher stopped and further callbacks are now locked.`,
    ];
    if (existing?.agyConversationId) {
      if (cancelResult?.cancelled) {
        lines.push(`- Sent cancel signal (\`Esc\`) to cloud session and confirmed idle.`);
      } else if (cancelResult && cancelResult.ok && !cancelResult.wasRunning) {
        lines.push(`- Cloud session was already idle when attached.`);
      } else if (cancelResult?.stillRunning) {
        lines.push(
          `- Sent cancel signal (\`Esc\`) to cloud session; attach in terminal if a tool command is still winding down.`
        );
      }
      lines.push(
        `- Session ID: \`agy --remote-agent --conversation=${existing.agyConversationId}\``
      );
    }

    await this._safeSendActivity({
      agentSessionId,
      content: {
        type: "response",
        body: lines.join("\n"),
      },
    });
  }

  _buildSessionCallback(agentSessionId) {
    const baseUrl = String(this.config.publicBaseUrl || "").replace(/\/+$/, "");
    const secret =
      this.config.linear?.webhookSecret || this.config.linear?.clientSecret || "";
    if (!baseUrl || !secret || !agentSessionId) {
      return null;
    }
    return {
      agentSessionId,
      callbackUrl: `${baseUrl}/api/sessions/${encodeURIComponent(agentSessionId)}/activity`,
      callbackToken: createSessionCallbackToken({ agentSessionId, secret }),
    };
  }

  async _handleFollowUp(event, existing) {
    const { agentSessionId } = event;
    const issueIdentifier = existing.issueIdentifier || event.issue?.identifier || "";
    const sessionCallback = this._buildSessionCallback(agentSessionId);
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

    this.watcher?.stop(agentSessionId);
    const launchResult = await this.launcher.resume({
      conversationId: existing.agyConversationId,
      mode: this.config.launcher.remoteMode,
      issueIdentifier: issueIdentifier || agentSessionId,
      prompt,
    });

    const convId = launchResult.conversationId || existing.agyConversationId;
    this.logger.log?.(
      `[dispatcher] Resumed remote session agentSession=${agentSessionId} issue=${issueIdentifier || "-"} agyConversation=${convId || "-"}`
    );
    this.sessionStore.upsert(agentSessionId, {
      agyConversationId: convId,
      ...(launchResult.aceUvmId ? { aceUvmId: launchResult.aceUvmId } : {}),
      status: sessionCallback ? "active" : "resumed",
      lastError: null,
    });

    await this._safeSendActivity({
      agentSessionId,
      content: sessionCallback
        ? {
            type: "thought",
            body: [
              `Forwarded follow-up to cloud Remote Agent session.`,
              `- Resume/attach: \`agy --remote-agent --conversation=${convId}\``,
              `- Live progress and final \`response\` will be reported via session callback.`,
            ].join("\n"),
          }
        : {
            type: "response",
            body: [
              `✅ Forwarded follow-up to cloud Remote Agent session.`,
              `- Resume command: \`agy --remote-agent --conversation=${convId}\``,
              `- Further updates will be posted directly on the issue.`,
            ].join("\n"),
          },
    });

    if (sessionCallback && convId) {
      this.watcher?.start({
        agentSessionId,
        conversationId: convId,
        issueIdentifier,
        isResume: true,
      });
    }
  }

  async _handleNewOrClarifiedDispatch(event) {
    const { agentSessionId } = event;
    const projectsConfig = getProjectsConfig(this.config);
    const issueContext = await this._resolveIssueContext(event);
    const decision = await this.routeIssueFn({
      issueContext,
      promptContext: [event.promptContext, event.promptBody, event.comment?.body]
        .filter(Boolean)
        .join("\n\n"),
      projectsConfig,
      routerConfig: this.config.router,
      agyBin: this.config.launcher.agyBin,
    });

    this.logger.log?.(
      `[dispatcher] Routed session=${agentSessionId} issue=${issueContext?.identifier || event.issue?.identifier || "-"} action=${decision.action} project=${decision.project?.key || "-"} remoteProject=${decision.remoteProject || "-"} matchedBy=${decision.matchedBy || "-"}`
    );

    if (decision.action === "elicit") {
      this.sessionStore.upsert(agentSessionId, {
        issueId: issueContext?.id || event.issue?.id || null,
        issueIdentifier: issueContext?.identifier || event.issue?.identifier || null,
        status: "awaiting_clarification",
        lastError: null,
      });
      await this._safeSendActivity({
        agentSessionId,
        content: {
          type: "elicitation",
          body: decision.clarifyingQuestion,
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
          `[dispatcher] Failed loading WORKFLOW.md for project=${decision.project?.key || "-"}: ${err.message}`
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
    const sessionCallback = this._buildSessionCallback(agentSessionId);
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

    if (this.stopRequested.has(agentSessionId)) {
      this.sessionStore.upsert(agentSessionId, {
        issueId: issueContext?.id || event.issue?.id || null,
        issueIdentifier: issueContext?.identifier || event.issue?.identifier || null,
        projectKey: decision.project?.key || "default",
        projectName: decision.project?.name || remoteProject,
        remoteProject,
        githubRepo: decision.project?.githubRepo || null,
        ...(suggestedBranchName ? { suggestedBranchName } : {}),
        status: "stopped",
        lastError: null,
      });
      return;
    }

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
    this.logger.log?.(
      `[dispatcher] Launched remote session agentSession=${agentSessionId} issue=${issueContext?.identifier || event.issue?.identifier || "-"} agyConversation=${convId || "-"} aceUvm=${launchResult.aceUvmId || "-"} resolvedRemoteProject=${launchResult.resolvedRemoteProjectName || "-"}`
    );

    const initialExternalUrls = [ANTIGRAVITY_EXTERNAL_URL];
    if (this.stopRequested.has(agentSessionId)) {
      let cancelResult = null;
      if (convId && typeof this.launcher?.cancel === "function") {
        try {
          cancelResult = await this.launcher.cancel({
            conversationId: convId,
            issueIdentifier: issueContext?.identifier || agentSessionId,
          });
        } catch (err) {
          this.logger.warn?.(
            `[dispatcher] Cloud cancel during launch failed session=${agentSessionId}: ${err.message}`
          );
        }
      }
      this.sessionStore.upsert(agentSessionId, {
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
        status: "stopped",
        cancelledDuringLaunchConvId: convId,
        cancelledDuringLaunchResult: cancelResult,
        lastError: null,
      });
      return;
    }

    this.sessionStore.upsert(agentSessionId, {
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
    });

    await this._safeUpdateSession({
      id: agentSessionId,
      externalUrls: initialExternalUrls,
    });

    const branchLine = suggestedBranchName ? `- Suggested branch: \`${suggestedBranchName}\`` : null;
    const handoffLines = [
      `🚀 Routed to **${decision.project?.name || remoteProject}** (matched by \`${decision.matchedBy}\`) and launched cloud Remote Agent; Linear AgentSession (\`active\`) handed off:`,
      branchLine,
      convId
        ? `- Resume/attach: \`agy --remote-agent --conversation=${convId}\``
        : `- Launch log: \`${launchResult.logFile}\` (\`--conversation\` ID not captured; check \`antigravity.google.com\`)`,
      `- Cloud Agent will stream progress via callbacks and post the final \`response\` upon completion.`,
    ].filter(Boolean);

    const standaloneLines = [
      `✅ Routed to **${decision.project?.name || remoteProject}** (matched by \`${decision.matchedBy}\`) and launched isolated cloud Remote Agent.`,
      branchLine,
      convId
        ? `- Resume/attach: \`agy --remote-agent --conversation=${convId}\``
        : `- Launch log: \`${launchResult.logFile}\` (\`--conversation\` ID not captured; check \`antigravity.google.com\`)`,
      `- Further progress, questions, and PRs will be posted via the cloud \`linear\` CLI.`,
    ].filter(Boolean);

    await this._safeSendActivity({
      agentSessionId,
      content: {
        type: sessionCallback ? "thought" : "response",
        body: (sessionCallback ? handoffLines : standaloneLines).join("\n"),
      },
    });

    if (sessionCallback && convId) {
      this.watcher?.start({
        agentSessionId,
        conversationId: convId,
        issueIdentifier: issueContext?.identifier || event.issue?.identifier || "",
      });
    }
  }

  async handleGitHubEvent(ghEvent) {
    if (!ghEvent || typeof ghEvent !== "object") {
      return { handled: false, reason: "invalid_event" };
    }

    const session = this.sessionStore.findByPullRequest({
      repo: ghEvent.repo,
      prNumber: ghEvent.prNumber,
      prNumbers: ghEvent.prNumbers,
      branch: ghEvent.branch,
      issueIdentifiers: ghEvent.issueIdentifiers,
    });
    if (!session) {
      return { handled: false, reason: "no_matching_session" };
    }

    return this.queue.enqueue(session.linearSessionId, async () => {
      const latest = this.sessionStore.get(session.linearSessionId) || session;
      const agentSessionId = latest.linearSessionId;
      if (latest.status === "stopped" || this.stopRequested.has(agentSessionId)) {
        return { handled: false, reason: "session_stopped", agentSessionId };
      }

      const baseUrls =
        Array.isArray(latest.externalUrls) && latest.externalUrls.length > 0
          ? latest.externalUrls
          : [ANTIGRAVITY_EXTERNAL_URL];

      if (ghEvent.kind === "pr_sync") {
        const externalUrls = mergeExternalUrls(baseUrls, [
          { label: `PR #${ghEvent.prNumber}`, url: ghEvent.prUrl },
        ]);
        this.sessionStore.upsert(agentSessionId, {
          prUrl: ghEvent.prUrl,
          prRepo: ghEvent.repo,
          prNumber: ghEvent.prNumber,
          prBranch: ghEvent.branch || latest.prBranch || null,
          externalUrls,
        });
        await this._safeUpdateSession({
          id: agentSessionId,
          externalUrls,
        });
        this.logger.log?.(
          `[dispatcher] Linked GitHub PR session=${agentSessionId} pr=${ghEvent.repo}#${ghEvent.prNumber}`
        );
        return { handled: true, action: "pr_linked", agentSessionId };
      }

      if (ghEvent.kind === "ci_failure") {
        if (
          this.config.github?.ciAutoFix === false ||
          latest.workflowPolicy?.ciAutoFix === false ||
          !latest.agyConversationId
        ) {
          return { handled: false, reason: "ci_auto_fix_disabled", agentSessionId };
        }
        if (ghEvent.headSha && latest.lastCiFixSha === ghEvent.headSha) {
          return { handled: false, reason: "duplicate_ci_sha", agentSessionId };
        }

        const rawMax =
          latest.workflowPolicy?.maxCiFixRounds ??
          this.config.github?.maxCiFixRounds ??
          3;
        const maxRounds = Number.isFinite(Number(rawMax)) ? Math.max(0, Number(rawMax)) : 3;
        const prevAttempts = Number(latest.ciFixAttempts || 0);

        if (prevAttempts >= maxRounds) {
          await this._safeSendActivity({
            agentSessionId,
            content: {
              type: "elicitation",
              body: [
                `⚠️ GitHub CI (\`${ghEvent.name}\`) failed after ${prevAttempts} automatic fix attempt(s), reaching the limit (\`maxCiFixRounds=${maxRounds}\`). Human review required.`,
                ghEvent.detailsUrl ? `- Check details: ${ghEvent.detailsUrl}` : null,
                latest.prUrl ? `- Pull Request: ${latest.prUrl}` : null,
              ]
                .filter(Boolean)
                .join("\n"),
            },
          });
          this.sessionStore.upsert(agentSessionId, {
            status: "awaiting_clarification",
            lastCiFixSha: ghEvent.headSha || latest.lastCiFixSha || null,
          });
          return { handled: true, action: "ci_limit_reached", agentSessionId };
        }

        const attempts = prevAttempts + 1;
        const branchName = ghEvent.branch || latest.prBranch || latest.suggestedBranchName || "";
        const sessionCallback = this._buildSessionCallback(agentSessionId);
        const prompt = buildGitHubFeedbackPrompt({
          issueIdentifier: latest.issueIdentifier,
          branchName,
          feedback: ghEvent,
          sessionCallback,
        });

        this.watcher?.stop(agentSessionId);
        await this._safeSendActivity({
          agentSessionId,
          content: {
            type: "thought",
            body: `⚠️ CI failed (${ghEvent.name}) — resuming cloud session for automatic fix (attempt ${attempts}/${maxRounds})...`,
          },
        });

        const launchResult = await this.launcher.resume({
          conversationId: latest.agyConversationId,
          mode: this.config.launcher.remoteMode,
          issueIdentifier: latest.issueIdentifier || agentSessionId,
          prompt,
        });

        const convId = launchResult.conversationId || latest.agyConversationId;
        this.sessionStore.upsert(agentSessionId, {
          agyConversationId: convId,
          ...(launchResult.aceUvmId ? { aceUvmId: launchResult.aceUvmId } : {}),
          ...(branchName ? { prBranch: branchName } : {}),
          ciFixAttempts: attempts,
          lastCiFixSha: ghEvent.headSha || null,
          status: sessionCallback ? "active" : "resumed",
          lastError: null,
        });

        if (sessionCallback && convId) {
          this.watcher?.start({
            agentSessionId,
            conversationId: convId,
            issueIdentifier: latest.issueIdentifier || "",
            isResume: true,
          });
        }
        return { handled: true, action: "ci_resumed", agentSessionId };
      }

      if (ghEvent.kind === "pr_review" || ghEvent.kind === "pr_review_comment") {
        if (
          this.config.github?.reviewAutoResume === false ||
          latest.workflowPolicy?.reviewAutoResume === false ||
          !latest.agyConversationId
        ) {
          return { handled: false, reason: "review_auto_resume_disabled", agentSessionId };
        }

        const deliveryKey =
          ghEvent.deliveryId || ghEvent.commentUrl || ghEvent.reviewUrl || "";
        const seenList = Array.isArray(latest.seenGithubDeliveries)
          ? latest.seenGithubDeliveries
          : [];
        if (
          deliveryKey &&
          (latest.lastGithubDeliveryId === deliveryKey || seenList.includes(deliveryKey))
        ) {
          return { handled: false, reason: "duplicate_delivery", agentSessionId };
        }

        const prUrlChanged = !baseUrls.some(
          (u) => String(u?.url || "").toLowerCase() === ghEvent.prUrl.toLowerCase()
        );
        const externalUrls = mergeExternalUrls(baseUrls, [
          { label: `PR #${ghEvent.prNumber}`, url: ghEvent.prUrl },
        ]);
        const branchName = ghEvent.branch || latest.prBranch || latest.suggestedBranchName || "";
        const sessionCallback = this._buildSessionCallback(agentSessionId);
        const prompt = buildGitHubFeedbackPrompt({
          issueIdentifier: latest.issueIdentifier,
          branchName,
          feedback: ghEvent,
          sessionCallback,
        });

        this.watcher?.stop(agentSessionId);
        await this._safeSendActivity({
          agentSessionId,
          content: {
            type: "thought",
            body: `💬 Received PR #${ghEvent.prNumber} review feedback (@${ghEvent.reviewer}) — resuming cloud session...`,
          },
        });

        const launchResult = await this.launcher.resume({
          conversationId: latest.agyConversationId,
          mode: this.config.launcher.remoteMode,
          issueIdentifier: latest.issueIdentifier || agentSessionId,
          prompt,
        });

        const convId = launchResult.conversationId || latest.agyConversationId;
        const nextSeen = deliveryKey
          ? [...seenList, deliveryKey].slice(-30)
          : seenList;

        this.sessionStore.upsert(agentSessionId, {
          agyConversationId: convId,
          ...(launchResult.aceUvmId ? { aceUvmId: launchResult.aceUvmId } : {}),
          prUrl: ghEvent.prUrl,
          prRepo: ghEvent.repo,
          prNumber: ghEvent.prNumber,
          ...(branchName ? { prBranch: branchName } : {}),
          externalUrls,
          lastGithubDeliveryId: deliveryKey || latest.lastGithubDeliveryId || null,
          seenGithubDeliveries: nextSeen,
          status: sessionCallback ? "active" : "resumed",
          lastError: null,
        });

        if (prUrlChanged) {
          await this._safeUpdateSession({
            id: agentSessionId,
            externalUrls,
          });
        }

        if (sessionCallback && convId) {
          this.watcher?.start({
            agentSessionId,
            conversationId: convId,
            issueIdentifier: latest.issueIdentifier || "",
            isResume: true,
          });
        }
        return { handled: true, action: "review_resumed", agentSessionId };
      }

      return { handled: false, reason: "unsupported_github_kind", agentSessionId };
    });
  }

  async _resolveIssueContext(event) {
    const base = event.issue || {};
    if (!base.id) {
      return base;
    }
    try {
      const detailed = await this.linearClient.getIssueContext(base.id);
      if (detailed) {
        return detailed;
      }
    } catch (err) {
      this.logger.warn(
        `[dispatcher] Failed to fetch enriched issue context for ${base.id}: ${err.message}`
      );
    }
    return base;
  }

  async _safeSendActivity(args) {
    try {
      await this.linearClient.createAgentActivity(args);
    } catch (err) {
      this.logger.error(
        `[dispatcher] Failed to create agent activity for ${args.agentSessionId}: ${err.message}`
      );
    }
  }

  async _safeUpdateSession(args) {
    try {
      await this.linearClient.updateAgentSession(args);
    } catch (err) {
      this.logger.warn(
        `[dispatcher] Failed to update agent session ${args.id}: ${err.message}`
      );
    }
  }
}
