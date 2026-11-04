#!/bin/bash
# Runs as root: joins this workspace to the tailnet as its own device, then drops to `o3`.
set -euo pipefail

drop_to_o3() {
  chown o3:o3 /home/o3
  exec setpriv --reuid=o3 --regid=o3 --init-groups env HOME=/home/o3 USER=o3 /usr/local/bin/o3-workspace-start
}

# Local development: Docker publishes the server on a host loopback port instead.
if [ "${O3_PUBLISH:-tailnet}" = "loopback" ]; then
  drop_to_o3
fi

mkdir -p /var/lib/tailscale /var/run/tailscale
chmod 700 /var/lib/tailscale
tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock \
  >/var/log/tailscaled.log 2>&1 &
for _ in $(seq 1 100); do [ -S /var/run/tailscale/tailscaled.sock ] && break; sleep 0.1; done

if ! tailscale status >/dev/null 2>&1; then
  if [ -z "${O3_TS_AUTHKEY:-}" ]; then
    echo "[o3] No Tailscale auth key; the instance must recreate this workspace." >&2
    exit 1
  fi
  tailscale up --authkey="$O3_TS_AUTHKEY" --hostname="$O3_TS_HOSTNAME" --operator=o3 \
    ${O3_TS_TAGS:+--advertise-tags="$O3_TS_TAGS"}
fi
# The operator setting lets O3 Code, running as `o3`, configure Tailscale Serve.
tailscale set --operator=o3
unset O3_TS_AUTHKEY

drop_to_o3
