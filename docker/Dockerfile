# Images for an O3 instance and its per-user workspaces. Build from the repo root:
#   docker build -f docker/Dockerfile --target instance -t o3code/instance .
#   docker build -f docker/Dockerfile --target workspace -t o3code/workspace .
# Both run the server from source on Node's type stripping, like `vp run dev`.

ARG NODE_VERSION=26.12.1

FROM node:${NODE_VERSION}-trixie AS build
RUN npm install -g vite-plus@1.4.0
WORKDIR /opt/o3
COPY . .
RUN vp install --frozen-lockfile -- --yes \
 && vp run --filter @t3tools/web build \
 && rm -rf node_modules apps/*/node_modules packages/*/node_modules \
 && vp install --frozen-lockfile --prod --filter "t3..." -- --yes \
 && rm -rf apps/desktop apps/web/src apps/web/test packages/*/test \
 && printf '#!/bin/sh\nexec node /opt/o3/apps/server/src/bin.ts "$@"\n' > /usr/local/bin/t3 \
 && chmod +x /usr/local/bin/t3

# Tailscale's apt repository, shared by both images.
FROM node:${NODE_VERSION}-trixie-slim AS tailscale-base
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg iptables iproute2 \
 && curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg \
 && curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends tailscale \
 && rm -rf /var/lib/apt/lists/*

FROM tailscale-base AS instance
COPY --from=build /opt/o3 /opt/o3
COPY --from=build /usr/local/bin/t3 /usr/local/bin/t3
COPY docker/instance-entrypoint.sh /usr/local/bin/o3-instance-entrypoint
ENV T3CODE_HOME=/data \
    T3CODE_HOST=127.0.0.1 \
    T3CODE_PORT=3773 \
    T3CODE_TAILSCALE_SERVE=1 \
    NODE_ENV=production
VOLUME ["/data", "/var/lib/tailscale"]
ENTRYPOINT ["/usr/local/bin/o3-instance-entrypoint"]

FROM tailscale-base AS workspace
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      git gh openssh-client build-essential python3 python3-venv pipx ripgrep fd-find jq \
      less vim-tiny nano unzip zip xz-utils procps locales tmux \
 && rm -rf /var/lib/apt/lists/* \
 && usermod --login o3 --move-home --home /home/o3 node \
 && groupmod --new-name o3 node
COPY --from=build /opt/o3 /opt/o3
COPY --from=build /usr/local/bin/t3 /usr/local/bin/t3
# System libraries for the headless browser the server downloads for previews and HTML renders.
RUN apt-get update \
 && node "$(dirname "$(node -p 'require.resolve("playwright-core/package.json", { paths: ["/opt/o3/apps/server"] })')")/cli.js" install-deps chromium \
 && apt-get install -y --no-install-recommends fontconfig fonts-liberation \
 && rm -rf /var/lib/apt/lists/*
COPY docker/tools /opt/o3/tools
COPY docker/workspace-entrypoint.sh /usr/local/bin/o3-workspace-entrypoint
COPY docker/workspace-start.sh /usr/local/bin/o3-workspace-start
COPY docker/workspace-profile.sh /etc/profile.d/o3.sh
ENV T3CODE_TAILSCALE_SERVE=1 \
    NODE_ENV=production \
    LANG=C.UTF-8
VOLUME ["/home/o3", "/var/lib/tailscale"]
ENTRYPOINT ["/usr/local/bin/o3-workspace-entrypoint"]
