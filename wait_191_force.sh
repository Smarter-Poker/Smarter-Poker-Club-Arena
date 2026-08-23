#!/bin/bash
while true; do
  STATUS=$(gh run view 32549238076 --json status -q '.status')
  if [ "$STATUS" = "completed" ]; then
    echo "Run completed. Attempting admin merge..."
    gh pr merge 191 --merge --admin
    break
  fi
  sleep 20
done
