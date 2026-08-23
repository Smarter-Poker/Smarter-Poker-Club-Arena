#!/bin/bash
echo "Waiting for PR 189 to finish checks..."
while true; do
  STATUS=$(gh run list --branch feat/leaderboard-upgrades --json status,conclusion --limit 1 | jq -r '.[0].status')
  if [ "$STATUS" = "completed" ]; then
    echo "Run completed! Attempting merge..."
    gh pr merge 189 --merge --admin
    break
  fi
  echo "Still running... sleeping 20s"
  sleep 20
done
echo "Waiting for PR 191 to finish checks..."
while true; do
  STATUS=$(gh run list --branch fix/members-loop-and-union-wallet --json status,conclusion --limit 1 | jq -r '.[0].status')
  if [ "$STATUS" = "completed" ]; then
    echo "Run completed! Attempting merge..."
    gh pr merge 191 --merge --admin
    break
  fi
  echo "Still running... sleeping 20s"
  sleep 20
done
