#!/bin/sh
# SkyTide launcher for macOS / Linux: ./start-skytide.sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "SkyTide needs Node.js (free): https://nodejs.org/"
  exit 1
fi
( sleep 2; (open http://localhost:8080 || xdg-open http://localhost:8080) >/dev/null 2>&1 ) &
node server.js
