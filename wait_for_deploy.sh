#!/bin/bash
TARGET="bfbfcce686399e8bd66984ec9b621a9e8c77bafd"
URL="https://smarter.poker/hub/club-arena/build-info.json"
echo "Waiting for $URL to serve ca_sha = $TARGET..."
for i in {1..30}; do
  LIVE=$(curl -fsSL -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' "$URL?cb=$(date +%s)" | grep -o '"ca_sha"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4)
  if [ "$LIVE" = "$TARGET" ]; then
    echo "DEPLOYED! It is now serving $TARGET."
    exit 0
  fi
  echo "Current: $LIVE (attempt $i). Waiting 30s..."
  sleep 30
done
echo "Timeout."
exit 1
