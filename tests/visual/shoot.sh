#!/usr/bin/env bash
set -e
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd "$(dirname "$0")/../.."
npx vite --port 5199 --strictPort > /tmp/p1-vite.log 2>&1 &
VPID=$!
trap 'kill $VPID 2>/dev/null || true' EXIT
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:5199/hub/club-arena/tests/visual/ticker-rail.html || true)
  [ "$code" = "200" ] && break
  sleep 1
done
HARNESS_URL=http://localhost:5199/hub/club-arena/tests/visual/ticker-rail.html node tests/visual/ticker-rail.spec.mjs
