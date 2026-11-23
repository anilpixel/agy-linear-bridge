import { spawn } from "node:child_process";
import { extractPullRequestUrls, mergeExternalUrls } from "./github-webhook.mjs";

/**
 * Watches active remote Antigravity conversations in read-only mode and forwards
 * live status thoughts, tool actions, keepalives, and completion fallback responses to Linear.
 */
export class RemoteStreamWatcher {
  constructor({
    config,
    linearClient,
    sessionStore,
    spawnImpl = spawn,
    logger = console,
    nowFn = () => Date.now(),
  }) {
    this.config = config;
    this.linearClient = linearClient;
    this.sessionStore = sessionStore;
    this.spawnImpl = spawnImpl;
    this.logger = logger;
    this.nowFn = nowFn;
    this.active = new Map();
  }

  activeCount() {
    return this.active.size;
  }

  _isSessionActive(agentSessionId) {
    return this.sessionStore?.get(agentSessionId)?.status === "active";
  }

  _watcherSettings() {
    const w = this.config?.watcher || {};
    return {
      enabled: w.enabled !== false,
      statusThrottleMs: Number.isFinite(w.statusThrottleMs) ? w.statusThrottleMs : 12_000,
      actionThrottleMs: Number.isFinite(w.actionThrottleMs) ? w.actionThrottleMs : 15_000,
      keepaliveMs: Number.isFinite(w.keepaliveMs) ? w.keepaliveMs : 900_000,
      idleGraceMs: Number.isFinite(w.idleGraceMs) ? w.idleGraceMs : 5_000,
      maxConcurrent: Math.max(1, Number(w.maxConcurrent || 4)),
      maxDurationSec: Math.max(60, Number(w.maxDurationSec || 7_200)),
    };
  }

