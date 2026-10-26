// One-time Google sign-in that yields a long-lived refresh token for an
// http-proxy server's x-rmcp-oauth-* entries (see packages/bridge/src/httpProxy.ts).
//
//   pnpm google-token --client-file client_secret_….json [--redirect-uri <uri>] [--scopes "a b"] [--verify <mcp url>]
//   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... pnpm google-token [...]
//
// The OAuth client must list --redirect-uri exactly (default http://localhost:8765/callback);
// the script listens on that URI's port and path.
// The refresh token is bound to that client, so the proxy must use the same id/secret.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const CHAT_SCOPES = [
  "https://www.googleapis.com/auth/chat.spaces.readonly",
  "https://www.googleapis.com/auth/chat.memberships.readonly",
  "https://www.googleapis.com/auth/chat.messages.readonly",
  "https://www.googleapis.com/auth/chat.messages.create",
  "https://www.googleapis.com/auth/chat.users.readstate",
];
const TOKEN_URL = "https://oauth2.googleapis.com/token";

const { values: opts } = parseArgs({
  options: {
    "client-file": { type: "string" },
    "redirect-uri": { type: "string", default: "http://localhost:8765/callback" },
    scopes: { type: "string" },
    verify: { type: "string" },
  },
});
// the JSON Google Cloud Console downloads nests the client under "web" or "installed"
const fileClient = opts["client-file"]
  ? (({ web, installed }) => web ?? installed)(JSON.parse(readFileSync(opts["client-file"], "utf8"))) as
    { client_id?: string; client_secret?: string } | undefined
  : undefined;
const clientId = fileClient?.client_id ?? process.env.GOOGLE_CLIENT_ID;
const clientSecret = fileClient?.client_secret ?? process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Pass --client-file, or set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (the same OAuth client the proxy will use).");
  process.exit(1);
}
const scopes = opts.scopes ? opts.scopes.split(/\s+/).filter(Boolean) : CHAT_SCOPES;
const redirectUri = opts["redirect-uri"]!;
const redirect = new URL(redirectUri);
if (redirect.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(redirect.hostname)) {
  console.error(`--redirect-uri must be http://localhost or http://127.0.0.1, got ${redirectUri}`);
  process.exit(1);
}
const state = randomBytes(16).toString("base64url");
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: "code",
  scope: scopes.join(" "),
  // both are needed: offline asks for a refresh token, consent forces Google
  // to issue a fresh one even if this client was already granted access
  access_type: "offline",
  prompt: "consent",
  state,
  code_challenge: challenge,
  code_challenge_method: "S256",
}).toString();

const code = await new Promise<string>((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", redirectUri);
    if (url.pathname !== redirect.pathname) { res.writeHead(404).end(); return; }
    const err = url.searchParams.get("error");
    const got = url.searchParams.get("code");
    const ok = !err && got && url.searchParams.get("state") === state;
    res.writeHead(ok ? 200 : 400, { "content-type": "text/plain" })
      .end(ok ? "Signed in. You can close this tab." : `Sign-in failed: ${err ?? "state mismatch"}`);
    server.close();
    if (ok) resolve(got); else reject(new Error(`authorization failed: ${err ?? "state mismatch"}`));
  });
  const port = Number(redirect.port || 80);
  // macOS lets non-root bind privileged ports only on the wildcard address;
  // the brief exposure is harmless because the code is useless without our PKCE verifier
  server.listen(port, port < 1024 ? undefined : "127.0.0.1", () => {
    console.log(`Open this URL in your browser and sign in:\n\n${authUrl}\n`);
  });
});

const tokenRes = await fetch(TOKEN_URL, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
    code_verifier: verifier,
  }),
});
const tokens = await tokenRes.json() as {
  access_token?: string; refresh_token?: string; scope?: string; error?: string; error_description?: string;
};
if (!tokenRes.ok || !tokens.access_token) {
  console.error(`token exchange failed (${tokenRes.status}): ${tokens.error} ${tokens.error_description ?? ""}`);
  process.exit(1);
}
if (!tokens.refresh_token) {
  console.error("Google returned no refresh token — revoke the app at myaccount.google.com/permissions and retry.");
  process.exit(1);
}
const missing = scopes.filter((s) => !(tokens.scope ?? "").split(" ").includes(s));
if (missing.length) console.warn(`warning: not granted: ${missing.join(", ")}`);

if (opts.verify) {
  const headers = {
    authorization: `Bearer ${tokens.access_token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const init = await fetch(opts.verify, {
    method: "POST", headers,
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "rmcp-token-check", version: "0" } },
    }),
  });
  const session = init.headers.get("mcp-session-id");
  console.log(`verify initialize: ${init.status} ${init.headers.get("content-type")}`);
  const list = await fetch(opts.verify, {
    method: "POST", headers: { ...headers, ...(session ? { "mcp-session-id": session } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  const body = await list.text();
  const names = [...body.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
  console.log(`verify tools/list: ${list.status} → ${names.join(", ") || body.slice(0, 300)}`);
}

console.log(`\nRefresh token (store as the secret x-rmcp-oauth-refresh-token):\n\n${tokens.refresh_token}\n`);
