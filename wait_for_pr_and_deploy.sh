#!/bin/bash
echo "Waiting for PR to merge..."
while true; do
  STATUS=$(gh pr view --json state --jq .state)
  if [ "$STATUS" = "MERGED" ]; then
    echo "PR is merged!"
    break
  fi
  sleep 20
done

echo "Waiting for main to trigger World Hub Sync..."
sleep 10
LATEST_RUN=""
while true; do
  LATEST_RUN=$(gh run list --workflow publish-club-arena.yml --branch main --json databaseId,status --jq '.[0].databaseId')
  if [ -n "$LATEST_RUN" ]; then
    echo "Found run $LATEST_RUN"
    break
  fi
  sleep 10
done

echo "Waiting for World Hub Sync to complete..."
while true; do
  STATUS=$(gh run view $LATEST_RUN --json status,conclusion --jq '.status')
  if [ "$STATUS" = "completed" ]; then
    CONCLUSION=$(gh run view $LATEST_RUN --json conclusion --jq '.conclusion')
    if [ "$CONCLUSION" = "success" ]; then
      echo "Sync successful!"
      break
    else
      echo "Sync failed!"
      exit 1
    fi
  fi
  sleep 30
done

echo "Waiting for Vercel deployment on World Hub repo to finish..."
sleep 30
while true; do
  LATEST_WH_RUN=$(gh run list --repo Smarter-Poker/Smarter-Poker-World-Hub --json databaseId,status --jq '.[0].databaseId')
  STATUS=$(gh run view $LATEST_WH_RUN --repo Smarter-Poker/Smarter-Poker-World-Hub --json status,conclusion --jq '.status')
  if [ "$STATUS" = "completed" ]; then
    echo "World Hub workflow finished."
    break
  fi
  sleep 30
done

TARGET=$(git rev-parse HEAD)
URL="https://smarter.poker/hub/club-arena/build-info.json"
echo "Waiting for $URL to serve descendant of $TARGET..."
for i in {1..30}; do
  LIVE=$(curl -fsSL -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' "$URL?cb=$(date +%s)" | grep -o '"ca_sha"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4)
  if git merge-base --is-ancestor $TARGET $LIVE 2>/dev/null; then
    echo "DEPLOYED! It is now serving $LIVE (descendant of $TARGET)."
    exit 0
  fi
  echo "Current: $LIVE. Waiting 30s..."
  sleep 30
done
echo "Timeout."
exit 1
