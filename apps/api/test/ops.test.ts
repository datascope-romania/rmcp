import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import type { DeployerPort } from "../src/deployer.js";
import { makeRepo, type Repo } from "../src/repo.js";

let app: ReturnType<typeof createApp>;
let repo: Repo;
let deployer: DeployerPort;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rmcp-ops-"));
  repo = makeRepo(openDb(path.join(dir, "test.db")));
  deployer = {
    deploy: vi.fn(async (_rec, _target, _secrets, onEvent) => {
      // one timer tick so the transient "deploying" status is observable
      await new Promise((r) => setTimeout(r, 5));
      onEvent({ step: "stage", status: "start" });
      onEvent({ step: "stage", status: "ok" });
      return { endpointUrl: "https://f.lambda-url.aws/", bearerToken: "tok-1" };
    }),
    undeploy: vi.fn(async () => {}),
    deleteAllParams: vi.fn(async () => {}),
    deleteRemoteSecret: vi.fn(async () => {}),
    removeLocalStaging: vi.fn(async () => {}),
    listOrphans: vi.fn(async () => []),
    destroyFunction: vi.fn(async () => {}),
  };
  app = createApp({ repo, deployer });
});

const httpBody = {
  name: "github-proxy",
  config: { type: "http", url: "https://api.example.com/mcp/", headers: { Authorization: { kind: "secret", set: false } } },
};

const httpCfg = { type: "http", url: "https://u.example/mcp/", headers: {} };

async function createServer() {
  const res = await app.request("/api/servers", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(httpBody),
  });
  return res.json();
}

async function createServerWith(name: string, config: unknown) {
  const res = await app.request("/api/servers", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, config }),
  });
  return res.json();
}

describe("deploy/undeploy", () => {
  it("deploys async: 202, then status deployed with endpoint, token, logs", async () => {
    const rec = await createServer();
    const res = await app.request(`/api/servers/${rec.id}/deploy`, { method: "POST" });
    expect(res.status).toBe(202);
    expect(repo.getServer(rec.id)!.status).toBe("deploying");
    await vi.waitFor(() => expect(repo.getServer(rec.id)!.status).toBe("deployed"));
    const after = repo.getServer(rec.id)!;
    expect(after.endpointUrl).toBe("https://f.lambda-url.aws/");
    expect(after.bearerToken).toBe("tok-1");
    expect(repo.latestDeployLogs(rec.id).map((l) => l.status)).toEqual(["start", "ok"]);
  });

  it("409s a deploy while one is in flight", async () => {
    const rec = await createServer();
    repo.setServerState(rec.id, { status: "deploying" });
    expect((await app.request(`/api/servers/${rec.id}/deploy`, { method: "POST" })).status).toBe(409);
  });

  it("records error status when the pipeline fails", async () => {
    (deployer.deploy as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("function: AccessDenied"));
    const rec = await createServer();
    await app.request(`/api/servers/${rec.id}/deploy`, { method: "POST" });
    await vi.waitFor(() => expect(repo.getServer(rec.id)!.status).toBe("error"));
    expect(repo.getServer(rec.id)!.lastError).toBe("function: AccessDenied");
  });

  it("undeploys: status undeployed, endpoint cleared, token kept", async () => {
    const rec = await createServer();
    repo.setServerState(rec.id, { status: "deployed", endpointUrl: "https://f.example/", bearerToken: "tok-1" });
    const res = await app.request(`/api/servers/${rec.id}/undeploy`, { method: "POST" });
    expect(res.status).toBe(200);
    const after = repo.getServer(rec.id)!;
    expect(after.status).toBe("undeployed");
    expect(after.endpointUrl).toBeNull();
    expect(after.bearerToken).toBe("tok-1");
    expect(deployer.undeploy).toHaveBeenCalledOnce();
  });
});

