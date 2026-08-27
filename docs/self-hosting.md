# Self-hosting

Running rmcp on a Linux box so your MCP endpoints are reachable over public
HTTPS from anywhere, while the management UI stays on your LAN.

This is the setup the files in [`deploy/`](../deploy) automate. The example uses
Caddy for automatic TLS and systemd for process supervision; nothing here is
specific to a distribution beyond `apt`.

## What you end up with

- **Public, from anywhere:** `https://mcp.example.com/service/<id>` — locally
  deployed MCP endpoints only. Caddy terminates TLS with an auto-renewing
  Let's Encrypt certificate. Every other path returns `403`.
- **LAN only:** the management UI and API at `http://<lan-ip>:8080`, behind HTTP
  Basic Auth, on a port that is never port-forwarded.

Reaching a server needs **both** its unguessable UUID path and its bearer token
(or an OAuth access token).

A modest box is plenty — the control plane is a Node process and a SQLite file.
The one thing to watch is RAM during `npm install` of native packages; see
[Troubleshooting](#troubleshooting).

## Before you start

1. A DNS record for `mcp.example.com` pointing at your public IP.
2. Your router forwarding ports **80 and 443** to the box. Port 80 is required
   for the ACME challenge and the HTTP→HTTPS redirect.
3. Ports 80 and 443 free on the box (`ss -tlnp | grep -E ":80 |:443 "`).
4. SSH access with a key, and `sudo`.

Throughout, set these once in your shell:

```bash
export RMCP_HOST=deploy@mcp-box          # user@host for ssh/rsync
export RMCP_SSH_KEY=~/.ssh/your_key
```

## Rollout

Order matters — Caddy needs the gateway to exist before it can proxy to it.

### 1. Provision the host

```bash
scp -i "$RMCP_SSH_KEY" deploy/provision.sh "$RMCP_HOST:/tmp/provision.sh"
ssh -i "$RMCP_SSH_KEY" "$RMCP_HOST" 'RMCP_USER=deploy bash /tmp/provision.sh'
```

Installs build tools, Node 22 from NodeSource, and Caddy from its official apt
repo; creates `/opt/rmcp` owned by `RMCP_USER`; adds a 1 GB swapfile if no swap
is active. Idempotent — safe to re-run.

### 2. Ship the code

```bash
bash deploy/ship.sh
```

Builds the web UI **locally** (keeping Vite's memory usage off the box), rsyncs
the tree, then runs `pnpm install` and builds the bridge bundle on the host.
`apps/api/data` is excluded, so shipping never overwrites the live database.

### 3. Migrate an existing database (optional, first time only)

If you already ran rmcp somewhere else, bring its database over — with rmcp
**not running** on the source machine:

```bash
sqlite3 apps/api/data/rmcp.db ".backup '/tmp/rmcp-migrate.db'"
scp -i "$RMCP_SSH_KEY" /tmp/rmcp-migrate.db \
    "$RMCP_HOST:/opt/rmcp/apps/api/data/rmcp.db"
ssh -i "$RMCP_SSH_KEY" "$RMCP_HOST" 'chmod 600 /opt/rmcp/apps/api/data/rmcp.db'
```

`.backup` collapses the WAL, so the `-wal` and `-shm` sidecars need not be
copied. **Mode 600 matters** — the file holds secrets in plaintext.

### 4. Install the systemd unit

Edit `User=` in `deploy/rmcp.service` to match the account that owns
`/opt/rmcp`, then:

```bash
scp -i "$RMCP_SSH_KEY" deploy/rmcp.service "$RMCP_HOST:/tmp/"
ssh -i "$RMCP_SSH_KEY" "$RMCP_HOST" '
  sudo install -m 644 /tmp/rmcp.service /etc/systemd/system/rmcp.service
  sudo systemctl daemon-reload
  sudo systemctl enable --now rmcp
'
```

Allow ~10 seconds for `tsx` to boot. `systemctl is-active rmcp` should say
`active`.

### 5. Configure and install Caddy

The Caddyfile reads every host-specific value from the environment, so nothing
sensitive is committed. Supply them through a root-only drop-in:

```bash
ssh -i "$RMCP_SSH_KEY" "$RMCP_HOST" '
  HASH=$(caddy hash-password --plaintext "your-ui-password")
  sudo mkdir -p /etc/systemd/system/caddy.service.d
  sudo tee /etc/systemd/system/caddy.service.d/override.conf >/dev/null <<EOF
[Service]
Environment=RMCP_PUBLIC_HOST=mcp.example.com
Environment=RMCP_LAN_ADDR=192.0.2.10:8080
Environment=RMCP_ADMIN_USER=admin
Environment=RMCP_BASIC_AUTH_HASH=$HASH
EOF
  sudo chmod 600 /etc/systemd/system/caddy.service.d/override.conf
  sudo systemctl daemon-reload
'
```

Then install the Caddyfile and reload:

```bash
scp -i "$RMCP_SSH_KEY" deploy/Caddyfile "$RMCP_HOST:/tmp/"
ssh -i "$RMCP_SSH_KEY" "$RMCP_HOST" '
  sudo install -m 640 -o root -g caddy /tmp/Caddyfile /etc/caddy/Caddyfile
  sudo systemctl restart caddy
'
```

Restart rather than reload the first time, so the new environment is picked up.
Caddy obtains the certificate on first start via the ACME `tls-alpn-01`
challenge on port 443.

> `caddy validate` must be run **on the host**, not locally — the LAN vhost
> reads variables that only exist in the drop-in there.

### 6. Point rmcp at its public URL

Open the LAN UI at `http://<lan-ip>:8080`, go to **Settings**, and set
**Public MCP base URL** to `https://mcp.example.com/service`.

This makes client snippets render the public URL, and it enables OAuth — the
issuer is derived from it. Until it's set, every OAuth endpoint returns `503`.

## Redeploying after a code change

```bash
bash deploy/ship.sh
ssh -i "$RMCP_SSH_KEY" "$RMCP_HOST" 'sudo systemctl restart rmcp'
```

Locally deployed servers are re-mounted automatically on start, so a restart
does not require redeploying them.

## What the proxy exposes

Caddy forwards exactly three prefixes to the gateway on `127.0.0.1:8788`, each
with its own request-body cap:

| Prefix | Body limit | Purpose |
|---|---|---|
| `/service/*` | 4 MB | MCP endpoints (prefix stripped) |
| `/oauth/*` | 16 KB | Authorization server (prefix preserved) |
| `/.well-known/oauth-*` | 4 KB | Discovery metadata |

Everything else — including `/` — returns `403`. The body limits are the only
DoS protection in the stack; rmcp itself does no rate limiting.

## Operating notes

- **Lambda-target servers appear in the UI but can't be deployed from the box**
  if it has no AWS credentials. That's by design — manage those from a machine
  that does.
- **Changing the gateway port** in Settings doesn't rebind a running gateway.
  Restart `rmcp.service`.
- **Renaming a server doesn't change its URL** — endpoints are keyed by UUID.
- **Both units are enabled**, so they survive a reboot.
- **Servers deployed before OAuth existed have no OAuth credentials.** They keep
  working on their bearer token, but an OAuth connect attempt fails quietly.
  Redeploy them, or press **Regenerate** on the server's page. To check:
  ```bash
  sqlite3 /opt/rmcp/apps/api/data/rmcp.db \
    "SELECT name, oauth_client_id IS NOT NULL AS has_oauth
     FROM servers WHERE deployed_target='local';"
  ```
- **Regenerating credentials revokes every outstanding token** for that server.
  Clients connected via OAuth must be re-added.

## Health checks

```bash
ssh -i "$RMCP_SSH_KEY" "$RMCP_HOST" 'systemctl is-active rmcp caddy'
```

A real MCP handshake against a deployed server needs its id and token:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://mcp.example.com/service/<id> \
  -H 'authorization: Bearer <token>' \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
```

Expected: `200` with the token, `401` without it, `404` for an unknown id, and
`403` for `https://mcp.example.com/` or any non-`/service` path.

Check the OAuth metadata too:

```bash
curl -s https://mcp.example.com/.well-known/oauth-authorization-server | jq .
```

## Troubleshooting

**`npm install` gets OOM-killed on a small box.** Packages with native addons
compile from source when a prebuilt binary can't be resolved, which can exhaust
RAM on a 1–2 GB host and leave the server undeployed. Make sure swap is active
(`provision.sh` adds some), and prefer packages that ship prebuilt binaries. A
server that can't build is better deployed to Lambda, or staged from a bigger
machine.

**Certificate never issues.** Port 80 must reach the box from the internet, and
DNS must have propagated. `journalctl -u caddy -n 50` shows the ACME exchange.

**`503` from every OAuth endpoint.** `publicMcpBaseUrl` isn't set in Settings.

**Local servers show `error: local staging missing` after a restore.** The
staging tree is a disposable install cache and isn't part of the database.
Redeploy those servers.

**The control plane is unreachable from the LAN but `rmcp` is active.** The API
binds to `127.0.0.1` deliberately; only Caddy's LAN vhost should reach it. Check
`RMCP_LAN_ADDR` in the drop-in matches the box's actual LAN address.
