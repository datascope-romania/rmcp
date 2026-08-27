import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import type { DeployerPort } from "../src/deployer.js";
import { deployLocal, removeLocalStaging, undeployLocal, type LocalDeps } from "../src/local/deployer.js";
import { createGateway } from "../src/local/gateway.js";
import { makeRepo, type Repo } from "../src/repo.js";

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, "..", "..", "..", "packages", "bridge", "test", "fixtures", "fake-mcp-server");

let app: ReturnType<typeof createApp>;
let repo: Repo;
let local: LocalDeps;
let srv: ReturnType<ReturnType<typeof createGateway>["listen"]>;
let port = 0;
let tgzPath: string;

beforeAll(async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "rmcp-e2e-"));
  const { stdout } = await exec("npm", ["pack", fixtureDir, "--pack-destination", tmp]);
  tgzPath = path.join(tmp, stdout.trim().split("\n").at(-1)!);

  repo = makeRepo(openDb(path.join(tmp, "rmcp.db")));
  const gateway = createGateway();
  srv = gateway.listen(0);
  await new Promise<void>((r) => srv.once("listening", () => r()));
  port = (srv.address() as AddressInfo).port;
  local = { gateway, localRoot: path.join(tmp, "local"), getPort: () => port, healthDelayMs: 50 };
  // Mirror production (index.ts): the gateway's actual port must be reflected
  // in settings so read-time endpoint URL rendering (withDisplayEndpoint) agrees
  // with where the gateway is really listening.
  repo.putSettings({ region: "us-east-1", localGatewayPort: port });

  const deployer: DeployerPort = {
    deploy: (rec, target, secrets, onEvent) => {
      if (target !== "local") throw new Error("lambda is stubbed out in this test");
      return deployLocal(rec, secrets, local, onEvent);
    },
    undeploy: (rec) => undeployLocal(rec, local),
    deleteAllParams: async () => {},
    deleteRemoteSecret: async () => {},
    removeLocalStaging: (id) => removeLocalStaging(local.localRoot, id),
    listOrphans: async () => [],
    destroyFunction: async () => {},
  };
  app = createApp({ repo, deployer });
}, 120_000);

afterAll(() => { srv?.close(); });

async function waitForStatus(id: string, status: string, timeoutMs = 90_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rec = repo.getServer(id)!;
    if (rec.status === status) return;
    if (rec.status === "error") throw new Error(`deploy failed: ${rec.lastError}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for status=${status}`);
}

describe("local deploy end-to-end through the HTTP API", () => {
  it("create → deploy locally → speak MCP through the gateway → undeploy", { timeout: 120_000 }, async () => {
    const createRes = await app.request("/api/servers", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "e2e",
        config: { type: "stdio", package: "fake-mcp-server", version: tgzPath, args: [], env: {} },
      }),
    });
    expect(createRes.status).toBe(201);
    const rec = (await createRes.json()) as { id: string };

    const deployRes = await app.request(`/api/servers/${rec.id}/deploy`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "local" }),
    });
    expect(deployRes.status).toBe(202);
    await waitForStatus(rec.id, "deployed");

    const after = repo.getServer(rec.id)!;
    expect(after.deployedTarget).toBe("local");
    expect(after.endpointUrl).toContain(`:${port}/${after.id}`);
    expect(after.awsFootprint).toBe(false);

    const init = await fetch(`http://127.0.0.1:${port}/${after.id}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${after.bearerToken}` },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } },
      }),
    });
    expect(init.status).toBe(200);
    expect(((await init.json()) as any).result.serverInfo.name).toBe("fake-mcp-server");

    // export snippets work for the local target
    const exportRes = await app.request(`/api/servers/${rec.id}/export`);
    expect(exportRes.status).toBe(200);
    expect(((await exportRes.json()) as any).vscode).toContain(after.endpointUrl);

    const undeployRes = await app.request(`/api/servers/${rec.id}/undeploy`, { method: "POST" });
    expect(undeployRes.status).toBe(200);
    expect(((await undeployRes.json()) as any).deployedTarget).toBe("local"); // survives undeploy
    const gone = await fetch(`http://127.0.0.1:${port}/${after.id}`, { method: "POST", body: "{}" });
    expect(gone.status).toBe(404);
  });
});
