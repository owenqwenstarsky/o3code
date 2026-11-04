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

# A fresh home has no git identity, and project creation and agents commit. Members can override it.
if ! git config --global user.email >/dev/null; then
  git config --global user.name "${O3_WORKSPACE_LABEL:-O3 workspace}"
  git config --global user.email "${O3_WORKSPACE_SLUG:-workspace}@workspace.o3.invalid"
fi

cd "$HOME/projects"
# Docker's port forwarding reaches the container's interface, not its loopback.
host=127.0.0.1
[ "${O3_PUBLISH:-tailnet}" = "loopback" ] && host=0.0.0.0
exec t3 serve --host "$host" --port 3773 --base-dir "$HOME/.t3"
