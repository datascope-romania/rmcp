import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../src/config.js";
import { createStdioBackend } from "../src/stdio.js";
import type { Backend, JsonRpcMessage } from "../src/types.js";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-mcp-server");
const ctx = { headers: {} };

function makeRt(env: Record<string, string> = {}): Runtime {
  return {
    serverId: "t", token: "tok", secrets: { SECRET_KEY: "from-ssm" },
    config: { mode: "stdio", binPath: "server.mjs", args: [], env },
  };
}

let backend: Backend;
beforeEach(() => {
  process.env.RMCP_TASK_ROOT = fixtureDir;
  process.env.RMCP_CHILD_CWD = fixtureDir;
  backend = createStdioBackend(makeRt({ PLAIN_KEY: "plain" }));
});

const req = (id: number | string, method: string, params?: unknown): JsonRpcMessage =>
  ({ jsonrpc: "2.0", id, method, params });

describe("createStdioBackend", () => {
  it("answers initialize from the cached child handshake", async () => {
    const r1 = await backend.handleRequest(req(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "0" } }), ctx);
    const r2 = await backend.handleRequest(req(9, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c2", version: "0" } }), ctx);
    expect((r1.message.result as any).serverInfo.name).toBe("fake-mcp-server");
    expect(r2.message.id).toBe(9);
    expect(r2.message.result).toEqual(r1.message.result);
  });

  it("forwards tools/list and tools/call with id mapping", async () => {
    const list = await backend.handleRequest(req(42, "tools/list"), ctx);
    expect(list.message.id).toBe(42);
    expect((list.message.result as any).tools).toHaveLength(4);
    const call = await backend.handleRequest(req("s-1", "tools/call", { name: "echo", arguments: { text: "hi" } }), ctx);
    expect(call.message.id).toBe("s-1");
    expect((call.message.result as any).content[0].text).toBe("hi");
  });

  it("injects plain env and SSM secrets into the child environment", async () => {
    const plain = await backend.handleRequest(req(1, "tools/call", { name: "env", arguments: { name: "PLAIN_KEY" } }), ctx);
    const secret = await backend.handleRequest(req(2, "tools/call", { name: "env", arguments: { name: "SECRET_KEY" } }), ctx);
    expect((plain.message.result as any).content[0].text).toBe("plain");
    expect((secret.message.result as any).content[0].text).toBe("from-ssm");
  });

  it("swallows notifications/initialized and forwards other notifications", async () => {
    await expect(backend.handleNotification({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx)).resolves.toBeUndefined();
    await expect(backend.handleNotification({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} }, ctx)).resolves.toBeUndefined();
  });

  it("returns a JSON-RPC error when the child dies mid-request, then respawns", async () => {
    const crash = await backend.handleRequest(req(5, "tools/call", { name: "crash", arguments: {} }), ctx);
    expect(crash.message.error?.code).toBe(-32603);
    expect(crash.message.id).toBe(5);
    const list = await backend.handleRequest(req(6, "tools/list"), ctx);
    expect((list.message.result as any).tools).toHaveLength(4);
  });

  it("propagates JSON-RPC errors from the child with the original id", async () => {
    const res = await backend.handleRequest(req(8, "tools/call", { name: "nope", arguments: {} }), ctx);
    expect(res.message.error?.code).toBe(-32602);
    expect(res.message.id).toBe(8);
  });

  it("prefers rt.taskRoot over the RMCP_TASK_ROOT env var", async () => {
    process.env.RMCP_TASK_ROOT = "/nonexistent";
    const b = createStdioBackend({ ...makeRt(), taskRoot: fixtureDir });
    const r = await b.handleRequest(req(1, "tools/list"), ctx);
    expect((r.message.result as any).tools).toHaveLength(4);
  });

  it("dispose kills the child; the next request respawns it", async () => {
    const first = await backend.handleRequest(req(1, "tools/call", { name: "pid", arguments: {} }), ctx);
    backend.dispose?.();
    const second = await backend.handleRequest(req(2, "tools/call", { name: "pid", arguments: {} }), ctx);
    expect(second.message.result).toBeDefined();
    expect((second.message.result as any).content[0].text)
      .not.toBe((first.message.result as any).content[0].text);
  });

  it("dispose during an in-flight cold start does not poison the next request", async () => {
    const inflight = backend.handleRequest(req(1, "tools/list"), ctx);
    backend.dispose?.();
    await inflight.catch(() => {}); // the disposed request may fail; that's fine
    const r = await backend.handleRequest(req(2, "tools/list"), ctx);
    expect((r.message.result as any).tools).toHaveLength(4);
  });
});
