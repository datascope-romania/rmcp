import { Hono, type Context } from "hono";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { localMcpEndpoint, oauthIssuer, redirectUriAllowed, redirectUris } from "../endpoint.js";
import type { Repo } from "../repo.js";

export const ACCESS_TTL_MS = 3_600_000; // 1 hour
export const CODE_TTL_MS = 60_000; // 60 seconds

/** Constant-time compare of two secrets of any length. Hashing first keeps the
 *  comparison length-independent, so a mismatch leaks nothing about the value. */
function secretsMatch(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}

function pkceMatches(verifier: string, challenge: string): boolean {
  if (!verifier) return false;
  return createHash("sha256").update(verifier).digest("base64url") === challenge;
}

/** client_secret_basic per RFC 6749 §2.3.1, falling back to client_secret_post. */
function clientCredentials(
  authHeader: string | undefined,
  body: Record<string, string>,
): { id: string; secret: string } | null {
  const m = /^Basic\s+(\S+)\s*$/i.exec(authHeader ?? "");
  if (m) {
    const decoded = Buffer.from(m[1], "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep < 0) return null;
    // Percent-escapes here come from an untrusted, unauthenticated client, so a
    // malformed escape (e.g. "%zz") must not throw — fall back to the raw slice
    // rather than let decodeURIComponent turn a bad header into a 500.
    const dec = (s: string) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    };
    return { id: dec(decoded.slice(0, sep)), secret: dec(decoded.slice(sep + 1)) };
  }
  if (body.client_id && body.client_secret) return { id: body.client_id, secret: body.client_secret };
  return null;
}

/** Every OAuth endpoint needs a public issuer: without one the browser redirect
 *  and the token back-channel have nowhere to reach us, so fail loudly and point
 *  at the setting rather than advertising a LAN host. Returns the issuer, or the
 *  503 Response to return as-is when the setting is unset: `if (typeof issuer
 *  !== "string") return issuer;` */
function requireIssuer(c: Context, repo: Repo): string | Response {
  const issuer = oauthIssuer(repo.getSettings());
  if (!issuer) return c.json({ error: "OAuth is unavailable: set publicMcpBaseUrl in Settings" }, 503);
  return issuer;
}

export interface OAuthDeps {
  repo: Repo;
  now?: () => Date;
}

export interface OAuthProvider {
  routes: Hono;
  /** The static bearer to forward for a valid OAuth access token on this
   *  server, or null when the header carries no such token. */
  resolve(serverId: string, authHeader: string | undefined): string | null;
  /** WWW-Authenticate value to attach to a 401 from this server, or null when
   *  OAuth is unconfigured. */
  challengeHeader(serverId: string): string | null;
}

