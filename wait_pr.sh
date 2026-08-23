#!/bin/bash
while true; do
  STATUS=$(gh pr status --json state -q '.currentBranch.state' 2>/dev/null)
  if [ "$STATUS" = "MERGED" ]; then
    echo "PR is merged!"
    exit 0
  fi
  sleep 5
done
