import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { FnUrlEvent, FnUrlResponse } from "@rmcp/bridge";
import type { OAuthProvider } from "./oauth.js";

export interface MountedServer {
  handle(event: FnUrlEvent): Promise<FnUrlResponse>;
  dispose(): void;
}

export interface Gateway {
  app: Hono;
  mount(id: string, s: MountedServer): void;
  unmount(id: string): void;
  ids(): string[];
  listen(port: number): ServerType;
}

export interface GatewayDeps { oauth?: OAuthProvider }

export function createGateway(deps: GatewayDeps = {}): Gateway {
  const registry = new Map<string, MountedServer>();
  const app = new Hono();

  // must come first: "/.well-known/..." would otherwise be swallowed by "/:id"
  if (deps.oauth) app.route("/", deps.oauth.routes);

  app.all("/:id", async (c) => {
    const id = c.req.param("id");
    const mounted = registry.get(id);
    if (!mounted) return c.json({ error: "unknown server" }, 404);
    const headers = Object.fromEntries(c.req.raw.headers);
    // a valid OAuth access token stands in for the static bearer, so the bridge
    // keeps doing the one check it already knows how to do
    const forwarded = deps.oauth?.resolve(id, headers.authorization);
    if (forwarded) headers.authorization = `Bearer ${forwarded}`;
    const event: FnUrlEvent = {
      requestContext: { http: { method: c.req.method } },
      headers,
      body: await c.req.text(),
      isBase64Encoded: false,
    };
    try {
      const res = await mounted.handle(event);
      const outHeaders = { ...(res.headers ?? {}) };
      // A 401 that arrived with a token that already resolved (`forwarded`
      // non-null) is definitionally not an rmcp auth failure — it's the
      // upstream rejecting its own credentials (e.g. httpProxy's handleDelete
      // relaying the upstream's status verbatim). Stamping a challenge on that
      // would send a client with a perfectly good token into a re-auth loop.
      if (res.statusCode === 401 && !forwarded) {
        const challenge = deps.oauth?.challengeHeader(id);
        // tells a spec-compliant client where to start the OAuth dance
        if (challenge) outHeaders["www-authenticate"] ??= challenge;
      }
      return c.newResponse(res.body || null, res.statusCode as ContentfulStatusCode, outHeaders);
    } catch (err) {
      console.error("gateway handler error", err);
      return c.json({ error: "internal error" }, 500);
    }
  });

  return {
    app,
    mount(id, s) {
      registry.get(id)?.dispose();
      registry.set(id, s);
    },
    unmount(id) {
      registry.get(id)?.dispose();
      registry.delete(id);
    },
    ids: () => [...registry.keys()],
    listen(port) {
      return serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
    },
  };
}
