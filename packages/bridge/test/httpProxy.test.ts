import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
