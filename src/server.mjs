import http from "node:http";
import { getProjectsConfig } from "./config.mjs";
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  LinearTokenManager,
  OAuthStateStore,
} from "./linear-auth.mjs";
import { LinearClient } from "./linear-client.mjs";
import { RemoteAgentLauncher } from "./launcher.mjs";
import { EventDispatcher } from "./dispatcher.mjs";
import {
  extractPullRequestUrls,
  mergeExternalUrls,
  parseGitHubEvent,
  verifyGitHubWebhook,
} from "./github-webhook.mjs";
import { SessionStore, TokenStore } from "./store.mjs";
import { RemoteStreamWatcher } from "./watcher.mjs";
import {
  parseAgentSessionEvent,
  verifyLinearWebhook,
  verifySessionCallbackToken,
} from "./webhook.mjs";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(html);
}

function readRawBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        const err = new Error("Request body too large");
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Create the HTTP bridge server and its wired dependencies.
 */
export function createBridgeServer({
  config,
  logger = console,
  tokenStore = new TokenStore(config.paths.tokensFile),
  sessionStore = new SessionStore(config.paths.sessionsFile),
  tokenManager = new LinearTokenManager({
    linearConfig: config.linear,
    tokenStore,
  }),
  linearClient = new LinearClient({ tokenManager }),
  launcher = new RemoteAgentLauncher({ config }),
  watcher = new RemoteStreamWatcher({
    config,
    linearClient,
    sessionStore,
    logger,
  }),
  dispatcher = new EventDispatcher({
    config,
    linearClient,
    sessionStore,
    launcher,
    watcher,
    logger,
  }),
  stateStore = new OAuthStateStore(),
  exchangeCodeFn = exchangeAuthorizationCode,
}) {
  const seenGithubDeliveries = new Set();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          authConfigured: Boolean(config.linear.clientId && config.linear.clientSecret),
          webhookConfigured: Boolean(config.linear.webhookSecret),
          githubWebhookConfigured: Boolean(config.github?.webhookSecret),
          hasToken: Boolean(await tokenManager.hasToken()),
          sessionsCount: sessionStore.count(),
          projectsCount: getProjectsConfig(config).projects.length,
          activeWatchers: watcher.activeCount(),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/oauth/start") {
        if (!config.linear.clientId || !config.publicBaseUrl) {
          sendJson(res, 500, {
            ok: false,
            error: "LINEAR_CLIENT_ID and PUBLIC_BASE_URL must be configured first",
          });
          return;
        }
        const state = stateStore.create({ createdAt: Date.now() });
        const redirectUri = `${config.publicBaseUrl}/oauth/callback`;
        const authUrl = buildAuthorizeUrl({
          clientId: config.linear.clientId,
          redirectUri,
          scopes: config.linear.oauthScopes,
          state,
        });
        res.writeHead(302, { Location: authUrl });
        res.end();
        return;
      }

      if (req.method === "GET" && url.pathname === "/oauth/callback") {
        const oauthError = url.searchParams.get("error");
        if (oauthError) {
          const desc = url.searchParams.get("error_description") || oauthError;
          sendHtml(
            res,
            400,
            `<h1>Linear Authorization Failed</h1><p>${escapeHtml(desc)}</p>`
          );
          return;
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state || !stateStore.consume(state)) {
          sendHtml(
            res,
            400,
            "<h1>Invalid or Expired OAuth State</h1><p>Please revisit /oauth/start.</p>"
          );
          return;
        }

        const redirectUri = `${config.publicBaseUrl}/oauth/callback`;
        const tokenResp = await exchangeCodeFn({
          clientId: config.linear.clientId,
          clientSecret: config.linear.clientSecret,
          redirectUri,
          code,
        });
        await tokenManager.saveInitialOAuthToken(tokenResp);

        let viewerInfo = null;
        try {
          viewerInfo = await linearClient.getViewer();
        } catch (err) {
          logger.warn("[oauth] Viewer verification warning:", err.message);
        }

        const viewer = viewerInfo?.viewer;
        const org = viewerInfo?.organization;
        sendHtml(
          res,
          200,
          `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Linear Agent Installed</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 640px; margin: 48px auto; line-height: 1.6;">
  <h1>✅ Linear Agent Installed</h1>
  <ul>
    <li><strong>Workspace</strong>: ${escapeHtml(org?.name || org?.urlKey || "unknown")}</li>
    <li><strong>Agent Name</strong>: ${escapeHtml(viewer?.name || "unknown")}</li>
    <li><strong>Display Name</strong>: ${escapeHtml(viewer?.displayName || "unknown")}</li>
    <li><strong>App Actor</strong>: ${escapeHtml(String(viewer?.app ?? "unknown"))}</li>
    <li><strong>User ID</strong>: <code>${escapeHtml(viewer?.id || "unknown")}</code></li>
  </ul>
  <p>Token saved to <code>data/tokens.json</code> (mode 0600). You can now return to your terminal or mention/assign this Agent in Linear.</p>
</body>
</html>`
        );
        return;
      }

      if (
        req.method === "POST" &&
        (url.pathname === "/webhooks/linear" || url.pathname === "/oauth/callback/webhooks/linear")
      ) {
        const deliveryId = req.headers["linear-delivery"] || "-";
        const linearEventHeader = req.headers["linear-event"] || "-";
        const rawBody = await readRawBody(req);
        let payload;
        try {
          payload = JSON.parse(rawBody.toString("utf8"));
        } catch {
          logger.warn?.(
            `[webhook] 400 Invalid JSON path=${url.pathname} delivery=${deliveryId} event=${linearEventHeader}`
          );
          sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
          return;
        }

        const verification = verifyLinearWebhook({
          rawBody,
          signatureHeader: req.headers["linear-signature"],
          payload,
          webhookSecret: config.linear.webhookSecret,
          maxAgeMs: config.linear.webhookMaxAgeMs,
        });

        if (!verification.ok) {
          logger.warn?.(
            `[webhook] ${verification.status} rejected path=${url.pathname} reason="${verification.reason}" delivery=${deliveryId} event=${linearEventHeader}`
          );
          sendJson(res, verification.status, { ok: false, error: verification.reason });
          return;
        }

        const event = parseAgentSessionEvent(payload);
        logger.log?.(
          `[webhook] 200 accepted=${Boolean(event)} path=${url.pathname} type=${payload?.type || "-"} action=${payload?.action || "-"} session=${event?.agentSessionId || "-"} issue=${event?.issue?.identifier || "-"} delivery=${deliveryId}`
        );
        // Respond 200 immediately to obey Linear's 5-second webhook timeout.
        sendJson(res, 200, { ok: true, accepted: Boolean(event) });

        if (event) {
          setImmediate(() => {
            dispatcher.enqueue(event).catch((err) => {
              logger.error("[webhook] Unhandled dispatch error:", err);
            });
          });
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/webhooks/github") {
        const deliveryId = String(req.headers["x-github-delivery"] || "").trim();
        const eventName = String(req.headers["x-github-event"] || "").trim();
        const rawBody = await readRawBody(req);

        const verification = verifyGitHubWebhook({
          rawBody,
          signature256Header: req.headers["x-hub-signature-256"],
          webhookSecret: config.github?.webhookSecret,
        });

        if (!verification.ok) {
          logger.warn?.(
            `[github] ${verification.status} rejected event=${eventName || "-"} reason="${verification.reason}" delivery=${deliveryId || "-"}`
          );
          sendJson(res, verification.status, { ok: false, error: verification.reason });
          return;
        }

        let payload;
        try {
          payload = JSON.parse(rawBody.toString("utf8"));
        } catch {
          sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
          return;
        }

        if (deliveryId && seenGithubDeliveries.has(deliveryId)) {
          sendJson(res, 200, { ok: true, accepted: false, duplicate: true });
          return;
        }
        if (deliveryId) {
          seenGithubDeliveries.add(deliveryId);
          if (seenGithubDeliveries.size > 500) {
            const oldest = seenGithubDeliveries.values().next().value;
            if (oldest !== undefined) {
              seenGithubDeliveries.delete(oldest);
            }
          }
        }

        const ghEvent = parseGitHubEvent({
          eventName,
          deliveryId,
          payload,
          ignoredActors: config.github?.ignoredActors,
        });

        logger.log?.(
          `[github] 200 accepted=${Boolean(ghEvent)} event=${eventName || "-"} kind=${ghEvent?.kind || "-"} repo=${ghEvent?.repo || "-"} delivery=${deliveryId || "-"}`
        );
        sendJson(res, 200, { ok: true, accepted: Boolean(ghEvent), kind: ghEvent?.kind || null });

        if (ghEvent) {
          setImmediate(() => {
            dispatcher.handleGitHubEvent(ghEvent).catch((err) => {
              logger.error("[github] Unhandled event error:", err);
            });
          });
        }
        return;
      }

      if (req.method === "POST") {
        const activityMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/activity$/);
        if (activityMatch) {
          let agentSessionId = "";
          try {
            agentSessionId = decodeURIComponent(activityMatch[1]).trim();
          } catch {
            sendJson(res, 400, { ok: false, error: "Malformed agentSessionId in path" });
            return;
          }
          if (!agentSessionId) {
            sendJson(res, 400, { ok: false, error: "Missing agentSessionId in path" });
            return;
          }

          const callbackSecret = config.linear.webhookSecret || config.linear.clientSecret;
          if (!callbackSecret) {
            sendJson(res, 500, { ok: false, error: "Callback signing secret is not configured" });
            return;
          }

          const authHeader = String(req.headers.authorization || "");
          const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
          const token = bearerMatch ? bearerMatch[1].trim() : "";
          if (
            !token ||
            !verifySessionCallbackToken({ agentSessionId, token, secret: callbackSecret })
          ) {
            logger.warn?.(`[callback] 401 rejected session=${agentSessionId}`);
            sendJson(res, 401, { ok: false, error: "Unauthorized session callback token" });
            return;
          }

          const existingSession = sessionStore.get(agentSessionId);
          if (existingSession?.status === "stopped") {
            sendJson(res, 409, {
              ok: false,
              stopped: true,
              error: "Session has been stopped",
            });
            return;
          }

          const rawBody = await readRawBody(req);
          let payload;
          try {
            payload = JSON.parse(rawBody.toString("utf8"));
          } catch {
            sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
            return;
          }

          const allowedTypes = new Set(["thought", "action", "elicitation", "response", "error"]);
          const type = typeof payload?.type === "string" ? payload.type.trim() : "";
          if (!allowedTypes.has(type)) {
            sendJson(res, 400, {
              ok: false,
              error: `Invalid activity type "${type}"`,
            });
            return;
          }

          let content;
          if (type === "action") {
            const actionName = typeof payload.action === "string" ? payload.action.trim() : "";
            if (!actionName) {
              sendJson(res, 400, { ok: false, error: "Action activity requires non-empty action" });
              return;
            }
            content = { type: "action", action: actionName };
            if (typeof payload.parameter === "string") content.parameter = payload.parameter;
            if (typeof payload.result === "string") content.result = payload.result;
          } else {
            const bodyText = typeof payload?.body === "string" ? payload.body.trim() : "";
            if (!bodyText) {
              sendJson(res, 400, { ok: false, error: `${type} activity requires non-empty body` });
              return;
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
              Array.isArray(existingSession?.externalUrls) &&
              existingSession.externalUrls.length > 0
                ? existingSession.externalUrls
                : existingSession?.agyConversationId
                  ? [{ label: "Antigravity Remote", url: "https://antigravity.google.com" }]
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
          sessionStore.upsert(agentSessionId, {
            ...sessionPatch,
            status: statusMap[type],
            lastActivityType: type,
          });
          watcher?.noteExternalActivity(agentSessionId);
          if (type === "response" || type === "error") {
            watcher?.stop(agentSessionId);
          }

          const agentActivityId = act?.agentActivity?.id || null;
          logger.log?.(
            `[callback] 200 session=${agentSessionId} type=${type} activity=${agentActivityId || "-"}`
          );
          sendJson(res, 200, {
            ok: true,
            agentSessionId,
            type,
            agentActivityId,
          });
          return;
        }
      }

      if (
        req.method === "POST" ||
        req.headers["linear-delivery"] ||
        req.headers["linear-event"]
      ) {
        logger.warn?.(
          `[http] ${req.method} ${url.pathname} -> 404 (linear-event=${req.headers["linear-event"] || "-"}, linear-delivery=${req.headers["linear-delivery"] || "-"})`
        );
      }
      sendJson(res, 404, { ok: false, error: "Not found" });
    } catch (err) {
      const status = err?.statusCode || 500;
      logger.error("[server] Request error:", err);
      if (!res.headersSent) {
        sendJson(res, status, { ok: false, error: err.message });
      }
    }
  });

  return {
    server,
    dispatcher,
    watcher,
    tokenManager,
    linearClient,
    sessionStore,
  };
}
