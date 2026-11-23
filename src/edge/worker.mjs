import crypto from "node:crypto";
import {
  extractPullRequestUrls,
  mergeExternalUrls,
  parseGitHubEvent,
  verifyGitHubWebhook,
} from "../github-webhook.mjs";
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  LinearTokenManager,
} from "../linear-auth.mjs";
import { LinearClient } from "../linear-client.mjs";
import {
  createSessionCallbackToken,
  parseAgentSessionEvent,
  verifyLinearWebhook,
  verifySessionCallbackToken,
} from "../webhook.mjs";
import { D1BridgeStore, D1OAuthStateStore, D1TokenStore } from "./d1-store.mjs";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const ANTIGRAVITY_EXTERNAL_URL = {
  label: "Antigravity Remote",
  url: "https://antigravity.google.com",
};

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlResponse(status, html) {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function logInfo(message, fields = {}) {
  console.log(JSON.stringify({ message, ...fields }));
}

function logError(message, fields = {}) {
  console.error(JSON.stringify({ message, ...fields }));
}

async function readBoundedBytes(request, maxBytes = MAX_BODY_BYTES) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > maxBytes) {
    const err = new Error("Request body too large");
    err.statusCode = 413;
    throw err;
  }
  const ab = await request.arrayBuffer();
  if (ab.byteLength > maxBytes) {
    const err = new Error("Request body too large");
    err.statusCode = 413;
    throw err;
  }
  return Buffer.from(ab);
}

/**
 * Constant-time bearer secret check using fixed-size SHA-256 digests.
 */
export function verifyBearerSecret(authHeader, expectedSecret) {
  const secret = String(expectedSecret || "").trim();
  if (!secret) {
    return false;
  }
  const match = String(authHeader || "").match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return false;
  }
  const provided = match[1].trim();
  if (!provided) {
    return false;
  }
  const providedHash = crypto.createHash("sha256").update(provided, "utf8").digest();
  const expectedHash = crypto.createHash("sha256").update(secret, "utf8").digest();
  return crypto.timingSafeEqual(providedHash, expectedHash);
}

function resolvePublicBaseUrl(env, requestUrl) {
  const configured = String(env.PUBLIC_BASE_URL || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(?:oauth\/callback|webhooks\/linear)$/i, "");
  if (configured) {
    return configured;
  }
  return `${requestUrl.protocol}//${requestUrl.host}`;
}

