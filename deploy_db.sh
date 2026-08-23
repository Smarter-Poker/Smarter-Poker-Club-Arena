#!/bin/bash
while true; do
  echo "Trying to deploy migrations..."
  npx supabase db push -p "215SlalomCt!!!" > deploy_out.txt 2>&1
  if [ $? -eq 0 ]; then
    echo "SUCCESS!!!"
    cat deploy_out.txt
    exit 0
  fi
  echo "Failed. Output:"
  cat deploy_out.txt
  sleep 3
done
