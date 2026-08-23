#!/bin/bash
while true; do
  STATUS=$(gh run view 32548752858 --json status,conclusion -q '.status')
  if [ "$STATUS" = "completed" ]; then
    gh pr merge 189 --merge --admin
    break
  fi
  sleep 30
done
