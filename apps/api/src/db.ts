import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type Db = Database.Database;

export function openDb(dbPath: string): Db {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      config_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      endpoint_url TEXT,
      bearer_token TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deploy_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id TEXT NOT NULL,
      attempt TEXT NOT NULL,
      step TEXT NOT NULL,
      status TEXT NOT NULL,
      detail TEXT,
      ts TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  const cols = (db.prepare("PRAGMA table_info(servers)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("deployed_target")) {
    db.exec("ALTER TABLE servers ADD COLUMN deployed_target TEXT");
    db.exec("UPDATE servers SET deployed_target = 'lambda' WHERE status = 'deployed'");
  }
  if (!cols.includes("aws_footprint")) {
    db.exec("ALTER TABLE servers ADD COLUMN aws_footprint INTEGER NOT NULL DEFAULT 0");
    // pre-migration heuristic: anything beyond a pristine draft touched AWS
    // (deploys created resources; entering a secret wrote it straight to SSM)
    db.exec(`UPDATE servers SET aws_footprint = 1
      WHERE status != 'draft' OR endpoint_url IS NOT NULL OR bearer_token IS NOT NULL
        OR config_json LIKE '%"set":true%'`);
  }
  if (!cols.includes("folder")) {
    db.exec("ALTER TABLE servers ADD COLUMN folder TEXT");
  }
  if (!cols.includes("sort_index")) {
    db.exec("ALTER TABLE servers ADD COLUMN sort_index INTEGER NOT NULL DEFAULT 0");
    // backfill by the previous display order (alphabetical by name)
    const rows = db.prepare("SELECT id FROM servers ORDER BY name").all() as { id: string }[];
    const set = db.prepare("UPDATE servers SET sort_index = ? WHERE id = ?");
    rows.forEach((row, i) => set.run(i, row.id));
  }
  if (!cols.includes("oauth_client_id")) {
    db.exec("ALTER TABLE servers ADD COLUMN oauth_client_id TEXT");
    db.exec("ALTER TABLE servers ADD COLUMN oauth_client_secret TEXT");
  }
  // enforce uniqueness only across servers that actually have a client_id;
  // rows with a NULL oauth_client_id (the common case — most servers have
  // no OAuth credentials yet) are excluded and may coexist without limit
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS servers_oauth_client_id ON servers (oauth_client_id) WHERE oauth_client_id IS NOT NULL;");
  db.exec(`CREATE TABLE IF NOT EXISTS secrets (
    server_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (server_id, key)
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS oauth_codes (
    code           TEXT PRIMARY KEY,
    server_id      TEXT NOT NULL,
    redirect_uri   TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    resource       TEXT,
    expires_at     TEXT NOT NULL
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS oauth_tokens (
    token      TEXT PRIMARY KEY,
    server_id  TEXT NOT NULL,
    kind       TEXT NOT NULL,
    expires_at TEXT,
    created_at TEXT NOT NULL
  );`);
  db.exec("CREATE INDEX IF NOT EXISTS oauth_tokens_server ON oauth_tokens (server_id);");

  return db;
}
