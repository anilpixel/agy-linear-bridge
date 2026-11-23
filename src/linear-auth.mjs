import crypto from "node:crypto";

const LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Build Linear OAuth2 install URL requesting `actor=app` identity.
 */
export function buildAuthorizeUrl({ clientId, redirectUri, scopes, state }) {
  if (!clientId) {
    throw new Error("Missing LINEAR_CLIENT_ID");
  }
  if (!redirectUri) {
    throw new Error("Missing redirectUri");
  }
  const scopeStr = Array.isArray(scopes) ? scopes.join(",") : String(scopes || "");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopeStr,
    actor: "app",
    state,
  });
  return `${LINEAR_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Single-use CSRF state store with TTL for OAuth browser flows.
 */
export class OAuthStateStore {
  constructor({ ttlMs = 10 * 60 * 1000, nowFn = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.nowFn = nowFn;
    this.states = new Map();
  }

  create(metadata = {}) {
    this._prune();
    const state = crypto.randomBytes(24).toString("hex");
    this.states.set(state, {
      metadata,
      expiresAt: this.nowFn() + this.ttlMs,
    });
    return state;
  }

  consume(state) {
    this._prune();
    if (!state || !this.states.has(state)) {
      return null;
    }
    const entry = this.states.get(state);
    this.states.delete(state);
    if (entry.expiresAt < this.nowFn()) {
      return null;
    }
    return entry.metadata;
  }

  _prune() {
    const now = this.nowFn();
    for (const [key, entry] of this.states.entries()) {
      if (entry.expiresAt < now) {
        this.states.delete(key);
      }
    }
  }
}

async function postTokenForm(params, fetchImpl = fetch) {
  const response = await fetchImpl(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(params).toString(),
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok || !json?.access_token) {
    const detail = json?.error_description || json?.error || text || `HTTP ${response.status}`;
    const err = new Error(`Linear OAuth token request failed: ${detail}`);
    err.status = response.status;
    err.body = json || text;
    throw err;
  }

  return json;
}

export async function exchangeAuthorizationCode({
  clientId,
  clientSecret,
  redirectUri,
  code,
  fetchImpl = fetch,
}) {
  return postTokenForm(
    {
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
    },
    fetchImpl
  );
}

export async function refreshAccessToken({
  clientId,
  clientSecret,
  refreshToken,
  fetchImpl = fetch,
}) {
  return postTokenForm(
    {
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    },
    fetchImpl
  );
}

export async function fetchClientCredentialsToken({
  clientId,
  clientSecret,
  scopes,
  fetchImpl = fetch,
}) {
  const scopeStr = Array.isArray(scopes) ? scopes.join(",") : String(scopes || "");
  return postTokenForm(
    {
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      ...(scopeStr ? { scope: scopeStr } : {}),
    },
    fetchImpl
  );
}

function normalizeTokenRecord(raw, { authMode, previousRefreshToken = null, nowMs }) {
  const expiresInSec = Number(raw.expires_in);
  const expiresAt =
    Number.isFinite(expiresInSec) && expiresInSec > 0 ? nowMs + expiresInSec * 1000 : null;
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? previousRefreshToken ?? null,
    tokenType: raw.token_type || "Bearer",
    scope: raw.scope || "",
    expiresAt,
    authMode,
    actor: "app",
    updatedAt: new Date(nowMs).toISOString(),
  };
}

/**
 * Manages persisted Linear app-actor tokens and automatic single-flight refreshes.
 */
export class LinearTokenManager {
  constructor({ linearConfig, tokenStore, fetchImpl = fetch, nowFn = Date.now }) {
    this.linearConfig = linearConfig;
    this.tokenStore = tokenStore;
    this.fetchImpl = (...args) => fetchImpl(...args);
    this.nowFn = nowFn;
    this._inflightRefresh = null;
  }

  hasToken() {
    const stored = this.tokenStore.load();
    if (stored && typeof stored.then === "function") {
      return stored.then((s) => Boolean(s?.accessToken));
    }
    return Boolean(stored?.accessToken);
  }

  async saveInitialOAuthToken(rawTokenResponse) {
    const record = normalizeTokenRecord(rawTokenResponse, {
      authMode: "oauth",
      nowMs: this.nowFn(),
    });
    return await this.tokenStore.save(record);
  }

  async getAccessToken({ forceRefresh = false } = {}) {
    if (this._inflightRefresh) {
      return this._inflightRefresh;
    }

    const loaded = this.tokenStore.load();
    const stored =
      loaded && typeof loaded.then === "function" ? await loaded : loaded;
    const now = this.nowFn();
    const isFresh =
      stored?.accessToken &&
      (!stored.expiresAt || stored.expiresAt - now > TOKEN_REFRESH_MARGIN_MS);

    if (!forceRefresh && isFresh) {
      return stored.accessToken;
    }

    if (this._inflightRefresh) {
      return this._inflightRefresh;
    }

    this._inflightRefresh = this._refreshOrFetch(stored, forceRefresh).finally(() => {
      this._inflightRefresh = null;
    });
    return this._inflightRefresh;
  }

  async _refreshOrFetch(stored, forceRefresh) {
    const { clientId, clientSecret, oauthScopes, authMode } = this.linearConfig;
    const now = this.nowFn();

    if (stored?.refreshToken) {
      if (!clientId || !clientSecret) {
        throw new Error(
          "Cannot refresh Linear OAuth token without LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET"
        );
      }
      const raw = await refreshAccessToken({
        clientId,
        clientSecret,
        refreshToken: stored.refreshToken,
        fetchImpl: this.fetchImpl,
      });
      const updated = normalizeTokenRecord(raw, {
        authMode: "oauth",
        previousRefreshToken: stored.refreshToken,
        nowMs: now,
      });
      await this.tokenStore.save(updated);
      return updated.accessToken;
    }

    if (authMode === "client_credentials") {
      if (!clientId || !clientSecret) {
        throw new Error(
          "LINEAR_AUTH_MODE=client_credentials requires LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET"
        );
      }
      const raw = await fetchClientCredentialsToken({
        clientId,
        clientSecret,
        scopes: oauthScopes,
        fetchImpl: this.fetchImpl,
      });
      const updated = normalizeTokenRecord(raw, {
        authMode: "client_credentials",
        nowMs: now,
      });
      await this.tokenStore.save(updated);
      return updated.accessToken;
    }

    if (stored?.accessToken && !forceRefresh && (!stored.expiresAt || stored.expiresAt > now)) {
      return stored.accessToken;
    }

    throw new Error(
      "Linear App token is missing or expired. Visit /oauth/start or run `npm run setup:linear` to authorize."
    );
  }
}
