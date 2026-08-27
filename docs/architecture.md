# Architecture

rmcp is a pnpm workspace of five units. Each has one job, and they talk through
narrow interfaces — which is what makes a server behave identically whether it
ends up on your laptop or in Lambda.

| Package | Responsibility |
|---|---|
| `packages/shared` | zod schemas and constants shared by everything else. No logic. |
| `packages/bridge` | Translates Streamable HTTP into a stdio subprocess or an upstream HTTP call. |
| `packages/deployer` | The AWS pipeline: stage, zip, IAM role, SSM params, function, health check. |
| `apps/api` | Control plane: REST API, SQLite, local gateway, OAuth authorization server. |
| `apps/web` | React + Vite UI. Talks only to the control plane's REST API. |

## The bridge is the load-bearing abstraction

Everything interesting follows from one decision: **the bridge doesn't know
where it's running.**

Its entry point is a plain function — `makeHandler(loadRuntime, createBackend)`
— that takes an AWS Function URL event shape and returns a Function URL response
shape. In Lambda, that's literally the handler AWS invokes. Locally, the gateway
*synthesizes* the same event shape from an incoming Hono request and calls the
same function:

```ts
const event: FnUrlEvent = {
  requestContext: { http: { method: c.req.method } },
  headers, body: await c.req.text(), isBase64Encoded: false,
};
const res = await mounted.handle(event);
```

So the auth check, the JSON-RPC parsing, the error mapping, and the backend
dispatch are one implementation with one test suite. There is no "local mode"
branch to drift out of sync with the Lambda path.

The two units the handler is parameterized over:

**`loadRuntime`** produces `{ serverId, config, token, secrets, taskRoot }`. In
Lambda it reads them from SSM Parameter Store under `/rmcp/<id>/`, paginating
and decrypting, and memoizes the result across warm invocations. Locally the
control plane hands the runtime over directly at mount time — no SSM, no AWS
credentials needed.

**`createBackend`** switches on `config.mode`:

- **`stdio`** spawns the vendored MCP server as a child process
  (`node <taskRoot>/<binPath> …args`), performs the MCP `initialize` handshake
  once at spawn, and caches the result. Subsequent `initialize` requests are
  answered from that cache rather than restarting the child. Requests are
  correlated by an internal id with a 110-second timeout; if the child dies,
  every pending request is failed rather than left hanging.
- **`http-proxy`** POSTs the JSON-RPC message to the upstream URL with the
  configured headers plus the decrypted secrets merged in. It handles both JSON
  and `text/event-stream` responses, picking the SSE `data:` frame matching the
  request id. `mcp-session-id` and `mcp-protocol-version` pass through in both
  directions, and `DELETE` is relayed so clients can end upstream sessions.

### What the bridge deliberately doesn't do

It is **stateless**. There is no MCP session, no server-initiated request
channel, and no streaming to the client:

- Server → client requests get an immediate `-32601`; there is nowhere to send
  them.
- Server notifications are dropped for the same reason.
- JSON-RPC batch requests are rejected with `-32600`.

For the tool-calling servers this exists to host, none of that matters. For a
server that depends on sampling or elicitation, it does — that's a real
limitation, not an oversight.

## Control plane

`apps/api` is a Hono app on `127.0.0.1:8787` (loopback only — it is not meant to
be exposed; see [self-hosting](self-hosting.md) for putting a proxy in front).

`createApp({ repo, deployer })` is the whole surface. `repo` wraps SQLite;
`deployer` is a `DeployerPort` interface with seven methods, which is what lets
the entire test suite run against a stub with no AWS and no child processes.

Deploys are **asynchronous**. `POST /api/servers/:id/deploy` sets status to
`deploying`, returns `202` with an attempt id, and runs the pipeline in the
background, appending step events to `deploy_logs`. The UI polls
`GET /api/servers/:id/logs`, which returns only the latest attempt's rows. An
in-memory `inflight` set plus the `deploying` status make concurrent deploys of
the same server a `409`.

Switching a server's target has **replace semantics**: if the server is live
somewhere else, that target is torn down first. If the new deploy then fails,
the endpoint URL is cleared — because the old one genuinely no longer exists.

## Local gateway

A second Hono server on `0.0.0.0:8788` (port configurable), deliberately
listening on all interfaces so other devices on your LAN can reach it.

It's a registry: `mount(id, server)` / `unmount(id)`, with one route, `/:id`.
Requests are looked up by UUID, converted into a Function URL event, and handed
to the mounted handler. Mounting the same id twice disposes the old backend
first, so a redeploy never leaks a child process.

