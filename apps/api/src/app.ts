import { randomBytes, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { DeployTargetSchema, SERVER_NAME_RE, ServerConfigSchema, type ServerConfig } from "@rmcp/shared";
import { z } from "zod";
import type { DeployerPort } from "./deployer.js";
import { withDisplayEndpoint } from "./endpoint.js";
import { exportSnippets } from "./export.js";
import type { Repo } from "./repo.js";

export interface AppDeps { repo: Repo; deployer: DeployerPort }

const FolderSchema = z.string().trim().min(1).max(60).nullable();
const OrderBody = z.object({ ids: z.array(z.uuid()) });
const CreateBody = z.object({ name: z.string().regex(SERVER_NAME_RE), config: ServerConfigSchema, folder: FolderSchema.optional() });
const UpdateBody = z.object({ name: z.string().regex(SERVER_NAME_RE).optional(), config: ServerConfigSchema.optional(), folder: FolderSchema.optional() });
const SettingsBody = z.object({
  region: z.string().min(1),
  profile: z.string().min(1).optional(),
  localGatewayPort: z.number().int().min(1).max(65535).optional(),
  publicMcpBaseUrl: z.union([z.url(), z.literal("")]).optional(),
  oauthRedirectUris: z.array(z.string().min(1)).optional(),
});
const SecretBody = z.object({ value: z.string().min(1) });
const CleanupBody = z.object({ items: z.array(z.object({ functionName: z.string(), serverId: z.string() })) });
const DeployBody = z.object({ target: DeployTargetSchema.default("lambda") });

const BUSY_STATUSES = ["deployed", "deploying"];

function flipSecretFlag(config: ServerConfig, key: string, set: boolean): ServerConfig | null {
  const bag = config.type === "stdio" ? config.env : config.headers;
  const entry = bag[key];
  if (!entry || entry.kind !== "secret") return null;
  const updatedBag = { ...bag, [key]: { kind: "secret" as const, set } };
  return config.type === "stdio" ? { ...config, env: updatedBag } : { ...config, headers: updatedBag };
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  const { repo, deployer } = deps;
  const inflight = new Set<string>();

  app.get("/api/servers", (c) => {
    const s = repo.getSettings();
    const port = s.localGatewayPort ?? 8788;
    return c.json(repo.listServers().map((r) => withDisplayEndpoint(r, s, port)));
  });

  app.post("/api/servers", async (c) => {
    const parsed = CreateBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      return c.json(repo.createServer(parsed.data.name, parsed.data.config, parsed.data.folder ?? null), 201);
    } catch (err) {
      if (err instanceof Error && err.message.includes("UNIQUE")) {
        return c.json({ error: `a server named "${parsed.data.name}" already exists` }, 409);
      }
      throw err;
    }
  });

  app.get("/api/servers/:id", (c) => {
    const rec = repo.getServer(c.req.param("id"));
    if (!rec) return c.json({ error: "not found" }, 404);
    const s = repo.getSettings();
    return c.json(withDisplayEndpoint(rec, s, s.localGatewayPort ?? 8788));
  });

  app.put("/api/servers/order", async (c) => {
    const parsed = OrderBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      repo.setServerOrder(parsed.data.ids);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    return c.body(null, 204);
  });

  app.put("/api/servers/:id", async (c) => {
    const rec = repo.getServer(c.req.param("id"));
    if (!rec) return c.json({ error: "not found" }, 404);
    const parsed = UpdateBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    if (
      parsed.data.name && parsed.data.name !== rec.name &&
      BUSY_STATUSES.includes(rec.status) && rec.deployedTarget !== "local"
    ) {
      return c.json({ error: "cannot rename while deployed (the Lambda function is named after the server); undeploy first" }, 409);
    }
    return c.json(repo.updateServer(rec.id, parsed.data));
  });

  app.delete("/api/servers/:id", async (c) => {
    const rec = repo.getServer(c.req.param("id"));
    if (!rec) return c.json({ error: "not found" }, 404);
    if (BUSY_STATUSES.includes(rec.status)) {
      return c.json({ error: "undeploy before deleting" }, 409);
    }
    if (rec.awsFootprint) await deployer.deleteAllParams(rec.id);
    if (rec.deployedTarget === "local") await deployer.undeploy(rec); // clear any zombie mount (idempotent)
    await deployer.removeLocalStaging(rec.id);
    repo.deleteServer(rec.id);
    return c.body(null, 204);
  });

  app.get("/api/settings", (c) => c.json(repo.getSettings()));
  app.put("/api/settings", async (c) => {
    const parsed = SettingsBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    repo.putSettings(parsed.data);
    return c.json(parsed.data);
  });

  app.post("/api/servers/:id/deploy", async (c) => {
    const rec = repo.getServer(c.req.param("id"));
    if (!rec) return c.json({ error: "not found" }, 404);
    if (rec.status === "deploying" || inflight.has(rec.id)) {
      return c.json({ error: "a deploy is already in flight" }, 409);
    }
    const parsed = DeployBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const target = parsed.data.target;
    const secrets = repo.getSecretValues(rec.id);
    if (target === "local") {
      const bag = rec.config.type === "stdio" ? rec.config.env : rec.config.headers;
      const missing = Object.entries(bag)
        .filter(([key, v]) => v.kind === "secret" && v.set && !(key in secrets))
        .map(([key]) => key);
      if (missing.length > 0) {
        // declared-and-set secret with no local value: it predates the SQLite secrets store
        return c.json({ error: missing.map((k) => `re-enter secret "${k}" (stored only in AWS)`).join("; ") }, 400);
      }
    }
    const attempt = randomUUID();
    inflight.add(rec.id);
    repo.setServerState(rec.id, { status: "deploying", lastError: null });
    // deployedTarget survives undeploy as the UI's "last used target" hint, so it
    // alone does not mean compute still exists there. For these statuses nothing is
    // live to tear down — and attempting it anyway breaks local deploys on a host
    // with no AWS credentials. "error" is deliberately NOT included: an errored
    // deploy may have left orphaned compute behind, which must still be reclaimed.
    const nothingLiveAtOldTarget = rec.status === "undeployed" || rec.status === "draft";
    let undeployedOldTarget = false;
    void (async () => {
      if (rec.deployedTarget && rec.deployedTarget !== target && !nothingLiveAtOldTarget) {
        await deployer.undeploy(rec); // replace semantics: leave the old target first
        undeployedOldTarget = true;
      }
      const res = await deployer.deploy(rec, target, secrets, (e) => repo.appendDeployLog(rec.id, attempt, e));
      repo.setServerState(rec.id, {
        status: "deployed", endpointUrl: res.endpointUrl, bearerToken: res.bearerToken,
        lastError: null, deployedTarget: target,
        ...(target === "lambda" ? { awsFootprint: true } : {}),
      });
      if (res.oauthClientId && res.oauthClientSecret) {
        repo.setOAuthClient(rec.id, res.oauthClientId, res.oauthClientSecret);
      }
    })()
      .catch((err) => repo.setServerState(rec.id, {
        status: "error",
        lastError: err instanceof Error ? err.message : String(err),
        // the old target was torn down before the new deploy failed — its endpoint no longer exists
        ...(undeployedOldTarget ? { endpointUrl: null } : {}),
      }))
      .finally(() => inflight.delete(rec.id));
    return c.json({ attempt }, 202);
  });

  app.post("/api/servers/:id/undeploy", async (c) => {
    const rec = repo.getServer(c.req.param("id"));
    if (!rec) return c.json({ error: "not found" }, 404);
    await deployer.undeploy(rec);
    repo.setServerState(rec.id, { status: "undeployed", endpointUrl: null });
    return c.json(repo.getServer(rec.id));
  });

  app.post("/api/servers/:id/oauth/regenerate", (c) => {
    const rec = repo.getServer(c.req.param("id"));
    if (!rec) return c.json({ error: "not found" }, 404);
    if (rec.deployedTarget !== "local") return c.json({ error: "OAuth is local-target only" }, 400);
    // A deploy in flight for this server will, on completion, write the
    // PRE-regenerate credentials back via setOAuthClient — reverting the
    // rotation while leaving grants cleared. Refuse until it settles.
    if (inflight.has(rec.id)) return c.json({ error: "a deploy is in flight for this server" }, 409);
    repo.setOAuthClient(rec.id, randomBytes(16).toString("base64url"), randomBytes(32).toString("base64url"));
    // regenerating is how a connection is revoked: outstanding codes and
    // tokens must not survive the credentials that authorised them
    repo.clearOAuthGrants(rec.id);
    return c.json(repo.getServer(rec.id));
  });

  app.get("/api/servers/:id/logs", (c) => {
    const rec = repo.getServer(c.req.param("id"));
    if (!rec) return c.json({ error: "not found" }, 404);
    return c.json(repo.latestDeployLogs(rec.id));
  });

  app.put("/api/servers/:id/secrets/:key", async (c) => {
    const rec = repo.getServer(c.req.param("id"));
    if (!rec) return c.json({ error: "not found" }, 404);
    const key = c.req.param("key");
    const parsed = SecretBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const updated = flipSecretFlag(rec.config, key, true);
    if (!updated) return c.json({ error: `"${key}" is not declared as a secret in this server's config` }, 400);
    repo.putSecretValue(rec.id, key, parsed.data.value);
    return c.json(repo.updateServer(rec.id, { config: updated }));
  });

  app.delete("/api/servers/:id/secrets/:key", async (c) => {
    const rec = repo.getServer(c.req.param("id"));
    if (!rec) return c.json({ error: "not found" }, 404);
    const key = c.req.param("key");
    const updated = flipSecretFlag(rec.config, key, false);
    if (!updated) return c.json({ error: `"${key}" is not declared as a secret in this server's config` }, 400);
    repo.deleteSecretValue(rec.id, key);
    if (rec.awsFootprint) await deployer.deleteRemoteSecret(rec.id, key);
    return c.json(repo.updateServer(rec.id, { config: updated }));
  });

  app.get("/api/servers/:id/export", (c) => {
    const rec = repo.getServer(c.req.param("id"));
    if (!rec) return c.json({ error: "not found" }, 404);
    if (rec.status !== "deployed" || !rec.endpointUrl) return c.json({ error: "server is not deployed" }, 400);
    const s = repo.getSettings();
    return c.json(exportSnippets(withDisplayEndpoint(rec, s, s.localGatewayPort ?? 8788)));
  });

  app.get("/api/orphans", async (c) => {
    const known = new Set(repo.listServers().map((s) => s.id));
    const all = await deployer.listOrphans();
    return c.json(all.filter((f) => !known.has(f.serverId)));
  });

  app.post("/api/orphans/cleanup", async (c) => {
    const parsed = CleanupBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    for (const item of parsed.data.items) {
      await deployer.destroyFunction(item.functionName);
      await deployer.deleteAllParams(item.serverId);
    }
    return c.json({ removed: parsed.data.items.length });
  });

  return app;
}
