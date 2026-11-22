#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8787}"
CONFIG_PATH="$REPO_ROOT/cloudflared.yml"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "Error: cloudflared is not installed or not in PATH." >&2
  exit 1
fi

MODE="${1:-}"

if [[ -z "$MODE" || "$MODE" == "--quick" || "$MODE" == "--run" ]]; then
  echo "Quick Tunnel mode (no domain or DNS auth required):"
  echo "  cloudflared tunnel --no-autoupdate --config /dev/null --url http://127.0.0.1:${PORT}"
  echo ""
  echo "Note: Quick Tunnel assigns a random https://<id>.trycloudflare.com URL per run."
  echo "For a stable URL, pass an active custom hostname instead:"
  echo "  bash scripts/setup-tunnel.sh <active-hostname> [tunnel-name]"
  if [[ "$MODE" == "--run" ]]; then
    exec cloudflared tunnel --no-autoupdate --config /dev/null --url "http://127.0.0.1:${PORT}"
  fi
  exit 0
fi

HOSTNAME="$MODE"
TUNNEL_NAME="${2:-${TUNNEL_NAME:-agy-linear}}"

resolve_tunnel_id() {
  cloudflared tunnel list -o json 2>/dev/null \
    | python3 -c "import json,sys; items=json.load(sys.stdin) or []; print(next((i['id'] for i in items if i.get('name')==sys.argv[1] and (not i.get('deleted_at') or i.get('deleted_at','').startswith('0001-'))), ''))" "$TUNNEL_NAME"
}

echo "Checking Cloudflare tunnel '$TUNNEL_NAME'..."
TUNNEL_ID="$(resolve_tunnel_id)"
if [[ -z "$TUNNEL_ID" ]]; then
  echo "Creating tunnel '$TUNNEL_NAME'..."
  cloudflared tunnel create "$TUNNEL_NAME"
  TUNNEL_ID="$(resolve_tunnel_id)"
else
  echo "Tunnel '$TUNNEL_NAME' already exists ($TUNNEL_ID)."
fi

if [[ -z "$TUNNEL_ID" ]]; then
  echo "Error: could not resolve tunnel ID for '$TUNNEL_NAME'." >&2
  exit 1
fi

CREDS_FILE="$HOME/.cloudflared/${TUNNEL_ID}.json"
if [[ ! -f "$CREDS_FILE" ]]; then
  echo "Error: expected credentials file not found at $CREDS_FILE" >&2
  exit 1
fi

cat > "$CONFIG_PATH" <<EOF
tunnel: ${TUNNEL_ID}
credentials-file: ${CREDS_FILE}

ingress:
  - hostname: ${HOSTNAME}
    service: http://127.0.0.1:${PORT}
  - service: http_status:404
EOF

chmod 600 "$CONFIG_PATH"

echo "Routing DNS '$HOSTNAME' -> tunnel '$TUNNEL_NAME' ($TUNNEL_ID)..."
cloudflared tunnel --config "$CONFIG_PATH" route dns -f "$TUNNEL_NAME" "$HOSTNAME"

echo ""
echo "Wrote self-contained tunnel config: $CONFIG_PATH"
echo "Existing ~/.cloudflared/config.yml was NOT modified."
echo ""
echo "Run the tunnel with:"
echo "  cloudflared tunnel --config \"$CONFIG_PATH\" run"
