import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../src/config.js";
import { createHttpProxyBackend } from "../src/httpProxy.js";

let server: Server;
let url: string;
let lastReq: { method: string; headers: Record<string, string | string[] | undefined>; body: string };
let respondWith: { status: number; headers: Record<string, string>; body: string };

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      lastReq = { method: req.method!, headers: req.headers, body };
      res.writeHead(respondWith.status, respondWith.headers);
      res.end(respondWith.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  url = `http://127.0.0.1:${addr.port}/mcp/`;
});
afterAll(() => server.close());

function makeRt(): Runtime {
  return {
    serverId: "t", token: "tok",
    secrets: { Authorization: "Bearer upstream-pat" },
    config: { mode: "http-proxy", upstreamUrl: url, headers: { "X-Extra": "1" } },
  };
}
const ctx = { headers: { "mcp-session-id": "sess-9", "mcp-protocol-version": "2025-06-18" } };

describe("createHttpProxyBackend", () => {
  it("forwards requests, injecting configured + secret headers and session headers", async () => {
    respondWith = {
      status: 200,
      headers: { "content-type": "application/json", "mcp-session-id": "sess-9" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
    };
    const res = await createHttpProxyBackend(makeRt()).handleRequest(
      { jsonrpc: "2.0", id: 1, method: "tools/list" }, ctx,
    );
    expect(lastReq.method).toBe("POST");
    expect(lastReq.headers.authorization).toBe("Bearer upstream-pat");
    expect(lastReq.headers["x-extra"]).toBe("1");
    expect(lastReq.headers["mcp-session-id"]).toBe("sess-9");
    expect(JSON.parse(lastReq.body).method).toBe("tools/list");
    expect(res.message.result).toEqual({ ok: true });
    expect(res.headers?.["mcp-session-id"]).toBe("sess-9");
  });

  it("extracts the matching JSON-RPC message from a buffered SSE response", async () => {
    respondWith = {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":5,"result":{"tools":[]}}\n\n',
    };
    const res = await createHttpProxyBackend(makeRt()).handleRequest(
      { jsonrpc: "2.0", id: 5, method: "tools/list" }, ctx,
    );
    expect(res.message.id).toBe(5);
    expect(res.message.result).toEqual({ tools: [] });
  });

  it("posts notifications and ignores the response body", async () => {
    respondWith = { status: 202, headers: {}, body: "" };
    await createHttpProxyBackend(makeRt()).handleNotification(
      { jsonrpc: "2.0", method: "notifications/initialized" }, ctx,
    );
    expect(JSON.parse(lastReq.body).method).toBe("notifications/initialized");
  });

  it("forwards DELETE and returns the upstream status", async () => {
    respondWith = { status: 204, headers: {}, body: "" };
    const status = await createHttpProxyBackend(makeRt()).handleDelete!(ctx);
    expect(lastReq.method).toBe("DELETE");
    expect(status).toBe(204);
  });

  it("throws a descriptive error on upstream 5xx", async () => {
    respondWith = { status: 502, headers: {}, body: "bad gateway" };
    await expect(
      createHttpProxyBackend(makeRt()).handleRequest({ jsonrpc: "2.0", id: 1, method: "ping" }, ctx),
    ).rejects.toThrow(/upstream returned 502/);
  });
});

describe("createHttpProxyBackend with OAuth refresh", () => {
  const TOKEN_URL = "https://oauth.test/token";
  const UPSTREAM = "https://upstream.test/mcp";

  interface Call { url: string; headers: Headers; body: string }

  function fakeFetch(opts: { upstreamStatus?: (bearer: string, n: number) => number; tokenError?: string } = {}) {
    const calls: Call[] = [];
    let minted = 0;
    let upstreamHits = 0;
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const body = init?.body ? String(init.body) : "";
      calls.push({ url, headers, body });
      if (url === TOKEN_URL) {
        if (opts.tokenError) {
          return new Response(JSON.stringify({ error: opts.tokenError, error_description: "Token has been expired or revoked." }), { status: 400 });
        }
        minted++;
        return new Response(JSON.stringify({ access_token: `at-${minted}`, expires_in: 3599 }), { status: 200 });
      }
      const bearer = headers.get("authorization") ?? "";
      const status = opts.upstreamStatus?.(bearer, upstreamHits++) ?? 200;
      return new Response(
        status === 200 ? JSON.stringify({ jsonrpc: "2.0", id: 1, result: { bearer } }) : "nope",
        { status, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    return { impl, calls, tokenCalls: () => calls.filter((c) => c.url === TOKEN_URL) };
  }

  function oauthRt(extraHeaders: Record<string, string> = {}): Runtime {
    return {
      serverId: "t", token: "tok",
      secrets: { "x-rmcp-oauth-client-secret": "cs", "x-rmcp-oauth-refresh-token": "rt-1" },
      config: {
        mode: "http-proxy", upstreamUrl: UPSTREAM,
        headers: { "x-rmcp-oauth-token-url": TOKEN_URL, "x-rmcp-oauth-client-id": "cid", "X-Extra": "1", ...extraHeaders },
      },
    };
  }
  const req = { jsonrpc: "2.0" as const, id: 1, method: "tools/list" };

  it("mints a bearer from the refresh token and never forwards the reserved entries", async () => {
    const f = fakeFetch();
    const res = await createHttpProxyBackend(oauthRt(), f.impl).handleRequest(req, ctx);
    expect(res.message.result).toEqual({ bearer: "Bearer at-1" });

    const tokenBody = new URLSearchParams(f.tokenCalls()[0].body);
    expect(Object.fromEntries(tokenBody)).toEqual({
      grant_type: "refresh_token", refresh_token: "rt-1", client_id: "cid", client_secret: "cs",
    });
    const upstream = f.calls.find((c) => c.url === UPSTREAM)!;
    expect([...upstream.headers.keys()].filter((k) => k.startsWith("x-rmcp-oauth-"))).toEqual([]);
    expect(upstream.headers.get("x-extra")).toBe("1");
    expect(upstream.headers.get("mcp-session-id")).toBe("sess-9");
  });

  it("replaces a user-configured Authorization header regardless of case", async () => {
    const f = fakeFetch();
    const res = await createHttpProxyBackend(oauthRt({ AUTHORIZATION: "Bearer stale" }), f.impl).handleRequest(req, ctx);
    expect(res.message.result).toEqual({ bearer: "Bearer at-1" });
  });

  it("caches the access token and shares one refresh across concurrent requests", async () => {
    const f = fakeFetch();
    const backend = createHttpProxyBackend(oauthRt(), f.impl);
    await Promise.all([backend.handleRequest(req, ctx), backend.handleRequest(req, ctx), backend.handleNotification(
      { jsonrpc: "2.0", method: "notifications/initialized" }, ctx,
    )]);
    await backend.handleRequest(req, ctx);
    expect(f.tokenCalls()).toHaveLength(1);
  });

  it("refreshes again once the cached token is within a minute of expiry", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeFetch();
      const backend = createHttpProxyBackend(oauthRt(), f.impl);
      await backend.handleRequest(req, ctx);
      vi.advanceTimersByTime(3599_000 - 59_000);
      const res = await backend.handleRequest(req, ctx);
      expect(res.message.result).toEqual({ bearer: "Bearer at-2" });
      expect(f.tokenCalls()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("on an upstream 401 drops the cached token, refreshes and retries once", async () => {
    const f = fakeFetch({ upstreamStatus: (bearer) => (bearer === "Bearer at-1" ? 401 : 200) });
    const res = await createHttpProxyBackend(oauthRt(), f.impl).handleRequest(req, ctx);
    expect(res.message.result).toEqual({ bearer: "Bearer at-2" });
    expect(f.tokenCalls()).toHaveLength(2);
  });

  it("does not loop when the upstream keeps answering 401", async () => {
    const f = fakeFetch({ upstreamStatus: () => 401 });
    await expect(createHttpProxyBackend(oauthRt(), f.impl).handleRequest(req, ctx)).rejects.toThrow(/upstream returned 401/);
    expect(f.calls.filter((c) => c.url === UPSTREAM)).toHaveLength(2);
  });

  it("explains how to recover when the refresh token is revoked", async () => {
    const f = fakeFetch({ tokenError: "invalid_grant" });
    await expect(createHttpProxyBackend(oauthRt(), f.impl).handleRequest(req, ctx))
      .rejects.toThrow(/revoked or expired.*pnpm google-token/);
  });

  it("defaults the token endpoint to Google's", async () => {
    const seen: string[] = [];
    const impl = (async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ access_token: "g", expires_in: 3599, jsonrpc: "2.0", id: 1, result: {} }), { status: 200 });
    }) as typeof fetch;
    const rt = oauthRt();
    if (rt.config.mode === "http-proxy") delete rt.config.headers["x-rmcp-oauth-token-url"];
    await createHttpProxyBackend(rt, impl).handleRequest(req, ctx);
    expect(seen[0]).toBe("https://oauth2.googleapis.com/token");
  });

  it("rejects a refresh token without its client credentials at mount time", () => {
    const rt = oauthRt();
    rt.secrets = { "x-rmcp-oauth-refresh-token": "rt-1" };
    expect(() => createHttpProxyBackend(rt, fakeFetch().impl)).toThrow(/needs x-rmcp-oauth-client-id and x-rmcp-oauth-client-secret/);
  });
});
