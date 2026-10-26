import type { Runtime } from "./config.js";
import type { Backend, BackendResult, JsonRpcMessage, RequestCtx } from "./types.js";

const PASSTHROUGH_REQUEST_HEADERS = ["mcp-session-id", "mcp-protocol-version"];

// Reserved entries in the headers bag that turn on OAuth refresh instead of being
// forwarded: the proxy holds a refresh token and mints the upstream's bearer itself.
// They live in the headers bag (and so show up as "headers" in the UI) because that
// is where the secret store already is. Mint one with `pnpm google-token`.
const OAUTH_PREFIX = "x-rmcp-oauth-";
const OAUTH_KEYS = {
  tokenUrl: `${OAUTH_PREFIX}token-url`,
  clientId: `${OAUTH_PREFIX}client-id`,
  clientSecret: `${OAUTH_PREFIX}client-secret`,
  refreshToken: `${OAUTH_PREFIX}refresh-token`,
};
const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";
const EXPIRY_SKEW_MS = 60_000;

interface OAuthRefreshConfig { tokenUrl: string; clientId: string; clientSecret: string; refreshToken: string }

function parseSse(text: string, id: JsonRpcMessage["id"]): JsonRpcMessage {
  const messages: JsonRpcMessage[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try { messages.push(JSON.parse(line.slice(5).trim())); } catch { /* skip non-JSON data lines */ }
  }
  const match = messages.find((m) => m.id === id);
  const chosen = match ?? messages.at(-1);
  if (!chosen) throw new Error("upstream SSE response contained no JSON-RPC message");
  return chosen;
}

function splitOAuth(bag: Record<string, string>): { headers: Record<string, string>; oauth: OAuthRefreshConfig | null } {
  const headers: Record<string, string> = {};
  const reserved: Record<string, string> = {};
  for (const [k, v] of Object.entries(bag)) {
    if (k.toLowerCase().startsWith(OAUTH_PREFIX)) reserved[k.toLowerCase()] = v;
    else headers[k] = v;
  }
  const refreshToken = reserved[OAUTH_KEYS.refreshToken];
  if (!refreshToken) return { headers, oauth: null };
  const clientId = reserved[OAUTH_KEYS.clientId];
  const clientSecret = reserved[OAUTH_KEYS.clientSecret];
  if (!clientId || !clientSecret) {
    throw new Error(`${OAUTH_KEYS.refreshToken} needs ${OAUTH_KEYS.clientId} and ${OAUTH_KEYS.clientSecret}`);
  }
  return {
    headers,
    oauth: { tokenUrl: reserved[OAUTH_KEYS.tokenUrl] || DEFAULT_TOKEN_URL, clientId, clientSecret, refreshToken },
  };
}

function createTokenSource(oauth: OAuthRefreshConfig, fetchImpl: typeof fetch) {
  let cached: { token: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;

  async function refresh(): Promise<string> {
    const res = await fetchImpl(oauth.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: oauth.refreshToken,
        client_id: oauth.clientId,
        client_secret: oauth.clientSecret,
      }),
    });
    const body = await res.json().catch(() => ({})) as {
      access_token?: string; expires_in?: number; error?: string; error_description?: string;
    };
    if (body.error === "invalid_grant") {
      throw new Error(`refresh token was revoked or expired (${body.error_description ?? "invalid_grant"}) — ` +
        `mint a new one with \`pnpm google-token\` and update ${OAUTH_KEYS.refreshToken}`);
    }
    if (!res.ok || !body.access_token) {
      throw new Error(`token refresh failed (${res.status}): ${body.error ?? "no access_token"} ${body.error_description ?? ""}`.trim());
    }
    cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  return {
    async get(): Promise<string> {
      if (cached && cached.expiresAt - EXPIRY_SKEW_MS > Date.now()) return cached.token;
      // concurrent callers share one refresh round-trip
      inflight ??= refresh().finally(() => { inflight = null; });
      return inflight;
    },
    invalidate(): void { cached = null; },
  };
}

export function createHttpProxyBackend(rt: Runtime, fetchImpl: typeof fetch = fetch): Backend {
  if (rt.config.mode !== "http-proxy") throw new Error("not an http-proxy config");
  const cfg = rt.config;
  const { headers: staticHeaders, oauth } = splitOAuth({ ...cfg.headers, ...rt.secrets });
  const tokens = oauth ? createTokenSource(oauth, fetchImpl) : null;

  async function upstreamHeaders(ctx: RequestCtx): Promise<Headers> {
    const h = new Headers({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...staticHeaders,
    });
    for (const name of PASSTHROUGH_REQUEST_HEADERS) {
      if (ctx.headers[name]) h.set(name, ctx.headers[name]);
    }
    if (tokens) h.set("authorization", `Bearer ${await tokens.get()}`);
    return h;
  }

  // a 401 with a minted token most likely means it was revoked early: refresh once and retry
  async function send(init: { method: string; body?: string }, ctx: RequestCtx): Promise<Response> {
    const res = await fetchImpl(cfg.upstreamUrl, { ...init, headers: await upstreamHeaders(ctx) });
    if (res.status !== 401 || !tokens) return res;
    await res.body?.cancel();
    tokens.invalidate();
    return fetchImpl(cfg.upstreamUrl, { ...init, headers: await upstreamHeaders(ctx) });
  }

  return {
    async handleRequest(msg, ctx): Promise<BackendResult> {
      const res = await send({ method: "POST", body: JSON.stringify(msg) }, ctx);
      const text = await res.text();
      if (res.status >= 400) throw new Error(`upstream returned ${res.status}: ${text.slice(0, 200)}`);
      const message = (res.headers.get("content-type") ?? "").includes("text/event-stream")
        ? parseSse(text, msg.id)
        : (JSON.parse(text) as JsonRpcMessage);
      const sessionId = res.headers.get("mcp-session-id");
      return { message, headers: sessionId ? { "mcp-session-id": sessionId } : undefined };
    },
    async handleNotification(msg, ctx): Promise<void> {
      await send({ method: "POST", body: JSON.stringify(msg) }, ctx);
    },
    async handleDelete(ctx): Promise<number> {
      const res = await send({ method: "DELETE" }, ctx);
      return res.status;
    },
  };
}
