#!/usr/bin/env bash
#
# gen-icon.sh — rasterize the Circle app mark (TM-383) to every icon surface.
#
# ONE shared SVG source per variant lives in resources/icon/:
#   ring-teal.svg             hollow teal ring, transparent bg   -> web favicon
#   ring-white-on-teal.svg    white ring on solid teal tile      -> iOS AppIcon + Android launcher PNGs
#   ring-white-foreground.svg white ring, transparent, safe-zone -> Android adaptive foreground PNGs
#
# This script rasterizes those SVGs to the exact PNG sizes each platform expects, matching
# the density/size layout already committed in the repo. It writes NO XML — the Android
# adaptive config (mipmap-anydpi-v26/*.xml, drawable/ic_launcher_monochrome.xml) and the iOS
# Contents.json are checked in as vectors/config and are not regenerated here.
#
# Requirements: rsvg-convert (brew install librsvg). ImageMagick `magick`/`convert` also work
# if you swap the render() body — rsvg-convert is used because it is already on the toolchain.
#
# Usage:  ./scripts/gen-icon.sh
# Run from anywhere; paths are resolved relative to the repo root.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/resources/icon"
AND="$REPO_ROOT/android/app/src/main/res"
IOS="$REPO_ROOT/ios/App/App/Assets.xcassets/AppIcon.appiconset"
WEB="$REPO_ROOT/web/src"

if ! command -v rsvg-convert >/dev/null 2>&1; then
  echo "error: rsvg-convert not found. Install with: brew install librsvg" >&2
  exit 1
fi

# render <svg> <px> <out>
render() {
  local svg="$1" px="$2" out="$3"
  mkdir -p "$(dirname "$out")"
  rsvg-convert -w "$px" -h "$px" "$svg" -o "$out"
  echo "  $out (${px}px)"
}

echo "iOS AppIcon (single 1024 universal — matches Contents.json):"
render "$SRC/ring-white-on-teal.svg" 1024 "$IOS/AppIcon-512@2x.png"

echo "Capacitor master icon (resources/icon.png — source for 'cap' asset generation):"
render "$SRC/ring-white-on-teal.svg" 1024 "$REPO_ROOT/resources/icon.png"

echo "Android launcher (ic_launcher.png + ic_launcher_round.png):"
for row in "mdpi 48" "hdpi 72" "xhdpi 96" "xxhdpi 144" "xxxhdpi 192"; do
  d="${row% *}"; px="${row#* }"
  render "$SRC/ring-white-on-teal.svg" "$px" "$AND/mipmap-$d/ic_launcher.png"
  render "$SRC/ring-white-on-teal.svg" "$px" "$AND/mipmap-$d/ic_launcher_round.png"
done

echo "Android adaptive foreground (ic_launcher_foreground.png — 108dp canvas):"
for row in "mdpi 108" "hdpi 162" "xhdpi 216" "xxhdpi 324" "xxxhdpi 432"; do
  d="${row% *}"; px="${row#* }"
  render "$SRC/ring-white-foreground.svg" "$px" "$AND/mipmap-$d/ic_launcher_foreground.png"
done

echo "Web favicon PNG fallback (favicon-32.png; favicon.svg is the primary, checked in):"
render "$SRC/ring-teal.svg" 32 "$WEB/favicon-32.png"

echo "Done."
