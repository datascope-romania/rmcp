import { describe, expect, it, vi } from "vitest";
import { makeHandler } from "../src/handler.js";
import type { Backend, FnUrlEvent } from "../src/types.js";
import type { Runtime } from "../src/config.js";

const rt: Runtime = {
  serverId: "t", token: "tok", secrets: {},
  config: { mode: "http-proxy", upstreamUrl: "https://u.example/", headers: {} },
};

function makeEvent(over: Partial<{ method: string; auth: string; body: unknown; raw: string }>): FnUrlEvent {
  return {
    requestContext: { http: { method: over.method ?? "POST" } },
    headers: { authorization: over.auth ?? "Bearer tok", "content-type": "application/json" },
    body: over.raw ?? (over.body !== undefined ? JSON.stringify(over.body) : undefined),
  };
}

function backend(over: Partial<Backend> = {}): Backend {
  return {
    handleRequest: vi.fn(async (msg) => ({ message: { jsonrpc: "2.0" as const, id: msg.id, result: { ok: true } } })),
    handleNotification: vi.fn(async () => {}),
    ...over,
  };
}

describe("makeHandler", () => {
  it("401s on bad token without touching the backend", async () => {
    const b = backend();
    const res = await makeHandler(async () => rt, () => b)(makeEvent({ auth: "Bearer wrong", body: { jsonrpc: "2.0", id: 1, method: "ping" } }));
    expect(res.statusCode).toBe(401);
    expect(b.handleRequest).not.toHaveBeenCalled();
  });

  it("405s GET", async () => {
    const res = await makeHandler(async () => rt, () => backend())(makeEvent({ method: "GET" }));
    expect(res.statusCode).toBe(405);
  });

  it("400s invalid JSON with a -32700 error", async () => {
    const res = await makeHandler(async () => rt, () => backend())(makeEvent({ raw: "{nope" }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe(-32700);
  });

  it("rejects batch arrays with -32600", async () => {
    const res = await makeHandler(async () => rt, () => backend())(makeEvent({ body: [{ jsonrpc: "2.0", id: 1, method: "ping" }] }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe(-32600);
  });

  it("routes requests to the backend and returns 200 JSON", async () => {
    const res = await makeHandler(async () => rt, () => backend())(makeEvent({ body: { jsonrpc: "2.0", id: 7, method: "tools/list" } }));
    expect(res.statusCode).toBe(200);
    expect(res.headers?.["content-type"]).toBe("application/json");
    expect(JSON.parse(res.body)).toEqual({ jsonrpc: "2.0", id: 7, result: { ok: true } });
  });

  it("returns 202 with empty body for notifications", async () => {
    const b = backend();
    const res = await makeHandler(async () => rt, () => b)(makeEvent({ body: { jsonrpc: "2.0", method: "notifications/initialized" } }));
    expect(res.statusCode).toBe(202);
    expect(b.handleNotification).toHaveBeenCalledOnce();
  });

  it("decodes base64 bodies", async () => {
    const ev = makeEvent({});
    ev.body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })).toString("base64");
    ev.isBase64Encoded = true;
    const res = await makeHandler(async () => rt, () => backend())(ev);
    expect(res.statusCode).toBe(200);
  });

  it("maps backend throws to a 500 JSON-RPC -32603 with the request id", async () => {
    const b = backend({ handleRequest: vi.fn(async () => { throw new Error("boom"); }) });
    const res = await makeHandler(async () => rt, () => b)(makeEvent({ body: { jsonrpc: "2.0", id: 3, method: "x" } }));
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe(-32603);
    expect(body.id).toBe(3);
  });

  it("DELETE returns 200 when the backend has no handleDelete", async () => {
    const res = await makeHandler(async () => rt, () => backend())(makeEvent({ method: "DELETE" }));
    expect(res.statusCode).toBe(200);
  });

  it("reuses one backend instance across invocations", async () => {
    const create = vi.fn(() => backend());
    const h = makeHandler(async () => rt, create);
    await h(makeEvent({ body: { jsonrpc: "2.0", id: 1, method: "ping" } }));
    await h(makeEvent({ body: { jsonrpc: "2.0", id: 2, method: "ping" } }));
    expect(create).toHaveBeenCalledOnce();
  });
});
