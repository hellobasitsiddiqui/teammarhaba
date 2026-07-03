#!/bin/sh
# TM-377 — re-render the wireflow PNGs from the HTML sources (see index.md).
# Uses headless Google Chrome; --virtual-time-budget lets the Google-Fonts load settle so the
# hand-lettered faces (Patrick Hand / Gochi Hand / Shadows Into Light) are in before capture.
# Window sizes match each strip's laid-out width (frames x 320 + arrows x 120 + canvas padding);
# --force-device-scale-factor=2 exports at 2x for crisp pencil strokes.
set -eu

WF="$(cd "$(dirname "$0")" && pwd)"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

render() { # name width
    profile="$(mktemp -d)"
    "$CHROME" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
        --user-data-dir="$profile" --hide-scrollbars --force-device-scale-factor=2 \
        --window-size="$2,960" --virtual-time-budget=15000 \
        --screenshot="$WF/$1.png" "file://$WF/$1.html"
    rm -rf "$profile"
    echo "rendered $1.png"
}

render auth 3080
render messaging 3080
render events 2640
