import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseDotEnv } from "../config.mjs";
import {
  buildAuthorizeUrl,
  LinearTokenManager,
  OAuthStateStore,
} from "../linear-auth.mjs";
import { LinearClient } from "../linear-client.mjs";
import { TokenStore } from "../store.mjs";

test("parseDotEnv decodes wizard single-quoted escaped values accurately", () => {
  const raw = [
    "# comment",
    "PUBLIC_BASE_URL='https://bridge.example.com'",
    "LINEAR_WEBHOOK_SECRET='abc'\\''def=123'",
    'DOUBLE_VAL="line1\\nline2"',
    "PLAIN=hello # inline comment",
  ].join("\n");

  const parsed = parseDotEnv(raw);
  assert.equal(parsed.PUBLIC_BASE_URL, "https://bridge.example.com");
  assert.equal(parsed.LINEAR_WEBHOOK_SECRET, "abc'def=123");
  assert.equal(parsed.DOUBLE_VAL, "line1\nline2");
  assert.equal(parsed.PLAIN, "hello");
});

test("buildAuthorizeUrl sets actor=app and required scopes", () => {
  const url = new URL(
    buildAuthorizeUrl({
      clientId: "cid-1",
      redirectUri: "https://bridge.example.com/oauth/callback",
      scopes: ["read", "write", "app:assignable", "app:mentionable"],
      state: "state-xyz",
    })
  );
  assert.equal(url.origin + url.pathname, "https://linear.app/oauth/authorize");
  assert.equal(url.searchParams.get("actor"), "app");
  assert.equal(url.searchParams.get("client_id"), "cid-1");
  assert.equal(url.searchParams.get("state"), "state-xyz");
  assert.equal(
    url.searchParams.get("scope"),
    "read,write,app:assignable,app:mentionable"
  );
});

test("OAuthStateStore enforces single-use and TTL expiry", () => {
  let now = 1_000_000;
  const store = new OAuthStateStore({ ttlMs: 5_000, nowFn: () => now });
  const s1 = store.create({ ok: 1 });
  assert.deepEqual(store.consume(s1), { ok: 1 });
  assert.equal(store.consume(s1), null);

  const s2 = store.create({ ok: 2 });
  now += 6_000;
  assert.equal(store.consume(s2), null);
});

test("LinearTokenManager deduplicates refresh and LinearClient retries once on 401", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-linear-auth-"));
  try {
    const tokenStore = new TokenStore(path.join(tmpDir, "tokens.json"));
    let now = 1_000_000;
    let tokenCalls = 0;
    let graphqlCalls = 0;

    tokenStore.save({
      accessToken: "old-token",
      refreshToken: "refresh-1",
      expiresAt: now + 60_000, // within 5m refresh window
      authMode: "oauth",
    });

    const fetchImpl = async (url, init) => {
      if (url === "https://api.linear.app/oauth/token") {
        tokenCalls += 1;
        return new Response(
          JSON.stringify({
            access_token: `new-token-${tokenCalls}`,
            refresh_token: "refresh-2",
            expires_in: 3600,
          }),
          { status: 200 }
        );
      }

      graphqlCalls += 1;
      const auth = init.headers.Authorization;
      if (graphqlCalls === 1) {
        assert.equal(auth, "Bearer new-token-1");
        return new Response(JSON.stringify({ errors: [{ message: "expired" }] }), {
          status: 401,
        });
      }
      assert.equal(auth, "Bearer new-token-2");
      return new Response(
        JSON.stringify({
          data: { viewer: { id: "u1", name: "Agy", app: true } },
        }),
        { status: 200 }
      );
    };

    const manager = new LinearTokenManager({
      linearConfig: {
        clientId: "cid",
        clientSecret: "csec",
        oauthScopes: ["read", "write"],
        authMode: "oauth",
      },
      tokenStore,
      fetchImpl,
      nowFn: () => now,
    });

    // Two concurrent getAccessToken calls only refresh once
    const [t1, t2] = await Promise.all([
      manager.getAccessToken(),
      manager.getAccessToken(),
    ]);
    assert.equal(t1, "new-token-1");
    assert.equal(t2, "new-token-1");
    assert.equal(tokenCalls, 1);

    // LinearClient hits 401 on first call, forces refresh, and succeeds on retry
    const client = new LinearClient({ tokenManager: manager, fetchImpl });
    const viewer = await client.getViewer();
    assert.equal(viewer.viewer.app, true);
    assert.equal(tokenCalls, 2);
    assert.equal(graphqlCalls, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
