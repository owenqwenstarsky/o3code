version="$(curl -fsSL 'https://go.dev/VERSION?m=text' | head -n1)"
case "$(uname -m)" in
  x86_64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
rm -rf "$HOME/.local/go"
curl -fsSL "https://go.dev/dl/${version}.linux-${arch}.tar.gz" | tar -xz -C "$HOME/.local"