describe("secrets", () => {
  it("stores a declared secret and flips its set flag", async () => {
    const rec = await createServer();
    const res = await app.request(`/api/servers/${rec.id}/secrets/Authorization`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "Bearer pat-123" }),
    });
    expect(res.status).toBe(200);
    expect(repo.getSecretValues(rec.id)).toEqual({ Authorization: "Bearer pat-123" });
    const after = repo.getServer(rec.id)!;
    expect((after.config as any).headers.Authorization).toEqual({ kind: "secret", set: true });
  });

  it("400s a secret key not declared in the config", async () => {
    const rec = await createServer();
    const res = await app.request(`/api/servers/${rec.id}/secrets/UNDECLARED`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("propagates a secret deletion to SSM when the server has an AWS footprint", async () => {
    const rec = await createServer();
    repo.setServerState(rec.id, { awsFootprint: true });
    await app.request(`/api/servers/${rec.id}/secrets/Authorization`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "Bearer pat-123" }),
    });
    const res = await app.request(`/api/servers/${rec.id}/secrets/Authorization`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(deployer.deleteRemoteSecret).toHaveBeenCalledWith(rec.id, "Authorization");
  });

  it("skips the SSM revoke for a server that never touched AWS", async () => {
    const rec = await createServer();
    await app.request(`/api/servers/${rec.id}/secrets/Authorization`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "Bearer pat-123" }),
    });
    const res = await app.request(`/api/servers/${rec.id}/secrets/Authorization`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(deployer.deleteRemoteSecret).not.toHaveBeenCalled();
  });
});

describe("export", () => {
  it("400s when not deployed, returns snippets when deployed", async () => {
    const rec = await createServer();
    expect((await app.request(`/api/servers/${rec.id}/export`)).status).toBe(400);
    repo.setServerState(rec.id, { status: "deployed", endpointUrl: "https://f.example/", bearerToken: "tok-1" });
    const snippets = await (await app.request(`/api/servers/${rec.id}/export`)).json();
    expect(JSON.parse(snippets.vscode).servers["github-proxy"].headers.Authorization).toBe("Bearer tok-1");
    expect(JSON.parse(snippets.cursor).mcpServers["github-proxy"].url).toBe("https://f.example/");
    expect(snippets.claudeCli).toContain("claude mcp add --transport http github-proxy https://f.example/");
    expect(snippets.claudeDesktop).toContain("claude_desktop_config.json");
    expect(snippets.claudeDesktop).toContain("mcp-remote");
    expect(snippets.claudeDesktop).toContain("https://f.example/");
    expect(snippets.claudeDesktop).toContain("Bearer tok-1");
    expect(snippets.notion).toContain("Custom MCP server");
    expect(snippets.notion).toContain("https://f.example/");
    expect(snippets.notion).toContain("Bearer tok-1");
    expect(snippets.notion).toContain("github-proxy");
  });
});

