import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { openDb } from "./db.js";
import { createDeployer } from "./deployer.js";
import { rehydrateLocal, type LocalDeps } from "./local/deployer.js";
import { createGateway } from "./local/gateway.js";
import { createOAuth } from "./local/oauth.js";
import { makeRepo } from "./repo.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeBundlePath = path.resolve(here, "../../../packages/bridge/dist/index.mjs");
if (!existsSync(bridgeBundlePath)) {
  console.error(`bridge bundle missing at ${bridgeBundlePath} — run: pnpm --filter @rmcp/bridge build`);
  process.exit(1);
}

// Anchor to this module's location, not process.cwd(): the DB must resolve to
// the same file no matter which directory the API is launched from.
const dbPath = process.env.RMCP_DB_PATH ?? path.join(here, "..", "data", "rmcp.db");
const repo = makeRepo(openDb(dbPath));

const gateway = createGateway({ oauth: createOAuth({ repo }) });
const gatewayPort = repo.getSettings().localGatewayPort ?? 8788;
const local: LocalDeps = {
  gateway,
  localRoot: path.join(path.dirname(dbPath), "local"),
  getPort: () => gatewayPort,
};

const app = createApp({ repo, deployer: createDeployer(() => repo.getSettings(), bridgeBundlePath, local) });

function markLocalServersError(message: string): void {
  for (const rec of repo.listServers()) {
    if (rec.status === "deployed" && rec.deployedTarget === "local") {
      repo.setServerState(rec.id, { status: "error", lastError: message });
    }
  }
}

const gatewayServer = gateway.listen(gatewayPort);
// a dead gateway must not take down the control plane; flag affected servers instead
gatewayServer.on("error", (err: Error) => {
  console.error(`local gateway failed on :${gatewayPort} — ${err.message}`);
  markLocalServersError(`local gateway port ${gatewayPort} unavailable: ${err.message}`);
});
gatewayServer.on("listening", () => {
  console.log(`local gateway listening on http://0.0.0.0:${gatewayPort}`);
});

try {
  await rehydrateLocal(
    repo.listServers(),
    (id) => repo.getSecretValues(id),
    local,
    (id, message) => repo.setServerState(id, { status: "error", lastError: message }),
  );
} catch (err) {
  console.error("local rehydration failed", err);
}

const port = Number(process.env.RMCP_API_PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
console.log(`rmcp api listening on http://127.0.0.1:${port} (db: ${dbPath})`);
