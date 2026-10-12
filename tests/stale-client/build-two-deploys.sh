#!/bin/sh
# Two production builds of this commit that differ the way two deploys do: the
# anon key is compiled into the entry chunk, so the entry and every chunk that
# imports it change name, and optimize-dist-media stamps each sw-bus.js with
# its own DEPLOY_TS and precache list. The Supabase URL is a placeholder: the
# stale-client specs answer every call in the browser. Usage: build-two-deploys.sh <out-dir>
set -eu
OUT="${1:?usage: build-two-deploys.sh <out-dir>}"
mkdir -p "$OUT"
for BUILD in A B; do
  VITE_SUPABASE_URL=https://example.supabase.co \
  VITE_SUPABASE_ANON_KEY="stale-client-build-$BUILD" \
    npm run build:ci
  rm -rf "$OUT/dist$BUILD"
  cp -R dist "$OUT/dist$BUILD"
  echo "dist$BUILD entry: $(grep -o 'assets/index-[A-Za-z0-9_-]*\.js' "$OUT/dist$BUILD/index.html" | head -1)"
done
