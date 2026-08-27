import { randomUUID } from "node:crypto";
import { ServerConfigSchema, type DeployTarget, type ServerConfig, type ServerRecord, type ServerStatus } from "@rmcp/shared";
import type { Db } from "./db.js";

export interface DeployLogRow { attempt: string; step: string; status: string; detail: string | null; ts: string }
export interface Settings {
  region: string; profile?: string; localGatewayPort?: number;
  publicMcpBaseUrl?: string; oauthRedirectUris?: string[];
}

export interface OAuthClient { serverId: string; clientId: string; clientSecret: string }
export interface AuthCodeRow {
  code: string; serverId: string; redirectUri: string;
  codeChallenge: string; resource: string | null; expiresAt: string;
}
export interface TokenRow {
  token: string; serverId: string; kind: "access" | "refresh"; expiresAt: string | null;
}

function rowToRecord(row: any): ServerRecord {
  return {
    id: row.id, name: row.name,
    config: ServerConfigSchema.parse(JSON.parse(row.config_json)),
    status: row.status as ServerStatus,
    deployedTarget: row.deployed_target ?? null,
    awsFootprint: !!row.aws_footprint,
    folder: row.folder ?? null,
    sortIndex: row.sort_index,
    endpointUrl: row.endpoint_url, bearerToken: row.bearer_token,
    oauthClientId: row.oauth_client_id ?? null,
    oauthClientSecret: row.oauth_client_secret ?? null,
    lastError: row.last_error,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function makeRepo(db: Db) {
  const now = () => new Date().toISOString();
  return {
    createServer(name: string, config: ServerConfig, folder: string | null = null): ServerRecord {
      const id = randomUUID();
      const next = (db.prepare("SELECT COALESCE(MAX(sort_index) + 1, 0) AS n FROM servers").get() as { n: number }).n;
      db.prepare(
        "INSERT INTO servers (id, name, config_json, status, folder, sort_index, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)",
      ).run(id, name, JSON.stringify(config), folder, next, now(), now());
      return this.getServer(id)!;
    },
    listServers(): ServerRecord[] {
      return db.prepare("SELECT * FROM servers ORDER BY sort_index, name").all().map(rowToRecord);
    },
    getServer(id: string): ServerRecord | null {
      const row = db.prepare("SELECT * FROM servers WHERE id = ?").get(id);
      return row ? rowToRecord(row) : null;
    },
    updateServer(id: string, patch: { name?: string; config?: ServerConfig; folder?: string | null }): ServerRecord {
      const existing = this.getServer(id);
      if (!existing) throw new Error("not found");
      db.prepare("UPDATE servers SET name = ?, config_json = ?, folder = ?, updated_at = ? WHERE id = ?").run(
        patch.name ?? existing.name,
        JSON.stringify(patch.config ?? existing.config),
        patch.folder === undefined ? existing.folder : patch.folder,
        now(), id,
      );
      return this.getServer(id)!;
    },
    setServerOrder(ids: string[]): void {
      const existing = db.prepare("SELECT id FROM servers").all() as { id: string }[];
      const known = new Set(existing.map((r) => r.id));
      const seen = new Set<string>();
      for (const id of ids) {
        if (!known.has(id)) throw new Error(`unknown server id ${id}`);
        if (seen.has(id)) throw new Error(`duplicate server id ${id}`);
        seen.add(id);
      }
      if (seen.size !== known.size) {
        const missing = existing.filter((r) => !seen.has(r.id)).map((r) => r.id);
        throw new Error(`order is missing server id(s): ${missing.join(", ")}`);
      }
      const set = db.prepare("UPDATE servers SET sort_index = ?, updated_at = ? WHERE id = ?");
      const ts = now();
      db.transaction(() => { ids.forEach((id, i) => set.run(i, ts, id)); })();
    },
    setServerState(id: string, patch: { status?: ServerStatus; endpointUrl?: string | null; bearerToken?: string | null; lastError?: string | null; deployedTarget?: DeployTarget | null; awsFootprint?: boolean }): void {
      const existing = this.getServer(id);
      if (!existing) throw new Error("not found");
      db.prepare(
        "UPDATE servers SET status = ?, endpoint_url = ?, bearer_token = ?, last_error = ?, deployed_target = ?, aws_footprint = ?, updated_at = ? WHERE id = ?",
      ).run(
        patch.status ?? existing.status,
        patch.endpointUrl === undefined ? existing.endpointUrl : patch.endpointUrl,
        patch.bearerToken === undefined ? existing.bearerToken : patch.bearerToken,
        patch.lastError === undefined ? existing.lastError : patch.lastError,
        patch.deployedTarget === undefined ? existing.deployedTarget : patch.deployedTarget,
        (patch.awsFootprint === undefined ? existing.awsFootprint : patch.awsFootprint) ? 1 : 0,
        now(), id,
      );
    },
    deleteServer(id: string): void {
      db.prepare("DELETE FROM deploy_logs WHERE server_id = ?").run(id);
      db.prepare("DELETE FROM secrets WHERE server_id = ?").run(id);
      db.prepare("DELETE FROM oauth_codes WHERE server_id = ?").run(id);
      db.prepare("DELETE FROM oauth_tokens WHERE server_id = ?").run(id);
      db.prepare("DELETE FROM servers WHERE id = ?").run(id);
    },
    putSecretValue(serverId: string, key: string, value: string): void {
      db.prepare(
        "INSERT INTO secrets (server_id, key, value) VALUES (?, ?, ?) ON CONFLICT(server_id, key) DO UPDATE SET value = excluded.value",
      ).run(serverId, key, value);
    },
    deleteSecretValue(serverId: string, key: string): void {
      db.prepare("DELETE FROM secrets WHERE server_id = ? AND key = ?").run(serverId, key);
    },
    getSecretValues(serverId: string): Record<string, string> {
      const rows = db.prepare("SELECT key, value FROM secrets WHERE server_id = ?").all(serverId) as { key: string; value: string }[];
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    },
    appendDeployLog(serverId: string, attempt: string, e: { step: string; status: string; detail?: string }): void {
      db.prepare(
        "INSERT INTO deploy_logs (server_id, attempt, step, status, detail, ts) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(serverId, attempt, e.step, e.status, e.detail ?? null, now());
    },
    latestDeployLogs(serverId: string): DeployLogRow[] {
      return db.prepare(`
        SELECT attempt, step, status, detail, ts FROM deploy_logs
        WHERE server_id = ? AND attempt = (
          SELECT attempt FROM deploy_logs WHERE server_id = ? ORDER BY id DESC LIMIT 1
        ) ORDER BY id
      `).all(serverId, serverId) as DeployLogRow[];
    },
    setOAuthClient(serverId: string, clientId: string, clientSecret: string): void {
      db.prepare("UPDATE servers SET oauth_client_id = ?, oauth_client_secret = ?, updated_at = ? WHERE id = ?")
        .run(clientId, clientSecret, now(), serverId);
    },
    getOAuthClientByClientId(clientId: string): OAuthClient | null {
      const row = db.prepare(
        "SELECT id, oauth_client_id, oauth_client_secret FROM servers WHERE oauth_client_id = ?",
      ).get(clientId) as { id: string; oauth_client_id: string; oauth_client_secret: string } | undefined;
      return row ? { serverId: row.id, clientId: row.oauth_client_id, clientSecret: row.oauth_client_secret } : null;
    },
    clearOAuthGrants(serverId: string): void {
      db.prepare("DELETE FROM oauth_codes WHERE server_id = ?").run(serverId);
      db.prepare("DELETE FROM oauth_tokens WHERE server_id = ?").run(serverId);
    },
    createAuthCode(row: AuthCodeRow): void {
      // Opportunistic pruning: an abandoned/failed /oauth/authorize leaves a row
      // no other path deletes (only redemption, regenerate, or server delete do).
      db.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").run(now());
      db.prepare(
        "INSERT INTO oauth_codes (code, server_id, redirect_uri, code_challenge, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(row.code, row.serverId, row.redirectUri, row.codeChallenge, row.resource, row.expiresAt);
    },
    // single-use by construction: read and delete in one transaction, so a
    // replayed code can never be redeemed twice even under concurrent requests
    takeAuthCode(code: string): AuthCodeRow | null {
      return db.transaction((c: string) => {
        const row = db.prepare("SELECT * FROM oauth_codes WHERE code = ?").get(c) as any;
        if (!row) return null;
        db.prepare("DELETE FROM oauth_codes WHERE code = ?").run(c);
        return {
          code: row.code, serverId: row.server_id, redirectUri: row.redirect_uri,
          codeChallenge: row.code_challenge, resource: row.resource ?? null, expiresAt: row.expires_at,
        };
      })(code);
    },
    createToken(row: TokenRow): void {
      // Opportunistic pruning of expired access tokens only: refresh tokens have
      // a NULL expires_at (they don't expire) and must never match this delete.
      db.prepare("DELETE FROM oauth_tokens WHERE kind = 'access' AND expires_at < ?").run(now());
      db.prepare("INSERT INTO oauth_tokens (token, server_id, kind, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(row.token, row.serverId, row.kind, row.expiresAt, now());
    },
    getToken(token: string): TokenRow | null {
      const row = db.prepare("SELECT * FROM oauth_tokens WHERE token = ?").get(token) as any;
      return row ? { token: row.token, serverId: row.server_id, kind: row.kind, expiresAt: row.expires_at ?? null } : null;
    },
    deleteToken(token: string): void {
      db.prepare("DELETE FROM oauth_tokens WHERE token = ?").run(token);
    },
    getSettings(): Settings {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'aws'").get() as { value: string } | undefined;
      return row ? JSON.parse(row.value) : { region: "us-east-1" };
    },
    putSettings(s: Settings): void {
      db.prepare("INSERT INTO settings (key, value) VALUES ('aws', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(JSON.stringify(s));
    },
  };
}

export type Repo = ReturnType<typeof makeRepo>;
