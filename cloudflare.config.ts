import { bindings, defineConfig } from "cf/config";

const customDomains = (process.env.WORKER_CUSTOM_DOMAIN || "")
  .split(",")
  .map((domain) => domain.trim())
  .filter(Boolean);

export default defineConfig({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID || undefined,
  worker: {
    name: process.env.WORKER_NAME || "agy-linear-bridge",
    entrypoint: "./src/edge/worker.mjs",
    compatibilityDate: "2026-11-17",
    compatibilityFlags: ["nodejs_compat"],
    domains: customDomains.length > 0 ? customDomains : undefined,
    observability: {
      enabled: true,
      logs: {
        enabled: true,
        headSamplingRate: 1,
      },
      traces: {
        enabled: true,
        headSamplingRate: 0.1,
      },
    },
    env: {
      DB: bindings.d1({
        name: process.env.D1_DATABASE_NAME || "agy-linear-bridge-db",
        ...(process.env.D1_DATABASE_ID ? { id: process.env.D1_DATABASE_ID } : {}),
      }),
      PUBLIC_BASE_URL: bindings.text(process.env.PUBLIC_BASE_URL || ""),
      LINEAR_OAUTH_SCOPES: bindings.text(
        process.env.LINEAR_OAUTH_SCOPES || "read,write,app:assignable,app:mentionable"
      ),
      LINEAR_AUTH_MODE: bindings.text(process.env.LINEAR_AUTH_MODE || "oauth"),
      GITHUB_CI_AUTO_FIX: bindings.text(process.env.GITHUB_CI_AUTO_FIX || "true"),
      GITHUB_REVIEW_AUTO_RESUME: bindings.text(process.env.GITHUB_REVIEW_AUTO_RESUME || "true"),
      GITHUB_MAX_CI_FIX_ROUNDS: bindings.text(process.env.GITHUB_MAX_CI_FIX_ROUNDS || "3"),
      GITHUB_IGNORED_ACTORS: bindings.text(process.env.GITHUB_IGNORED_ACTORS || ""),
      LINEAR_CLIENT_ID: bindings.secret(),
      LINEAR_CLIENT_SECRET: bindings.secret(),
      LINEAR_WEBHOOK_SECRET: bindings.secret(),
      RUNNER_SHARED_SECRET: bindings.secret(),
    },
  },
});
