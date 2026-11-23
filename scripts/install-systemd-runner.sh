#!/usr/bin/env bash
set -euo pipefail

# Install and manage `agy-linear-runner.service` as a persistent user-level systemd service
# on headless Linux hosts (e.g., Oracle Cloud ARM, Ubuntu/Debian VPS).

NO_START=0
for arg in "$@"; do
  case "$arg" in
    --no-start)
      NO_START=1
      ;;
    -h|--help)
      echo "Usage: bash scripts/install-systemd-runner.sh [--no-start]"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Error: 'node' (>= 22) not found in PATH." >&2
  exit 1
fi

NODE_DIR="$(dirname "$NODE_BIN")"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="$UNIT_DIR/agy-linear-runner.service"

mkdir -p "$UNIT_DIR"

cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Antigravity Linear Bridge Outbound Edge Runner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT_DIR}
Environment="NODE_ENV=production"
Environment="PATH=${HOME}/.local/bin:${NODE_DIR}:/usr/local/bin:/usr/bin:/bin"
Environment="SSH_CONNECTION=127.0.0.1 0 127.0.0.1 22"
ExecStart=${NODE_BIN} ${ROOT_DIR}/src/cli.mjs runner
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=default.target
EOF

# Keep user systemd services running across SSH logouts and reboots
loginctl enable-linger "$USER" 2>/dev/null || sudo -n loginctl enable-linger "$USER" 2>/dev/null || true

systemctl --user daemon-reload

if [[ "$NO_START" -eq 1 ]]; then
  systemctl --user enable agy-linear-runner.service
  echo "Installed and enabled $UNIT_FILE (not started yet)."
  echo "Sign in to Antigravity CLI once ('agy'), then run:"
  echo "  systemctl --user start agy-linear-runner && systemctl --user status agy-linear-runner --no-pager"
else
  systemctl --user enable --now agy-linear-runner.service
  systemctl --user restart agy-linear-runner.service
  systemctl --user status agy-linear-runner.service --no-pager
fi
