import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { makeRepo, type Repo, type Settings } from "../src/repo.js";
import { createOAuth } from "../src/local/oauth.js";
import { createGateway, type MountedServer } from "../src/local/gateway.js";

export function harness(
  settings: Partial<Settings> = { publicMcpBaseUrl: "https://mcp.example.com/service" },
  now?: () => Date,
) {
  const dir = mkdtempSync(path.join(tmpdir(), "rmcp-oauth-"));
  const repo: Repo = makeRepo(openDb(path.join(dir, "test.db")));
  repo.putSettings({ region: "us-east-1", ...settings });
  const rec = repo.createServer("alpha", { type: "http", url: "https://example.com/mcp", headers: {} });
  repo.setOAuthClient(rec.id, "cid-1", "secret-1");
  repo.setServerState(rec.id, { status: "deployed", deployedTarget: "local", bearerToken: "static-bearer" });
  return { repo, serverId: rec.id, oauth: createOAuth(now ? { repo, now } : { repo }) };
}

describe("discovery metadata", () => {
  it("serves protected resource metadata naming the authorization server", async () => {
    const { oauth, serverId } = harness();
    const res = await oauth.routes.request(`/.well-known/oauth-protected-resource/service/${serverId}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resource: `https://mcp.example.com/service/${serverId}`,
      authorization_servers: ["https://mcp.example.com"],
      bearer_methods_supported: ["header"],
    });
  });

  it("404s protected resource metadata for an unknown service", async () => {
    const { oauth } = harness();
    const res = await oauth.routes.request("/.well-known/oauth-protected-resource/service/ghost");
    expect(res.status).toBe(404);
  });

  it("serves authorization server metadata", async () => {
    const { oauth } = harness();
    const res = await oauth.routes.request("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      issuer: "https://mcp.example.com",
      authorization_endpoint: "https://mcp.example.com/oauth/authorize",
      token_endpoint: "https://mcp.example.com/oauth/token",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    });
  });

  it("503s every oauth endpoint when publicMcpBaseUrl is unset", async () => {
    const { oauth, serverId } = harness({});
    for (const url of [
      "/.well-known/oauth-authorization-server",
      `/.well-known/oauth-protected-resource/service/${serverId}`,
      "/oauth/authorize?client_id=cid-1",
    ]) {
      const res = await oauth.routes.request(url);
      expect(res.status, url).toBe(503);
      expect((await res.json()).error).toMatch(/publicMcpBaseUrl/);
    }
    expect((await oauth.routes.request("/oauth/token", { method: "POST", body: "" })).status).toBe(503);
  });

  // The path served here must track publicMcpBaseUrl's path, not assume
  // "/service": that's the actual resource a client is told to talk to
  // (localMcpEndpoint), and RFC 9728 requires `resource` to match it exactly.
  it("derives the protected-resource path from publicMcpBaseUrl instead of hardcoding /service", async () => {
    const { oauth, serverId } = harness({ publicMcpBaseUrl: "https://mcp.example.com/mcp" });
    const res = await oauth.routes.request(`/.well-known/oauth-protected-resource/mcp/${serverId}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resource: `https://mcp.example.com/mcp/${serverId}`,
      authorization_servers: ["https://mcp.example.com"],
      bearer_methods_supported: ["header"],
    });
  });

  it("404s protected-resource metadata for a server that isn't OAuth-capable", async () => {
    const { oauth, repo } = harness();
    const lambdaServer = repo.createServer("lam", { type: "http", url: "https://example.com/mcp", headers: {} });
    repo.setServerState(lambdaServer.id, { status: "deployed", deployedTarget: "lambda" });
    const noCreds = repo.createServer("nocreds", { type: "http", url: "https://example.com/mcp", headers: {} });
    repo.setServerState(noCreds.id, { status: "deployed", deployedTarget: "local" });

    for (const id of [lambdaServer.id, noCreds.id]) {
      const res = await oauth.routes.request(`/.well-known/oauth-protected-resource/service/${id}`);
      expect(res.status, id).toBe(404);
    }
  });
});

