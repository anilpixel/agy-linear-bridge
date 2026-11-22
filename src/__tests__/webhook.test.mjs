import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { parseAgentSessionEvent, verifyLinearWebhook } from "../webhook.mjs";

function sign(secret, body) {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

test("verifyLinearWebhook accepts valid HMAC-SHA256 signature and fresh timestamp", () => {
  const secret = "lin_wh_secret_123";
  const nowMs = 1_700_000_000_000;
  const payload = {
    type: "AgentSessionEvent",
    action: "created",
    webhookTimestamp: nowMs - 10_000,
    agentSession: { id: "ase-1" },
  };
  const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
  const signatureHeader = sign(secret, rawBody);

  const result = verifyLinearWebhook({
    rawBody,
    signatureHeader,
    payload,
    webhookSecret: secret,
    maxAgeMs: 300_000,
    nowMs,
  });
  assert.deepEqual(result, { ok: true });
});

test("verifyLinearWebhook rejects invalid, missing, and malformed signatures", () => {
  const secret = "lin_wh_secret_123";
  const rawBody = Buffer.from('{"hello":"world"}', "utf8");

  assert.equal(
    verifyLinearWebhook({
      rawBody,
      signatureHeader: "",
      payload: {},
      webhookSecret: secret,
    }).status,
    401
  );

  assert.equal(
    verifyLinearWebhook({
      rawBody,
      signatureHeader: "not-hex!",
      payload: {},
      webhookSecret: secret,
    }).status,
    401
  );

  assert.equal(
    verifyLinearWebhook({
      rawBody,
      signatureHeader: "deadbeef",
      payload: {},
      webhookSecret: secret,
    }).status,
    401
  );

  assert.equal(
    verifyLinearWebhook({
      rawBody,
      signatureHeader: sign("wrong_secret", rawBody),
      payload: {},
      webhookSecret: secret,
    }).status,
    401
  );
});

test("verifyLinearWebhook rejects stale webhook timestamps and missing secret", () => {
  const secret = "lin_wh_secret_123";
  const nowMs = 1_700_000_000_000;
  const payload = { webhookTimestamp: nowMs - 600_000 };
  const rawBody = Buffer.from(JSON.stringify(payload), "utf8");

  const stale = verifyLinearWebhook({
    rawBody,
    signatureHeader: sign(secret, rawBody),
    payload,
    webhookSecret: secret,
    maxAgeMs: 300_000,
    nowMs,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.status, 401);

  const noSecret = verifyLinearWebhook({
    rawBody,
    signatureHeader: sign(secret, rawBody),
    payload,
    webhookSecret: "",
  });
  assert.equal(noSecret.ok, false);
  assert.equal(noSecret.status, 500);
});

test("parseAgentSessionEvent parses created/prompted events and ignores unrelated payloads", () => {
  const created = parseAgentSessionEvent({
    type: "AgentSessionEvent",
    action: "created",
    organizationId: "org-1",
    appUserId: "app-usr-1",
    promptContext: "<issue><identifier>ENG-12</identifier></issue>",
    agentSession: {
      id: "ase-123",
      status: "pending",
      issue: { id: "iss-1", identifier: "ENG-12", title: "Fix auth" },
      comment: { id: "com-1", body: "@Agy please check" },
    },
  });

  assert.equal(created.agentSessionId, "ase-123");
  assert.equal(created.action, "created");
  assert.equal(created.issue.identifier, "ENG-12");

  const prompted = parseAgentSessionEvent({
    type: "AgentSessionEvent",
    action: "prompted",
    agentSession: {
      id: "ase-123",
      comment: { id: "com-2", body: "Also add unit tests" },
    },
  });
  assert.equal(prompted.action, "prompted");

  assert.equal(
    parseAgentSessionEvent({ type: "Issue", action: "update", data: { id: "iss-1" } }),
    null
  );
});

test("parseAgentSessionEvent detects stop signals and agentActivity prompt bodies", () => {
  const stopped = parseAgentSessionEvent({
    type: "AgentSessionEvent",
    action: "prompted",
    agentSession: {
      id: "ase-stop-1",
      issue: { id: "iss-1", identifier: "ENG-101" },
    },
    agentActivity: {
      id: "act-stop-1",
      type: "prompt",
      body: "Please stop",
      signal: "stop",
    },
  });

  assert.equal(stopped.agentSessionId, "ase-stop-1");
  assert.equal(stopped.signal, "stop");
  assert.equal(stopped.isStopSignal, true);
  assert.equal(stopped.promptBody, "Please stop");

  const actionStopped = parseAgentSessionEvent({
    type: "AgentSessionEvent",
    action: "stopped",
    agentSession: { id: "ase-stop-2" },
  });
  assert.equal(actionStopped.isStopSignal, true);

  const followUpFromContent = parseAgentSessionEvent({
    type: "AgentSessionEvent",
    action: "prompted",
    agentSession: { id: "ase-follow-1" },
    agentActivity: { content: { type: "prompt", body: "Continue with tests" } },
  });
  assert.equal(followUpFromContent.isStopSignal, false);
  assert.equal(followUpFromContent.promptBody, "Continue with tests");
});
