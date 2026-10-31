# Tools install into the user's home so they persist across workspace recreation.
export NPM_CONFIG_PREFIX="$HOME/.local"
export PATH="$HOME/.local/bin:$HOME/.local/go/bin:$HOME/.cargo/bin:$HOME/.bun/bin:$PATH"
