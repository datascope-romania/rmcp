#!/usr/bin/env bash
# Ship rmcp from a local working tree to the host, then install + build there.
# Run from the repo root. Safe to re-run (this is also the redeploy path).
#
#   RMCP_HOST      user@host to ship to           (required)
#   RMCP_SSH_KEY   ssh identity file              (default ~/.ssh/id_ed25519)
#   RMCP_DEST      install directory on the host  (default /opt/rmcp)
#
#   RMCP_HOST=deploy@mcp-box bash deploy/ship.sh
#
# Rather than exporting these every time, put them in an untracked `.env.deploy`
# at the repo root; it is sourced automatically when present, and its values
# take effect over anything already in the environment.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -f .env.deploy ]; then
  # shellcheck disable=SC1091
  . ./.env.deploy
fi

HOST="${RMCP_HOST:?set RMCP_HOST=user@host, or put it in .env.deploy}"
KEY="${RMCP_SSH_KEY:-$HOME/.ssh/id_ed25519}"
DEST="${RMCP_DEST:-/opt/rmcp}"

echo "==> build web UI locally (keeps Vite off a small host)"
pnpm --filter @rmcp/web build

echo "==> rsync source to $HOST:$DEST"
rsync -az --delete \
  -e "ssh -i $KEY" \
  --exclude '.git' --exclude 'node_modules' --exclude 'apps/api/data' \
  --exclude '.claude' --exclude '.remember' --exclude '.superpowers' \
  --exclude '.playwright-mcp' \
  ./ "$HOST:$DEST/"

echo "==> install deps + build bridge on the host"
ssh -i "$KEY" "$HOST" "set -euo pipefail; cd '$DEST'; corepack pnpm install --frozen-lockfile; corepack pnpm --filter @rmcp/bridge build"
echo "ship OK"
echo "==> reminder: code changes need a restart to take effect:"
echo "    ssh -i $KEY $HOST 'sudo systemctl restart rmcp'"
