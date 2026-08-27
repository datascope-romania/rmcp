# Deployment artifacts

Files for running rmcp on a Linux host behind Caddy. The full walkthrough —
prerequisites, rollout order, TLS, Basic Auth, health checks — is in
[`docs/self-hosting.md`](../docs/self-hosting.md).

| File | What it is |
|---|---|
| `provision.sh` | Idempotent host setup: build tools, Node 22, Caddy, install dir, swap. Run **on the host**. |
| `ship.sh` | Builds the web UI locally, rsyncs the tree to the host, installs deps and builds the bridge there. Run **from the repo root**. |
| `rmcp.service` | systemd unit for the control plane. Install to `/etc/systemd/system/`. |
| `Caddyfile` | Two vhosts: public MCP endpoints (auto-TLS) and a LAN-only management UI behind Basic Auth. Install to `/etc/caddy/Caddyfile`. |

Every host-specific value — hostname, user, install path, SSH key, Basic Auth
credentials — comes from the environment. Nothing here is checked in.