describe("delete + orphans", () => {
  it("purges SSM params when a server that touched AWS is deleted", async () => {
    const rec = await createServer();
    repo.setServerState(rec.id, { status: "undeployed", bearerToken: "tok-1", awsFootprint: true });
    await app.request(`/api/servers/${rec.id}`, { method: "DELETE" });
    expect(deployer.deleteAllParams).toHaveBeenCalledWith(rec.id);
  });

  it("skips the SSM purge for a pristine draft (no AWS needed)", async () => {
    const rec = await createServer();
    const res = await app.request(`/api/servers/${rec.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(deployer.deleteAllParams).not.toHaveBeenCalled();
  });

  it("lists only orphans (AWS functions with no local record)", async () => {
    const rec = await createServer();
    (deployer.listOrphans as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { functionName: "rmcp-github-proxy", serverId: rec.id },
      { functionName: "rmcp-ghost", serverId: "dead-beef" },
    ]);
    const orphans = await (await app.request("/api/orphans")).json();
    expect(orphans).toEqual([{ functionName: "rmcp-ghost", serverId: "dead-beef" }]);
  });

  it("cleanup destroys the function and purges params", async () => {
    const res = await app.request("/api/orphans/cleanup", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ functionName: "rmcp-ghost", serverId: "dead-beef" }] }),
    });
    expect(res.status).toBe(200);
    expect(deployer.destroyFunction).toHaveBeenCalledWith("rmcp-ghost");
    expect(deployer.deleteAllParams).toHaveBeenCalledWith("dead-beef");
  });
});

describe("deploy targets", () => {
  it("defaults to lambda and records deployedTarget + awsFootprint", async () => {
    const rec = await createServerWith("t-lambda", httpCfg);
    await app.request(`/api/servers/${rec.id}/deploy`, { method: "POST" });
    await vi.waitFor(() => expect(repo.getServer(rec.id)!.status).toBe("deployed"));
    expect(deployer.deploy).toHaveBeenCalledWith(expect.objectContaining({ id: rec.id }), "lambda", {}, expect.any(Function));
    const after = repo.getServer(rec.id)!;
    expect(after.deployedTarget).toBe("lambda");
    expect(after.awsFootprint).toBe(true);
  });

  it("deploys locally without setting awsFootprint", async () => {
    const rec = await createServerWith("t-local", httpCfg);
    await app.request(`/api/servers/${rec.id}/deploy`, {
      method: "POST", body: JSON.stringify({ target: "local" }), headers: { "content-type": "application/json" },
    });
    await vi.waitFor(() => expect(repo.getServer(rec.id)!.status).toBe("deployed"));
    const after = repo.getServer(rec.id)!;
    expect(after.deployedTarget).toBe("local");
    expect(after.awsFootprint).toBe(false);
  });

  it("undeploys the other target first when switching (replace semantics)", async () => {
    const rec = await createServerWith("t-switch", httpCfg);
    repo.setServerState(rec.id, { status: "deployed", deployedTarget: "lambda", endpointUrl: "https://old/", bearerToken: "t", awsFootprint: true });
    await app.request(`/api/servers/${rec.id}/deploy`, {
      method: "POST", body: JSON.stringify({ target: "local" }), headers: { "content-type": "application/json" },
    });
    await vi.waitFor(() => expect(repo.getServer(rec.id)!.status).toBe("deployed"));
    expect(deployer.undeploy).toHaveBeenCalledTimes(1);
    const undeployOrder = (deployer.undeploy as any).mock.invocationCallOrder[0];
    const deployOrder = (deployer.deploy as any).mock.invocationCallOrder[0];
    expect(undeployOrder).toBeLessThan(deployOrder);
    expect(repo.getServer(rec.id)!.deployedTarget).toBe("local");
    expect(repo.getServer(rec.id)!.awsFootprint).toBe(true); // footprint is sticky
  });

  it("skips the old-target undeploy when nothing is deployed there", async () => {
    const rec = await createServerWith("t-stale-target", httpCfg);
    // deployedTarget survives undeploy as the UI's "last used target" hint, so an
    // undeployed server still carries deployedTarget=lambda. There is no live
    // Lambda to tear down, and on a local-only host the AWS call cannot even be
    // built (no credentials) — it must not run.
    repo.setServerState(rec.id, {
      status: "undeployed", deployedTarget: "lambda", endpointUrl: null, bearerToken: "t", awsFootprint: true,
    });
    await app.request(`/api/servers/${rec.id}/deploy`, {
      method: "POST", body: JSON.stringify({ target: "local" }), headers: { "content-type": "application/json" },
    });
    await vi.waitFor(() => expect(repo.getServer(rec.id)!.status).toBe("deployed"));
    expect(deployer.undeploy).not.toHaveBeenCalled();
    expect(repo.getServer(rec.id)!.deployedTarget).toBe("local");
  });

  it("clears endpointUrl when the switch-undeploy succeeded but the deploy failed", async () => {
    const rec = await createServerWith("t-switch-fail", httpCfg);
    repo.setServerState(rec.id, { status: "deployed", deployedTarget: "lambda", endpointUrl: "https://old/", bearerToken: "t", awsFootprint: true });
    (deployer.deploy as any).mockRejectedValueOnce(new Error("boom"));
    await app.request(`/api/servers/${rec.id}/deploy`, {
      method: "POST", body: JSON.stringify({ target: "local" }), headers: { "content-type": "application/json" },
    });
    await vi.waitFor(() => expect(repo.getServer(rec.id)!.status).toBe("error"));
    const after = repo.getServer(rec.id)!;
    expect(after.endpointUrl).toBeNull();       // old endpoint was torn down
    expect(after.deployedTarget).toBe("lambda"); // last-used target retained for the UI
    expect(after.bearerToken).toBe("t");         // token stays stable
  });

  it("keeps endpointUrl when a non-switch redeploy fails (no undeploy ran)", async () => {
    const rec = await createServerWith("t-redeploy-fail", httpCfg);
    repo.setServerState(rec.id, { status: "deployed", deployedTarget: "lambda", endpointUrl: "https://old/", bearerToken: "t", awsFootprint: true });
    (deployer.deploy as any).mockRejectedValueOnce(new Error("boom"));
    await app.request(`/api/servers/${rec.id}/deploy`, {
      method: "POST", body: JSON.stringify({ target: "lambda" }), headers: { "content-type": "application/json" },
    });
    await vi.waitFor(() => expect(repo.getServer(rec.id)!.status).toBe("error"));
    const after = repo.getServer(rec.id)!;
    expect(after.endpointUrl).toBe("https://old/"); // no target switch, no undeploy, endpoint still valid
    expect(deployer.undeploy).not.toHaveBeenCalled();
  });

  it("undeploys the old target when switching away from an error-state deploy (orphaned compute)", async () => {
    const rec = await createServerWith("t-error-switch", httpCfg);
    repo.setServerState(rec.id, {
      status: "error", deployedTarget: "lambda", endpointUrl: "https://old/", bearerToken: "t",
      awsFootprint: true, lastError: "healthcheck: boom",
    });
    await app.request(`/api/servers/${rec.id}/deploy`, {
      method: "POST", body: JSON.stringify({ target: "local" }), headers: { "content-type": "application/json" },
    });
    await vi.waitFor(() => expect(repo.getServer(rec.id)!.status).toBe("deployed"));
    expect(deployer.undeploy).toHaveBeenCalledOnce();
  });

  it("rejects local deploy when a set secret has no local value", async () => {
    const rec = await createServerWith("t-ssm-only", {
      type: "http", url: "https://u.example/mcp/",
      headers: { Authorization: { kind: "secret", set: true } },
    });
    const res = await app.request(`/api/servers/${rec.id}/deploy`, {
      method: "POST", body: JSON.stringify({ target: "local" }), headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain('re-enter secret "Authorization"');
    expect(repo.getServer(rec.id)!.status).toBe("draft"); // rejected before flipping to deploying
  });

  it("passes locally stored secrets into deploy", async () => {
    const rec = await createServerWith("t-secrets", {
      type: "http", url: "https://u.example/mcp/",
      headers: { Authorization: { kind: "secret", set: false } },
    });
    await app.request(`/api/servers/${rec.id}/secrets/Authorization`, {
      method: "PUT", body: JSON.stringify({ value: "Bearer up" }), headers: { "content-type": "application/json" },
    });
    await app.request(`/api/servers/${rec.id}/deploy`, {
      method: "POST", body: JSON.stringify({ target: "local" }), headers: { "content-type": "application/json" },
    });
    await vi.waitFor(() => expect(repo.getServer(rec.id)!.status).toBe("deployed"));
    expect(deployer.deploy).toHaveBeenCalledWith(expect.anything(), "local", { Authorization: "Bearer up" }, expect.any(Function));
  });
});

describe("footprint-aware delete", () => {
  it("skips the SSM purge for servers that never touched AWS", async () => {
    const rec = await createServerWith("t-del-local", httpCfg);
    repo.setServerState(rec.id, { status: "undeployed", deployedTarget: "local" });
    const res = await app.request(`/api/servers/${rec.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(deployer.deleteAllParams).not.toHaveBeenCalled();
    expect(deployer.removeLocalStaging).toHaveBeenCalledWith(rec.id);
  });

  it("purges SSM when the footprint flag is set", async () => {
    const rec = await createServerWith("t-del-aws", httpCfg);
    repo.setServerState(rec.id, { status: "undeployed", awsFootprint: true });
    await app.request(`/api/servers/${rec.id}`, { method: "DELETE" });
    expect(deployer.deleteAllParams).toHaveBeenCalledWith(rec.id);
  });

  it("undeploys a zombie local mount left behind by an error-state server", async () => {
    const rec = await createServerWith("t-del-error-local", httpCfg);
    repo.setServerState(rec.id, { status: "error", deployedTarget: "local", lastError: "healthcheck: boom" });
    const res = await app.request(`/api/servers/${rec.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(deployer.undeploy).toHaveBeenCalledOnce();
  });

  it("does not call undeploy for an error-state lambda server (orphans flow handles it)", async () => {
    const rec = await createServerWith("t-del-error-lambda", httpCfg);
    repo.setServerState(rec.id, { status: "error", deployedTarget: "lambda", awsFootprint: true, lastError: "healthcheck: boom" });
    const res = await app.request(`/api/servers/${rec.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(deployer.undeploy).not.toHaveBeenCalled();
  });
});
