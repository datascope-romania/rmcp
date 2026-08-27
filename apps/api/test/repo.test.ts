import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { makeRepo } from "../src/repo.js";

function tmpDbPath(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), "rmcp-repo-")), "rmcp.db");
}

const cfg = JSON.stringify({ type: "http", url: "https://u.example/mcp/", headers: {} });
const cfgSecretSet = JSON.stringify({
  type: "http", url: "https://u.example/mcp/",
  headers: { Authorization: { kind: "secret", set: true } },
});

// v1 schema, as created before this feature existed
function seedLegacyDb(dbPath: string): void {
  const raw = new Database(dbPath);
  raw.exec(`CREATE TABLE servers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, config_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft', endpoint_url TEXT, bearer_token TEXT,
    last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE deploy_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id TEXT NOT NULL,
      attempt TEXT NOT NULL, step TEXT NOT NULL, status TEXT NOT NULL, detail TEXT, ts TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const ins = raw.prepare(
    "INSERT INTO servers (id, name, config_json, status, endpoint_url, bearer_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '2026-07-01', '2026-07-01')",
  );
  ins.run("11111111-1111-4111-8111-111111111111", "was-deployed", cfg, "deployed", "https://f.lambda-url.aws/", "tok");
  ins.run("22222222-2222-4222-8222-222222222222", "pristine-draft", cfg, "draft", null, null);
  ins.run("33333333-3333-4333-8333-333333333333", "draft-secret-set", cfgSecretSet, "draft", null, null);
  raw.close();
}

describe("db migration", () => {
  it("backfills deployed_target and aws_footprint on legacy rows", () => {
    const dbPath = tmpDbPath();
    seedLegacyDb(dbPath);
    const repo = makeRepo(openDb(dbPath));
    const byName = Object.fromEntries(repo.listServers().map((s) => [s.name, s]));
    expect(byName["was-deployed"].deployedTarget).toBe("lambda");
    expect(byName["was-deployed"].awsFootprint).toBe(true);
    expect(byName["pristine-draft"].deployedTarget).toBeNull();
    expect(byName["pristine-draft"].awsFootprint).toBe(false);
    // a set secret was written straight to SSM under the old model
    expect(byName["draft-secret-set"].awsFootprint).toBe(true);
  });

  it("is idempotent (reopening an already-migrated db works)", () => {
    const dbPath = tmpDbPath();
    seedLegacyDb(dbPath);
    openDb(dbPath).close();
    const repo = makeRepo(openDb(dbPath));
    expect(repo.listServers()).toHaveLength(3);
  });
});

describe("oauth_client_id uniqueness", () => {
  // simulates the live production db: has the oauth_client_id/secret columns
  // (from an earlier migration) but predates the unique index, and every
  // existing row's oauth_client_id is NULL (no server has credentials yet)
  function seedPreIndexDb(dbPath: string): void {
    const raw = new Database(dbPath);
    raw.exec(`CREATE TABLE servers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, config_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft', endpoint_url TEXT, bearer_token TEXT,
      last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      deployed_target TEXT, aws_footprint INTEGER NOT NULL DEFAULT 0,
      folder TEXT, sort_index INTEGER NOT NULL DEFAULT 0,
      oauth_client_id TEXT, oauth_client_secret TEXT);
      CREATE TABLE deploy_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id TEXT NOT NULL,
        attempt TEXT NOT NULL, step TEXT NOT NULL, status TEXT NOT NULL, detail TEXT, ts TEXT NOT NULL);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    const ins = raw.prepare(
      "INSERT INTO servers (id, name, config_json, status, created_at, updated_at) VALUES (?, ?, ?, 'draft', '2026-07-01', '2026-07-01')",
    );
    ins.run("11111111-1111-4111-8111-111111111111", "existing-a", cfg);
    ins.run("22222222-2222-4222-8222-222222222222", "existing-b", cfg);
    ins.run("33333333-3333-4333-8333-333333333333", "existing-c", cfg);
    raw.close();
  }

  it("migrates safely over rows that already have a NULL oauth_client_id", () => {
    const dbPath = tmpDbPath();
    seedPreIndexDb(dbPath);
    // the migration itself (in openDb) must not throw despite three
    // pre-existing NULL oauth_client_id rows
    const repo = makeRepo(openDb(dbPath));
    expect(repo.listServers()).toHaveLength(3);
  });

  it("allows many servers to coexist with a NULL oauth_client_id", () => {
    const repo = makeRepo(openDb(tmpDbPath()));
    const a = repo.createServer("s-a", { type: "http", url: "https://u.example/mcp/", headers: {} });
    const b = repo.createServer("s-b", { type: "http", url: "https://u.example/mcp/", headers: {} });
    repo.createServer("s-c", { type: "http", url: "https://u.example/mcp/", headers: {} });
    expect(repo.getServer(a.id)!.oauthClientId).toBeNull();
    expect(repo.getServer(b.id)!.oauthClientId).toBeNull();
  });

  it("rejects assigning a duplicate client_id to a second server", () => {
    const repo = makeRepo(openDb(tmpDbPath()));
    const a = repo.createServer("s-x", { type: "http", url: "https://u.example/mcp/", headers: {} });
    const b = repo.createServer("s-y", { type: "http", url: "https://u.example/mcp/", headers: {} });
    repo.setOAuthClient(a.id, "dup-client-id", "secret-a");
    expect(() => repo.setOAuthClient(b.id, "dup-client-id", "secret-b")).toThrow();
  });
});

