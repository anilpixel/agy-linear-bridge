import crypto from "node:crypto";

/**
 * Verify Linear HMAC-SHA256 webhook signature and optional replay window.
 */
export function verifyLinearWebhook({
  rawBody,
  signatureHeader,
  payload,
  webhookSecret,
  maxAgeMs = 300_000,
  nowMs = Date.now(),
}) {
  if (!webhookSecret) {
    return { ok: false, status: 500, reason: "LINEAR_WEBHOOK_SECRET is not configured" };
  }

  const sig = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!sig || typeof sig !== "string") {
    return { ok: false, status: 401, reason: "Missing Linear-Signature header" };
  }

  const cleanSig = sig.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(cleanSig) || cleanSig.length % 2 !== 0) {
    return { ok: false, status: 401, reason: "Malformed Linear-Signature header" };
  }

  const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""), "utf8");
  const expectedHex = crypto
    .createHmac("sha256", webhookSecret)
    .update(bodyBuffer)
    .digest("hex");

  const sigBuf = Buffer.from(cleanSig, "hex");
  const expectedBuf = Buffer.from(expectedHex, "hex");
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return { ok: false, status: 401, reason: "Invalid Linear-Signature" };
  }

  if (maxAgeMs > 0 && payload && payload.webhookTimestamp !== undefined) {
    const ts = Number(payload.webhookTimestamp);
    if (!Number.isFinite(ts) || Math.abs(nowMs - ts) > maxAgeMs) {
      return { ok: false, status: 401, reason: "Webhook timestamp outside allowed window" };
    }
  }

  return { ok: true };
}

export function isLinearThreadPlaceholder(text) {
  return /^\s*This thread is for an agent session with\b/i.test(String(text || ""));
}

/**
 * Parse a Linear webhook payload into a normalized AgentSessionEvent when applicable.
 */
export function parseAgentSessionEvent(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const action = String(payload.action || "created");
  const isAgentSession =
    payload.type === "AgentSessionEvent" ||
    (payload.agentSession &&
      (action === "created" ||
        action === "prompted" ||
        action === "stopped" ||
        action === "cancelled"));

  if (!isAgentSession || !payload.agentSession?.id) {
    return null;
  }

  const session = payload.agentSession;
  const agentActivity = payload.agentActivity || null;
  const rawSignal =
    typeof agentActivity?.signal === "string"
      ? agentActivity.signal
      : typeof payload.signal === "string"
        ? payload.signal
        : "";
  const signal = rawSignal ? rawSignal.trim().toLowerCase() : null;
  const isStopSignal = Boolean(
    signal === "stop" || action === "stopped" || action === "cancelled"
  );
  const activityBody =
    [agentActivity?.body, agentActivity?.content?.body]
      .find((v) => typeof v === "string" && v.trim())
      ?.trim() || "";
  const rawCommentBody =
    typeof session.comment?.body === "string" ? session.comment.body.trim() : "";
  const commentBody = isLinearThreadPlaceholder(rawCommentBody) ? "" : rawCommentBody;
  const promptBody = activityBody || commentBody;

  return {
    type: payload.type || "AgentSessionEvent",
    action,
    agentSessionId: String(session.id),
    status: session.status || null,
    issue: session.issue || null,
    comment: session.comment || null,
    agentActivity,
    signal,
    isStopSignal,
    promptBody,
    creator: session.creator || null,
    promptContext: typeof payload.promptContext === "string" ? payload.promptContext : "",
    guidance: payload.guidance || null,
    appUserId: payload.appUserId || null,
    organizationId: payload.organizationId || null,
  };
}

/**
 * Derive a per-session HMAC bearer token so a Remote Agent can post Linear AgentActivity updates.
 */
export function createSessionCallbackToken({ agentSessionId, secret }) {
  if (!agentSessionId || !secret) {
    throw new Error("agentSessionId and secret are required for session callback token");
  }
  return crypto
    .createHmac("sha256", String(secret))
    .update(`session-callback:v1:${String(agentSessionId)}`)
    .digest("hex");
}

/**
 * Constant-time verification of a per-session callback bearer token.
 */
export function verifySessionCallbackToken({ agentSessionId, token, secret }) {
  if (!agentSessionId || !secret || typeof token !== "string") {
    return false;
  }
  const clean = token.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(clean) || clean.length % 2 !== 0) {
    return false;
  }
  const expected = createSessionCallbackToken({ agentSessionId, secret });
  const tokenBuf = Buffer.from(clean, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  return (
    tokenBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(tokenBuf, expectedBuf)
  );
}
