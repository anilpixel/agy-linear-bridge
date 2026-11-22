import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  extractIssueIdentifiers,
  extractPullRequestUrls,
  parseGitHubEvent,
  verifyGitHubWebhook,
} from "../github-webhook.mjs";
import { createBridgeServer } from "../server.mjs";
import { SessionStore } from "../store.mjs";

function signGitHub(secret, rawBody) {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

test("verifyGitHubWebhook checks HMAC-SHA256 signature and secret presence", () => {
  const secret = "gh_wh_secret_abc";
  const body = Buffer.from(JSON.stringify({ hello: "world" }), "utf8");

  assert.deepEqual(
    verifyGitHubWebhook({
      rawBody: body,
      signature256Header: signGitHub(secret, body),
      webhookSecret: secret,
    }),
    { ok: true }
  );
  assert.equal(
    verifyGitHubWebhook({ rawBody: body, signature256Header: "", webhookSecret: secret }).status,
    401
  );
  assert.equal(
    verifyGitHubWebhook({
      rawBody: body,
      signature256Header: "sha256=nothex",
      webhookSecret: secret,
    }).status,
    401
  );
  assert.equal(
    verifyGitHubWebhook({
      rawBody: body,
      signature256Header: signGitHub("wrong", body),
      webhookSecret: secret,
    }).status,
    401
  );
  assert.equal(
    verifyGitHubWebhook({ rawBody: body, signature256Header: "", webhookSecret: "" }).status,
    500
  );
});

test("extractPullRequestUrls and extractIssueIdentifiers normalize and deduplicate cleanly", () => {
  const prs = extractPullRequestUrls(
    "Opened https://github.com/acme/backend-app/pull/42/files). Also check https://github.com/acme/backend-app/pull/42 and https://github.com/acme/mobile-app/pull/7!"
  );
  assert.deepEqual(prs, [
    {
      url: "https://github.com/acme/backend-app/pull/42",
      repo: "acme/backend-app",
      prNumber: 42,
    },
    {
      url: "https://github.com/acme/mobile-app/pull/7",
      repo: "acme/mobile-app",
      prNumber: 7,
    },
  ]);

  assert.deepEqual(
    extractIssueIdentifiers("Fix utf-8 bug for ENG-101 and MOB-9 (ENG-101)"),
    ["ENG-101", "MOB-9"]
  );
});

test("parseGitHubEvent normalizes pull_request, check_run, workflow_run, review, and review comments while filtering bots", () => {
  const prEvt = parseGitHubEvent({
    eventName: "pull_request",
    deliveryId: "del-pr-1",
    payload: {
      action: "opened",
      repository: { full_name: "acme/backend-app" },
      pull_request: {
        number: 128,
        html_url: "https://github.com/acme/backend-app/pull/128",
        title: "perf(ENG-101): optimize outbound concurrency",
        body: "Fixes ENG-101",
        head: { ref: "antigravity/eng-101-opt", sha: "sha-1" },
      },
    },
  });
  assert.equal(prEvt.kind, "pr_sync");
  assert.equal(prEvt.prNumber, 128);
  assert.deepEqual(prEvt.issueIdentifiers, ["ENG-101"]);

  const checkFail = parseGitHubEvent({
    eventName: "check_run",
    deliveryId: "del-ci-1",
    payload: {
      action: "completed",
      repository: { full_name: "acme/backend-app" },
      check_run: {
        name: "vitest",
        conclusion: "failure",
        head_sha: "sha-fail-1",
        html_url: "https://github.com/acme/backend-app/runs/99",
        pull_requests: [{ number: 128, head: { ref: "antigravity/eng-101-opt" } }],
        output: { title: "2 specs failed", summary: "timeout in batch write test" },
      },
    },
  });
  assert.equal(checkFail.kind, "ci_failure");
  assert.deepEqual(checkFail.prNumbers, [128]);
  assert.match(checkFail.summary, /2 specs failed/);

  const wfFail = parseGitHubEvent({
    eventName: "workflow_run",
    deliveryId: "del-wf-1",
    payload: {
      action: "completed",
      repository: { full_name: "acme/backend-app" },
      workflow_run: {
        name: "CI",
        conclusion: "timed_out",
        head_branch: "antigravity/eng-101-opt",
        head_sha: "sha-wf-1",
        html_url: "https://github.com/acme/backend-app/actions/runs/55",
        pull_requests: [{ number: 128 }],
      },
    },
  });
  assert.equal(wfFail.kind, "ci_failure");
  assert.equal(wfFail.source, "workflow_run");

  assert.equal(
    parseGitHubEvent({
      eventName: "pull_request_review",
      payload: {
        action: "submitted",
        repository: { full_name: "acme/backend-app" },
        pull_request: { number: 128, head: { ref: "b" } },
        review: { state: "approved", user: { login: "alice", type: "User" } },
      },
    }),
    null
  );

  assert.equal(
    parseGitHubEvent({
      eventName: "pull_request_review",
      payload: {
        action: "submitted",
        repository: { full_name: "acme/backend-app" },
        pull_request: { number: 128, head: { ref: "b" } },
        review: {
          state: "changes_requested",
          body: "Automated lint note",
          user: { login: "copilot-pull-request-reviewer", type: "User" },
        },
      },
      ignoredActors: ["copilot-pull-request-reviewer"],
    }),
    null
  );

  const reviewComment = parseGitHubEvent({
    eventName: "pull_request_review_comment",
    deliveryId: "del-rc-1",
    payload: {
      action: "created",
      repository: { full_name: "acme/backend-app" },
      pull_request: {
        number: 128,
        html_url: "https://github.com/acme/backend-app/pull/128",
        head: { ref: "antigravity/eng-101-opt" },
      },
      comment: {
        body: "Please avoid unbounded concurrency here",
        path: "packages/backend/src/outbound.ts",
        line: 84,
        html_url: "https://github.com/acme/backend-app/pull/128#discussion_r1",
        user: { login: "alice", type: "User" },
      },
    },
  });
  assert.equal(reviewComment.kind, "pr_review_comment");
  assert.equal(reviewComment.line, 84);
});

test("POST /webhooks/github attaches PR externalUrls, enforces CI dedupe/round cap, resumes on review, and ignores stopped sessions", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-gh-e2e-"));
  let server = null;
  try {
    const activities = [];
    const sessionUpdates = [];
    const resumes = [];
    const watcherStarts = [];

    const config = {
      publicBaseUrl: "https://bridge.example.com",
      linear: { webhookSecret: "lin-sec" },
      github: {
        webhookSecret: "gh-sec-123",
        ciAutoFix: true,
        reviewAutoResume: true,
        maxCiFixRounds: 3,
        ignoredActors: [],
      },
      router: { mode: "rules" },
      launcher: { remoteMode: "accept-edits", agyBin: "agy", pythonBin: "python3" },
      paths: {
        logsDir: tmpDir,
        tokensFile: path.join(tmpDir, "tokens.json"),
        sessionsFile: path.join(tmpDir, "sessions.json"),
      },
      projectsConfig: { defaultRemoteProject: "", projects: [] },
    };

    const sessionStore = new SessionStore(config.paths.sessionsFile);
    sessionStore.upsert("ase-gh-1", {
      issueIdentifier: "ENG-101",
      githubRepo: "acme/backend-app",
      suggestedBranchName: "antigravity/eng-101-opt",
      agyConversationId: "conv-gh-1",
      workflowPolicy: { maxCiFixRounds: 1 },
      externalUrls: [{ label: "Antigravity Remote", url: "https://antigravity.google.com" }],
      status: "complete",
    });

    const linearClient = {
      async createAgentActivity(payload) {
        activities.push(payload);
        return { success: true, agentActivity: { id: `act-${activities.length}` } };
      },
      async updateAgentSession(payload) {
        sessionUpdates.push(payload);
        return { success: true };
      },
    };
    const launcher = {
      async resume(args) {
        resumes.push(args);
        return { ok: true, conversationId: args.conversationId };
      },
    };
    const watcher = {
      activeCount() {
        return 0;
      },
      start(args) {
        watcherStarts.push(args);
      },
      stop() {},
      noteExternalActivity() {},
    };

    const created = createBridgeServer({
      config,
      linearClient,
      sessionStore,
      launcher,
      watcher,
      logger: { log() {}, warn() {}, error() {} },
    });
    server = created.server;
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const baseUrl = `http://127.0.0.1:${port}`;

    const postGh = async (eventName, deliveryId, payload, overrideSig = null) => {
      const raw = Buffer.from(JSON.stringify(payload), "utf8");
      const res = await fetch(`${baseUrl}/webhooks/github`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Event": eventName,
          "X-GitHub-Delivery": deliveryId,
          "X-Hub-Signature-256": overrideSig ?? signGitHub("gh-sec-123", raw),
        },
        body: raw,
      });
      return { status: res.status, json: await res.json() };
    };

    // Invalid signature -> 401
    const badSig = await postGh("ping", "del-bad", {}, signGitHub("wrong", Buffer.from("{}")));
    assert.equal(badSig.status, 401);

    // 1) PR opened -> attaches externalUrls
    const prSyncRes = await postGh("pull_request", "del-1", {
      action: "opened",
      repository: { full_name: "acme/backend-app" },
      pull_request: {
        number: 128,
        html_url: "https://github.com/acme/backend-app/pull/128",
        title: "perf: ENG-101",
        head: { ref: "antigravity/eng-101-opt", sha: "sha-0" },
      },
    });
    assert.equal(prSyncRes.status, 200);
    assert.equal(prSyncRes.json.kind, "pr_sync");
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(sessionStore.get("ase-gh-1").prNumber, 128);
    assert.deepEqual(sessionUpdates.at(-1).externalUrls, [
      { label: "Antigravity Remote", url: "https://antigravity.google.com" },
      { label: "PR #128", url: "https://github.com/acme/backend-app/pull/128" },
    ]);

    // 2) Review comment -> resumes remote conversation + starts watcher
    const reviewRes = await postGh("pull_request_review_comment", "del-2", {
      action: "created",
      repository: { full_name: "acme/backend-app" },
      pull_request: {
        number: 128,
        html_url: "https://github.com/acme/backend-app/pull/128",
        head: { ref: "antigravity/eng-101-opt" },
      },
      comment: {
        body: "Use per-entity key queue here",
        path: "outbound.ts",
        line: 42,
        html_url: "https://github.com/acme/backend-app/pull/128#discussion_r2",
        user: { login: "alice", type: "User" },
      },
    });
    assert.equal(reviewRes.status, 200);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(resumes.length, 1);
    assert.match(resumes[0].prompt, /Use per-entity key queue here/);
    assert.match(resumes[0].prompt, /outbound\.ts:42/);
    assert.equal(watcherStarts.length, 1);

    // 3) First CI failure -> resumes round 1 of maxCiFixRounds=1
    const ci1 = await postGh("check_run", "del-3", {
      action: "completed",
      repository: { full_name: "acme/backend-app" },
      check_run: {
        name: "unit-tests",
        conclusion: "failure",
        head_sha: "sha-fail-1",
        html_url: "https://github.com/acme/backend-app/runs/100",
        pull_requests: [{ number: 128, head: { ref: "antigravity/eng-101-opt" } }],
      },
    });
    assert.equal(ci1.status, 200);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(resumes.length, 2);
    assert.equal(sessionStore.get("ase-gh-1").ciFixAttempts, 1);

    // Duplicate head_sha in new delivery -> skipped
    await postGh("check_run", "del-4", {
      action: "completed",
      repository: { full_name: "acme/backend-app" },
      check_run: {
        name: "lint",
        conclusion: "failure",
        head_sha: "sha-fail-1",
        pull_requests: [{ number: 128, head: { ref: "antigravity/eng-101-opt" } }],
      },
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(resumes.length, 2);

    // 4) Second CI failure with new SHA -> hits maxCiFixRounds=1 circuit breaker -> elicitation
    await postGh("check_run", "del-5", {
      action: "completed",
      repository: { full_name: "acme/backend-app" },
      check_run: {
        name: "unit-tests",
        conclusion: "failure",
        head_sha: "sha-fail-2",
        html_url: "https://github.com/acme/backend-app/runs/101",
        pull_requests: [{ number: 128, head: { ref: "antigravity/eng-101-opt" } }],
      },
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(resumes.length, 2);
    assert.equal(activities.at(-1).content.type, "elicitation");
    assert.equal(sessionStore.get("ase-gh-1").status, "awaiting_clarification");

    // 5) Stopped session ignores subsequent GitHub events
    sessionStore.upsert("ase-gh-1", { status: "stopped" });
    await postGh("pull_request_review", "del-6", {
      action: "submitted",
      repository: { full_name: "acme/backend-app" },
      pull_request: {
        number: 128,
        html_url: "https://github.com/acme/backend-app/pull/128",
        head: { ref: "antigravity/eng-101-opt" },
      },
      review: {
        state: "changes_requested",
        body: "Should be ignored because stopped",
        user: { login: "alice", type: "User" },
      },
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(resumes.length, 2);
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
