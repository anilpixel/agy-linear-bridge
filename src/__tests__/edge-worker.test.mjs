import assert from "node:assert/strict";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createEdgeWorkerHandler } from "../edge/worker.mjs";
import { EdgeRunner } from "../runner.mjs";

/**
 * Minimal Cloudflare D1-compatible adapter backed by Node's built-in `node:sqlite` (`DatabaseSync`).
 */
function createSqliteD1Binding() {
  const sqlite = new DatabaseSync(":memory:");

  class PreparedStatement {
    constructor(sql, boundValues = []) {
      this.sql = sql;
      this.boundValues = boundValues;
    }

    bind(...values) {
      for (const v of values) {
        if (v === undefined) {
          throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported");
        }
      }
      return new PreparedStatement(this.sql, values);
    }

    async first(colName) {
      const stmt = sqlite.prepare(this.sql);
      const row = stmt.get(...this.boundValues) ?? null;
      if (!row) return null;
      return colName ? row[colName] ?? null : row;
    }

    async all() {
      const stmt = sqlite.prepare(this.sql);
      const results = stmt.all(...this.boundValues);
      return { success: true, results, meta: {} };
    }

    async run() {
      const stmt = sqlite.prepare(this.sql);
      const info = stmt.run(...this.boundValues);
      return {
        success: true,
        meta: {
          changes: Number(info.changes || 0),
          last_row_id: Number(info.lastInsertRowid || 0),
        },
      };
    }
  }

  return {
    prepare(sql) {
      return new PreparedStatement(sql);
    },
    async batch(statements) {
      const out = [];
      sqlite.exec("BEGIN");
      try {
        for (const st of statements) {
          if (/^\s*SELECT\b/i.test(st.sql)) {
            out.push(await st.all());
          } else {
            out.push(await st.run());
          }
        }
        sqlite.exec("COMMIT");
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
      return out;
    },
  };
}

function signLinear(secret, rawBody) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

function signGitHub(secret, rawBody) {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

test("Cloudflare Edge Worker + D1 + Outbound EdgeRunner end-to-end: offline queueing, runner claim, watcher proxy, lid-closed callback, GitHub CI/Review loop, and stop signal", async () => {
  const db = createSqliteD1Binding();
  let nowMs = 1_760_000_000_000;
  const nowFn = () => nowMs;

  const env = {
    DB: db,
    PUBLIC_BASE_URL: "https://bridge.example.com",
    LINEAR_CLIENT_ID: "lin-cid",
    LINEAR_CLIENT_SECRET: "lin-csec",
    LINEAR_WEBHOOK_SECRET: "lin-wh-sec",
    GITHUB_WEBHOOK_SECRET: "gh-wh-sec",
    GITHUB_CI_AUTO_FIX: "true",
    GITHUB_REVIEW_AUTO_RESUME: "true",
    GITHUB_MAX_CI_FIX_ROUNDS: "1",
    RUNNER_SHARED_SECRET: "runner-super-secret",
  };

  const linearActivities = [];
  const linearSessionUpdates = [];

  // Mock external Linear GraphQL calls made by the Edge Worker
  const linearFetchMock = async (url, init) => {
    const u = String(url);
    if (u === "https://api.linear.app/graphql") {
      const { query, variables } = JSON.parse(init.body);
      if (query.includes("IssueContext")) {
        return Response.json({
          data: {
            issue: {
              id: variables.id,
              identifier: "ENG-500",
              title: "Optimize worker queue",
              url: "https://linear.app/acme-workspace/issue/ENG-500",
              branchName: "antigravity/eng-500-optimize-worker-queue",
              priorityLabel: "High",
              description: "Fix worker queue latency",
              team: { id: "t-1", key: "ENG", name: "Engineering" },
              project: { id: "lin-proj-1", name: "backend-app", slugId: "slug-backend-01" },
              labels: { nodes: [] },
              state: { name: "Todo", type: "unstarted" },
            },
          },
        });
      }
      if (query.includes("AgentActivityCreate")) {
        linearActivities.push(variables.input);
        return Response.json({
          data: {
            agentActivityCreate: {
              success: true,
              agentActivity: { id: `act-${linearActivities.length}` },
            },
          },
        });
      }
      if (query.includes("AgentSessionUpdate")) {
        linearSessionUpdates.push(variables);
        return Response.json({
          data: { agentSessionUpdate: { success: true, agentSession: { id: variables.id } } },
        });
      }
    }
    throw new Error(`Unexpected external fetch: ${u}`);
  };

  const backgroundPromises = [];
  const makeCtx = () => ({
    waitUntil(p) {
      backgroundPromises.push(p);
    },
  });
  const flushEdgeBackground = async () => {
    while (backgroundPromises.length > 0) {
      const batch = backgroundPromises.splice(0, backgroundPromises.length);
      await Promise.all(batch);
    }
  };

  const edgeHandler = createEdgeWorkerHandler({ fetchImpl: linearFetchMock, nowFn });
  const callEdge = async (path, init = {}) => {
    const req = new Request(`https://bridge.example.com${path}`, init);
    const res = await edgeHandler(req, env, makeCtx());
    await flushEdgeBackground();
    return res;
  };

  // 1) Seed token into D1 via /api/runner/bootstrap (rejects unauthorized first)
  const unauthBoot = await callEdge("/api/runner/bootstrap", {
    method: "POST",
    headers: { Authorization: "Bearer wrong" },
  });
  assert.equal(unauthBoot.status, 401);

  const bootRes = await callEdge("/api/runner/bootstrap", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer runner-super-secret",
    },
    body: JSON.stringify({
      token: {
        accessToken: "lin-app-access-token",
        refreshToken: "lin-app-refresh-token",
        expiresAt: nowMs + 3_600_000,
        authMode: "oauth",
      },
      sessions: [],
    }),
  });
  assert.equal(bootRes.status, 200);
  assert.deepEqual(await bootRes.json(), {
    ok: true,
    tokenImported: true,
    sessionsImported: 0,
  });

  // 2) Laptop is asleep (runner offline) -> Linear webhook arrives!
  const createdPayload = {
    type: "AgentSessionEvent",
    action: "created",
    webhookTimestamp: nowMs - 2_000,
    promptContext: '<issue identifier="ENG-500"><title>Optimize worker queue</title></issue>',
    agentSession: {
      id: "ase-edge-1",
      status: "pending",
      creator: { name: "Alice", displayName: "alice" },
      issue: { id: "iss-500", identifier: "ENG-500", title: "Optimize worker queue" },
    },
  };
  const createdRaw = Buffer.from(JSON.stringify(createdPayload), "utf8");
  const whRes = await callEdge("/webhooks/linear", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Linear-Delivery": "lin-del-1",
      "Linear-Signature": signLinear("lin-wh-sec", createdRaw),
    },
    body: createdRaw,
  });
  assert.equal(whRes.status, 200);

  // Duplicate webhook delivery ID is ignored cleanly
  const dupRes = await callEdge("/webhooks/linear", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Linear-Delivery": "lin-del-1",
      "Linear-Signature": signLinear("lin-wh-sec", createdRaw),
    },
    body: createdRaw,
  });
  assert.equal((await dupRes.json()).duplicate, true);

  // Linear got an immediate offline-aware thought within the 10s rule!
  assert.equal(linearActivities.length, 1);
  assert.equal(linearActivities[0].content.type, "thought");
  assert.match(linearActivities[0].content.body, /本地 Runner 当前离线或休眠/);

  const healthOffline = await (await callEdge("/health")).json();
  assert.equal(healthOffline.mode, "cloudflare-edge");
  assert.equal(healthOffline.hasToken, true);
  assert.equal(healthOffline.runnerOnline, false);
  assert.equal(healthOffline.pendingJobsCount, 1);

  // 3) Laptop wakes up -> Outbound EdgeRunner polls and launches `agy --remote-agent`
  const launches = [];
  const resumes = [];
  const cancels = [];
  const watcherStarts = [];
  const watcherStops = [];

  const runnerConfig = {
    edge: {
      baseUrl: "https://bridge.example.com",
      runnerSecret: "runner-super-secret",
      runnerId: "macbook-runner-1",
      pollIntervalMs: 1000,
    },
    router: { mode: "rules" },
    launcher: { remoteMode: "accept-edits", agyBin: "agy", maxConcurrentLaunches: 2 },
    workflow: { enabled: false },
    paths: {},
    projectsConfig: {
      defaultRemoteProject: "",
      defaultMode: "accept-edits",
      projects: [
        {
          key: "backend-app",
          name: "Backend App",
          githubRepo: "acme/backend-app",
          remoteProject: "remote-backend-uuid",
          linear: {
            projectIds: ["lin-proj-1"],
            projectSlugs: ["slug-backend-01"],
            projectNames: ["backend-app"],
            teamKeys: ["ENG"],
            labels: [],
          },
          extraInstructions: "Follow AGENTS.md",
        },
      ],
    },
  };

  let runnerRef = null;
  const mockWatcher = {
    activeCount() {
      return watcherStarts.length - watcherStops.length;
    },
    start(args) {
      watcherStarts.push(args);
    },
    stop(id) {
      watcherStops.push(id);
    },
    stopAll() {},
  };

  runnerRef = new EdgeRunner({
    config: runnerConfig,
    watcher: mockWatcher,
    launcher: {
      async launchNew(args) {
        launches.push(args);
        return {
          ok: true,
          conversationId: "conv-edge-500",
          aceUvmId: "uvm-500",
          logFile: "/tmp/edge.log",
        };
      },
      async resume(args) {
        resumes.push(args);
        return { ok: true, conversationId: args.conversationId, logFile: "/tmp/res.log" };
      },
      async cancel(args) {
        cancels.push(args);
        return { ok: true, wasRunning: true, cancelled: true, stillRunning: false };
      },
    },
    fetchImpl: (url, init) => callEdge(new URL(url).pathname, init),
    logger: { log() {}, warn() {}, error() {} },
  });

  const claimedCount = await runnerRef.pollOnce();
  assert.equal(claimedCount, 1);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].remoteProject, "remote-backend-uuid");
  assert.match(
    launches[0].prompt,
    /Suggested branch name: antigravity\/eng-500-optimize-worker-queue/
  );
  assert.match(
    launches[0].prompt,
    /https:\/\/bridge\.example\.com\/api\/sessions\/ase-edge-1\/activity/
  );
  assert.equal(watcherStarts.length, 1);
  assert.equal(watcherStarts[0].conversationId, "conv-edge-500");

  const healthOnline = await (await callEdge("/health")).json();
  assert.equal(healthOnline.runnerOnline, true);
  assert.equal(healthOnline.pendingJobsCount, 0);
  assert.equal(healthOnline.projectsCount, 1);

  // Watcher proxies status thoughts through Edge without local Linear token
  await runnerRef.linearProxy.createAgentActivity({
    agentSessionId: "ase-edge-1",
    content: { type: "thought", body: "🔄 云端执行中：Running vitest" },
    ephemeral: true,
  });
  assert.match(linearActivities.at(-1).content.body, /Running vitest/);

  // 4) Laptop closes lid again! Cloud ACE uVM finishes and posts callback directly to Cloudflare Edge!
  const cbMatch = launches[0].prompt.match(/Authorization: Bearer ([0-9a-f]+)/);
  assert.ok(cbMatch);
  const callbackToken = cbMatch[1];

  const cloudCbRes = await callEdge("/api/sessions/ase-edge-1/activity", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${callbackToken}`,
    },
    body: JSON.stringify({
      type: "response",
      body: "Optimized worker queue: https://github.com/acme/backend-app/pull/501",
    }),
  });
  assert.equal(cloudCbRes.status, 200);
  assert.equal(linearActivities.at(-1).content.type, "response");
  assert.deepEqual(linearSessionUpdates.at(-1).input.externalUrls, [
    { label: "Antigravity Remote", url: "https://antigravity.google.com" },
    { label: "PR #501", url: "https://github.com/acme/backend-app/pull/501" },
  ]);

  // Next Runner poll learns session completed on edge and stops local watcher
  await runnerRef.pollOnce();
  assert.ok(watcherStops.includes("ase-edge-1"));

  // 5) GitHub CI fails -> Edge enqueues github_feedback -> Runner resumes -> second failure hits maxCiFixRounds=1 on Edge!
  const postGitHub = async (eventName, deliveryId, payload) => {
    const raw = Buffer.from(JSON.stringify(payload), "utf8");
    return callEdge("/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": eventName,
        "X-GitHub-Delivery": deliveryId,
        "X-Hub-Signature-256": signGitHub("gh-wh-sec", raw),
      },
      body: raw,
    });
  };

  const ciRes1 = await postGitHub("check_run", "gh-del-1", {
    action: "completed",
    repository: { full_name: "acme/backend-app" },
    check_run: {
      name: "test-suite",
      conclusion: "failure",
      head_sha: "sha-ci-1",
      html_url: "https://github.com/acme/backend-app/runs/1",
      pull_requests: [{ number: 501, head: { ref: "antigravity/eng-500-optimize-worker-queue" } }],
    },
  });
  assert.equal(ciRes1.status, 200);
  const resumedJobs = await runnerRef.pollOnce();
  assert.equal(resumedJobs, 1);
  assert.equal(resumes.length, 1);
  assert.equal(resumes[0].conversationId, "conv-edge-500");

  // Second CI failure on new SHA hits maxCiFixRounds=1 directly on Edge -> sends elicitation
  await postGitHub("check_run", "gh-del-2", {
    action: "completed",
    repository: { full_name: "acme/backend-app" },
    check_run: {
      name: "test-suite",
      conclusion: "failure",
      head_sha: "sha-ci-2",
      html_url: "https://github.com/acme/backend-app/runs/2",
      pull_requests: [{ number: 501, head: { ref: "antigravity/eng-500-optimize-worker-queue" } }],
    },
  });
  assert.equal(linearActivities.at(-1).content.type, "elicitation");

  // 6) Linear stop signal -> Edge locks callback (409), confirms stop immediately, and Runner executes stop_session
  const stopPayload = {
    type: "AgentSessionEvent",
    action: "prompted",
    webhookTimestamp: nowMs,
    agentSession: {
      id: "ase-edge-1",
      issue: { id: "iss-500", identifier: "ENG-500" },
    },
    agentActivity: { id: "act-stop", type: "prompt", body: "Stop", signal: "stop" },
  };
  const stopRaw = Buffer.from(JSON.stringify(stopPayload), "utf8");
  const stopWhRes = await callEdge("/webhooks/linear", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Linear-Delivery": "lin-del-stop",
      "Linear-Signature": signLinear("lin-wh-sec", stopRaw),
    },
    body: stopRaw,
  });
  assert.equal(stopWhRes.status, 200);
  assert.equal(linearActivities.at(-1).content.type, "response");
  assert.match(linearActivities.at(-1).content.body, /已收到 Linear 停止信号/);

  const lateCb = await callEdge("/api/sessions/ase-edge-1/activity", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${callbackToken}`,
    },
    body: JSON.stringify({ type: "thought", body: "Should be blocked" }),
  });
  assert.equal(lateCb.status, 409);

  const stopJobCount = await runnerRef.pollOnce();
  assert.equal(stopJobCount, 1);
  assert.equal(cancels.length, 1);
  assert.equal(cancels[0].conversationId, "conv-edge-500");
});
