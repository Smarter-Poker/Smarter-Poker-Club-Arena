#!/bin/bash
# usage: run-shots.sh <outdir> "?surface=rebuy[&click=New%20Post]"
set -e
OUT="$1"; Q="$2"
export LD_LIBRARY_PATH=/tmp/lib/usr/lib/aarch64-linux-gnu
export CHROME=$(ls /tmp/pw/chromium-*/chrome-linux*/chrome | head -1)
mkdir -p "$OUT"
npx vite --port 5199 --strictPort > /tmp/vite.log 2>&1 &
VP=$!
for i in $(seq 1 30); do curl -s -o /dev/null http://localhost:5199/hub/club-arena/ && break; sleep 1; done
node ./.shot.mjs "http://localhost:5199/hub/club-arena/card-harness.html$Q" "$OUT" 2>&1 | grep -v "^\s*at " | tail -5
kill $VP 2>/dev/null || true
