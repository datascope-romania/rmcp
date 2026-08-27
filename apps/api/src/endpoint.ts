import type { ServerRecord } from "@rmcp/shared";
import { localHostname } from "./local/deployer.js";
import type { Settings } from "./repo.js";

/** Base URL (no trailing slash) for local MCP endpoints: the configured public
 *  base when set, otherwise the LAN gateway host. */
export function localMcpBase(settings: Settings, port: number): string {
  const custom = settings.publicMcpBaseUrl?.trim();
  return custom ? custom.replace(/\/+$/, "") : `http://${localHostname()}:${port}`;
}

export function localMcpEndpoint(id: string, settings: Settings, port: number): string {
  return `${localMcpBase(settings, port)}/${id}`;
}

/** Local-deployed servers render their endpoint from current settings so a
 *  publicMcpBaseUrl change updates every server without a redeploy. Lambda
 *  endpoints (stored Function URLs) are returned unchanged. */
export function withDisplayEndpoint(rec: ServerRecord, settings: Settings, port: number): ServerRecord {
  if (rec.deployedTarget === "local" && rec.status === "deployed" && rec.endpointUrl) {
    return { ...rec, endpointUrl: localMcpEndpoint(rec.id, settings, port) };
  }
  return rec;
}

/** Redirect URIs accepted at /oauth/authorize when Settings has no explicit list.
 *  Claude's two callbacks, plus loopback for desktop clients that spin up a
 *  throwaway local listener on an unpredictable port. */
export const DEFAULT_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  "http://localhost:*",
  "http://127.0.0.1:*",
] as const;

/** The OAuth issuer is the origin of the configured public MCP base URL:
 *  publicMcpBaseUrl is ".../service", the issuer is the bare origin. Null means
 *  OAuth is unconfigured — callers must answer 503 rather than guess a host. */
export function oauthIssuer(settings: Settings): string | null {
  const raw = settings.publicMcpBaseUrl?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

export function redirectUris(settings: Settings): string[] {
  const list = settings.oauthRedirectUris;
  return list && list.length > 0 ? list : [...DEFAULT_REDIRECT_URIS];
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** Exact match, with one exception: the "http://localhost:*" and
 *  "http://127.0.0.1:*" entries match any port and any path, because a desktop
 *  client's local callback listener picks its port at runtime. The wildcard
 *  never widens beyond those two literal hosts over plain http. */
export function redirectUriAllowed(uri: string, allowlist: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  for (const entry of allowlist) {
    if (entry === uri) return true;
    if (!entry.endsWith(":*")) continue;
    if (!entry.startsWith("http://")) continue;
    const host = entry.slice("http://".length, -":*".length);
    if (!LOOPBACK_HOSTS.has(host)) continue;
    if (parsed.protocol === "http:" && parsed.hostname === host) return true;
  }
  return false;
}
