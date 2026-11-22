import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getProjectsConfig, loadConfig } from "../config.mjs";
import { EventDispatcher } from "../dispatcher.mjs";
import { buildDispatchPrompt, buildFollowUpPrompt } from "../launcher.mjs";
import { LinearClient } from "../linear-client.mjs";
import { createBridgeServer } from "../server.mjs";
import { SessionStore } from "../store.mjs";
import { createSessionCallbackToken } from "../webhook.mjs";

function makeBaseConfig(tmpDir) {
  return {
    router: { mode: "hybrid", model: "gemini-3.8-flash-medium" },
    launcher: { remoteMode: "accept-edits", agyBin: "agy" },
    paths: { logsDir: tmpDir },
    projectsConfig: {
      defaultRemoteProject: "default-proj",
      defaultMode: "accept-edits",
      projects: [
        {
          key: "backend-app",
          name: "Backend App",
          description: "Backend App",
          remoteProject: "remote-backend-uuid",
          linear: {
            projectIds: ["lin-proj-1"],
            projectSlugs: ["slug-backend-01"],
            projectNames: ["backend-app"],
            teamKeys: ["ENG"],
            labels: [],
          },
          extraInstructions: "Keep AGENTS.md rules",
        },
      ],
    },
  };
}

test("EventDispatcher ACKs immediately, launches new session, persists conversationId, and resumes on prompted", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dispatch-"));
  try {
    const activities = [];
    const sessionUpdates = [];
    const launches = [];
    const resumes = [];

    const linearClient = {
      async getIssueContext(id) {
        return {
          id,
          identifier: "ENG-900",
          title: "Add webhook bridge",
          url: "https://linear.app/acme-workspace/issue/ENG-900",
          description: "Implement bridge",
          team: { key: "ENG" },
          project: { id: "lin-proj-1", name: "backend-app", slugId: "slug-backend-01" },
          labels: { nodes: [] },
          state: { name: "Todo", type: "unstarted" },
        };
      },
      async createAgentActivity(payload) {
        activities.push(payload);
        return { success: true };
      },
      async updateAgentSession(payload) {
        sessionUpdates.push(payload);
        return { success: true };
      },
    };

    const launcher = {
      async launchNew(args) {
        launches.push(args);
        return {
          ok: true,
          conversationId: "conv-cloud-abc",
          localProxyId: "proxy-1",
          logFile: "/tmp/agy.log",
        };
      },
      async resume(args) {
        resumes.push(args);
        return {
          ok: true,
          conversationId: args.conversationId,
          logFile: "/tmp/agy-resume.log",
        };
      },
    };

    const sessionStore = new SessionStore(path.join(tmpDir, "sessions.json"));
    const dispatcher = new EventDispatcher({
      config: makeBaseConfig(tmpDir),
      linearClient,
      sessionStore,
      launcher,
      logger: { warn() {}, error() {} },
    });

    await dispatcher.enqueue({
      type: "AgentSessionEvent",
      action: "created",
      agentSessionId: "ase-900",
      issue: { id: "iss-900", identifier: "ENG-900", title: "Add webhook bridge" },
      promptContext: "<issue>ENG-900</issue>",
    });

    assert.equal(launches.length, 1);
    assert.equal(launches[0].remoteProject, "remote-backend-uuid");
    assert.match(launches[0].prompt, /linear issue comment add ENG-900/);
    assert.equal(activities[0].content.type, "thought");
    assert.equal(activities[0].ephemeral, true);
    assert.equal(activities[1].content.type, "response");
    assert.match(activities[1].content.body, /conv-cloud-abc/);
    assert.equal(sessionUpdates.length, 1);
    assert.equal(sessionStore.get("ase-900").agyConversationId, "conv-cloud-abc");

    await dispatcher.enqueue({
      type: "AgentSessionEvent",
      action: "prompted",
      agentSessionId: "ase-900",
      issue: { id: "iss-900", identifier: "ENG-900" },
      comment: { body: "@Agy please also update README" },
      promptContext: "",
    });

    assert.equal(resumes.length, 1);
    assert.equal(resumes[0].conversationId, "conv-cloud-abc");
    assert.match(resumes[0].prompt, /please also update README/);
    assert.equal(sessionStore.get("ase-900").status, "resumed");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("EventDispatcher sends elicitation when router returns elicit and error activity on failure", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-dispatch-err-"));
  try {
    const activities = [];
    const linearClient = {
      async getIssueContext() {
        return { id: "iss-1", identifier: "OPS-1", title: "Ambiguous" };
      },
      async createAgentActivity(payload) {
        activities.push(payload);
        return { success: true };
      },
      async updateAgentSession() {
        return { success: true };
      },
    };

    const sessionStore = new SessionStore(path.join(tmpDir, "sessions.json"));
    const dispatcher = new EventDispatcher({
      config: makeBaseConfig(tmpDir),
      linearClient,
      sessionStore,
      launcher: {
        async launchNew() {
          throw new Error("PTY failed");
        },
      },
      routeIssueFn: async () => ({
        action: "elicit",
        clarifyingQuestion: "请先确认是哪个项目？",
      }),
      logger: { warn() {}, error() {} },
    });

    await dispatcher.enqueue({
      type: "AgentSessionEvent",
      action: "created",
      agentSessionId: "ase-elicit",
      issue: { id: "iss-1", identifier: "OPS-1" },
    });
    assert.equal(activities[1].content.type, "elicitation");
    assert.equal(sessionStore.get("ase-elicit").status, "awaiting_clarification");

    const dispatcherFail = new EventDispatcher({
      config: makeBaseConfig(tmpDir),
      linearClient,
      sessionStore,
      launcher: {
        async launchNew() {
          throw new Error("PTY crashed");
        },
      },
      routeIssueFn: async () => ({
        action: "dispatch",
        project: { key: "backend-app", name: "Backend App", remoteProject: "remote-1" },
        remoteProject: "remote-1",
        matchedBy: "projectName",
      }),
      logger: { warn() {}, error() {} },
    });

    await dispatcherFail.enqueue({
      type: "AgentSessionEvent",
      action: "created",
      agentSessionId: "ase-fail",
      issue: { id: "iss-2", identifier: "ENG-2" },
    });
    assert.equal(activities.at(-1).content.type, "error");
    assert.match(activities.at(-1).content.body, /PTY crashed/);
    assert.equal(sessionStore.get("ase-fail").status, "error");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("loadConfig strips accidental webhook/callback suffixes from PUBLIC_BASE_URL", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cfg-"));
  try {
    fs.mkdirSync(path.join(tmpDir, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, ".env"),
      "PUBLIC_BASE_URL='https://bridge.example.com/oauth/callback/'\n",
      "utf8"
    );
    const cfg1 = loadConfig(tmpDir, {});
    assert.equal(cfg1.publicBaseUrl, "https://bridge.example.com");

    const cfg2 = loadConfig(tmpDir, {
      PUBLIC_BASE_URL: "https://bridge.example.com/webhooks/linear",
    });
    assert.equal(cfg2.publicBaseUrl, "https://bridge.example.com");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("EventDispatcher hot-reloads modified config/projects.json via getProjectsConfig without restarting", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hotreload-"));
  try {
    const configDir = path.join(tmpDir, "config");
    fs.mkdirSync(configDir, { recursive: true });
    const projectsFile = path.join(configDir, "projects.json");
    fs.writeFileSync(
      projectsFile,
      JSON.stringify({
        defaultRemoteProject: "",
        defaultMode: "accept-edits",
        projects: [
          {
            key: "proj-a",
            name: "Proj A",
            remoteProject: "remote-a-1",
            linear: { projectIds: [], projectSlugs: [], projectNames: ["Proj A"], teamKeys: [], labels: [] },
          },
        ],
      }),
      "utf8"
    );

    const cfg = loadConfig(tmpDir, {});
    assert.equal(getProjectsConfig(cfg).projects[0].remoteProject, "remote-a-1");

    const launches = [];
    const linearClient = {
      async getIssueContext(id) {
        return {
          id,
          identifier: "OPS-201",
          title: "Hot reload test",
          project: { name: "Proj B" },
          labels: { nodes: [] },
        };
      },
      async createAgentActivity() {
        return { success: true };
      },
      async updateAgentSession() {
        return { success: true };
      },
    };
    const launcher = {
      async launchNew(args) {
        launches.push(args);
        return { ok: true, conversationId: "conv-b", logFile: "/tmp/b.log" };
      },
    };
    const sessionStore = new SessionStore(path.join(tmpDir, "sessions.json"));
    const dispatcher = new EventDispatcher({
      config: cfg,
      linearClient,
      sessionStore,
      launcher,
      logger: { warn() {}, error() {} },
    });

    // Update projects.json on disk after EventDispatcher was already constructed
    fs.writeFileSync(
      projectsFile,
      JSON.stringify({
        defaultRemoteProject: "",
        defaultMode: "accept-edits",
        projects: [
          {
            key: "proj-b",
            name: "Proj B",
            remoteProject: "remote-b-uuid",
            linear: { projectIds: [], projectSlugs: [], projectNames: ["Proj B"], teamKeys: [], labels: [] },
          },
        ],
      }),
      "utf8"
    );

    await dispatcher.enqueue({
      type: "AgentSessionEvent",
      action: "created",
      agentSessionId: "ase-hot-1",
      issue: { id: "iss-hot-1", identifier: "OPS-201", title: "Hot reload test" },
    });

    assert.equal(launches.length, 1);
    assert.equal(launches[0].remoteProject, "remote-b-uuid");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("EventDispatcher handoff mode keeps session active via thought and callback API updates Linear & SessionStore", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-handoff-"));
  const serverHolder = { server: null };
  try {
    const config = {
      ...makeBaseConfig(tmpDir),
      publicBaseUrl: "https://bridge.example.com",
      linear: {
        clientId: "cid",
        clientSecret: "csec",
        webhookSecret: "test-wh-secret",
        oauthScopes: ["read", "write"],
        authMode: "oauth",
        webhookMaxAgeMs: 300_000,
      },
      paths: {
        logsDir: tmpDir,
        tokensFile: path.join(tmpDir, "tokens.json"),
        sessionsFile: path.join(tmpDir, "sessions.json"),
      },
    };

    const activities = [];
    const sessionUpdates = [];
    const launches = [];
    const resumes = [];
    const linearClient = {
      async getIssueContext(id) {
        return {
          id,
          identifier: "ENG-101",
          title: "Test handoff",
          url: "https://linear.app/acme-workspace/issue/ENG-101",
          description: "Test description",
          team: { key: "ENG" },
          project: { id: "lin-proj-1", name: "backend-app", slugId: "slug-backend-01" },
          labels: { nodes: [] },
          state: { name: "Todo", type: "unstarted" },
        };
      },
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
      async launchNew(args) {
        launches.push(args);
        return {
          ok: true,
          conversationId: "conv-cloud-handoff",
          localProxyId: "proxy-handoff",
          aceUvmId: "uvm-123",
          resolvedRemoteProjectName: "backend-app",
          logFile: "/tmp/handoff.log",
        };
      },
      async resume(args) {
        resumes.push(args);
        return {
          ok: true,
          conversationId: args.conversationId,
          logFile: "/tmp/handoff-resume.log",
        };
      },
    };

    const sessionStore = new SessionStore(config.paths.sessionsFile);
    const { server } = createBridgeServer({
      config,
      linearClient,
      sessionStore,
      launcher,
      logger: { log() {}, warn() {}, error() {} },
    });
    serverHolder.server = server;
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const baseLocal = `http://127.0.0.1:${port}`;

    const dispatcher = new EventDispatcher({
      config,
      linearClient,
      sessionStore,
      launcher,
      logger: { log() {}, warn() {}, error() {} },
    });

    await dispatcher.enqueue({
      type: "AgentSessionEvent",
      action: "created",
      agentSessionId: "ase-handoff-1",
      issue: { id: "iss-101", identifier: "ENG-101", title: "Test handoff" },
    });

    const expectedToken = createSessionCallbackToken({
      agentSessionId: "ase-handoff-1",
      secret: "test-wh-secret",
    });
    assert.equal(launches.length, 1);
    assert.match(
      launches[0].prompt,
      /https:\/\/bridge\.example\.com\/api\/sessions\/ase-handoff-1\/activity/
    );
    assert.ok(launches[0].prompt.includes(`Authorization: Bearer ${expectedToken}`));
    assert.equal(activities.length, 2);
    assert.equal(activities[0].content.type, "thought");
    assert.equal(activities[1].content.type, "thought");
    assert.equal(activities[1].ephemeral, undefined);
    assert.equal(sessionStore.get("ase-handoff-1").status, "active");
    assert.equal(sessionStore.get("ase-handoff-1").aceUvmId, "uvm-123");

    await dispatcher.enqueue({
      type: "AgentSessionEvent",
      action: "prompted",
      agentSessionId: "ase-handoff-1",
      issue: { id: "iss-101", identifier: "ENG-101" },
      comment: { body: "补充一个约束" },
    });
    assert.equal(resumes.length, 1);
    assert.ok(resumes[0].prompt.includes(expectedToken));
    assert.equal(activities.at(-1).content.type, "thought");
    assert.equal(sessionStore.get("ase-handoff-1").status, "active");

    const unauth = await fetch(`${baseLocal}/api/sessions/ase-handoff-1/activity`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer deadbeef",
      },
      body: JSON.stringify({ type: "thought", body: "bad" }),
    });
    assert.equal(unauth.status, 401);

    const badType = await fetch(`${baseLocal}/api/sessions/ase-handoff-1/activity`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${expectedToken}`,
      },
      body: JSON.stringify({ type: "bogus", body: "x" }),
    });
    assert.equal(badType.status, 400);

    const thoughtRes = await fetch(`${baseLocal}/api/sessions/ase-handoff-1/activity`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${expectedToken}`,
      },
      body: JSON.stringify({ type: "thought", body: "云端正在运行单测" }),
    });
    assert.equal(thoughtRes.status, 200);
    assert.equal(sessionStore.get("ase-handoff-1").status, "active");

    const elicitRes = await fetch(`${baseLocal}/api/sessions/ase-handoff-1/activity`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${expectedToken}`,
      },
      body: JSON.stringify({ type: "elicitation", body: "需要确认迁移策略？" }),
    });
    assert.equal(elicitRes.status, 200);
    assert.equal(sessionStore.get("ase-handoff-1").status, "awaiting_clarification");

    const finalRes = await fetch(`${baseLocal}/api/sessions/ase-handoff-1/activity`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${expectedToken}`,
      },
      body: JSON.stringify({
        type: "response",
        body: "已完成修复并提交 PR #42",
        plan: { steps: [{ content: "Fix & test", status: "completed" }] },
      }),
    });
    assert.equal(finalRes.status, 200);
    assert.equal(sessionStore.get("ase-handoff-1").status, "complete");
    assert.equal(activities.at(-1).content.type, "response");
    assert.equal(sessionUpdates.at(-1).plan.steps[0].status, "completed");
  } finally {
    if (serverHolder.server) {
      await new Promise((resolve) => serverHolder.server.close(resolve));
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("buildDispatchPrompt adopts Linear native prompt structure, deduplicates XML & comments, and formats guidance", () => {
  const issueContext = {
    identifier: "ENG-101",
    title: "优化 outbound-sync 批量写入并发度",
    url: "https://linear.app/acme-workspace/issue/ENG-101",
    branchName: "antigravity/eng-101-优化-outbound-sync",
    priorityLabel: "High",
    description: "UNIQUE_ISSUE_BODY_SHOULD_NOT_REPEAT",
    state: { name: "Todo", type: "unstarted" },
    team: { key: "ENG", name: "Engineering" },
    project: { name: "backend-app" },
    parent: { identifier: "ENG-100", title: "Performance Epic" },
    labels: { nodes: [{ name: "Improvement" }] },
  };

  const promptContextWithComment = [
    '<issue identifier="ENG-101">',
    "<title>优化 outbound-sync 批量写入并发度</title>",
    "<description>",
    "UNIQUE_ISSUE_BODY_SHOULD_NOT_REPEAT",
    "</description>",
    "<comment>DUPLICATE_COMMENT_BODY_HERE</comment>",
    '<parent identifier="ENG-100"/>',
    "</issue>",
  ].join("\n");

  const prompt1 = buildDispatchPrompt({
    issueContext,
    comment: { body: "DUPLICATE_COMMENT_BODY_HERE" },
    promptContext: promptContextWithComment,
    guidance: "Always run focused tests before PR.",
    creator: { name: "Alice Example", displayName: "alice" },
    project: { name: "Backend App", extraInstructions: "遵守 AGENTS.md" },
  });

  assert.match(prompt1, /^Work on Linear issue ENG-101:/);
  assert.ok(
    prompt1.includes("Suggested branch name: antigravity/eng-101-优化-outbound-sync")
  );
  assert.ok(
    prompt1.includes('git checkout -B "antigravity/eng-101-优化-outbound-sync"')
  );
  assert.ok(prompt1.includes("Issue URL: https://linear.app/acme-workspace/issue/ENG-101"));
  assert.ok(prompt1.includes("State: Todo | Priority: High"));
  assert.ok(prompt1.includes("Triggered by: alice"));
  assert.ok(prompt1.includes("Target project: Backend App"));
  assert.ok(!prompt1.includes("## 工单描述"));
  assert.equal(prompt1.split("UNIQUE_ISSUE_BODY_SHOULD_NOT_REPEAT").length - 1, 1);
  assert.ok(!prompt1.includes("## Triggering Comment"));
  assert.equal(prompt1.split("DUPLICATE_COMMENT_BODY_HERE").length - 1, 1);
  assert.ok(!prompt1.includes("Parent issue:"));
  assert.match(prompt1, /## Linear Guidance\nAlways run focused tests before PR\./);
  assert.match(prompt1, /## 项目额外约束\n遵守 AGENTS\.md/);

  const prompt2 = buildDispatchPrompt({
    issueContext,
    comment: { body: "FRESH_TRIGGER_COMMENT" },
    promptContext: "Extra plain prompt note",
    guidance: [{ body: "Rule 1" }, "Rule 2", { content: "Rule 3" }],
    project: { name: "Backend App" },
  });
  assert.ok(prompt2.includes("## Triggering Comment\nFRESH_TRIGGER_COMMENT"));
  assert.ok(prompt2.includes("## Linear Guidance\nRule 1\n\nRule 2\n\nRule 3"));
  assert.ok(prompt2.includes("## Linear Prompt Context\nExtra plain prompt note"));
});

test("buildDispatchPrompt renders fallback <issue> XML when promptContext lacks <issue> tag", () => {
  const prompt = buildDispatchPrompt({
    issueContext: {
      identifier: "ENG-120",
      title: 'Fix "quoted" & <escaped> attrs',
      description: "Fallback body line 1",
      team: { key: "ENG", name: "Engineering" },
      project: { name: "backend-app" },
      parent: { identifier: "ENG-99", title: 'Parent "Quote"' },
      labels: { nodes: [{ name: "Bug" }, { name: "Backend" }] },
    },
    comment: { body: "Please check ASAP" },
    promptContext: "",
    project: { name: "Backend App" },
  });

  assert.match(prompt, /^Work on Linear issue ENG-120:/);
  assert.ok(prompt.includes('Parent issue: ENG-99 (Parent "Quote")'));
  assert.ok(prompt.includes('<issue identifier="ENG-120">'));
  assert.ok(prompt.includes('<title>Fix "quoted" & <escaped> attrs</title>'));
  assert.ok(prompt.includes("<description>\nFallback body line 1\n</description>"));
  assert.ok(prompt.includes('<team name="Engineering"/>'));
  assert.ok(prompt.includes("<label>Bug</label>"));
  assert.ok(prompt.includes("<label>Backend</label>"));
  assert.ok(prompt.includes('<project name="backend-app"/>'));
  assert.ok(prompt.includes('<parent identifier="ENG-99" title="Parent &quot;Quote&quot;"/>'));
  assert.ok(prompt.includes("</issue>"));
  assert.ok(prompt.includes("## Triggering Comment\nPlease check ASAP"));
});

test("EventDispatcher persists suggestedBranchName, includes it in initial thought, and forwards it with guidance to follow-ups", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-branch-persist-"));
  try {
    const activities = [];
    const launches = [];
    const resumes = [];

    const linearClient = {
      async getIssueContext(id) {
        return {
          id,
          identifier: "ENG-101",
          title: "Improve throughput",
          url: "https://linear.app/acme-workspace/issue/ENG-101",
          branchName: "antigravity/eng-101-improve-throughput",
          priorityLabel: "High",
          description: "Issue body",
          team: { key: "ENG", name: "Engineering" },
          project: { id: "lin-proj-1", name: "backend-app", slugId: "slug-backend-01" },
          parent: { id: "p-1", identifier: "ENG-100", title: "Epic" },
          labels: { nodes: [] },
          state: { name: "Todo", type: "unstarted" },
        };
      },
      async createAgentActivity(payload) {
        activities.push(payload);
        return { success: true };
      },
      async updateAgentSession() {
        return { success: true };
      },
    };

    const launcher = {
      async launchNew(args) {
        launches.push(args);
        return { ok: true, conversationId: "conv-branch-1", logFile: "/tmp/branch.log" };
      },
      async resume(args) {
        resumes.push(args);
        return { ok: true, conversationId: args.conversationId, logFile: "/tmp/branch-res.log" };
      },
    };

    const config = {
      ...makeBaseConfig(tmpDir),
      publicBaseUrl: "https://bridge.example.com",
      linear: { webhookSecret: "sec-1" },
    };
    const sessionStore = new SessionStore(path.join(tmpDir, "sessions.json"));
    const dispatcher = new EventDispatcher({
      config,
      linearClient,
      sessionStore,
      launcher,
      logger: { log() {}, warn() {}, error() {} },
    });

    await dispatcher.enqueue({
      type: "AgentSessionEvent",
      action: "created",
      agentSessionId: "ase-branch-1",
      issue: { id: "iss-branch-1", identifier: "ENG-101" },
      creator: { name: "Alice", displayName: "alice" },
      guidance: [{ body: "Workspace policy X" }],
      promptContext: '<issue identifier="ENG-101"><title>Improve throughput</title></issue>',
    });

    assert.equal(
      sessionStore.get("ase-branch-1").suggestedBranchName,
      "antigravity/eng-101-improve-throughput"
    );
    assert.ok(
      activities[1].content.body.includes("建议分支：`antigravity/eng-101-improve-throughput`")
    );
    assert.ok(launches[0].prompt.includes("Suggested branch name: antigravity/eng-101-improve-throughput"));
    assert.ok(launches[0].prompt.includes("## Linear Guidance\nWorkspace policy X"));

    await dispatcher.enqueue({
      type: "AgentSessionEvent",
      action: "prompted",
      agentSessionId: "ase-branch-1",
      issue: { id: "iss-branch-1", identifier: "ENG-101" },
      comment: { body: "Run integration tests too" },
      guidance: "Follow-up policy Y",
      promptContext: "",
    });

    assert.equal(resumes.length, 1);
    assert.ok(resumes[0].prompt.startsWith("Follow-up on Linear issue ENG-101:"));
    assert.ok(
      resumes[0].prompt.includes("Suggested branch name: antigravity/eng-101-improve-throughput")
    );
    assert.ok(resumes[0].prompt.includes("## Linear Guidance\nFollow-up policy Y"));
    assert.ok(resumes[0].prompt.includes("## Triggering Comment\nRun integration tests too"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("LinearClient.getIssueContext requests branchName, priorityLabel, parent, creator, and assignee", async () => {
  let capturedBody = null;
  const client = new LinearClient({
    tokenManager: {
      async getAccessToken() {
        return "tok-test";
      },
    },
    fetchImpl: async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              id: "iss-1",
              identifier: "ENG-101",
              branchName: "antigravity/eng-101-test",
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    },
  });

  const issue = await client.getIssueContext("iss-1");
  assert.equal(issue.branchName, "antigravity/eng-101-test");
  assert.equal(capturedBody.variables.id, "iss-1");
  for (const field of ["branchName", "priorityLabel", "parent {", "creator {", "assignee {"]) {
    assert.ok(capturedBody.query.includes(field), `Expected query to include ${field}`);
  }
});

test("EventDispatcher handles stop signal immediately, cancels cloud session, locks callback API (409), and handles in-flight launch races", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-stop-"));
  let server = null;
  try {
    const activities = [];
    const cancelCalls = [];
    const stoppedWatchers = [];
    const startedWatchers = [];

    const config = {
      ...makeBaseConfig(tmpDir),
      publicBaseUrl: "https://bridge.example.com",
      linear: { webhookSecret: "sec-stop" },
      github: { webhookSecret: "gh-sec" },
      paths: {
        logsDir: tmpDir,
        tokensFile: path.join(tmpDir, "tokens.json"),
        sessionsFile: path.join(tmpDir, "sessions.json"),
      },
    };
    const sessionStore = new SessionStore(config.paths.sessionsFile);
    sessionStore.upsert("ase-stop-1", {
      issueIdentifier: "ENG-101",
      agyConversationId: "conv-stop-1",
      status: "active",
    });

    const linearClient = {
      async getIssueContext(id) {
        return {
          id,
          identifier: "ENG-102",
          title: "Launch race",
          team: { key: "ENG" },
          project: { id: "lin-proj-1", name: "backend-app" },
          labels: { nodes: [] },
        };
      },
      async createAgentActivity(payload) {
        activities.push(payload);
        return { success: true };
      },
      async updateAgentSession() {
        return { success: true };
      },
    };

    let releaseLaunch = null;
    const launchEntered = new Promise((r) => {
      releaseLaunch = r;
    });
    let resolveLaunch = null;

    const launcher = {
      async launchNew() {
        releaseLaunch();
        await new Promise((r) => {
          resolveLaunch = r;
        });
        return { ok: true, conversationId: "conv-race-1", logFile: "/tmp/race.log" };
      },
      async cancel(args) {
        cancelCalls.push(args);
        return { ok: true, wasRunning: true, cancelled: true, stillRunning: false };
      },
    };

    const watcher = {
      activeCount() {
        return 0;
      },
      start(args) {
        startedWatchers.push(args);
      },
      stop(id) {
        stoppedWatchers.push(id);
      },
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

    await created.dispatcher.enqueue({
      type: "AgentSessionEvent",
      action: "prompted",
      agentSessionId: "ase-stop-1",
      isStopSignal: true,
      signal: "stop",
      issue: { id: "iss-1", identifier: "ENG-101" },
    });

    assert.equal(stoppedWatchers[0], "ase-stop-1");
    assert.equal(sessionStore.get("ase-stop-1").status, "stopped");
    assert.equal(cancelCalls.length, 1);
    assert.equal(cancelCalls[0].conversationId, "conv-stop-1");
    // Stop signal must post confirmation response directly without preceding follow-up thought
    assert.equal(activities.length, 1);
    assert.equal(activities[0].content.type, "response");
    assert.match(activities[0].content.body, /已收到 Linear 停止信号/);

    const tok = createSessionCallbackToken({ agentSessionId: "ase-stop-1", secret: "sec-stop" });
    const blockedRes = await fetch(`http://127.0.0.1:${port}/api/sessions/ase-stop-1/activity`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tok}`,
      },
      body: JSON.stringify({ type: "thought", body: "Late cloud write" }),
    });
    assert.equal(blockedRes.status, 409);
    assert.equal((await blockedRes.json()).stopped, true);
    assert.equal(activities.length, 1);

    // Launch race: stop arrives while launchNew() is in flight
    const dispatchP = created.dispatcher.enqueue({
      type: "AgentSessionEvent",
      action: "created",
      agentSessionId: "ase-race-1",
      issue: { id: "iss-race-1", identifier: "ENG-102" },
    });
    await launchEntered;
    const stopRaceP = created.dispatcher.enqueue({
      type: "AgentSessionEvent",
      action: "prompted",
      agentSessionId: "ase-race-1",
      isStopSignal: true,
      signal: "stop",
      issue: { id: "iss-race-1", identifier: "ENG-102" },
    });
    resolveLaunch();
    await Promise.all([dispatchP, stopRaceP]);

    assert.equal(sessionStore.get("ase-race-1").status, "stopped");
    assert.equal(sessionStore.get("ase-race-1").agyConversationId, "conv-race-1");
    assert.equal(startedWatchers.length, 0);
    // Cancelled exactly once despite launch + queued stop handler
    assert.equal(cancelCalls.length, 2);
    assert.equal(cancelCalls[1].conversationId, "conv-race-1");
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Callback prUrl and PR links in body merge externalUrls preserving Antigravity Remote and update SessionStore", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cb-pr-"));
  let server = null;
  try {
    const sessionUpdates = [];
    const config = {
      ...makeBaseConfig(tmpDir),
      publicBaseUrl: "https://bridge.example.com",
      linear: { webhookSecret: "sec-pr" },
      paths: {
        logsDir: tmpDir,
        tokensFile: path.join(tmpDir, "tokens.json"),
        sessionsFile: path.join(tmpDir, "sessions.json"),
      },
    };
    const sessionStore = new SessionStore(config.paths.sessionsFile);
    sessionStore.upsert("ase-cb-1", {
      issueIdentifier: "ENG-101",
      agyConversationId: "conv-cb-1",
      externalUrls: [{ label: "Antigravity Remote", url: "https://antigravity.google.com" }],
      status: "active",
    });

    const created = createBridgeServer({
      config,
      sessionStore,
      linearClient: {
        async createAgentActivity() {
          return { success: true, agentActivity: { id: "act-1" } };
        },
        async updateAgentSession(payload) {
          sessionUpdates.push(payload);
          return { success: true };
        },
      },
      launcher: {
        async launchNew() {
          return { ok: true, conversationId: "conv-cb-1" };
        },
      },
      logger: { log() {}, warn() {}, error() {} },
    });
    server = created.server;
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const tok = createSessionCallbackToken({ agentSessionId: "ase-cb-1", secret: "sec-pr" });

    const r1 = await fetch(`http://127.0.0.1:${port}/api/sessions/ase-cb-1/activity`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
      body: JSON.stringify({
        type: "thought",
        body: "Opened draft PR",
        prUrl: "https://github.com/acme/backend-app/pull/301",
      }),
    });
    assert.equal(r1.status, 200);
    assert.deepEqual(sessionUpdates[0].externalUrls, [
      { label: "Antigravity Remote", url: "https://antigravity.google.com" },
      { label: "PR #301", url: "https://github.com/acme/backend-app/pull/301" },
    ]);

    const r2 = await fetch(`http://127.0.0.1:${port}/api/sessions/ase-cb-1/activity`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}` },
      body: JSON.stringify({
        type: "response",
        body: "Done: https://github.com/acme/backend-app/pull/302",
      }),
    });
    assert.equal(r2.status, 200);
    assert.equal(sessionStore.get("ase-cb-1").prNumber, 302);
    assert.deepEqual(sessionUpdates[1].externalUrls, [
      { label: "Antigravity Remote", url: "https://antigravity.google.com" },
      { label: "PR #301", url: "https://github.com/acme/backend-app/pull/301" },
      { label: "PR #302", url: "https://github.com/acme/backend-app/pull/302" },
    ]);
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("EventDispatcher injects WORKFLOW.md body into prompt and applies frontmatter mode override", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-wf-dispatch-"));
  try {
    const launches = [];
    const cfg = {
      ...makeBaseConfig(tmpDir),
      workflow: { enabled: true },
    };
    cfg.projectsConfig.projects[0].mode = "accept-edits";
    cfg.projectsConfig.projects[0].githubRepo = "acme/backend-app";

    const sessionStore = new SessionStore(path.join(tmpDir, "sessions.json"));
    const dispatcher = new EventDispatcher({
      config: cfg,
      linearClient: {
        async getIssueContext(id) {
          return {
            id,
            identifier: "ENG-110",
            title: "Use WORKFLOW.md policy",
            team: { key: "ENG" },
            project: { id: "lin-proj-1", name: "backend-app" },
            labels: { nodes: [] },
          };
        },
        async createAgentActivity() {
          return { success: true };
        },
        async updateAgentSession() {
          return { success: true };
        },
      },
      sessionStore,
      workflowLoader: {
        async load(project) {
          assert.equal(project.key, "backend-app");
          return {
            path: "WORKFLOW.md",
            source: "github",
            frontmatter: { mode: "auto", maxCiFixRounds: 2, ciAutoFix: true },
            body: "Run `pnpm verify` cleanly before submitting a PR.",
          };
        },
      },
      launcher: {
        async launchNew(args) {
          launches.push(args);
          return { ok: true, conversationId: "conv-wf-1", logFile: "/tmp/wf.log" };
        },
      },
      logger: { log() {}, warn() {}, error() {} },
    });

    await dispatcher.enqueue({
      type: "AgentSessionEvent",
      action: "created",
      agentSessionId: "ase-wf-1",
      issue: { id: "iss-wf-1", identifier: "ENG-110" },
    });

    assert.equal(launches.length, 1);
    assert.equal(launches[0].mode, "auto");
    assert.match(
      launches[0].prompt,
      /## Repository Workflow Policy \(WORKFLOW\.md\)\nRun `pnpm verify` cleanly before submitting a PR\./
    );
    assert.deepEqual(sessionStore.get("ase-wf-1").workflowPolicy, {
      ciAutoFix: true,
      maxCiFixRounds: 2,
    });
    assert.equal(sessionStore.get("ase-wf-1").githubRepo, "acme/backend-app");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
