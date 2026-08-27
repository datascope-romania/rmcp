import { describe, expect, it, vi } from "vitest";
import { healthCheck } from "../src/healthcheck.js";

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

function fetchScript(responses: (Response | Error)[]): typeof fetch {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("fetch script exhausted");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
}

describe("healthCheck", () => {
  it("initializes, notifies, lists tools", async () => {
    const fetchImpl = fetchScript([
      ok({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "srv", version: "1" } } }),
      new Response("", { status: 202 }),
      ok({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "a" }, { name: "b" }] } }),
    ]);
    const res = await healthCheck("https://f.example/", "tok", { fetchImpl, delayMs: 1 });
    expect(res).toEqual({ serverName: "srv", toolCount: 2 });
    const firstCall = (fetchImpl as any).mock.calls[0];
    expect(firstCall[1].headers.authorization).toBe("Bearer tok");
    expect(firstCall[1].headers.accept).toBe("application/json, text/event-stream");
  });

  it("retries initialize on 5xx then succeeds", async () => {
    const fetchImpl = fetchScript([
      new Response("cold", { status: 503 }),
      ok({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "srv", version: "1" } } }),
      new Response("", { status: 202 }),
      ok({ jsonrpc: "2.0", id: 2, result: { tools: [] } }),
    ]);
    await expect(healthCheck("https://f.example/", "tok", { fetchImpl, delayMs: 1 })).resolves.toBeTruthy();
  });

  it("retries initialize on 403 (function URL policy propagation) then succeeds", async () => {
    const fetchImpl = fetchScript([
      new Response('{"Message":"Forbidden..."}', { status: 403 }),
      ok({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "srv", version: "1" } } }),
      new Response("", { status: 202 }),
      ok({ jsonrpc: "2.0", id: 2, result: { tools: [] } }),
    ]);
    await expect(healthCheck("https://f.example/", "tok", { fetchImpl, delayMs: 1 })).resolves.toBeTruthy();
  });

  it("explains persistent Function URL 403s with a guardrail hint", async () => {
    const forbidden = () => new Response('{"Message":"Forbidden. For troubleshooting Function URL authorization issues, see: ..."}', { status: 403 });
    const fetchImpl = fetchScript([forbidden(), forbidden(), forbidden(), forbidden(), forbidden()]);
    await expect(healthCheck("https://f.example/", "tok", { fetchImpl, delayMs: 1 }))
      .rejects.toThrow(/may block public Lambda Function URLs/);
  });

  it("throws when the endpoint returns a JSON-RPC error", async () => {
    const fetchImpl = fetchScript([
      ok({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "child failed to start" } }),
    ]);
    await expect(healthCheck("https://f.example/", "tok", { fetchImpl, delayMs: 1 })).rejects.toThrow(/child failed to start/);
  });
});
