# AUR packaging

This directory maintains the [`t3code-bin`](https://aur.archlinux.org/packages/t3code-bin) and
[`t3code-nightly-bin`](https://aur.archlinux.org/packages/t3code-nightly-bin) packages. Both
repackage the official x86_64 AppImage from GitHub Releases.

## Publishing

> [!NOTE]
> This fork has no AUR publishing workflow; `publish-aur.yml` was removed (recover it from commit
> `15fe28327`). These packages still point at the upstream repository.

The upstream workflow selected the stable or nightly
package, then updated its version and checksums, built it, regenerated `.SRCINFO`, and pushed it
to the AUR.

To validate a release on Arch Linux:

```bash
sudo pacman -Syu --needed base-devel github-cli jq namcap
GH_TOKEN=$(gh auth token) RELEASE_TAG=v0.0.33 \
  packaging/aur/scripts/release.sh
```
