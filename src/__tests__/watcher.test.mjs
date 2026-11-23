import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionStore } from "../store.mjs";
import { RemoteStreamWatcher } from "../watcher.mjs";

const WATCH_SCRIPT = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "scripts",
  "watch_remote_agent.py"
);

function parseSnapshotWithPython(lines) {
  const py = [
    "import importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('w', sys.argv[1])",
    "mod = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    "lines = json.loads(sys.stdin.read())",
    "print(json.dumps(mod.extract_snapshot(lines), ensure_ascii=False))",
  ].join("\n");
  const stdout = execFileSync("python3", ["-c", py, WATCH_SCRIPT], {
    input: JSON.stringify(lines),
    encoding: "utf8",
  });
  return JSON.parse(stdout);
}

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.killedSignals = [];
  child.kill = (sig = "SIGTERM") => {
    child.killed = true;
    child.killedSignals.push(sig);
    child.signalCode = sig;
    return true;
  };
  return child;
}

test("watch_remote_agent.py extract_snapshot parses running tasks, actions, ignores callbacks, and extracts idle finalText", () => {
  const runningFrame = [
    "○ Thought for 1m 20s (Checking outbound sync)",
    "● Used LookupSkills (Loaded skills: linear, github)",
    '● Ran (curl -fsS -X POST "https://bridge.example.com/api/sessions/abc/activity" -d "{}")',
    "● Ran 2 commands (grep -rn outbound packages/backend · git status)",
    "● Explored 2 files (runtime.ts, outbound.ts) (ctrl+o to expand)",
    "… 47 more actions (38 reads, 8 commands) …",
    "⣾ Tracing how prepare relates to PATCH calls...",
    "└ Tip: Press ctrl+r to review pending artifacts.",
    "────────────────────────────────────────────────────────────────────────",
    ">",
    "────────────────────────────────────────────────────────────────────────",
    "  ● [00:47:14] git checkout -b perf/eng-101 && pnpm install running",
    "────────────────────────────────────────────────────────────────────────",
    "esc to cancel   remote · backend-app · Gemini 4 Carbon · medium · 1 task(s)",
  ];

  const runningSnap = parseSnapshotWithPython(runningFrame);
  assert.equal(runningSnap.isRunning, true);
  assert.equal(runningSnap.isIdle, false);
  assert.equal(runningSnap.runningTask, "git checkout -b perf/eng-101 && pnpm install");
  assert.match(runningSnap.statusText, /Tracing how prepare relates to PATCH calls/);
  assert.match(runningSnap.statusText, /git checkout -b perf\/eng-101/);
  assert.equal(runningSnap.actions.length, 3);
  assert.deepEqual(runningSnap.actions[0], {
    action: "Used",
    parameter: "LookupSkills (Loaded skills: linear, github)",
  });
  assert.deepEqual(runningSnap.actions[1], {
    action: "Ran",
    parameter: "2 commands (grep -rn outbound packages/backend · git status)",
  });
  assert.deepEqual(runningSnap.actions[2], {
    action: "Explored",
    parameter: "2 files (runtime.ts, outbound.ts)",
  });

  const loadingFrame = [
    "⡿ Loading conversation...",
    "────────────────────────────────────────────────────────────────────────",
    ">",
    "────────────────────────────────────────────────────────────────────────",
    "? for shortcuts   remote · backend-app",
  ];
  const loadingSnap = parseSnapshotWithPython(loadingFrame);
  assert.equal(loadingSnap.isIdle, false);

  const idleFrame = [
    "○ Thought for 2m 10s",
    "● Ran (pnpm test)",
    "▸ Thought for 5s, 312 tokens",
    "  Completed fix and opened PR #128.",
    "  Batch latency dropped from 84s to 6.4s.",
    "────────────────────────────────────────────────────────────────────────",
    ">",
    "────────────────────────────────────────────────────────────────────────",
    "? for shortcuts   remote · backend-app · Gemini 4 Carbon · medium",
  ];
  const idleSnap = parseSnapshotWithPython(idleFrame);
  assert.equal(idleSnap.isRunning, false);
  assert.equal(idleSnap.isIdle, true);
  assert.match(idleSnap.finalText, /Completed fix and opened PR #128/);
  assert.match(idleSnap.finalText, /84s to 6\.4s/);
});

test("RemoteStreamWatcher throttles status/actions, deduplicates actions, runs idle fallback only when active, and stops cleanly", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-watcher-"));
  try {
    let fakeNow = 1_000_000;
    const spawned = [];
    const activities = [];
    const sessionStore = new SessionStore(path.join(tmpDir, "sessions.json"));

    sessionStore.upsert("sess-1", {
      agyConversationId: "conv-1",
      issueIdentifier: "ENG-101",
      status: "active",
    });

    const config = {
      rootDir: tmpDir,
      launcher: { pythonBin: "python3", agyBin: "agy" },
      paths: { watchScript: WATCH_SCRIPT },
      watcher: {
        enabled: true,
        statusThrottleMs: 12_000,
        actionThrottleMs: 15_000,
        keepaliveMs: 900_000,
        idleGraceMs: 40,
        maxConcurrent: 2,
        maxDurationSec: 3600,
      },
    };

    const watcher = new RemoteStreamWatcher({
      config,
      linearClient: {
        async createAgentActivity(payload) {
          activities.push(payload);
          return { success: true, agentActivity: { id: `a-${activities.length}` } };
        },
      },
      sessionStore,
      spawnImpl: (bin, args) => {
        const child = makeFakeChild();
        spawned.push({ bin, args, child });
        return child;
      },
      logger: { log() {}, warn() {}, error() {} },
      nowFn: () => fakeNow,
    });

    const started = watcher.start({
      agentSessionId: "sess-1",
      conversationId: "conv-1",
      issueIdentifier: "ENG-101",
    });
    assert.equal(started, true);
    assert.equal(watcher.activeCount(), 1);
    assert.equal(spawned.length, 1);

    // Emit initial status + throttled status + unthrottled status
    await watcher.handleWatcherEvent("sess-1", {
      event: "status",
      text: "Reading outbound/index.ts",
      running: true,
    });
    assert.equal(activities.length, 1);
    assert.equal(activities[0].ephemeral, true);
    assert.equal(activities[0].content.type, "thought");
    assert.match(activities[0].content.body, /Reading outbound\/index\.ts/);

    // Duplicate & within throttle window both skipped
    fakeNow += 3_000;
    await watcher.handleWatcherEvent("sess-1", {
      event: "status",
      text: "Running vitest",
      running: true,
    });
    assert.equal(activities.length, 1);

    // Past statusThrottleMs -> emitted
    fakeNow += 12_500;
    await watcher.handleWatcherEvent("sess-1", {
      event: "status",
      text: "Running vitest",
      running: true,
    });
    assert.equal(activities.length, 2);
    assert.match(activities[1].content.body, /Running vitest/);

    // Action event: first goes through immediately, duplicate ignored
    await watcher.handleWatcherEvent("sess-1", {
      event: "action",
      action: "Explored",
      parameter: "2 files (runtime.ts, outbound.ts)",
    });
    await watcher.handleWatcherEvent("sess-1", {
      event: "action",
      action: "Explored",
      parameter: "2 files (runtime.ts, outbound.ts)",
    });
    assert.equal(activities.length, 3);
    assert.deepEqual(activities[2].content, {
      type: "action",
      action: "Explored",
      parameter: "2 files (runtime.ts, outbound.ts)",
    });

    // Idle while still active -> sends fallback response & completes session
    await watcher.handleWatcherEvent("sess-1", {
      event: "idle",
      finalText: "Investigated root cause and fixed in PR #99",
    });
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(activities.length, 4);
    assert.equal(activities[3].content.type, "response");
    assert.match(activities[3].content.body, /Investigated root cause and fixed in PR #99/);
    assert.equal(sessionStore.get("sess-1").status, "complete");
    assert.equal(watcher.activeCount(), 0);
    assert.deepEqual(spawned[0].child.killedSignals, ["SIGTERM"]);

    // Second session closed via callback during idle grace -> skips duplicate response
    sessionStore.upsert("sess-2", {
      agyConversationId: "conv-2",
      issueIdentifier: "ENG-102",
      status: "active",
    });
    watcher.start({
      agentSessionId: "sess-2",
      conversationId: "conv-2",
      issueIdentifier: "ENG-102",
    });
    await watcher.handleWatcherEvent("sess-2", {
      event: "idle",
      finalText: "Should not be emitted because callback finished it",
    });
    sessionStore.upsert("sess-2", { status: "complete" });
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(activities.length, 4);
    assert.equal(watcher.activeCount(), 0);

    // stopAll terminates remaining watchers (and isResume forwards --resume)
    sessionStore.upsert("sess-3", {
      agyConversationId: "conv-3",
      status: "active",
    });
    watcher.start({ agentSessionId: "sess-3", conversationId: "conv-3", isResume: true });
    assert.equal(watcher.activeCount(), 1);
    assert.ok(spawned[2].args.includes("--resume"));
    watcher.stopAll();
    assert.equal(watcher.activeCount(), 0);
    assert.deepEqual(spawned[2].child.killedSignals, ["SIGTERM"]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("watch_remote_agent.py should_emit_idle holds off during cold-uVM resume wakeup until saw_running=True", () => {
  const py = [
    "import importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('w', sys.argv[1])",
    "mod = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(mod)",
    "# 1) At t=10s in --resume mode (startup_grace=60s), previous turn footer looks idle -> must NOT emit idle",
    "e1, s1 = mod.should_emit_idle(is_idle=True, saw_running=False, now=110.0, attached_at=100.0, idle_since=None, idle_confirm_seconds=8.0, startup_grace_seconds=60.0)",
    "# 2) At t=25s uVM wakes up (saw_running=True) and finishes at t=40s -> starts counting idle_since=140.0",
    "e2, s2 = mod.should_emit_idle(is_idle=True, saw_running=True, now=140.0, attached_at=100.0, idle_since=None, idle_confirm_seconds=8.0, startup_grace_seconds=60.0)",
    "# 3) 8.5s later (t=48.5s) -> emits idle cleanly without waiting 60s",
    "e3, s3 = mod.should_emit_idle(is_idle=True, saw_running=True, now=148.5, attached_at=100.0, idle_since=s2, idle_confirm_seconds=8.0, startup_grace_seconds=60.0)",
    "print(json.dumps({'e1': e1, 's1': s1, 'e2': e2, 's2': s2, 'e3': e3}))",
  ].join("\n");
  const out = JSON.parse(execFileSync("python3", ["-c", py, WATCH_SCRIPT], { encoding: "utf8" }));
  assert.equal(out.e1, false);
  assert.equal(out.s1, null);
  assert.equal(out.e2, false);
  assert.equal(out.s2, 140.0);
  assert.equal(out.e3, true);
});

test("RemoteStreamWatcher extracts PR URLs from actions and finalText, preserving Antigravity Remote and deduplicating updates", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-watcher-pr-"));
  try {
    const sessionUpdates = [];
    const activities = [];
    const sessionStore = new SessionStore(path.join(tmpDir, "sessions.json"));

    sessionStore.upsert("sess-pr", {
      agyConversationId: "conv-pr-1",
      issueIdentifier: "ENG-101",
      status: "active",
    });

    const watcher = new RemoteStreamWatcher({
      config: {
        rootDir: tmpDir,
        launcher: { pythonBin: "python3", agyBin: "agy" },
        paths: { watchScript: WATCH_SCRIPT },
        watcher: { enabled: true, statusThrottleMs: 1000, actionThrottleMs: 0, idleGraceMs: 30 },
      },
      linearClient: {
        async createAgentActivity(payload) {
          activities.push(payload);
          return { success: true };
        },
        async updateAgentSession(payload) {
          sessionUpdates.push(payload);
          return { success: true };
        },
      },
      sessionStore,
      spawnImpl: () => makeFakeChild(),
      logger: { log() {}, warn() {}, error() {} },
    });

    watcher.start({ agentSessionId: "sess-pr", conversationId: "conv-pr-1", issueIdentifier: "ENG-101" });

    await watcher.handleWatcherEvent("sess-pr", {
      event: "action",
      action: "Ran",
      parameter: "gh pr create -> https://github.com/acme/backend-app/pull/205",
    });
    assert.equal(sessionUpdates.length, 1);
    assert.deepEqual(sessionUpdates[0].externalUrls, [
      { label: "Antigravity Remote", url: "https://antigravity.google.com" },
      { label: "PR #205", url: "https://github.com/acme/backend-app/pull/205" },
    ]);
    assert.equal(sessionStore.get("sess-pr").prNumber, 205);

    // Same PR mentioned in idle finalText should not trigger a duplicate updateAgentSession
    await watcher.handleWatcherEvent("sess-pr", {
      event: "idle",
      finalText: "Opened https://github.com/acme/backend-app/pull/205 for review.",
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(sessionUpdates.length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
