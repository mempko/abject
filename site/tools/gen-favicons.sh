#!/usr/bin/env bash
# Regenerate every copy of the Abject mark from public/favicon.svg: the site's
# rasters, the client's favicon, and the desktop app icon. The mark is the eye
# sigil every window wears (a red ring with a phosphor slit pupil); keep this
# SVG the single source so the site, client, and app never drift apart.
#
# Browsers request /favicon.ico and /apple-touch-icon*.png by convention even
# when the HTML only advertises an SVG icon, so the rasters ship alongside it
# rather than being generated at build time. They change about as often as the
# logo does, which is to say almost never, so they live in public/ and this
# script exists for the day the SVG changes.
#
#   ./tools/gen-favicons.sh      (from the site/ directory)
#
# Needs inkscape (renders the SVG text correctly) and ImageMagick.

set -euo pipefail

cd "$(dirname "$0")/.."
SRC=public/favicon.svg
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

for tool in inkscape magick; do
    command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
done

for size in 16 32 48 180; do
    inkscape -w "$size" -h "$size" "$SRC" -o "$TMP/icon-$size.png" >/dev/null 2>&1
done

magick "$TMP/icon-16.png" "$TMP/icon-32.png" "$TMP/icon-48.png" public/favicon.ico
cp "$TMP/icon-180.png" public/apple-touch-icon.png
cp "$TMP/icon-180.png" public/apple-touch-icon-precomposed.png

# The thin client (Vite hashes it into dist-client) and the Electron app icon
# (electron-builder reads build/icon.png for every platform).
cp "$SRC" ../client/favicon.svg
inkscape -w 512 -h 512 "$SRC" -o ../build/icon.png >/dev/null 2>&1

echo "regenerated from $SRC:"
ls -la public/favicon.ico public/apple-touch-icon.png public/apple-touch-icon-precomposed.png \
    ../client/favicon.svg ../build/icon.png
