#!/bin/bash
# Joins the instance to the tailnet, then runs `t3 instance serve` behind Tailscale Serve.
set -euo pipefail

mkdir -p /var/lib/tailscale /var/run/tailscale
tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock \
  >/var/log/tailscaled.log 2>&1 &
for _ in $(seq 1 100); do [ -S /var/run/tailscale/tailscaled.sock ] && break; sleep 0.1; done

if ! tailscale status >/dev/null 2>&1; then
  if [ -z "${O3_INSTANCE_TS_AUTHKEY:-}" ]; then
    echo "O3_INSTANCE_TS_AUTHKEY is required the first time the instance joins the tailnet." >&2
    exit 1
  fi
  tailscale up --authkey="$O3_INSTANCE_TS_AUTHKEY" --hostname="${O3_INSTANCE_TS_HOSTNAME:-o3}" \
    ${O3_INSTANCE_TS_TAGS:+--advertise-tags="$O3_INSTANCE_TS_TAGS"}
fi
unset O3_INSTANCE_TS_AUTHKEY

exec t3 instance serve "$@"
