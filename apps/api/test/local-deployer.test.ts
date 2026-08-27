import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ServerRecord } from "@rmcp/shared";
import { deployLocal, localHostname, rehydrateLocal, removeLocalStaging, undeployLocal, type LocalDeps } from "../src/local/deployer.js";
import { createGateway } from "../src/local/gateway.js";

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, "..", "..", "..", "packages", "bridge", "test", "fixtures", "fake-mcp-server");

let tgzPath: string;
let deps: LocalDeps;
let srv: ReturnType<ReturnType<typeof createGateway>["listen"]>;
let port = 0;

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function record(overrides: Partial<ServerRecord> = {}): ServerRecord {
  return {
    id: ID, name: "fixture",
    config: { type: "stdio", package: "fake-mcp-server", version: tgzPath, args: [], env: {} },
    status: "draft", deployedTarget: null, awsFootprint: false, folder: null, sortIndex: 0,
    endpointUrl: null, bearerToken: null, oauthClientId: null, oauthClientSecret: null, lastError: null,
    createdAt: "2026-07-11T00:00:00Z", updatedAt: "2026-07-11T00:00:00Z",
    ...overrides,
  };
}

beforeAll(async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rmcp-localdep-"));
  const { stdout } = await exec("npm", ["pack", fixtureDir, "--pack-destination", tmp]);
  tgzPath = path.join(tmp, stdout.trim().split("\n").at(-1)!);
  const gateway = createGateway();
  srv = gateway.listen(0);
  await new Promise<void>((r) => srv.once("listening", () => r()));
  port = (srv.address() as AddressInfo).port;
  deps = { gateway, localRoot: await mkdtemp(path.join(os.tmpdir(), "rmcp-localroot-")), getPort: () => port, healthDelayMs: 50 };
}, 120_000);

afterAll(() => { srv?.close(); });

async function mcp(token: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/${ID}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, accept: "application/json" },
    body: JSON.stringify(body),
  });
}

describe("deployLocal (stdio)", () => {
  it("stages, registers, healthchecks, and serves real MCP over the gateway", { timeout: 120_000 }, async () => {
    const events: { step: string; status: string }[] = [];
    const res = await deployLocal(record(), {}, deps, (e) => events.push(e));
    expect(events.filter((e) => e.status === "start").map((e) => e.step)).toEqual(["stage", "register", "healthcheck"]);
    expect(events.every((e) => e.status !== "fail")).toBe(true);
    expect(res.endpointUrl).toBe(`http://${localHostname()}:${port}/${ID}`);
    expect(res.bearerToken).toHaveLength(43); // 32 random bytes, base64url

    const list = await mcp(res.bearerToken, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(list.status).toBe(200);
    expect(((await list.json()) as any).result.tools.length).toBeGreaterThan(0);

    const bad = await mcp("wrong-token", { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(bad.status).toBe(401);
  });

  it("keeps an existing bearer token on redeploy", { timeout: 120_000 }, async () => {
    const res = await deployLocal(record({ bearerToken: "keep-me" }), {}, deps);
    expect(res.bearerToken).toBe("keep-me");
  });

  it("keeps an existing oauth client pair on redeploy", { timeout: 120_000 }, async () => {
    const res = await deployLocal(record({ oauthClientId: "keep-id", oauthClientSecret: "keep-secret" }), {}, deps);
    expect(res.oauthClientId).toBe("keep-id");
    expect(res.oauthClientSecret).toBe("keep-secret");
  });

  it("generates fresh oauth client pair when null", { timeout: 120_000 }, async () => {
    const res = await deployLocal(record({ oauthClientId: null, oauthClientSecret: null }), {}, deps);
    expect(res.oauthClientId).toHaveLength(22); // 16 random bytes, base64url
    expect(res.oauthClientSecret).toHaveLength(43); // 32 random bytes, base64url
    expect(res.oauthClientId).not.toBe("");
    expect(res.oauthClientSecret).not.toBe("");
  });

  it("undeployLocal unmounts (404) but keeps the staged dir", async () => {
    await undeployLocal(record(), deps);
    const res = await mcp("any", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(404);
    await stat(path.join(deps.localRoot, record().id)); // staging survives undeploy
  });
});

describe("rehydrateLocal", () => {
  it("re-mounts locally-deployed servers from the staged dir", { timeout: 60_000 }, async () => {
    const rec = record({ status: "deployed", deployedTarget: "local", bearerToken: "rehydrated-tok" });
    const markError = vi.fn();
    await rehydrateLocal([rec], () => ({}), deps, markError);
    expect(markError).not.toHaveBeenCalled();
    const res = await mcp("rehydrated-tok", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(200);
  });

  it("prunes orphan staging dirs and flags servers with missing staging", async () => {
    await mkdir(path.join(deps.localRoot, "dead-beef"), { recursive: true });
    const rec = record({ status: "deployed", deployedTarget: "local", bearerToken: "t" });
    await removeLocalStaging(deps.localRoot, rec.id);
    const markError = vi.fn();
    await rehydrateLocal([rec], () => ({}), deps, markError);
    expect(markError).toHaveBeenCalledWith(rec.id, expect.stringContaining("redeploy"));
    await expect(stat(path.join(deps.localRoot, "dead-beef"))).rejects.toThrow();
  });

  it("skips servers that are not locally deployed", async () => {
    const markError = vi.fn();
    await rehydrateLocal([record({ status: "deployed", deployedTarget: "lambda", bearerToken: "t" })], () => ({}), deps, markError);
    expect(markError).not.toHaveBeenCalled();
  });

  // macOS-only: uses `chflags uchg` to make an orphan's entry un-removable so `rm(..., {force: true})`
  // rejects (force only swallows ENOENT, not EPERM). Proves pruning is best-effort per entry and a
  // failed prune does not abort mounting the rest of the records.
  it.skipIf(process.platform !== "darwin")(
    "continues processing records when pruning an orphan directory fails",
    { timeout: 60_000 },
    async () => {
      const stuckOrphan = path.join(deps.localRoot, "stuck-orphan");
      const stuckFile = path.join(stuckOrphan, "stuck.txt");
      await mkdir(stuckOrphan, { recursive: true });
      await writeFile(stuckFile, "immovable");
      await exec("chflags", ["uchg", stuckFile]);
      const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        // an earlier test in this suite removed this id's staging dir; restage so this test
        // doesn't depend on suite ordering.
        await deployLocal(record({ bearerToken: "rehydrated-tok" }), {}, deps);
        const rec = record({ status: "deployed", deployedTarget: "local", bearerToken: "rehydrated-tok" });
        const markError = vi.fn();
        await rehydrateLocal([rec], () => ({}), deps, markError);
        expect(markError).not.toHaveBeenCalled();
        const res = await mcp("rehydrated-tok", { jsonrpc: "2.0", id: 1, method: "tools/list" });
        expect(res.status).toBe(200);
        expect(consoleErr).toHaveBeenCalledWith(expect.stringContaining("failed to prune orphan staging"), expect.anything());
        await expect(stat(stuckFile)).resolves.toBeTruthy(); // the stuck orphan survives — prune failed but didn't throw
      } finally {
        consoleErr.mockRestore();
        await exec("chflags", ["nouchg", stuckFile]).catch(() => {});
        await rm(stuckOrphan, { recursive: true, force: true }).catch(() => {});
      }
    },
  );
});
