import { describe, expect, it, vi } from "vitest";
import type { FnUrlEvent } from "@rmcp/bridge";
import { createGateway, type MountedServer } from "../src/local/gateway.js";
import type { OAuthProvider } from "../src/local/oauth.js";
import { Hono } from "hono";

function echoServer(): MountedServer & { events: FnUrlEvent[] } {
  const events: FnUrlEvent[] = [];
  return {
    events,
    async handle(event) {
      events.push(event);
      return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true }) };
    },
    dispose: vi.fn(),
  };
}

describe("local gateway", () => {
  it("routes POST /<id> to the mounted server with a translated event", async () => {
    const gw = createGateway();
    const srv = echoServer();
    gw.mount("alpha", srv);
    const res = await gw.app.request("/alpha", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer t" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const event = srv.events[0];
    expect(event.requestContext.http.method).toBe("POST");
    expect(event.headers?.authorization).toBe("Bearer t");
    expect(JSON.parse(event.body!)).toEqual({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(event.isBase64Encoded).toBe(false);
  });

  it("propagates the mounted server's status and headers", async () => {
    const gw = createGateway();
    gw.mount("alpha", {
      async handle() { return { statusCode: 401, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "unauthorized" }) }; },
      dispose: () => {},
    });
    const res = await gw.app.request("/alpha", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  it("404s for unknown ids", async () => {
    const gw = createGateway();
    expect((await gw.app.request("/ghost", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await gw.app.request("/whatever", { method: "GET" })).status).toBe(404);
  });

  it("mount replaces and unmount disposes", async () => {
    const gw = createGateway();
    const first = echoServer();
    gw.mount("alpha", first);
    gw.mount("alpha", echoServer());   // replace must dispose the old mount
    expect(first.dispose).toHaveBeenCalled();
    const second = echoServer();
    gw.mount("beta", second);
    gw.unmount("beta");
    expect(second.dispose).toHaveBeenCalled();
    expect(gw.ids()).toEqual(["alpha"]);
    expect((await gw.app.request("/beta", { method: "POST", body: "{}" })).status).toBe(404);
    gw.unmount("ghost"); // no-op, must not throw
  });

  it("handles a contentless response status (e.g. 204 from a session-close DELETE) without crashing", async () => {
    const gw = createGateway();
    gw.mount("alpha", {
      async handle() { return { statusCode: 204, headers: {}, body: "" }; },
      dispose: () => {},
    });
    const res = await gw.app.request("/alpha", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("answers JSON 500 when a mounted handler throws", async () => {
    const gw = createGateway();
    gw.mount("boom", { async handle() { throw new Error("kaboom"); }, dispose: () => {} });
    const res = await gw.app.request("/boom", { method: "POST", body: "{}" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal error" });
  });
});

function fakeOAuth(over: Partial<OAuthProvider> = {}): OAuthProvider {
  const routes = new Hono();
  routes.get("/.well-known/oauth-authorization-server", (c) => c.json({ issuer: "https://mcp.example.com" }));
  return { routes, resolve: () => null, challengeHeader: () => null, ...over };
}

describe("local gateway oauth integration", () => {
  it("serves oauth routes ahead of the /:id catch-all", async () => {
    const gw = createGateway({ oauth: fakeOAuth() });
    const res = await gw.app.request("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ issuer: "https://mcp.example.com" });
  });

  it("rewrites a resolved oauth token to the static bearer before dispatch", async () => {
    const gw = createGateway({ oauth: fakeOAuth({ resolve: () => "static-bearer" }) });
    const srv = echoServer();
    gw.mount("alpha", srv);
    await gw.app.request("/alpha", {
      method: "POST", headers: { authorization: "Bearer oauth-token" }, body: "{}",
    });
    expect(srv.events[0].headers?.authorization).toBe("Bearer static-bearer");
  });

  it("passes the header through untouched when nothing resolves", async () => {
    const gw = createGateway({ oauth: fakeOAuth() });
    const srv = echoServer();
    gw.mount("alpha", srv);
    await gw.app.request("/alpha", {
      method: "POST", headers: { authorization: "Bearer static-bearer" }, body: "{}",
    });
    expect(srv.events[0].headers?.authorization).toBe("Bearer static-bearer");
  });

  it("attaches the challenge to a 401 from the mounted server", async () => {
    const gw = createGateway({ oauth: fakeOAuth({ challengeHeader: () => 'Bearer resource_metadata="https://x/m"' }) });
    gw.mount("alpha", {
      async handle() { return { statusCode: 401, headers: {}, body: JSON.stringify({ error: "unauthorized" }) }; },
      dispose: () => {},
    });
    const res = await gw.app.request("/alpha", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://x/m"');
  });

  it("leaves non-401 responses without a challenge header", async () => {
    const gw = createGateway({ oauth: fakeOAuth({ challengeHeader: () => 'Bearer resource_metadata="https://x/m"' }) });
    gw.mount("alpha", echoServer());
    const res = await gw.app.request("/alpha", { method: "POST", body: "{}" });
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("does not challenge a 401 that arrived with an already-valid oauth token", async () => {
    // A request whose token already resolved got a 401 from the mounted server
    // itself (e.g. the upstream's own bad creds, per httpProxy's handleDelete
    // relaying the upstream status verbatim) — that 401 has nothing to do with
    // the client's rmcp token, so it must not be re-challenged into a loop.
    const gw = createGateway({
      oauth: fakeOAuth({
        resolve: () => "static-bearer",
        challengeHeader: () => 'Bearer resource_metadata="https://x/m"',
      }),
    });
    gw.mount("alpha", {
      async handle() { return { statusCode: 401, headers: {}, body: JSON.stringify({ error: "unauthorized" }) }; },
      dispose: () => {},
    });
    const res = await gw.app.request("/alpha", {
      method: "POST", headers: { authorization: "Bearer oauth-token" }, body: "{}",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });
});
