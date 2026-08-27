import { randomBytes } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBackend, makeHandler, type Runtime } from "@rmcp/bridge";
import { healthCheck, resolveBin, stageBundle, toBridgeConfig, type StepEvent } from "@rmcp/deployer";
import type { ServerRecord } from "@rmcp/shared";
import type { Gateway } from "./gateway.js";

export interface LocalDeps {
  gateway: Gateway;
  localRoot: string;
  getPort: () => number;
  healthDelayMs?: number;
}

export function localHostname(): string {
  const h = os.hostname().toLowerCase();
  return h.endsWith(".local") ? h : `${h}.local`;
}

function mount(deps: LocalDeps, id: string, runtime: Runtime): void {
  const backend = createBackend(runtime);
  const handler = makeHandler(async () => runtime, () => backend);
  deps.gateway.mount(id, { handle: handler, dispose: () => backend.dispose?.() });
}

type LocalStep = "stage" | "register" | "healthcheck";

export async function deployLocal(
  record: ServerRecord,
  secrets: Record<string, string>,
  deps: LocalDeps,
  onEvent?: (e: StepEvent) => void,
): Promise<{ endpointUrl: string; bearerToken: string; oauthClientId: string; oauthClientSecret: string }> {
  const emit = onEvent ?? (() => {});
  async function step<T>(name: LocalStep, fn: () => Promise<T>): Promise<T> {
    emit({ step: name, status: "start" });
    try {
      const result = await fn();
      emit({ step: name, status: "ok" });
      return result;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      emit({ step: name, status: "fail", detail });
      throw new Error(`${name}: ${detail}`, { cause: err });
    }
  }

  const dir = path.join(deps.localRoot, record.id);
  let binPath: string | undefined;
  if (record.config.type === "stdio") {
    binPath = (await step("stage", async () => {
      // fresh install so a changed package/version leaves no stale files behind
      await rm(dir, { recursive: true, force: true });
      return stageBundle({ config: record.config, workDir: dir });
    })).binPath;
  }

  const bearerToken = record.bearerToken ?? randomBytes(32).toString("base64url");
  // reused across redeploys: rotating them would silently break every
  // already-connected client for an unrelated code change
  const oauthClientId = record.oauthClientId ?? randomBytes(16).toString("base64url");
  const oauthClientSecret = record.oauthClientSecret ?? randomBytes(32).toString("base64url");
  await step("register", async () => {
    mount(deps, record.id, {
      serverId: record.id,
      config: toBridgeConfig(record, binPath),
      token: bearerToken,
      secrets,
      taskRoot: dir,
    });
  });

  const port = deps.getPort();
  await step("healthcheck", () => healthCheck(
    `http://127.0.0.1:${port}/${record.id}`, bearerToken, { delayMs: deps.healthDelayMs ?? 500 },
  ));
  return {
    endpointUrl: `http://${localHostname()}:${port}/${record.id}`,
    bearerToken, oauthClientId, oauthClientSecret,
  };
}

export async function undeployLocal(record: ServerRecord, deps: LocalDeps): Promise<void> {
  deps.gateway.unmount(record.id);
}

export async function removeLocalStaging(localRoot: string, serverId: string): Promise<void> {
  await rm(path.join(localRoot, serverId), { recursive: true, force: true });
}

export async function rehydrateLocal(
  records: ServerRecord[],
  getSecrets: (serverId: string) => Record<string, string>,
  deps: LocalDeps,
  markError: (serverId: string, message: string) => void,
): Promise<void> {
  // local staging is a disposable install cache: prune dirs with no matching server
  const known = new Set(records.map((r) => r.id));
  const entries = await readdir(deps.localRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory() && !known.has(entry.name)) {
      await rm(path.join(deps.localRoot, entry.name), { recursive: true, force: true })
        .catch((err) => console.error(`failed to prune orphan staging ${entry.name}`, err));
    }
  }

  for (const record of records) {
    if (record.status !== "deployed" || record.deployedTarget !== "local" || !record.bearerToken) continue;
    try {
      const dir = path.join(deps.localRoot, record.id);
      let binPath: string | undefined;
      if (record.config.type === "stdio") {
        binPath = await resolveBin(path.join(dir, "vendor"), record.config.package);
        await stat(path.join(dir, binPath));
      }
      mount(deps, record.id, {
        serverId: record.id,
        config: toBridgeConfig(record, binPath),
        token: record.bearerToken,
        secrets: getSecrets(record.id),
        taskRoot: dir,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      markError(record.id, `local staging missing — redeploy (${detail})`);
    }
  }
}
