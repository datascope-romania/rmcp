import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { makeRepo } from "../src/repo.js";
import { createApp } from "../src/app.js";

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "rmcp-oauth-life-"));
  const repo = makeRepo(openDb(path.join(dir, "test.db")));
  const deployer = {
    deploy: async () => ({ endpointUrl: "http://x/1", bearerToken: "b" }),
    undeploy: async () => {},
    deleteRemoteSecret: async () => {},
    listOrphans: async () => [],
    deleteOrphans: async () => {},
  } as any;
  return { repo, app: createApp({ repo, deployer }) };
}

describe("oauth credential lifecycle", () => {
  it("regenerates the client pair and drops existing grants", async () => {
    const { repo, app } = setup();
    const rec = repo.createServer("alpha", { type: "http", url: "https://example.com/mcp", headers: {} });
    repo.setServerState(rec.id, { deployedTarget: "local" });
    repo.setOAuthClient(rec.id, "old-id", "old-secret");
    repo.createToken({ token: "live", serverId: rec.id, kind: "access", expiresAt: "2999-01-01T00:00:00.000Z" });

    const res = await app.request(`/api/servers/${rec.id}/oauth/regenerate`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.oauthClientId).not.toBe("old-id");
    expect(body.oauthClientSecret).not.toBe("old-secret");
    expect(body.oauthClientId).toMatch(/^[\w-]{20,}$/);
    // revoking is the point: every previously issued token must be dead
    expect(repo.getToken("live")).toBeNull();
    expect(repo.getOAuthClientByClientId("old-id")).toBeNull();
  });

  it("404s regeneration for an unknown server", async () => {
    const { app } = setup();
    const res = await app.request("/api/servers/ghost/oauth/regenerate", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("400s regeneration for a server that isn't local-target", async () => {
    const { repo, app } = setup();
    const rec = repo.createServer("alpha", { type: "http", url: "https://example.com/mcp", headers: {} });
    // freshly created: deployedTarget is null (draft), never local
    const res = await app.request(`/api/servers/${rec.id}/oauth/regenerate`, { method: "POST" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/local-target/);
  });

  it("409s regeneration while a deploy is in flight for the server, and allows it once the deploy settles", async () => {
    const { repo } = setup();
    const rec = repo.createServer("alpha", { type: "http", url: "https://example.com/mcp", headers: {} });
    repo.setServerState(rec.id, { deployedTarget: "local" });
    repo.setOAuthClient(rec.id, "old-id", "old-secret");

    let resolveDeploy!: (v: { endpointUrl: string; bearerToken: string }) => void;
    const pendingDeploy = new Promise<{ endpointUrl: string; bearerToken: string }>((resolve) => {
      resolveDeploy = resolve;
    });
    const deployer = {
      deploy: async () => pendingDeploy,
      undeploy: async () => {},
      deleteRemoteSecret: async () => {},
      listOrphans: async () => [],
      deleteOrphans: async () => {},
    } as any;
    const app = createApp({ repo, deployer });

    const deployRes = await app.request(`/api/servers/${rec.id}/deploy`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "local" }),
    });
    expect(deployRes.status).toBe(202);

    // The deploy handler's async work is blocked on pendingDeploy: inflight
    // still holds the id, so regenerate must refuse rather than race it.
    const duringDeploy = await app.request(`/api/servers/${rec.id}/oauth/regenerate`, { method: "POST" });
    expect(duringDeploy.status).toBe(409);
    // The old pair must survive the refused attempt.
    expect(repo.getServer(rec.id)!.oauthClientId).toBe("old-id");

    resolveDeploy({ endpointUrl: "http://x/1", bearerToken: "b" });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const afterDeploy = await app.request(`/api/servers/${rec.id}/oauth/regenerate`, { method: "POST" });
    expect(afterDeploy.status).toBe(200);
  });
});

describe("redirect uri settings", () => {
  it("round-trips the allowlist", async () => {
    const { repo, app } = setup();
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        region: "us-east-1",
        oauthRedirectUris: ["https://claude.ai/api/mcp/auth_callback", "http://localhost:*"],
      }),
    });
    expect(res.status).toBe(200);
    expect(repo.getSettings().oauthRedirectUris).toEqual([
      "https://claude.ai/api/mcp/auth_callback", "http://localhost:*",
    ]);
  });

  it("rejects a non-string entry", async () => {
    const { app } = setup();
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ region: "us-east-1", oauthRedirectUris: [42] }),
    });
    expect(res.status).toBe(400);
  });
});
