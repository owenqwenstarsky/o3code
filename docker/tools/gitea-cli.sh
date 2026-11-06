# Gitea's installer verifies the download's checksum; it defaults to /usr/local/bin when writable.
curl -fsSL https://gitea.com/gitea/cli/raw/branch/main/scripts/install.sh | GITEA_CLI_INSTALL_DIR="$HOME/.local/bin" sh
