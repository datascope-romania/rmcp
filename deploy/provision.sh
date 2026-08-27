#!/usr/bin/env bash
# Idempotent host provisioning for rmcp. Run ON the host (via ssh). Safe to re-run.
#
#   RMCP_USER   account that will own the install dir (default: the invoking user)
#   RMCP_DEST   install directory                     (default /opt/rmcp)
set -euo pipefail

RMCP_USER="${RMCP_USER:-$(id -un)}"
RMCP_DEST="${RMCP_DEST:-/opt/rmcp}"

echo "==> apt base packages"
sudo apt-get update -y
sudo apt-get install -y build-essential python3 curl ca-certificates debian-keyring debian-archive-keyring apt-transport-https

echo "==> Node 22 (NodeSource) if missing or <22"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if ! command -v node >/dev/null 2>&1 || [ "$NODE_MAJOR" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo corepack enable

echo "==> Caddy (official apt repo) if missing"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi

echo "==> $RMCP_DEST owned by $RMCP_USER"
sudo mkdir -p "$RMCP_DEST/apps/api/data"
sudo chown -R "$RMCP_USER:$RMCP_USER" "$RMCP_DEST"

# Swap: some images ship with swap already active under a non-standard path, so
# check for ANY active swap rather than a specific /swapfile path (a
# path-specific check would add a redundant second swap area on top).
echo "==> swap"
if [ -z "$(swapon --show --noheadings 2>/dev/null)" ]; then
  echo "    no active swap — creating 1G /swapfile"
  sudo fallocate -l 1G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
else
  echo "    active swap already present — skipping:"
  swapon --show
fi

echo "==> versions"
node -v
(pnpm -v 2>/dev/null || corepack pnpm -v)
caddy version
echo "provision OK"
