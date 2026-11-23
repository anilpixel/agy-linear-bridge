import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { LinearTokenManager } from "./linear-auth.mjs";
import { LinearClient } from "./linear-client.mjs";
import { routeIssue } from "./router.mjs";
import { EdgeRunner } from "./runner.mjs";
import { createBridgeServer } from "./server.mjs";
import { SessionStore, TokenStore } from "./store.mjs";

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
      flags[arg.slice(2)] = args[i + 1];
      i += 1;
    } else {
      flags[arg.slice(2)] = true;
    }
  }
  return flags;
}

async function cmdServe(config) {
  const { server, watcher } = createBridgeServer({ config });
  await new Promise((resolve) => {
    server.listen(config.port, config.host, resolve);
  });
  console.log(
    `[agy-linear-bridge] Listening on http://${config.host}:${config.port} (public=${config.publicBaseUrl})`
  );
  watcher.restoreActiveSessions();

  const shutdown = (signal) => {
    console.log(`[agy-linear-bridge] Received ${signal}, shutting down...`);
    watcher.stopAll();
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function cmdRunner(config) {
  if (!config.edge.baseUrl || !config.edge.runnerSecret) {
    throw new Error(
      "Runner mode requires EDGE_BASE_URL (or PUBLIC_BASE_URL) and RUNNER_SHARED_SECRET in .env"
    );
  }
  const runner = new EdgeRunner({ config });
  // Perform one immediate poll so auth/connectivity errors surface right on startup
  await runner.pollOnce();
  runner.start();
  console.log(
    `[agy-linear-bridge:runner] Connected to edge=${config.edge.baseUrl} runnerId=${runner.runnerId} (outbound-only, zero local ports)`
  );

  const shutdown = (signal) => {
    console.log(`[agy-linear-bridge:runner] Received ${signal}, stopping watchers...`);
    runner.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function cmdEdgeSeed(config) {
  const edgeBaseUrl = config.edge.baseUrl;
  const runnerSecret = config.edge.runnerSecret;
  if (!edgeBaseUrl || !runnerSecret) {
    throw new Error(
      "edge-seed requires EDGE_BASE_URL (or PUBLIC_BASE_URL) and RUNNER_SHARED_SECRET in .env"
    );
  }

  const tokenStore = new TokenStore(config.paths.tokensFile);
  const sessionStore = new SessionStore(config.paths.sessionsFile);
  const token = tokenStore.load();
  const sessions = sessionStore.list();

  const res = await fetch(`${edgeBaseUrl}/api/runner/bootstrap`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${runnerSecret}`,
    },
    body: JSON.stringify({ token, sessions }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`edge-seed failed (${res.status}): ${text}`);
  }
  console.log(text);
}

async function cmdVerifyIdentity(config) {
  const tokenStore = new TokenStore(config.paths.tokensFile);
  const tokenManager = new LinearTokenManager({
    linearConfig: config.linear,
    tokenStore,
  });
  const client = new LinearClient({ tokenManager });
  const data = await client.getViewer();
  const viewer = data?.viewer;
  console.log(JSON.stringify(data, null, 2));
  if (!viewer || viewer.app !== true) {
    console.error(
      "ERROR: Linear token is not an actor=app identity (viewer.app !== true)."
    );
    process.exitCode = 1;
  }
}

async function cmdRouteTest(config, restArgs) {
  const flags = parseFlags(restArgs);
  let issueContext;
  let promptContext = "";

  if (typeof flags.file === "string") {
    const raw = JSON.parse(fs.readFileSync(path.resolve(flags.file), "utf8"));
    issueContext = raw.issue || raw.agentSession?.issue || raw;
    promptContext = raw.promptContext || "";
  } else {
    issueContext = {
      identifier: flags.identifier || "TEST-1",
      title: flags.title || "Test issue",
      description: flags.description || "",
      team: flags.team ? { key: String(flags.team) } : null,
      project:
        flags.project || flags.slug || flags["project-id"]
          ? {
              id: flags["project-id"] || undefined,
              slugId: flags.slug || undefined,
              name: flags.project || undefined,
            }
          : null,
      labels: {
        nodes: flags.label ? [{ name: String(flags.label) }] : [],
      },
    };
  }

  const decision = await routeIssue({
    issueContext,
    promptContext,
    projectsConfig: config.projectsConfig,
    routerConfig: config.router,
    agyBin: config.launcher.agyBin,
  });

  console.log(JSON.stringify(decision, null, 2));
}

function printHelp() {
  console.log(`Usage: node src/cli.mjs <command>

Commands:
  runner           Start zero-port outbound Runner polling Cloudflare Edge Gateway
  edge-seed        Migrate local data/tokens.json & data/sessions.json into Cloudflare D1
  serve            Start standalone all-in-one local HTTP webhook & OAuth server
  verify-identity  Verify persisted Linear actor=app identity
  route-test       Test deterministic/LLM routing (--project, --team, --title, --description, --file)
`);
}

async function main() {
  const [, , command, ...rest] = process.argv;
  const config = loadConfig();

  if (command === "runner") {
    await cmdRunner(config);
    return;
  }
  if (command === "edge-seed") {
    await cmdEdgeSeed(config);
    return;
  }
  if (command === "serve") {
    await cmdServe(config);
    return;
  }
  if (command === "verify-identity") {
    await cmdVerifyIdentity(config);
    return;
  }
  if (command === "route-test") {
    await cmdRouteTest(config, rest);
    return;
  }

  printHelp();
  if (command && command !== "--help" && command !== "-h") {
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