describe("/oauth/authorize", () => {
  const ok = new URLSearchParams({
    response_type: "code", client_id: "cid-1",
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256", state: "xyz",
  });

  it("auto-approves and redirects with a code and the state echoed back", async () => {
    const { oauth } = harness();
    const res = await oauth.routes.request(`/oauth/authorize?${ok}`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe("https://claude.ai/api/mcp/auth_callback");
    expect(loc.searchParams.get("code")).toMatch(/^[\w-]{43}$/);
    expect(loc.searchParams.get("state")).toBe("xyz");
  });

  it("sets Cache-Control: no-store on both the success redirect and an error redirect", async () => {
    const { oauth } = harness();
    const success = await oauth.routes.request(`/oauth/authorize?${ok}`);
    expect(success.status).toBe(302);
    expect(success.headers.get("cache-control")).toBe("no-store");

    const p = new URLSearchParams(ok); p.set("code_challenge", "");
    const failure = await oauth.routes.request(`/oauth/authorize?${p}`);
    expect(failure.status).toBe(302);
    expect(failure.headers.get("cache-control")).toBe("no-store");
  });

  it("binds the code to the server, redirect uri and challenge", async () => {
    const { oauth, repo, serverId } = harness();
    const res = await oauth.routes.request(`/oauth/authorize?${ok}`);
    const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
    expect(repo.takeAuthCode(code)).toMatchObject({
      serverId,
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    });
  });

  it("400s an unknown client_id without redirecting", async () => {
    const { oauth } = harness();
    const p = new URLSearchParams(ok); p.set("client_id", "nope");
    const res = await oauth.routes.request(`/oauth/authorize?${p}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_client");
  });

  it("400s a redirect_uri outside the allowlist without redirecting", async () => {
    const { oauth } = harness();
    const p = new URLSearchParams(ok); p.set("redirect_uri", "https://evil.com/cb");
    const res = await oauth.routes.request(`/oauth/authorize?${p}`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_request");
  });

  it("redirects an error back once client and redirect_uri are valid", async () => {
    const { oauth } = harness();
    for (const [key, value, expected] of [
      ["code_challenge_method", "plain", "invalid_request"],
      ["code_challenge", "", "invalid_request"],
      ["response_type", "token", "unsupported_response_type"],
    ] as const) {
      const p = new URLSearchParams(ok); p.set(key, value);
      const res = await oauth.routes.request(`/oauth/authorize?${p}`);
      expect(res.status, key).toBe(302);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.searchParams.get("error"), key).toBe(expected);
      expect(loc.searchParams.get("state"), key).toBe("xyz");
    }
  });

  it("does not redirect errors to an unallowed redirect_uri", async () => {
    const { oauth } = harness();
    for (const [key, value] of [
      ["response_type", "token"],
      ["code_challenge_method", "plain"],
      ["code_challenge", ""],
    ] as const) {
      const p = new URLSearchParams(ok);
      p.set("redirect_uri", "https://evil.com/cb");
      p.set(key, value);
      const res = await oauth.routes.request(`/oauth/authorize?${p}`);
      expect(res.status, key).toBe(400);
      expect(res.headers.get("location"), key).toBeNull();
    }
  });

  it("rejects a missing code_challenge_method", async () => {
    const { oauth } = harness();
    const p = new URLSearchParams(ok); p.delete("code_challenge_method");
    const res = await oauth.routes.request(`/oauth/authorize?${p}`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("invalid_request");
  });

  it("omits state from the redirect when the request carries none", async () => {
    const { oauth } = harness();
    const p = new URLSearchParams(ok); p.delete("state");
    const res = await oauth.routes.request(`/oauth/authorize?${p}`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.has("state")).toBe(false);
  });

  it("round-trips a state value containing reserved and space characters", async () => {
    const { oauth } = harness();
    const weird = "a&b#c d";
    const p = new URLSearchParams(ok); p.set("state", weird);
    const res = await oauth.routes.request(`/oauth/authorize?${p}`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.searchParams.get("state")).toBe(weird);
  });

  it("stamps the auth code with an expiry exactly CODE_TTL_MS after the injected clock", async () => {
    const { repo } = harness();
    const fixed = new Date("2026-01-01T00:00:00.000Z");
    const oauth = createOAuth({ repo, now: () => fixed });
    const res = await oauth.routes.request(`/oauth/authorize?${ok}`);
    const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
    const stored = repo.takeAuthCode(code);
    expect(stored?.expiresAt).toBe(new Date(fixed.getTime() + 60_000).toISOString());
  });
});

const VERIFIER = randomBytes(32).toString("base64url");
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

async function getCode(oauth: ReturnType<typeof harness>["oauth"]): Promise<string> {
  const p = new URLSearchParams({
    response_type: "code", client_id: "cid-1", redirect_uri: REDIRECT,
    code_challenge: CHALLENGE, code_challenge_method: "S256",
  });
  const res = await oauth.routes.request(`/oauth/authorize?${p}`);
  return new URL(res.headers.get("location")!).searchParams.get("code")!;
}

function form(fields: Record<string, string>) {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  };
}

describe("/oauth/token", () => {
  const exchange = (code: string, over: Record<string, string> = {}) => form({
    grant_type: "authorization_code", code, redirect_uri: REDIRECT,
    client_id: "cid-1", client_secret: "secret-1", code_verifier: VERIFIER, ...over,
  });

  it("exchanges a code for an access and refresh token", async () => {
    const { oauth, repo, serverId } = harness();
    const res = await oauth.routes.request("/oauth/token", exchange(await getCode(oauth)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect(repo.getToken(body.access_token)).toMatchObject({ serverId, kind: "access" });
    expect(repo.getToken(body.refresh_token)).toMatchObject({ serverId, kind: "refresh", expiresAt: null });
  });

  it("accepts client_secret_basic as well as client_secret_post", async () => {
    const { oauth } = harness();
    const basic = Buffer.from("cid-1:secret-1").toString("base64");
    const req = exchange(await getCode(oauth), {});
    const fields = new URLSearchParams(req.body);
    fields.delete("client_id"); fields.delete("client_secret");
    const res = await oauth.routes.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
      body: fields.toString(),
    });
    expect(res.status).toBe(200);
  });

  it("401s a wrong client secret", async () => {
    const { oauth } = harness();
    const res = await oauth.routes.request("/oauth/token", exchange(await getCode(oauth), { client_secret: "wrong" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_client");
  });

  it("400s a PKCE verifier mismatch", async () => {
    const { oauth } = harness();
    const res = await oauth.routes.request("/oauth/token", exchange(await getCode(oauth), { code_verifier: "wrong" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });

  it("400s a redirect_uri that differs from the one bound to the code", async () => {
    const { oauth } = harness();
    const res = await oauth.routes.request("/oauth/token", exchange(await getCode(oauth), {
      redirect_uri: "http://localhost:9999/cb",
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });

  it("400s a replayed code", async () => {
    const { oauth } = harness();
    const code = await getCode(oauth);
    expect((await oauth.routes.request("/oauth/token", exchange(code))).status).toBe(200);
    const replay = await oauth.routes.request("/oauth/token", exchange(code));
    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toBe("invalid_grant");
  });

  it("400s an expired code", async () => {
    const { oauth, repo, serverId } = harness();
    repo.createAuthCode({
      code: "stale", serverId, redirectUri: REDIRECT, codeChallenge: CHALLENGE,
      resource: null, expiresAt: "2000-01-01T00:00:00.000Z",
    });
    const res = await oauth.routes.request("/oauth/token", exchange("stale"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });

  it("rotates the refresh token and kills the old one", async () => {
    const { oauth, repo } = harness();
    const first = await (await oauth.routes.request("/oauth/token", exchange(await getCode(oauth)))).json();

    const refreshed = await oauth.routes.request("/oauth/token", form({
      grant_type: "refresh_token", refresh_token: first.refresh_token,
      client_id: "cid-1", client_secret: "secret-1",
    }));
    expect(refreshed.status).toBe(200);
    const second = await refreshed.json();
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(repo.getToken(first.refresh_token)).toBeNull();

    const replay = await oauth.routes.request("/oauth/token", form({
      grant_type: "refresh_token", refresh_token: first.refresh_token,
      client_id: "cid-1", client_secret: "secret-1",
    }));
    expect(replay.status).toBe(400);
  });

  it("refuses a refresh token belonging to another client", async () => {
    const { oauth, repo } = harness();
    const other = repo.createServer("beta", { type: "http", url: "https://example.com/mcp", headers: {} });
    repo.setOAuthClient(other.id, "cid-2", "secret-2");
    const first = await (await oauth.routes.request("/oauth/token", exchange(await getCode(oauth)))).json();

    const res = await oauth.routes.request("/oauth/token", form({
      grant_type: "refresh_token", refresh_token: first.refresh_token,
      client_id: "cid-2", client_secret: "secret-2",
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });

  it("400s an authorization code redeemed by a different registered client", async () => {
    const { oauth, repo } = harness();
    const other = repo.createServer("beta", { type: "http", url: "https://example.com/mcp", headers: {} });
    repo.setOAuthClient(other.id, "cid-2", "secret-2");
    const code = await getCode(oauth);
    const res = await oauth.routes.request("/oauth/token", exchange(code, {
      client_id: "cid-2", client_secret: "secret-2",
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
  });

  it("401s with no credentials at all", async () => {
    const { oauth } = harness();
    const code = await getCode(oauth);
    const fields = new URLSearchParams(exchange(code).body);
    fields.delete("client_id");
    fields.delete("client_secret");
    const res = await oauth.routes.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: fields.toString(),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_client");
  });

  it("401s a wrong client secret supplied via Basic auth", async () => {
    const { oauth } = harness();
    const code = await getCode(oauth);
    const fields = new URLSearchParams(exchange(code).body);
    fields.delete("client_id");
    fields.delete("client_secret");
    const basic = Buffer.from("cid-1:wrong").toString("base64");
    const res = await oauth.routes.request("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${basic}` },
      body: fields.toString(),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_client");
  });

  it("400s an unsupported grant type", async () => {
    const { oauth } = harness();
    const res = await oauth.routes.request("/oauth/token", form({
      grant_type: "client_credentials", client_id: "cid-1", client_secret: "secret-1",
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unsupported_grant_type");
  });
});

describe("resolve and challengeHeader", () => {
  it("resolves a live access token to the server's static bearer", async () => {
    const { oauth, serverId } = harness();
    const body = await (await oauth.routes.request("/oauth/token", form({
      grant_type: "authorization_code", code: await getCode(oauth), redirect_uri: REDIRECT,
      client_id: "cid-1", client_secret: "secret-1", code_verifier: VERIFIER,
    }))).json();
    expect(oauth.resolve(serverId, `Bearer ${body.access_token}`)).toBe("static-bearer");
  });

  it("accepts a case-insensitive Bearer scheme per RFC 6750", async () => {
    const { oauth, serverId } = harness();
    const body = await (await oauth.routes.request("/oauth/token", form({
      grant_type: "authorization_code", code: await getCode(oauth), redirect_uri: REDIRECT,
      client_id: "cid-1", client_secret: "secret-1", code_verifier: VERIFIER,
    }))).json();
    expect(oauth.resolve(serverId, `bearer ${body.access_token}`)).toBe("static-bearer");
    expect(oauth.resolve(serverId, `BEARER ${body.access_token}`)).toBe("static-bearer");
  });

  it("returns null for a missing, malformed, unknown or non-access token", async () => {
    const { oauth, repo, serverId } = harness();
    repo.createToken({ token: "refresh-only", serverId, kind: "refresh", expiresAt: null });
    expect(oauth.resolve(serverId, undefined)).toBeNull();
    expect(oauth.resolve(serverId, "Basic abc")).toBeNull();
    expect(oauth.resolve(serverId, "Bearer nope")).toBeNull();
    expect(oauth.resolve(serverId, "Bearer refresh-only")).toBeNull();
  });

  it("returns null for an expired access token", () => {
    const { oauth, repo, serverId } = harness();
    repo.createToken({ token: "stale", serverId, kind: "access", expiresAt: "2000-01-01T00:00:00.000Z" });
    expect(oauth.resolve(serverId, "Bearer stale")).toBeNull();
  });

  it("fails closed on an access token with a null expiresAt", () => {
    const { oauth, repo, serverId } = harness();
    repo.createToken({ token: "no-expiry", serverId, kind: "access", expiresAt: null });
    expect(oauth.resolve(serverId, "Bearer no-expiry")).toBeNull();
  });

  it("fails closed on an access token with an unparseable expiresAt", () => {
    const { oauth, repo, serverId } = harness();
    repo.createToken({ token: "bad-expiry", serverId, kind: "access", expiresAt: "not-a-date" });
    expect(oauth.resolve(serverId, "Bearer bad-expiry")).toBeNull();
  });

  it("refuses a token issued for another server", async () => {
    const { oauth, repo, serverId } = harness();
    const other = repo.createServer("beta", { type: "http", url: "https://example.com/mcp", headers: {} });
    repo.setServerState(other.id, { status: "deployed", deployedTarget: "local", bearerToken: "other-bearer" });
    repo.createToken({ token: "a-tok", serverId, kind: "access", expiresAt: "2999-01-01T00:00:00.000Z" });
    expect(oauth.resolve(other.id, "Bearer a-tok")).toBeNull();
  });

  it("builds a challenge pointing at the resource metadata, and null when unconfigured", () => {
    const { oauth, serverId } = harness();
    expect(oauth.challengeHeader(serverId)).toBe(
      `Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/service/${serverId}"`,
    );
    expect(harness({}).oauth.challengeHeader(serverId)).toBeNull();
  });

  it("points the challenge at a non-/service publicMcpBaseUrl path", () => {
    const { oauth, serverId } = harness({ publicMcpBaseUrl: "https://mcp.example.com/mcp" });
    expect(oauth.challengeHeader(serverId)).toBe(
      `Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp/${serverId}"`,
    );
  });

  it("returns null for a Lambda-target server or a local server with no minted client", () => {
    const { oauth, repo } = harness();
    const lambdaServer = repo.createServer("lam", { type: "http", url: "https://example.com/mcp", headers: {} });
    repo.setServerState(lambdaServer.id, { status: "deployed", deployedTarget: "lambda" });
    expect(oauth.challengeHeader(lambdaServer.id)).toBeNull();

    const noCreds = repo.createServer("nocreds", { type: "http", url: "https://example.com/mcp", headers: {} });
    repo.setServerState(noCreds.id, { status: "deployed", deployedTarget: "local" });
    expect(oauth.challengeHeader(noCreds.id)).toBeNull();
  });
});

describe("gateway integration", () => {
  it("rewrites to the routed service's static bearer, and leaves an unrelated service's traffic untouched", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rmcp-oauth-gw-"));
    const repo: Repo = makeRepo(openDb(path.join(dir, "test.db")));
    repo.putSettings({ region: "us-east-1", publicMcpBaseUrl: "https://mcp.example.com/service" });

    const a = repo.createServer("alpha", { type: "http", url: "https://example.com/mcp", headers: {} });
    repo.setOAuthClient(a.id, "cid-a", "secret-a");
    repo.setServerState(a.id, { status: "deployed", deployedTarget: "local", bearerToken: "bearer-a" });

    const b = repo.createServer("beta", { type: "http", url: "https://example.com/mcp", headers: {} });
    repo.setServerState(b.id, { status: "deployed", deployedTarget: "local", bearerToken: "bearer-b" });

    const oauth = createOAuth({ repo });
    const gw = createGateway({ oauth });

    const receivedA: (string | undefined)[] = [];
    const receivedB: (string | undefined)[] = [];
    const mounted = (sink: (string | undefined)[]): MountedServer => ({
      async handle(event) {
        sink.push(event.headers?.authorization);
        return { statusCode: 200, headers: {}, body: "{}" };
      },
      dispose: () => {},
    });
    gw.mount(a.id, mounted(receivedA));
    gw.mount(b.id, mounted(receivedB));

    // Drive the real /oauth/authorize + /oauth/token flow through the gateway
    // (not oauth.routes directly) to mint a real access token bound to A.
    const authParams = new URLSearchParams({
      response_type: "code", client_id: "cid-a", redirect_uri: REDIRECT,
      code_challenge: CHALLENGE, code_challenge_method: "S256",
    });
    const authRes = await gw.app.request(`/oauth/authorize?${authParams}`);
    const code = new URL(authRes.headers.get("location")!).searchParams.get("code")!;
    const tokenRes = await gw.app.request(
      "/oauth/token",
      form({
        grant_type: "authorization_code", code, redirect_uri: REDIRECT,
        client_id: "cid-a", client_secret: "secret-a", code_verifier: VERIFIER,
      }),
    );
    const { access_token } = await tokenRes.json();

    // POSTing to A's mount: the gateway routes the path segment as serverId,
    // resolve() matches it to A, and A receives the STATIC bearer, not the token.
    await gw.app.request(`/${a.id}`, {
      method: "POST", headers: { authorization: `Bearer ${access_token}` }, body: "{}",
    });
    expect(receivedA[0]).toBe("Bearer bearer-a");

    // The same token POSTed to B: resolve(B, token) fails (token was issued for
    // A), so the ORIGINAL OAuth token passes through untouched — no rewrite,
    // proving cross-service isolation holds at the HTTP layer.
    await gw.app.request(`/${b.id}`, {
      method: "POST", headers: { authorization: `Bearer ${access_token}` }, body: "{}",
    });
    expect(receivedB[0]).toBe(`Bearer ${access_token}`);
  });
});
