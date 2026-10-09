#!/bin/sh
# Install the `abject` command, Abject's headless edition, on Linux or macOS.
#
#   curl -fsSL https://abject.world/install.sh | sh
#
# Puts each release in ~/.abject/versions/<version>, points ~/.abject/current
# at the one in use (`abject update` moves it), and links ~/.local/bin/abject.
# Nothing outside those two places is touched, and no root is needed.
#
#   ABJECT_VERSION=0.16.0      install that release instead of the latest
#   ABJECT_INSTALL_DIR=/path   install there instead of ~/.abject
#   ABJECT_BIN_DIR=/path       link the command there instead of ~/.local/bin
#   ABJECT_DOWNLOAD_URL=https://mirror/releases/download
#                              fetch v<version>/<archive> from a mirror

set -eu

REPO="mempko/abject"
ROOT="${ABJECT_INSTALL_DIR:-$HOME/.abject}"
BIN_DIR="${ABJECT_BIN_DIR:-$HOME/.local/bin}"
VERSION="${ABJECT_VERSION:-}"
DOWNLOAD_URL="${ABJECT_DOWNLOAD_URL:-https://github.com/$REPO/releases/download}"

say() { printf '%s\n' "$*"; }
fail() { printf 'abject install: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=mac ;;
  *) fail "this script is for Linux and macOS. On Windows: irm https://abject.world/install.ps1 | iex" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) fail "no build for $(uname -m). Build from source: https://github.com/$REPO" ;;
esac

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
  fetch_text() { curl -fsSL "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q "$1" -O "$2"; }
  fetch_text() { wget -qO- "$1"; }
else
  fail "needs curl or wget"
fi

if [ -z "$VERSION" ]; then
  VERSION=$(fetch_text "https://api.github.com/repos/$REPO/releases/latest" \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$VERSION" ] || fail "could not find the latest release"
fi
VERSION="${VERSION#v}"

name="abject-$VERSION-$os-$arch.tar.gz"
url="$DOWNLOAD_URL/v$VERSION/$name"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading abject $VERSION ($os-$arch)…"
fetch "$url" "$tmp/$name" || fail "download failed: $url"
fetch "$url.sha256" "$tmp/$name.sha256" || fail "download failed: $url.sha256"

expected=$(cut -d ' ' -f 1 < "$tmp/$name.sha256")
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$name" | cut -d ' ' -f 1)
else
  actual=$(shasum -a 256 "$tmp/$name" | cut -d ' ' -f 1)
fi
[ "$expected" = "$actual" ] || fail "checksum mismatch for $name (expected $expected, got $actual)"

dest="$ROOT/versions/$VERSION"
rm -rf "$dest"
mkdir -p "$dest"
tar -xzf "$tmp/$name" -C "$dest" --strip-components=1
[ -x "$dest/abject" ] || fail "the archive did not contain the abject binary"

ln -sfn "versions/$VERSION" "$ROOT/current"
mkdir -p "$ROOT/bin" "$BIN_DIR"
ln -sfn "../current/abject" "$ROOT/bin/abject"
ln -sfn "$ROOT/bin/abject" "$BIN_DIR/abject"

say "Installed abject $VERSION in $dest"
case ":$PATH:" in
  *":$BIN_DIR:"*)
    say ""
    say "Run: abject"
    ;;
  *)
    say ""
    say "$BIN_DIR is not on your PATH. Add it, for example:"
    say "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.profile"
    say "then open a new terminal and run: abject"
    ;;
esac
