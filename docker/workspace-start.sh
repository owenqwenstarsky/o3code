#!/bin/bash
# Runs as `o3`: installs the tools the admin chose, then starts O3 Code.
set -uo pipefail
source /etc/profile.d/o3.sh
mkdir -p "$HOME/.local/bin" "$HOME/projects" "$HOME/.o3/tools"

IFS=, read -ra tools <<< "${O3_TOOLS:-}"
for tool in "${tools[@]}"; do
  [ -n "$tool" ] || continue
  script="/opt/o3/tools/$tool.sh"
  marker="$HOME/.o3/tools/$tool"
  if [ ! -f "$script" ]; then
    echo "[o3] Unknown tool: $tool" >&2
    continue
  fi
  digest="$(sha256sum "$script" | cut -d' ' -f1)"
  if [ "$(cat "$marker" 2>/dev/null)" != "$digest" ]; then
    echo "[o3] Installing $tool"
    if bash -euo pipefail "$script"; then
      echo "$digest" > "$marker"
    else
      echo "[o3] Failed to install $tool; it will be retried on the next start." >&2
    fi
  fi
done

cd "$HOME/projects"
exec t3 serve --host 127.0.0.1 --port 3773 --base-dir "$HOME/.t3"
