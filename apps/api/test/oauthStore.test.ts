import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { makeRepo } from "../src/repo.js";

function freshRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "rmcp-oauth-"));
  return makeRepo(openDb(path.join(dir, "test.db")));
}

describe("oauth store", () => {
  it("stores and looks up a client by client_id", () => {
    const repo = freshRepo();
    const rec = repo.createServer("alpha", { type: "http", url: "https://example.com/mcp", headers: {} });
    repo.setOAuthClient(rec.id, "cid-1", "secret-1");

    expect(repo.getOAuthClientByClientId("cid-1")).toEqual({
      serverId: rec.id, clientId: "cid-1", clientSecret: "secret-1",
    });
    expect(repo.getOAuthClientByClientId("nope")).toBeNull();
    expect(repo.getServer(rec.id)!.oauthClientId).toBe("cid-1");
    expect(repo.getServer(rec.id)!.oauthClientSecret).toBe("secret-1");
  });

  it("makes an auth code single-use", () => {
    const repo = freshRepo();
    const rec = repo.createServer("alpha", { type: "http", url: "https://example.com/mcp", headers: {} });
    const row = {
      code: "c1", serverId: rec.id, redirectUri: "https://claude.ai/api/mcp/auth_callback",
      codeChallenge: "chal", resource: null, expiresAt: "2999-01-01T00:00:00.000Z",
    };
    repo.createAuthCode(row);

    expect(repo.takeAuthCode("c1")).toEqual(row);
    expect(repo.takeAuthCode("c1")).toBeNull();   // replay must fail
  });

  it("stores, reads and deletes tokens", () => {
    const repo = freshRepo();
    const rec = repo.createServer("alpha", { type: "http", url: "https://example.com/mcp", headers: {} });
    repo.createToken({ token: "at", serverId: rec.id, kind: "access", expiresAt: "2999-01-01T00:00:00.000Z" });
    repo.createToken({ token: "rt", serverId: rec.id, kind: "refresh", expiresAt: null });

    expect(repo.getToken("at")).toMatchObject({ serverId: rec.id, kind: "access" });
    expect(repo.getToken("rt")).toMatchObject({ kind: "refresh", expiresAt: null });
    repo.deleteToken("rt");
    expect(repo.getToken("rt")).toBeNull();
  });

  it("prunes expired codes opportunistically on createAuthCode, leaving live ones alone", () => {
    const repo = freshRepo();
    const rec = repo.createServer("alpha", { type: "http", url: "https://example.com/mcp", headers: {} });
    repo.createAuthCode({
      code: "expired", serverId: rec.id, redirectUri: "https://x/cb", codeChallenge: "c",
      resource: null, expiresAt: "2000-01-01T00:00:00.000Z",
    });
    repo.createAuthCode({
      code: "live", serverId: rec.id, redirectUri: "https://x/cb", codeChallenge: "c",
      resource: null, expiresAt: "2999-01-01T00:00:00.000Z",
    });

    // A LATER createAuthCode call is what triggers the prune.
    repo.createAuthCode({
      code: "trigger", serverId: rec.id, redirectUri: "https://x/cb", codeChallenge: "c",
      resource: null, expiresAt: "2999-01-01T00:00:00.000Z",
    });

    expect(repo.takeAuthCode("expired")).toBeNull();
    expect(repo.takeAuthCode("live")).not.toBeNull();
    expect(repo.takeAuthCode("trigger")).not.toBeNull();
  });

  it("prunes expired access tokens on createToken, but never touches refresh tokens (NULL expiry)", () => {
    const repo = freshRepo();
    const rec = repo.createServer("alpha", { type: "http", url: "https://example.com/mcp", headers: {} });
    repo.createToken({ token: "stale-access", serverId: rec.id, kind: "access", expiresAt: "2000-01-01T00:00:00.000Z" });
    repo.createToken({ token: "live-refresh", serverId: rec.id, kind: "refresh", expiresAt: null });

    // A LATER createToken call is what triggers the prune.
    repo.createToken({ token: "trigger", serverId: rec.id, kind: "access", expiresAt: "2999-01-01T00:00:00.000Z" });

    expect(repo.getToken("stale-access")).toBeNull();
    expect(repo.getToken("live-refresh")).not.toBeNull();
    expect(repo.getToken("trigger")).not.toBeNull();
  });

  it("clearOAuthGrants drops that server's codes and tokens only", () => {
    const repo = freshRepo();
    const a = repo.createServer("alpha", { type: "http", url: "https://example.com/mcp", headers: {} });
    const b = repo.createServer("beta", { type: "http", url: "https://example.com/mcp", headers: {} });
    repo.createToken({ token: "a-tok", serverId: a.id, kind: "access", expiresAt: "2999-01-01T00:00:00.000Z" });
    repo.createToken({ token: "b-tok", serverId: b.id, kind: "access", expiresAt: "2999-01-01T00:00:00.000Z" });
    repo.createAuthCode({ code: "a-code", serverId: a.id, redirectUri: "https://x/cb", codeChallenge: "c", resource: null, expiresAt: "2999-01-01T00:00:00.000Z" });

    repo.clearOAuthGrants(a.id);

    expect(repo.getToken("a-tok")).toBeNull();
    expect(repo.takeAuthCode("a-code")).toBeNull();
    expect(repo.getToken("b-tok")).not.toBeNull();
  });
});
