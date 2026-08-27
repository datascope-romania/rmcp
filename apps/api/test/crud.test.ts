import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { makeRepo, type Repo } from "../src/repo.js";
import { makeStubDeployer } from "./stub-deployer.js";

let app: ReturnType<typeof createApp>;
let repo: Repo;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rmcp-db-"));
  repo = makeRepo(openDb(path.join(dir, "test.db")));
  app = createApp({ repo, deployer: makeStubDeployer() });
});

const stdioBody = {
  name: "monday",
  config: { type: "stdio", package: "mcp-server-monday", version: "1.0.0", args: [], env: { MONDAY_API_KEY: { kind: "secret", set: false } } },
};

async function post(path: string, body?: unknown) {
  return app.request(path, {
    method: "POST", headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("server CRUD", () => {
  it("creates a draft server and lists it", async () => {
    const res = await post("/api/servers", stdioBody);
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.status).toBe("draft");
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    const list = await (await app.request("/api/servers")).json();
    expect(list).toHaveLength(1);
  });

  it("rejects invalid names and configs with 400", async () => {
    expect((await post("/api/servers", { ...stdioBody, name: "Bad Name!" })).status).toBe(400);
    expect((await post("/api/servers", { name: "ok", config: { type: "http", url: "not-a-url" } })).status).toBe(400);
  });

  it("rejects duplicate names with 409", async () => {
    await post("/api/servers", stdioBody);
    expect((await post("/api/servers", stdioBody)).status).toBe(409);
  });

  it("gets, updates, deletes", async () => {
    const created = await (await post("/api/servers", stdioBody)).json();
    expect((await app.request(`/api/servers/${created.id}`)).status).toBe(200);
    const upd = await app.request(`/api/servers/${created.id}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: { ...stdioBody.config, args: ["--verbose"] } }),
    });
    expect((await upd.json()).config.args).toEqual(["--verbose"]);
    expect((await app.request(`/api/servers/${created.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await app.request(`/api/servers/${created.id}`)).status).toBe(404);
  });

  it("refuses rename and delete while deployed", async () => {
    const created = await (await post("/api/servers", stdioBody)).json();
    repo.setServerState(created.id, { status: "deployed", endpointUrl: "https://f.example/" });
    const rename = await app.request(`/api/servers/${created.id}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "other" }),
    });
    expect(rename.status).toBe(409);
    expect((await app.request(`/api/servers/${created.id}`, { method: "DELETE" })).status).toBe(409);
  });

  it("allows renaming a deployed LOCAL server but still refuses a deployed LAMBDA server", async () => {
    const local = await (await post("/api/servers", stdioBody)).json();
    repo.setServerState(local.id, { status: "deployed", endpointUrl: "https://f.example/", deployedTarget: "local" });
    const localRename = await app.request(`/api/servers/${local.id}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "other-local" }),
    });
    expect(localRename.status).toBe(200);
    expect((await localRename.json()).name).toBe("other-local");

    const lambda = await (await post("/api/servers", { ...stdioBody, name: "lambda-one" })).json();
    repo.setServerState(lambda.id, { status: "deployed", endpointUrl: "https://f.example/", deployedTarget: "lambda" });
    const lambdaRename = await app.request(`/api/servers/${lambda.id}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "other-lambda" }),
    });
    expect(lambdaRename.status).toBe(409);
  });
});

describe("settings", () => {
  it("defaults and persists", async () => {
    expect(await (await app.request("/api/settings")).json()).toEqual({ region: "us-east-1" });
    await app.request("/api/settings", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ region: "eu-west-1", profile: "personal" }),
    });
    expect(await (await app.request("/api/settings")).json()).toEqual({ region: "eu-west-1", profile: "personal" });
  });
});

describe("folders + order routes", () => {
  it("creates with a folder and clears it via PUT", async () => {
    const created = await (await post("/api/servers", { ...stdioBody, folder: "atlassian" })).json();
    expect(created.folder).toBe("atlassian");
    const cleared = await (await app.request(`/api/servers/${created.id}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: null }),
    })).json();
    expect(cleared.folder).toBeNull();
  });

  it("rejects invalid folders with 400", async () => {
    expect((await post("/api/servers", { ...stdioBody, folder: "   " })).status).toBe(400);
    expect((await post("/api/servers", { ...stdioBody, folder: "x".repeat(61) })).status).toBe(400);
  });

  it("PUT /api/servers/order reorders and is not shadowed by :id", async () => {
    const a = await (await post("/api/servers", { ...stdioBody, name: "aaa" })).json();
    const b = await (await post("/api/servers", { ...stdioBody, name: "bbb" })).json();
    const res = await app.request("/api/servers/order", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [b.id, a.id] }),
    });
    expect(res.status).toBe(204); // 404 here means the :id route swallowed "order"
    const list = await (await app.request("/api/servers")).json();
    expect(list.map((s: { name: string }) => s.name)).toEqual(["bbb", "aaa"]);
  });

  it("order route 400s on unknown and missing ids", async () => {
    const a = await (await post("/api/servers", { ...stdioBody, name: "aaa" })).json();
    const bad = await app.request("/api/servers/order", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: ["22222222-2222-4222-8222-222222222222"] }),
    });
    expect(bad.status).toBe(400);
    const missing = await app.request("/api/servers/order", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [] }),
    });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toContain(a.id);
  });
});