function resolveEnvConfig(env) {
  const rawMaxRounds = env.GITHUB_MAX_CI_FIX_ROUNDS;
  const maxCiFixRounds =
    rawMaxRounds !== undefined && rawMaxRounds !== ""
      ? Math.max(0, Number(rawMaxRounds) || 0)
      : 3;

  return {
    linear: {
      clientId: String(env.LINEAR_CLIENT_ID || "").trim(),
      clientSecret: String(env.LINEAR_CLIENT_SECRET || "").trim(),
      webhookSecret: String(env.LINEAR_WEBHOOK_SECRET || "").trim(),
      oauthScopes: String(
        env.LINEAR_OAUTH_SCOPES || "read,write,app:assignable,app:mentionable"
      )
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
      authMode: env.LINEAR_AUTH_MODE === "client_credentials" ? "client_credentials" : "oauth",
      webhookMaxAgeMs: 300_000,
    },
    github: {
      webhookSecret: String(env.GITHUB_WEBHOOK_SECRET || "").trim(),
      ciAutoFix: String(env.GITHUB_CI_AUTO_FIX || "true").toLowerCase() !== "false",
      reviewAutoResume:
        String(env.GITHUB_REVIEW_AUTO_RESUME || "true").toLowerCase() !== "false",
      maxCiFixRounds,
      ignoredActors: String(env.GITHUB_IGNORED_ACTORS || "")
        .split(/[,\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    },
    runnerSecret: String(env.RUNNER_SHARED_SECRET || "").trim(),
  };
}

function buildSessionCallback(publicBaseUrl, secret, agentSessionId) {
  if (!publicBaseUrl || !secret || !agentSessionId) {
    return null;
  }
  return {
    agentSessionId,
    callbackUrl: `${publicBaseUrl}/api/sessions/${encodeURIComponent(agentSessionId)}/activity`,
    callbackToken: createSessionCallbackToken({ agentSessionId, secret }),
  };
}

function scheduleBackground(ctx, promise) {
  const guarded = Promise.resolve(promise).catch((err) => {
    logError("edge_background_error", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(guarded);
    return null;
  }
  return guarded;
}

/**
 * Create a Cloudflare Worker handler (allowing dependency overrides in tests).
 */
export function createEdgeWorkerHandler({
  fetchImpl = (...args) => fetch(...args),
  exchangeCodeFn = exchangeAuthorizationCode,
  nowFn = Date.now,
} = {}) {
  return async function handleEdgeRequest(request, env, ctx) {
    const url = new URL(request.url);
    try {
      const cfg = resolveEnvConfig(env);
      const publicBaseUrl = resolvePublicBaseUrl(env, url);
      const tokenStore = new D1TokenStore(env.DB, { nowFn });
      const stateStore = new D1OAuthStateStore(env.DB, { nowFn });
      const store = new D1BridgeStore(env.DB, { nowFn });
      const tokenManager = new LinearTokenManager({
        linearConfig: cfg.linear,
        tokenStore,
        fetchImpl,
        nowFn,
      });
      const linearClient = new LinearClient({ tokenManager, fetchImpl });

      if (request.method === "GET" && url.pathname === "/health") {
        const [hasToken, sessionsCount, pendingJobsCount, runnerStatus] = await Promise.all([
          tokenManager.hasToken(),
          store.countSessions(),
          store.countPendingJobs(),
          store.getRunnerStatus(),
        ]);

        return Response.json({
          ok: true,
          mode: "cloudflare-edge",
          authConfigured: Boolean(cfg.linear.clientId && cfg.linear.clientSecret),
          webhookConfigured: Boolean(cfg.linear.webhookSecret),
          githubWebhookConfigured: Boolean(cfg.github.webhookSecret),
          runnerAuthConfigured: Boolean(cfg.runnerSecret),
          hasToken: Boolean(hasToken),
          sessionsCount,
          pendingJobsCount,
          projectsCount: runnerStatus.projectsCount,
          activeWatchers: runnerStatus.activeWatchers,
          runnerOnline: runnerStatus.online,
          runnerLastSeenAt: runnerStatus.lastSeenAt,
        });
      }

      if (request.method === "GET" && url.pathname === "/oauth/start") {
        if (!cfg.linear.clientId || !publicBaseUrl) {
          return Response.json(
            {
              ok: false,
              error: "LINEAR_CLIENT_ID and PUBLIC_BASE_URL must be configured first",
            },
            { status: 500 }
          );
        }
        const state = await stateStore.create({ createdAt: nowFn() });
        const redirectUri = `${publicBaseUrl}/oauth/callback`;
        const authUrl = buildAuthorizeUrl({
          clientId: cfg.linear.clientId,
          redirectUri,
          scopes: cfg.linear.oauthScopes,
          state,
        });
        return Response.redirect(authUrl, 302);
      }

      if (request.method === "GET" && url.pathname === "/oauth/callback") {
        const oauthError = url.searchParams.get("error");
        if (oauthError) {
          const desc = url.searchParams.get("error_description") || oauthError;
          return htmlResponse(400, `<h1>Linear 授权失败</h1><p>${escapeHtml(desc)}</p>`);
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const stateMeta = state ? await stateStore.consume(state) : null;
        if (!code || !stateMeta) {
          return htmlResponse(
            400,
            "<h1>无效或已过期的 OAuth state</h1><p>请重新访问 /oauth/start。</p>"
          );
        }

        const redirectUri = `${publicBaseUrl}/oauth/callback`;
        const tokenResp = await exchangeCodeFn({
          clientId: cfg.linear.clientId,
          clientSecret: cfg.linear.clientSecret,
          redirectUri,
          code,
          fetchImpl,
        });
        await tokenManager.saveInitialOAuthToken(tokenResp);

        let viewerInfo = null;
        try {
          viewerInfo = await linearClient.getViewer();
        } catch (err) {
          logError("oauth_viewer_warning", {
            error: err instanceof Error ? err.message : String(err),
          });
        }

        const viewer = viewerInfo?.viewer;
        const org = viewerInfo?.organization;
        return htmlResponse(
          200,
          `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>Linear Agent 已安装</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 640px; margin: 48px auto; line-height: 1.6;">
  <h1>✅ Linear Agent 边缘身份安装成功</h1>
  <ul>
    <li><strong>Workspace</strong>: ${escapeHtml(org?.name || org?.urlKey || "unknown")}</li>
    <li><strong>Agent Name</strong>: ${escapeHtml(viewer?.name || "unknown")}</li>
    <li><strong>Display Name</strong>: ${escapeHtml(viewer?.displayName || "unknown")}</li>
    <li><strong>App Actor</strong>: ${escapeHtml(String(viewer?.app ?? "unknown"))}</li>
    <li><strong>User ID</strong>: <code>${escapeHtml(viewer?.id || "unknown")}</code></li>
  </ul>
  <p>OAuth Token 已加密保存至 Cloudflare D1。现在可在本地运行 <code>npm run runner</code> 连接边缘网关。</p>
</body>
</html>`
        );
      }

      if (
        request.method === "POST" &&
        (url.pathname === "/webhooks/linear" ||
          url.pathname === "/oauth/callback/webhooks/linear")
      ) {
        const deliveryId = request.headers.get("linear-delivery") || "";
        const rawBody = await readBoundedBytes(request);
        let payload;
        try {
          payload = JSON.parse(rawBody.toString("utf8"));
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
        }

        const verification = verifyLinearWebhook({
          rawBody,
          signatureHeader: request.headers.get("linear-signature"),
          payload,
          webhookSecret: cfg.linear.webhookSecret,
          maxAgeMs: cfg.linear.webhookMaxAgeMs,
          nowMs: nowFn(),
        });

        if (!verification.ok) {
          logError("linear_webhook_rejected", {
            status: verification.status,
            reason: verification.reason,
            deliveryId,
          });
          return Response.json(
            { ok: false, error: verification.reason },
            { status: verification.status }
          );
        }

        if (deliveryId) {
          const isNew = await store.markDeliverySeen(`linear:${deliveryId}`, "linear");
          if (!isNew) {
            return Response.json({ ok: true, accepted: false, duplicate: true });
          }
        }

        const event = parseAgentSessionEvent(payload);
        logInfo("linear_webhook_accepted", {
          accepted: Boolean(event),
          action: event?.action || null,
          isStopSignal: Boolean(event?.isStopSignal),
          agentSessionId: event?.agentSessionId || null,
          issueIdentifier: event?.issue?.identifier || null,
        });

        if (event) {
          const bg = processLinearWebhookOnEdge({
            event,
            store,
            linearClient,
            publicBaseUrl,
            callbackSecret: cfg.linear.webhookSecret || cfg.linear.clientSecret,
            runnerConfigured: Boolean(cfg.runnerSecret),
            nowFn,
          });
          const maybeAwait = scheduleBackground(ctx, bg);
          if (maybeAwait) await maybeAwait;
        }

        return Response.json({ ok: true, accepted: Boolean(event) });
      }

      if (request.method === "POST" && url.pathname === "/webhooks/github") {
        const deliveryId = request.headers.get("x-github-delivery") || "";
        const eventName = request.headers.get("x-github-event") || "";
        const rawBody = await readBoundedBytes(request);

        const verification = verifyGitHubWebhook({
          rawBody,
          signature256Header: request.headers.get("x-hub-signature-256"),
          webhookSecret: cfg.github.webhookSecret,
        });

        if (!verification.ok) {
          logError("github_webhook_rejected", {
            status: verification.status,
            reason: verification.reason,
            deliveryId,
          });
          return Response.json(
            { ok: false, error: verification.reason },
            { status: verification.status }
          );
        }

        let payload;
        try {
          payload = JSON.parse(rawBody.toString("utf8"));
        } catch {
          return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
        }

        if (deliveryId) {
          const isNew = await store.markDeliverySeen(`github:${deliveryId}`, "github");
          if (!isNew) {
            return Response.json({ ok: true, accepted: false, duplicate: true });
          }
        }

        const ghEvent = parseGitHubEvent({
          eventName,
          deliveryId,
          payload,
          ignoredActors: cfg.github.ignoredActors,
        });

        if (ghEvent) {
          const bg = processGitHubWebhookOnEdge({
            ghEvent,
            cfg,
            store,
            linearClient,
            publicBaseUrl,
            callbackSecret: cfg.linear.webhookSecret || cfg.linear.clientSecret,
          });
          const maybeAwait = scheduleBackground(ctx, bg);
          if (maybeAwait) await maybeAwait;
        }

        return Response.json({
          ok: true,
          accepted: Boolean(ghEvent),
          kind: ghEvent?.kind || null,
        });
      }

      if (request.method === "POST") {
        const activityMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/activity$/);
        if (activityMatch) {
          return await handleCloudSessionCallback({
            request,
            rawSessionId: activityMatch[1],
            cfg,
            store,
            linearClient,
          });
        }

        if (url.pathname.startsWith("/api/runner/")) {
          if (!cfg.runnerSecret) {
            return Response.json(
              { ok: false, error: "RUNNER_SHARED_SECRET is not configured" },
              { status: 500 }
            );
          }
          if (!verifyBearerSecret(request.headers.get("authorization"), cfg.runnerSecret)) {
            return Response.json(
              { ok: false, error: "Unauthorized runner secret" },
              { status: 401 }
            );
          }
          return await handleRunnerApi({
            request,
            url,
            store,
            tokenStore,
            linearClient,
          });
        }
      }

      return Response.json({ ok: false, error: "Not found" }, { status: 404 });
    } catch (err) {
      const status = err?.statusCode || 500;
      logError("edge_request_failed", {
        path: url.pathname,
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        { ok: false, error: err instanceof Error ? err.message : "Internal error" },
        { status }
      );
    }
  };
}

async function processLinearWebhookOnEdge({
  event,
  store,
  linearClient,
  publicBaseUrl,
  callbackSecret,
  runnerConfigured,
  nowFn,
}) {
  const { agentSessionId, action } = event;
  const existing = await store.getSession(agentSessionId);

  if (event.isStopSignal) {
    await store.cancelPendingJobsForSession(agentSessionId);
    const issueIdentifier = existing?.issueIdentifier || event.issue?.identifier || null;
    await store.upsertSession(agentSessionId, {
      issueId: existing?.issueId || event.issue?.id || null,
      issueIdentifier,
      status: "stopped",
      stoppedAt: new Date(nowFn()).toISOString(),
      lastError: null,
    });

    if (existing?.agyConversationId && runnerConfigured) {
      await store.enqueueJob({
        agentSessionId,
        kind: "stop_session",
        payload: {
          agentSessionId,
          conversationId: existing.agyConversationId,
          issueIdentifier: issueIdentifier || "",
        },
      });
    }

    const stopLines = [
      `🛑 已收到 Linear 停止信号，Cloudflare 边缘网关已锁定后续回调写回并通知本地 Runner 中止任务。`,
      existing?.agyConversationId
        ? `- 会话 ID：\`agy --remote-agent --conversation=${existing.agyConversationId}\``
        : null,
    ].filter(Boolean);

    await safeCreateActivity(linearClient, {
      agentSessionId,
      content: { type: "response", body: stopLines.join("\n") },
    });
    return;
  }

  const issueLabel = event.issue?.identifier || event.issue?.title || agentSessionId;
  const runnerStatus = await store.getRunnerStatus();

  const ackBody = runnerStatus.online
    ? action === "prompted"
      ? `收到补充指令，边缘网关正在转发至在线 Runner 续接工单 ${issueLabel} 的云端会话...`
      : `已接单，边缘网关正在拉取工单 ${issueLabel} 上下文并派发给在线 Runner 启动 Antigravity Remote Agent...`
    : `📥 已由 Cloudflare 边缘网关接单并入队（本地 Runner 当前离线或休眠，恢复在线后将自动拉起工单 ${issueLabel} 的云端会话）...`;

  await safeCreateActivity(linearClient, {
    agentSessionId,
    content: { type: "thought", body: ackBody },
  });

  let issueContext = event.issue || {};
  const isFollowUp = Boolean(action === "prompted" && existing?.agyConversationId);
  if (!isFollowUp && event.issue?.id) {
    try {
      const detailed = await linearClient.getIssueContext(event.issue.id);
      if (detailed) {
        issueContext = detailed;
      }
    } catch (err) {
      logError("edge_issue_context_warning", {
        issueId: event.issue.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const suggestedBranchName =
    String(issueContext?.branchName || existing?.suggestedBranchName || "").trim() || null;

  await store.upsertSession(agentSessionId, {
    issueId: issueContext?.id || existing?.issueId || event.issue?.id || null,
    issueIdentifier:
      issueContext?.identifier || existing?.issueIdentifier || event.issue?.identifier || null,
    ...(suggestedBranchName ? { suggestedBranchName } : {}),
    status: isFollowUp ? "queued_followup" : "queued",
    lastError: null,
  });

  const sessionCallback = buildSessionCallback(publicBaseUrl, callbackSecret, agentSessionId);
  await store.enqueueJob({
    agentSessionId,
    kind: "dispatch_linear",
    payload: {
      event,
      issueContext,
      sessionCallback,
    },
  });
}

async function processGitHubWebhookOnEdge({
  ghEvent,
  cfg,
  store,
  linearClient,
  publicBaseUrl,
  callbackSecret,
}) {
  const session = await store.findByPullRequest({
    repo: ghEvent.repo,
    prNumber: ghEvent.prNumber,
    prNumbers: ghEvent.prNumbers,
    branch: ghEvent.branch,
    issueIdentifiers: ghEvent.issueIdentifiers,
  });
  if (!session) {
    return;
  }

  const agentSessionId = session.linearSessionId;
  if (session.status === "stopped") {
    return;
  }

  const baseUrls =
    Array.isArray(session.externalUrls) && session.externalUrls.length > 0
      ? session.externalUrls
      : [ANTIGRAVITY_EXTERNAL_URL];

  if (ghEvent.kind === "pr_sync") {
    const externalUrls = mergeExternalUrls(baseUrls, [
      { label: `PR #${ghEvent.prNumber}`, url: ghEvent.prUrl },
    ]);
    await store.upsertSession(agentSessionId, {
      prUrl: ghEvent.prUrl,
      prRepo: ghEvent.repo,
      prNumber: ghEvent.prNumber,
      prBranch: ghEvent.branch || session.prBranch || null,
      externalUrls,
    });
    await safeUpdateSession(linearClient, { id: agentSessionId, externalUrls });
    return;
  }

  if (ghEvent.kind === "ci_failure") {
    if (
      !cfg.github.ciAutoFix ||
      session.workflowPolicy?.ciAutoFix === false ||
      !session.agyConversationId
    ) {
      return;
    }
    if (ghEvent.headSha && session.lastCiFixSha === ghEvent.headSha) {
      return;
    }

    const rawMax = session.workflowPolicy?.maxCiFixRounds ?? cfg.github.maxCiFixRounds ?? 3;
    const maxRounds = Number.isFinite(Number(rawMax)) ? Math.max(0, Number(rawMax)) : 3;
    const prevAttempts = Number(session.ciFixAttempts || 0);

    if (prevAttempts >= maxRounds) {
      await safeCreateActivity(linearClient, {
        agentSessionId,
        content: {
          type: "elicitation",
          body: [
            `⚠️ GitHub CI（\`${ghEvent.name}\`）已连续触发 ${prevAttempts} 轮自动修复，达到上限（\`maxCiFixRounds=${maxRounds}\`），需要人工介入确认。`,
            ghEvent.detailsUrl ? `- 检查详情：${ghEvent.detailsUrl}` : null,
            session.prUrl ? `- PR 链接：${session.prUrl}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      });
      await store.upsertSession(agentSessionId, {
        status: "awaiting_clarification",
        lastCiFixSha: ghEvent.headSha || session.lastCiFixSha || null,
      });
      return;
    }

    const attempts = prevAttempts + 1;
    await store.upsertSession(agentSessionId, {
      ciFixAttempts: attempts,
      lastCiFixSha: ghEvent.headSha || null,
      ...(ghEvent.branch ? { prBranch: ghEvent.branch } : {}),
      status: "queued_followup",
    });

    await safeCreateActivity(linearClient, {
      agentSessionId,
      content: {
        type: "thought",
        body: `⚠️ CI 失败（${ghEvent.name}），边缘网关已入队唤醒原云端会话自动修复（第 ${attempts}/${maxRounds} 轮）...`,
      },
    });

    await store.enqueueJob({
      agentSessionId,
      kind: "github_feedback",
      payload: {
        ghEvent,
        attempts,
        maxRounds,
        sessionCallback: buildSessionCallback(publicBaseUrl, callbackSecret, agentSessionId),
      },
    });
    return;
  }

  if (ghEvent.kind === "pr_review" || ghEvent.kind === "pr_review_comment") {
    if (
      !cfg.github.reviewAutoResume ||
      session.workflowPolicy?.reviewAutoResume === false ||
      !session.agyConversationId
    ) {
      return;
    }

    const externalUrls = mergeExternalUrls(baseUrls, [
      { label: `PR #${ghEvent.prNumber}`, url: ghEvent.prUrl },
    ]);
    await store.upsertSession(agentSessionId, {
      prUrl: ghEvent.prUrl,
      prRepo: ghEvent.repo,
      prNumber: ghEvent.prNumber,
      ...(ghEvent.branch ? { prBranch: ghEvent.branch } : {}),
      externalUrls,
      status: "queued_followup",
    });
    await safeUpdateSession(linearClient, { id: agentSessionId, externalUrls });

    await safeCreateActivity(linearClient, {
      agentSessionId,
      content: {
        type: "thought",
        body: `💬 收到 PR #${ghEvent.prNumber} Review 反馈（@${ghEvent.reviewer}），边缘网关已入队唤醒原云端会话处理...`,
      },
    });

    await store.enqueueJob({
      agentSessionId,
      kind: "github_feedback",
      payload: {
        ghEvent,
        sessionCallback: buildSessionCallback(publicBaseUrl, callbackSecret, agentSessionId),
      },
    });
  }
}

async function handleCloudSessionCallback({
  request,
  rawSessionId,
  cfg,
  store,
  linearClient,
}) {
  let agentSessionId = "";
  try {
    agentSessionId = decodeURIComponent(rawSessionId).trim();
  } catch {
    return Response.json({ ok: false, error: "Malformed agentSessionId" }, { status: 400 });
  }
  if (!agentSessionId) {
    return Response.json({ ok: false, error: "Missing agentSessionId" }, { status: 400 });
  }

  const callbackSecret = cfg.linear.webhookSecret || cfg.linear.clientSecret;
  if (!callbackSecret) {
    return Response.json(
      { ok: false, error: "Callback signing secret is not configured" },
      { status: 500 }
    );
  }

  const authHeader = request.headers.get("authorization") || "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = bearerMatch ? bearerMatch[1].trim() : "";
  if (!token || !verifySessionCallbackToken({ agentSessionId, token, secret: callbackSecret })) {
    return Response.json(
      { ok: false, error: "Unauthorized session callback token" },
      { status: 401 }
    );
  }

  const existingSession = await store.getSession(agentSessionId);
  if (existingSession?.status === "stopped") {
    return Response.json(
      { ok: false, stopped: true, error: "Session has been stopped" },
      { status: 409 }
    );
  }

  const rawBody = await readBoundedBytes(request);
  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const allowedTypes = new Set(["thought", "action", "elicitation", "response", "error"]);
  const type = typeof payload?.type === "string" ? payload.type.trim() : "";
  if (!allowedTypes.has(type)) {
    return Response.json({ ok: false, error: `Invalid activity type "${type}"` }, { status: 400 });
  }

  let content;
  if (type === "action") {
    const actionName = typeof payload.action === "string" ? payload.action.trim() : "";
    if (!actionName) {
      return Response.json(
        { ok: false, error: "Action activity requires non-empty action" },
        { status: 400 }
      );
    }
    content = { type: "action", action: actionName };
    if (typeof payload.parameter === "string") content.parameter = payload.parameter;
    if (typeof payload.result === "string") content.result = payload.result;
  } else {
    const bodyText = typeof payload?.body === "string" ? payload.body.trim() : "";
    if (!bodyText) {
      return Response.json(
        { ok: false, error: `${type} activity requires non-empty body` },
        { status: 400 }
      );
    }
    content = { type, body: bodyText };
  }

  const prCandidateText = [
    typeof payload.prUrl === "string" ? payload.prUrl : "",
    Array.isArray(payload.externalUrls)
      ? payload.externalUrls.map((u) => u?.url).filter(Boolean).join("\n")
      : "",
    payload.body,
    payload.parameter,
    payload.result,
  ]
    .filter(Boolean)
    .join("\n");
  const extractedPrs = extractPullRequestUrls(prCandidateText);
  const urlAdditions = [
    ...(Array.isArray(payload.externalUrls) ? payload.externalUrls : []),
    ...extractedPrs.map((pr) => ({ label: `PR #${pr.prNumber}`, url: pr.url })),
  ];

  let mergedExternalUrls;
  const sessionPatch = {};
  if (urlAdditions.length > 0) {
    const baseUrls =
      Array.isArray(existingSession?.externalUrls) && existingSession.externalUrls.length > 0
        ? existingSession.externalUrls
        : existingSession?.agyConversationId
          ? [ANTIGRAVITY_EXTERNAL_URL]
          : [];
    mergedExternalUrls = mergeExternalUrls(baseUrls, urlAdditions);
    sessionPatch.externalUrls = mergedExternalUrls;
    if (extractedPrs.length > 0) {
      const latestPr = extractedPrs[extractedPrs.length - 1];
      sessionPatch.prUrl = latestPr.url;
      sessionPatch.prRepo = latestPr.repo;
      sessionPatch.prNumber = latestPr.prNumber;
    }
  }

  if (
    payload.plan !== undefined ||
    mergedExternalUrls !== undefined ||
    payload.summary !== undefined
  ) {
    await linearClient.updateAgentSession({
      id: agentSessionId,
      plan: payload.plan,
      externalUrls: mergedExternalUrls,
      summary: payload.summary,
    });
  }

  const act = await linearClient.createAgentActivity({
    agentSessionId,
    content,
    ephemeral: typeof payload.ephemeral === "boolean" ? payload.ephemeral : undefined,
  });

  const statusMap = {
    response: "complete",
    error: "error",
    elicitation: "awaiting_clarification",
    thought: "active",
    action: "active",
  };
  await store.upsertSession(agentSessionId, {
    ...sessionPatch,
    status: statusMap[type],
    lastActivityType: type,
  });

  return Response.json({
    ok: true,
    agentSessionId,
    type,
    agentActivityId: act?.agentActivity?.id || null,
  });
}

async function handleRunnerApi({ request, url, store, tokenStore, linearClient }) {
  const rawBody = await readBoundedBytes(request);
  let body = {};
  if (rawBody.length > 0) {
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
    }
  }

  if (url.pathname === "/api/runner/poll") {
    const runnerId = String(body.runnerId || "local-runner");
    await store.recordRunnerHeartbeat({
      runnerId,
      activeWatchers: Number(body.activeWatchers || 0),
      projectsCount: Number(body.projectsCount || 0),
    });

    const rawJobs = await store.claimJobs({
      runnerId,
      maxJobs: Number(body.maxJobs || 2),
    });
    const jobs = [];
    for (const job of rawJobs) {
      const session = await store.getSession(job.agentSessionId);
      jobs.push({ ...job, session });
    }

    const stopWatcherSessionIds = [];
    for (const sid of Array.isArray(body.activeSessionIds) ? body.activeSessionIds : []) {
      const s = await store.getSession(sid);
      if (!s || s.status !== "active") {
        stopWatcherSessionIds.push(sid);
      }
    }

    return Response.json({ ok: true, jobs, stopWatcherSessionIds });
  }

  const completeMatch = url.pathname.match(/^\/api\/runner\/jobs\/([^/]+)\/complete$/);
  if (completeMatch) {
    const jobId = decodeURIComponent(completeMatch[1]).trim();
    const agentSessionId = String(body.agentSessionId || "").trim();
    await store.completeJob(jobId, {
      status: body.status === "failed" ? "failed" : "completed",
      lastError: body.lastError || null,
    });

    let sessionStopped = false;
    if (agentSessionId) {
      const current = await store.getSession(agentSessionId);
      if (current?.status === "stopped") {
        sessionStopped = true;
        const newConv = body.sessionPatch?.agyConversationId;
        if (newConv && newConv !== current.agyConversationId) {
          await store.upsertSession(agentSessionId, {
            agyConversationId: newConv,
            status: "stopped",
          });
          await store.enqueueJob({
            agentSessionId,
            kind: "stop_session",
            payload: {
              agentSessionId,
              conversationId: newConv,
              issueIdentifier: current.issueIdentifier || "",
            },
          });
        }
      } else {
        if (body.sessionPatch && typeof body.sessionPatch === "object") {
          await store.upsertSession(agentSessionId, body.sessionPatch);
        }
        if (body.sessionUpdate && typeof body.sessionUpdate === "object") {
          await safeUpdateSession(linearClient, {
            id: agentSessionId,
            ...body.sessionUpdate,
          });
        }
        if (body.linearActivity && typeof body.linearActivity === "object") {
          await safeCreateActivity(linearClient, {
            agentSessionId,
            ...body.linearActivity,
          });
        }
      }
    }

    return Response.json({ ok: true, sessionStopped });
  }

  const proxyActMatch = url.pathname.match(/^\/api\/runner\/sessions\/([^/]+)\/activity$/);
  if (proxyActMatch) {
    const agentSessionId = decodeURIComponent(proxyActMatch[1]).trim();
    const current = await store.getSession(agentSessionId);
    if (current?.status === "stopped") {
      return Response.json(
        { ok: false, stopped: true, error: "Session has been stopped" },
        { status: 409 }
      );
    }

    if (body.sessionPatch && typeof body.sessionPatch === "object") {
      await store.upsertSession(agentSessionId, body.sessionPatch);
    }
    if (body.sessionUpdate && typeof body.sessionUpdate === "object") {
      await safeUpdateSession(linearClient, {
        id: agentSessionId,
        ...body.sessionUpdate,
      });
    }
    let agentActivityId = null;
    if (body.activity && typeof body.activity === "object") {
      const act = await linearClient.createAgentActivity({
        agentSessionId,
        content: body.activity.content,
        ephemeral: body.activity.ephemeral,
      });
      agentActivityId = act?.agentActivity?.id || null;
    }

    return Response.json({ ok: true, agentActivityId });
  }

  if (url.pathname === "/api/runner/bootstrap") {
    let tokenImported = false;
    if (body.token && typeof body.token === "object" && body.token.accessToken) {
      await tokenStore.save(body.token);
      tokenImported = true;
    }
    let sessionsImported = 0;
    const rawSessions = Array.isArray(body.sessions) ? body.sessions : [];
    for (const sess of rawSessions) {
      const sid = sess?.linearSessionId || sess?.agentSessionId;
      if (sid) {
        await store.upsertSession(sid, sess);
        sessionsImported += 1;
      }
    }
    return Response.json({ ok: true, tokenImported, sessionsImported });
  }

  return Response.json({ ok: false, error: "Unknown runner endpoint" }, { status: 404 });
}

async function safeCreateActivity(linearClient, args) {
  try {
    return await linearClient.createAgentActivity(args);
  } catch (err) {
    logError("edge_create_activity_failed", {
      agentSessionId: args.agentSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function safeUpdateSession(linearClient, args) {
  try {
    return await linearClient.updateAgentSession(args);
  } catch (err) {
    logError("edge_update_session_failed", {
      agentSessionId: args.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export default {
  fetch: createEdgeWorkerHandler(),
};