describe("secrets store", () => {
  it("upserts, reads, and deletes secret values per server", () => {
    const repo = makeRepo(openDb(tmpDbPath()));
    const rec = repo.createServer("s1", { type: "http", url: "https://u.example/mcp/", headers: {} });
    repo.putSecretValue(rec.id, "TOKEN", "v1");
    repo.putSecretValue(rec.id, "TOKEN", "v2"); // upsert
    repo.putSecretValue(rec.id, "OTHER", "x");
    expect(repo.getSecretValues(rec.id)).toEqual({ TOKEN: "v2", OTHER: "x" });
    repo.deleteSecretValue(rec.id, "TOKEN");
    expect(repo.getSecretValues(rec.id)).toEqual({ OTHER: "x" });
  });

  it("deleteServer removes its secrets", () => {
    const repo = makeRepo(openDb(tmpDbPath()));
    const rec = repo.createServer("s2", { type: "http", url: "https://u.example/mcp/", headers: {} });
    repo.putSecretValue(rec.id, "K", "v");
    repo.deleteServer(rec.id);
    expect(repo.getSecretValues(rec.id)).toEqual({});
  });
});

describe("server state", () => {
  it("persists deployedTarget and awsFootprint through setServerState", () => {
    const repo = makeRepo(openDb(tmpDbPath()));
    const rec = repo.createServer("s3", { type: "http", url: "https://u.example/mcp/", headers: {} });
    expect(rec.deployedTarget).toBeNull();
    expect(rec.awsFootprint).toBe(false);
    repo.setServerState(rec.id, { status: "deployed", deployedTarget: "local" });
    expect(repo.getServer(rec.id)!.deployedTarget).toBe("local");
    expect(repo.getServer(rec.id)!.awsFootprint).toBe(false);
    repo.setServerState(rec.id, { awsFootprint: true });
    expect(repo.getServer(rec.id)!.awsFootprint).toBe(true);
    // undeploy keeps the last target (drives the UI's default deploy action)
    repo.setServerState(rec.id, { status: "undeployed", endpointUrl: null });
    expect(repo.getServer(rec.id)!.deployedTarget).toBe("local");
  });

  it("settings roundtrip localGatewayPort", () => {
    const repo = makeRepo(openDb(tmpDbPath()));
    repo.putSettings({ region: "eu-west-1", localGatewayPort: 9000 });
    expect(repo.getSettings()).toEqual({ region: "eu-west-1", localGatewayPort: 9000 });
  });

  it("settings roundtrip publicMcpBaseUrl", () => {
    const repo = makeRepo(openDb(tmpDbPath()));
    repo.putSettings({ region: "us-east-1", publicMcpBaseUrl: "https://mcp.example.com/service" });
    expect(repo.getSettings()).toEqual({ region: "us-east-1", publicMcpBaseUrl: "https://mcp.example.com/service" });
  });
});

describe("folders + manual order", () => {
  it("migration backfills sort_index by name order and null folder", () => {
    const dbPath = tmpDbPath();
    seedLegacyDb(dbPath);
    const repo = makeRepo(openDb(dbPath));
    const list = repo.listServers();
    // alphabetical: draft-secret-set, pristine-draft, was-deployed
    expect(list.map((s) => s.name)).toEqual(["draft-secret-set", "pristine-draft", "was-deployed"]);
    expect(list.map((s) => s.sortIndex)).toEqual([0, 1, 2]);
    expect(list.every((s) => s.folder === null)).toBe(true);
  });

  it("createServer appends sortIndex and stores the folder", () => {
    const repo = makeRepo(openDb(tmpDbPath()));
    const a = repo.createServer("aaa", { type: "http", url: "https://u.example/mcp/", headers: {} });
    const b = repo.createServer("bbb", { type: "http", url: "https://u.example/mcp/", headers: {} }, "work");
    expect(a.sortIndex).toBe(0);
    expect(a.folder).toBeNull();
    expect(b.sortIndex).toBe(1);
    expect(b.folder).toBe("work");
  });

  it("setServerOrder reorders; listServers follows sort_index", () => {
    const repo = makeRepo(openDb(tmpDbPath()));
    const a = repo.createServer("aaa", { type: "http", url: "https://u.example/mcp/", headers: {} });
    const b = repo.createServer("bbb", { type: "http", url: "https://u.example/mcp/", headers: {} });
    const c = repo.createServer("ccc", { type: "http", url: "https://u.example/mcp/", headers: {} });
    repo.setServerOrder([c.id, a.id, b.id]);
    expect(repo.listServers().map((s) => s.name)).toEqual(["ccc", "aaa", "bbb"]);
  });

  it("setServerOrder rejects unknown, duplicate, and missing ids", () => {
    const repo = makeRepo(openDb(tmpDbPath()));
    const a = repo.createServer("aaa", { type: "http", url: "https://u.example/mcp/", headers: {} });
    const b = repo.createServer("bbb", { type: "http", url: "https://u.example/mcp/", headers: {} });
    expect(() => repo.setServerOrder([a.id, "11111111-1111-4111-8111-111111111111"])).toThrow(/unknown/);
    expect(() => repo.setServerOrder([a.id, a.id])).toThrow(/duplicate/);
    expect(() => repo.setServerOrder([a.id])).toThrow(/missing/);
    // failed calls must not have changed anything
    expect(repo.listServers().map((s) => s.id)).toEqual([a.id, b.id]);
  });

  it("updateServer sets and clears folder; setServerState leaves it alone", () => {
    const repo = makeRepo(openDb(tmpDbPath()));
    const a = repo.createServer("aaa", { type: "http", url: "https://u.example/mcp/", headers: {} });
    expect(repo.updateServer(a.id, { folder: "work" }).folder).toBe("work");
    repo.setServerState(a.id, { status: "deployed", deployedTarget: "local" });
    const after = repo.getServer(a.id)!;
    expect(after.folder).toBe("work");
    expect(after.sortIndex).toBe(0);
    expect(repo.updateServer(a.id, { folder: null }).folder).toBeNull();
  });
});