  start({ agentSessionId, conversationId, issueIdentifier = "", isResume = false }) {
    const settings = this._watcherSettings();
    if (!settings.enabled || !agentSessionId || !conversationId) {
      return false;
    }

    if (this.active.has(agentSessionId)) {
      this.stop(agentSessionId);
    }

    if (this.active.size >= settings.maxConcurrent) {
      this.logger.warn?.(
        `[watcher] Capacity reached (${this.active.size}/${settings.maxConcurrent}); skipping watch for session=${agentSessionId}`
      );
      return false;
    }

    const pythonBin = this.config?.launcher?.pythonBin || "python3";
    const agyBin = this.config?.launcher?.agyBin || "agy";
    const watchScript = this.config?.paths?.watchScript;
    const cwd = this.config?.rootDir || process.cwd();
    if (!watchScript) {
      this.logger.warn?.("[watcher] Missing watchScript path; skipping watch");
      return false;
    }

    const args = [
      watchScript,
      "--agy-bin",
      agyBin,
      "--conversation",
      conversationId,
      "--cwd",
      cwd,
      "--max-seconds",
      String(settings.maxDurationSec),
    ];
    if (isResume) {
      args.push("--resume");
    }

    const child = this.spawnImpl(pythonBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const entry = {
      agentSessionId,
      conversationId,
      issueIdentifier,
      child,
      lastStatusText: "",
      lastStatusAt: 0,
      lastActionAt: 0,
      lastAnyActivityAt: this.nowFn(),
      seenActions: new Set(),
      pendingActions: [],
      actionTimer: null,
      idleTimer: null,
      keepaliveTimer: null,
      killTimer: null,
      stopped: false,
    };

    entry.keepaliveTimer = setInterval(() => {
      this._checkKeepalive(agentSessionId);
    }, 60_000);
    entry.keepaliveTimer.unref?.();

    this.active.set(agentSessionId, entry);

    let stdoutBuf = "";
    child.stdout?.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          this.handleWatcherEvent(agentSessionId, msg);
        } catch (err) {
          this.logger.warn?.(
            `[watcher] Non-JSON line session=${agentSessionId}: ${err.message}`
          );
        }
      }
    });

    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        this.logger.warn?.(`[watcher:${agentSessionId}] stderr: ${text}`);
      }
    });

    child.on("close", (code, signal) => {
      if (entry.stopped) {
        return;
      }
      if (stdoutBuf.trim()) {
        try {
          const msg = JSON.parse(stdoutBuf.trim());
          this.handleWatcherEvent(agentSessionId, msg);
        } catch {
          // Ignore trailing partial line
        }
        stdoutBuf = "";
      }
      this.logger.log?.(
        `[watcher] Process exited session=${agentSessionId} conv=${conversationId} code=${code} signal=${signal || "-"}`
      );
      if (!entry.idleTimer) {
        this._cleanupEntry(agentSessionId);
      }
    });

    this.logger.log?.(
      `[watcher] Started session=${agentSessionId} issue=${issueIdentifier || "-"} conv=${conversationId}`
    );
    return true;
  }

  async handleWatcherEvent(agentSessionId, msg) {
    const entry = this.active.get(agentSessionId);
    if (!entry || entry.stopped || !msg || typeof msg !== "object") {
      return;
    }

    const settings = this._watcherSettings();
    const now = this.nowFn();
    const event = msg.event;

    if (event === "attached") {
      this.logger.log?.(
        `[watcher] Attached session=${agentSessionId} conv=${entry.conversationId} running=${Boolean(msg.running)}`
      );
      return;
    }

    if (event === "status") {
      const text = typeof msg.text === "string" ? msg.text.trim() : "";
      if (!text || !this._isSessionActive(agentSessionId)) {
        return;
      }
      if (text === entry.lastStatusText) {
        return;
      }
      if (now - entry.lastStatusAt < settings.statusThrottleMs) {
        return;
      }
      entry.lastStatusText = text;
      entry.lastStatusAt = now;
      entry.lastAnyActivityAt = now;
      await this._safeSendActivity({
        agentSessionId,
        content: {
          type: "thought",
          body: `🔄 ${text}`,
        },
        ephemeral: true,
      });
      return;
    }

    if (event === "action") {
      if (!this._isSessionActive(agentSessionId)) {
        return;
      }
      const action = typeof msg.action === "string" ? msg.action.trim() : "";
      const parameter = typeof msg.parameter === "string" ? msg.parameter.trim() : "";
      if (!action || !parameter) {
        return;
      }
      await this._syncPrUrlsFromText(agentSessionId, parameter);
      const key = `${action}\0${parameter}`;
      if (entry.seenActions.has(key)) {
        return;
      }
      entry.seenActions.add(key);
      entry.pendingActions.push({ action, parameter });

      if (entry.actionTimer) {
        return;
      }
      const elapsed = now - entry.lastActionAt;
      if (elapsed >= settings.actionThrottleMs) {
        await this._flushPendingActions(agentSessionId);
      } else {
        const waitMs = Math.max(0, settings.actionThrottleMs - elapsed);
        entry.actionTimer = setTimeout(() => {
          entry.actionTimer = null;
          this._flushPendingActions(agentSessionId).catch((err) => {
            this.logger.warn?.(`[watcher] Action flush error: ${err.message}`);
          });
        }, waitMs);
        entry.actionTimer.unref?.();
      }
      return;
    }

    if (event === "idle") {
      if (entry.idleTimer) {
        return;
      }
      const finalText = typeof msg.finalText === "string" ? msg.finalText.trim() : "";
      const finalize = async () => {
        entry.idleTimer = null;
        if (entry.stopped) {
          return;
        }
        try {
          if (entry.pendingActions.length > 0 && this._isSessionActive(agentSessionId)) {
            await this._flushPendingActions(agentSessionId);
          }
          if (finalText && this._isSessionActive(agentSessionId)) {
            await this._syncPrUrlsFromText(agentSessionId, finalText);
          }
          if (!this._isSessionActive(agentSessionId)) {
            this.logger.log?.(
              `[watcher] Idle grace confirmed session=${agentSessionId} already handled externally`
            );
            return;
          }
          const body = finalText
            ? [
                `✅ Cloud Remote Agent turn completed (synced automatically by stream watcher):`,
                "",
                finalText,
                "",
                `- Resume/attach: \`agy --remote-agent --conversation=${entry.conversationId}\``,
              ].join("\n")
            : [
                `✅ Cloud Remote Agent turn completed.`,
                `- Resume/attach: \`agy --remote-agent --conversation=${entry.conversationId}\``,
              ].join("\n");

          await this._safeSendActivity({
            agentSessionId,
            content: {
              type: "response",
              body,
            },
          });
          this.sessionStore.upsert(agentSessionId, {
            status: "complete",
            lastActivityType: "watcher_fallback_response",
          });
          this.logger.log?.(
            `[watcher] Fallback completion response sent session=${agentSessionId} conv=${entry.conversationId}`
          );
        } finally {
          this.stop(agentSessionId);
        }
      };

      entry.idleTimer = setTimeout(() => {
        finalize().catch((err) => {
          this.logger.error?.(
            `[watcher] Idle finalize failed session=${agentSessionId}:`,
            err
          );
          this.stop(agentSessionId);
        });
      }, settings.idleGraceMs);
      entry.idleTimer.unref?.();
      return;
    }

    if (event === "error") {
      this.logger.warn?.(
        `[watcher] Error event session=${agentSessionId}: ${msg.error || "unknown"}`
      );
      this.stop(agentSessionId);
      return;
    }

    if (event === "timeout") {
      this.logger.warn?.(`[watcher] Max watch duration reached session=${agentSessionId}`);
      this.stop(agentSessionId);
    }
  }

  async _flushPendingActions(agentSessionId) {
    const entry = this.active.get(agentSessionId);
    if (!entry || entry.stopped || entry.pendingActions.length === 0) {
      return;
    }
    if (!this._isSessionActive(agentSessionId)) {
      entry.pendingActions.length = 0;
      return;
    }
    const items = entry.pendingActions.splice(0, entry.pendingActions.length);
    const last = items[items.length - 1];
    const parameter =
      items.length === 1
        ? last.parameter
        : `${last.parameter} (${items.length} cloud steps: ${items
            .map((i) => `${i.action} ${i.parameter}`)
            .join(" · ")
            .slice(0, 260)})`;

    const now = this.nowFn();
    entry.lastActionAt = now;
    entry.lastAnyActivityAt = now;
    await this._safeSendActivity({
      agentSessionId,
      content: {
        type: "action",
        action: last.action,
        parameter: parameter.slice(0, 320),
      },
    });
  }

  _checkKeepalive(agentSessionId) {
    const entry = this.active.get(agentSessionId);
    if (!entry || entry.stopped) {
      return;
    }
    if (!this._isSessionActive(agentSessionId)) {
      this.stop(agentSessionId);
      return;
    }
    const settings = this._watcherSettings();
    const now = this.nowFn();
    if (now - entry.lastAnyActivityAt >= settings.keepaliveMs) {
      entry.lastAnyActivityAt = now;
      this._safeSendActivity({
        agentSessionId,
        content: {
          type: "thought",
          body: "🔄 Cloud session is still running in the background...",
        },
        ephemeral: true,
      }).catch((err) => {
        this.logger.warn?.(`[watcher] Keepalive failed session=${agentSessionId}: ${err.message}`);
      });
    }
  }

  noteExternalActivity(agentSessionId) {
    const entry = this.active.get(agentSessionId);
    if (entry && !entry.stopped) {
      entry.lastAnyActivityAt = this.nowFn();
    }
  }

  stop(agentSessionId) {
    const entry = this.active.get(agentSessionId);
    if (!entry) {
      return;
    }
    entry.stopped = true;
    this._cleanupEntry(agentSessionId, entry);
    const child = entry.child;
    if (child && child.exitCode === null && child.signalCode === null && !child.killed) {
      try {
        child.kill("SIGTERM");
        entry.killTimer = setTimeout(() => {
          try {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill("SIGKILL");
            }
          } catch {
            // Ignore kill failure
          }
        }, 3_000);
        entry.killTimer.unref?.();
      } catch {
        // Ignore kill error
      }
    }
  }

  _cleanupEntry(agentSessionId, existingEntry = null) {
    const entry = existingEntry || this.active.get(agentSessionId);
    if (!entry) {
      return;
    }
    if (entry.actionTimer) clearTimeout(entry.actionTimer);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.keepaliveTimer) clearInterval(entry.keepaliveTimer);
    entry.actionTimer = null;
    entry.idleTimer = null;
    entry.keepaliveTimer = null;
    this.active.delete(agentSessionId);
  }

  stopAll() {
    for (const id of Array.from(this.active.keys())) {
      this.stop(id);
    }
  }

  restoreActiveSessions() {
    const settings = this._watcherSettings();
    if (!settings.enabled || !this.sessionStore?.list) {
      return 0;
    }
    const now = this.nowFn();
    const maxAgeMs = settings.maxDurationSec * 1000;
    let started = 0;
    for (const session of this.sessionStore.list()) {
      if (session?.status !== "active" || !session?.agyConversationId || !session?.linearSessionId) {
        continue;
      }
      const updatedMs = Date.parse(session.updatedAt || session.createdAt || "");
      if (Number.isFinite(updatedMs) && now - updatedMs > maxAgeMs) {
        continue;
      }
      if (
        this.start({
          agentSessionId: session.linearSessionId,
          conversationId: session.agyConversationId,
          issueIdentifier: session.issueIdentifier || "",
        })
      ) {
        started += 1;
      }
    }
    return started;
  }

  async _syncPrUrlsFromText(agentSessionId, text) {
    const refs = extractPullRequestUrls(text);
    if (!refs.length) {
      return false;
    }

    const existing = this.sessionStore?.get?.(agentSessionId) || null;
    const baseUrls =
      Array.isArray(existing?.externalUrls) && existing.externalUrls.length > 0
        ? existing.externalUrls
        : existing?.agyConversationId
          ? [{ label: "Antigravity Remote", url: "https://antigravity.google.com" }]
          : [];
    const existingSet = new Set(baseUrls.map((u) => String(u?.url || "").toLowerCase()));
    const hasNewUrl = refs.some((r) => !existingSet.has(r.url.toLowerCase()));
    const latest = refs[refs.length - 1];
    if (!hasNewUrl && existing?.prUrl === latest.url) {
      return false;
    }

    const additions = refs.map((r) => ({
      label: `PR #${r.prNumber}`,
      url: r.url,
    }));
    const externalUrls = mergeExternalUrls(baseUrls, additions);

    this.sessionStore?.upsert?.(agentSessionId, {
      prUrl: latest.url,
      prRepo: latest.repo,
      prNumber: latest.prNumber,
      externalUrls,
    });

    if (typeof this.linearClient?.updateAgentSession === "function") {
      try {
        await this.linearClient.updateAgentSession({
          id: agentSessionId,
          externalUrls,
        });
      } catch (err) {
        this.logger.warn?.(
          `[watcher] Failed to attach PR externalUrls for ${agentSessionId}: ${err.message}`
        );
      }
    }
    return true;
  }

  async _safeSendActivity(args) {
    try {
      await this.linearClient.createAgentActivity(args);
    } catch (err) {
      this.logger.warn?.(
        `[watcher] Failed to create agent activity for ${args.agentSessionId}: ${err.message}`
      );
    }
  }
}
