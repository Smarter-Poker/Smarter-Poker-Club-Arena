#!/bin/bash
while true; do
  STATUS=$(gh run view 32548645016 --json status,conclusion -q '.status')
  if [ "$STATUS" = "completed" ]; then
    gh pr merge 191 --merge --admin
    break
  fi
  sleep 30
done