The OAuth routes are registered **before** `/:id`, or Hono's parameter route
would swallow `/.well-known/…`.

A dead gateway must not take down the control plane. If the port is unavailable,
the API still starts and every local-deployed server is flipped to `error` with
the reason.

**Rehydration.** Local servers are in-process, so an rmcp restart would
otherwise lose them. On boot, `rehydrateLocal` walks every server with status
`deployed` and target `local`, re-resolves its staged binary, and re-mounts it.
Staging directories with no matching server are pruned — the staging tree is a
disposable install cache, never a source of truth. A server whose staging has
gone missing is marked `error` with "redeploy" rather than silently disappearing.

## Deploy pipelines

### local

Three steps: **stage** (fresh `npm install` of the package into
`data/local/<id>/vendor`, so a version change leaves nothing stale behind),
**register** (mount into the gateway), **healthcheck**.

### lambda

Eight steps, each emitting `start` / `ok` / `fail` events into the deploy log:

1. **stage** — `npm install --omit=dev` the package into a work dir alongside the
   bundled bridge, with a scoped `.npmrc` pinning `registry.npmjs.org` so a
   corporate registry's auth and URLs never leak into the staged tree. Then
   prune: `.map` and TypeScript sources go (routinely half a package's size),
   and `node_modules/.bin` symlinks are stripped so the tree zips cleanly.
2. **zip** — refuses early if the unpacked tree exceeds Lambda's 250 MiB limit,
   with an error that says the server can't run on Lambda at all.
3. **role** — get-or-create a single shared `rmcp-lambda-role`, with an inline
   policy scoped to CloudWatch Logs and `arn:aws:ssm:*:*:parameter/rmcp/*`.
4. **params** — write the bridge config, the bearer token, and each secret to
   SSM under `/rmcp/<id>/`.
5. **upload** — only for zips over 45 MB, staged through
   `rmcp-deploy-<account>-<region>` and deleted once Lambda has copied the code.
6. **function** — create-or-update the function (`nodejs22.x`, arm64, 512 MB,
   120 s) and its Function URL. Creation retries for up to ~30 s because a
   freshly created IAM role takes a few seconds to become assumable.
7. **healthcheck** — a real MCP handshake: `initialize`, then
   `notifications/initialized`, then `tools/list`, retrying 5xx and 403 up to
   five times. A 403 that persists gets an explicit hint that the AWS account or
   organization may be blocking public Function URLs — which is otherwise a
   deeply confusing failure.

Undeploy deletes the Function URL config and the function. Both targets keep
secrets; only deleting the server purges them.

Functions are tagged `rmcp:server-id` and named `rmcp-<name>`, which is what
`GET /api/orphans` uses to find functions whose server no longer exists in the
local database.

## Data model

One SQLite file (`apps/api/data/rmcp.db` by default, WAL mode), five tables:

| Table | Holds |
|---|---|
| `servers` | id (UUID), name, config JSON, status, target, endpoint, bearer token, OAuth client id/secret, folder, sort index |
| `secrets` | plaintext secret values, keyed by (server_id, key) |
| `deploy_logs` | per-attempt step events |
| `oauth_codes` | short-lived authorization codes |
| `oauth_tokens` | access and refresh tokens |

Migrations run on open: `openDb` creates tables if absent, then inspects
`PRAGMA table_info` and adds missing columns with backfills. It's a one-way
ratchet suited to a single-user tool — no migration table, no down migrations.

Two schema decisions worth knowing:

**Endpoints are keyed by UUID, not name.** Renaming a server never breaks a
configured client. (The Lambda *function* is named after the server, which is
why renaming is refused while deployed to Lambda.)

**`aws_footprint` is a separate flag from `deployed_target`.** A server that
once touched AWS needs its SSM parameters cleaned up on delete even if it now
runs locally — and a purely local server must never trigger an AWS call on a
machine with no credentials. `deployed_target` survives undeploy as the UI's
"last used target" hint, so it alone can't answer that question.

## Config flow

A server definition is user-facing and secret-aware: env values are
`{kind: "plain", value}` or `{kind: "secret", set: boolean}` — the config knows a
secret *exists* without ever carrying it.

`toBridgeConfig` strips it down to what the bridge needs, keeping plain values
only. Secrets travel separately (SSM for Lambda, in-memory for local) and are
merged into the child's environment or the upstream headers at request time.
That's why the API can hand a full server record to the web UI without ever
exposing a secret value.