export function createOAuth(deps: OAuthDeps): OAuthProvider {
  const { repo } = deps;
  const routes = new Hono();

  routes.use("/oauth/*", async (c, next) => {
    const issuer = requireIssuer(c, repo);
    if (typeof issuer !== "string") return issuer;
    await next();
  });

  routes.get("/.well-known/oauth-authorization-server", (c) => {
    const issuer = requireIssuer(c, repo);
    if (typeof issuer !== "string") return issuer;
    return c.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    });
  });

  // The PATH here is not hardcoded: it is derived from localMcpEndpoint (=
  // publicMcpBaseUrl + "/" + id), which is also what clients are actually told
  // to talk to. Registering `*` and reading the last segment (rather than
  // hardcoding e.g. "/service/:id") keeps this correct if publicMcpBaseUrl's
  // path ever changes from "/service" to something else.
  routes.get("/.well-known/oauth-protected-resource/*", (c) => {
    const issuer = requireIssuer(c, repo);
    if (typeof issuer !== "string") return issuer;
    const segments = c.req.path.split("/").filter(Boolean);
    const id = segments[segments.length - 1];
    const rec = repo.getServer(id);
    // Gate on OAuth-capable servers only (MINOR 7): a Lambda-target server, or a
    // local one with no minted client, is not an OAuth-protected resource.
    if (!rec || rec.deployedTarget !== "local" || !rec.oauthClientId) {
      return c.json({ error: "unknown server" }, 404);
    }
    const settings = repo.getSettings();
    // The port argument can never matter here: requireIssuer above already
    // guarantees publicMcpBaseUrl is set, so localMcpEndpoint always resolves
    // against that custom base rather than the LAN `host:port` fallback.
    const resource = localMcpEndpoint(id, settings, 0);
    return c.json({
      resource,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
    });
  });

  const clock = deps.now ?? (() => new Date());

  routes.get("/oauth/authorize", (c) => {
    const q = c.req.query();
    const client = q.client_id ? repo.getOAuthClientByClientId(q.client_id) : null;
    if (!client) return c.json({ error: "invalid_client", error_description: "unknown client_id" }, 400);

    const redirectUri = q.redirect_uri ?? "";
    if (!redirectUriAllowed(redirectUri, redirectUris(repo.getSettings()))) {
      return c.json({
        error: "invalid_request",
        error_description: "redirect_uri is not in the allowlist — add it in Settings",
      }, 400);
    }

    // From here the client and its redirect target are both trusted, so errors
    // go back to the client the way the spec expects instead of dead-ending.
    const back = (error: string, description: string) => {
      const url = new URL(redirectUri);
      url.searchParams.set("error", error);
      url.searchParams.set("error_description", description);
      if (q.state) url.searchParams.set("state", q.state);
      // The redirect carries data in the Location URL (here: the error); the
      // success path below carries an auth code. Neither should be cached.
      c.header("Cache-Control", "no-store");
      return c.redirect(url.toString(), 302);
    };

    if (q.response_type !== "code") return back("unsupported_response_type", "only response_type=code is supported");
    if (q.code_challenge_method !== "S256") return back("invalid_request", "code_challenge_method must be S256");
    if (!q.code_challenge) return back("invalid_request", "code_challenge is required");

    const code = randomBytes(32).toString("base64url");
    repo.createAuthCode({
      code,
      serverId: client.serverId,
      redirectUri,
      codeChallenge: q.code_challenge,
      resource: q.resource ?? null,
      expiresAt: new Date(clock().getTime() + CODE_TTL_MS).toISOString(),
    });

    const url = new URL(redirectUri);
    url.searchParams.set("code", code);
    if (q.state) url.searchParams.set("state", q.state);
    c.header("Cache-Control", "no-store");
    return c.redirect(url.toString(), 302);
  });

  routes.post("/oauth/token", async (c) => {
    const body = Object.fromEntries(new URLSearchParams(await c.req.text())) as Record<string, string>;
    const fail = (error: string, description: string, status: 400 | 401 = 400) =>
      c.json({ error, error_description: description }, status);

    const creds = clientCredentials(c.req.header("authorization"), body);
    const client = creds ? repo.getOAuthClientByClientId(creds.id) : null;
    if (!client || !creds || !secretsMatch(creds.secret, client.clientSecret)) {
      // Only claim Basic when the client actually attempted it — a bare
      // client_secret_post failure shouldn't invite a scheme it didn't use.
      if (c.req.header("authorization")) c.header("WWW-Authenticate", `Basic realm="oauth"`);
      return fail("invalid_client", "unknown client_id or bad client_secret", 401);
    }

    const issue = () => {
      const accessToken = randomBytes(32).toString("base64url");
      const refreshToken = randomBytes(32).toString("base64url");
      repo.createToken({
        token: accessToken, serverId: client.serverId, kind: "access",
        expiresAt: new Date(clock().getTime() + ACCESS_TTL_MS).toISOString(),
      });
      repo.createToken({ token: refreshToken, serverId: client.serverId, kind: "refresh", expiresAt: null });
      c.header("Cache-Control", "no-store");
      return c.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: Math.floor(ACCESS_TTL_MS / 1000),
        refresh_token: refreshToken,
      });
    };

    if (body.grant_type === "authorization_code") {
      // takeAuthCode deletes as it reads, so a replay finds nothing. This also
      // means the code is consumed BEFORE the row.serverId check below, so a
      // second *registered* client presenting someone else's code burns it
      // without redeeming it. Checking serverId first would need a peek-then-take
      // API, which reopens the replay race takeAuthCode's atomic delete-on-read
      // closes; consuming first and rejecting after is the better trade-off.
      const row = body.code ? repo.takeAuthCode(body.code) : null;
      if (!row) return fail("invalid_grant", "unknown or already-used code");
      const expiresAtMs = new Date(row.expiresAt).getTime();
      // A non-finite timestamp (unparseable expiresAt) must fail closed as
      // expired, not slip through an `NaN < x` comparison that is always false.
      if (!Number.isFinite(expiresAtMs) || expiresAtMs < clock().getTime()) return fail("invalid_grant", "code expired");
      if (row.serverId !== client.serverId) return fail("invalid_grant", "code was issued to another client");
      if (row.redirectUri !== body.redirect_uri) return fail("invalid_grant", "redirect_uri mismatch");
      if (!pkceMatches(body.code_verifier ?? "", row.codeChallenge)) return fail("invalid_grant", "PKCE verification failed");
      return issue();
    }

    if (body.grant_type === "refresh_token") {
      const existing = body.refresh_token ? repo.getToken(body.refresh_token) : null;
      if (!existing || existing.kind !== "refresh") return fail("invalid_grant", "unknown refresh token");
      if (existing.serverId !== client.serverId) return fail("invalid_grant", "refresh token was issued to another client");
      repo.deleteToken(existing.token);   // rotation: the presented token dies here
      return issue();
    }

    return fail("unsupported_grant_type", "only authorization_code and refresh_token are supported");
  });

  return {
    routes,

    resolve(serverId, authHeader) {
      // RFC 6750: the "Bearer" scheme is case-insensitive.
      const m = /^Bearer\s+(.+)$/i.exec(authHeader ?? "");
      if (!m) return null;
      const row = repo.getToken(m[1]);
      if (!row || row.kind !== "access" || row.serverId !== serverId) return null;
      // Every access token is issued with an expiry (see issue() above), so a
      // missing or unparseable expiresAt must fail closed as expired rather than
      // slip through an `undefined`/`NaN < x` comparison that is always false.
      const expiresAtMs = row.expiresAt ? new Date(row.expiresAt).getTime() : NaN;
      if (!Number.isFinite(expiresAtMs) || expiresAtMs < clock().getTime()) return null;
      // Fails closed: a fully-validated token for a server whose bearerToken
      // column is NULL resolves to null rather than forwarding no auth at all.
      return repo.getServer(serverId)?.bearerToken ?? null;
    },

    challengeHeader(serverId) {
      const settings = repo.getSettings();
      const issuer = oauthIssuer(settings);
      if (!issuer) return null;
      const rec = repo.getServer(serverId);
      // Gate on OAuth-capable servers only (MINOR 7): sending a Lambda-target or
      // credential-less local server into discovery just dead-ends at
      // invalid_client, since there is no dynamic client registration.
      if (!rec || rec.deployedTarget !== "local" || !rec.oauthClientId) return null;
      // Port argument can never matter: the issuer check above already
      // guarantees publicMcpBaseUrl is set (see localMcpEndpoint's port fallback).
      const path = new URL(localMcpEndpoint(serverId, settings, 0)).pathname;
      return `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource${path}"`;
    },
  };
}
