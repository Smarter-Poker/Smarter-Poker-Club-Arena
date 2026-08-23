#!/bin/bash
echo "Waiting for PR 189 run 32548752858..."
while true; do
  STATUS=$(gh run view 32548752858 --json status,conclusion -q '.status')
  CONCLUSION=$(gh run view 32548752858 --json status,conclusion -q '.conclusion')
  if [ "$STATUS" = "completed" ]; then
    if [ "$CONCLUSION" = "success" ]; then
      echo "PR 189 CI success! Merging..."
      gh pr merge 189 --merge --admin
    else
      echo "PR 189 CI failed! ($CONCLUSION)"
    fi
    break
  fi
  sleep 20
done

echo "Waiting for PR 191 run 32548836379..."
while true; do
  STATUS=$(gh run view 32548836379 --json status,conclusion -q '.status')
  CONCLUSION=$(gh run view 32548836379 --json status,conclusion -q '.conclusion')
  if [ "$STATUS" = "completed" ]; then
    if [ "$CONCLUSION" = "success" ]; then
      echo "PR 191 CI success! Merging..."
      gh pr merge 191 --merge --admin
    else
      echo "PR 191 CI failed! ($CONCLUSION)"
    fi
    break
  fi
  sleep 20
done
