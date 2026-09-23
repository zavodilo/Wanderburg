#!/bin/sh
# ArcEngine — build (thin wrapper over the cross-platform CLI; any OS: node tools/arc.mjs build)
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
    echo "  [x] Node.js not found in PATH. Install it from https://nodejs.org/ (LTS)." >&2
    exit 1
fi
exec node tools/arc.mjs build "$@"
