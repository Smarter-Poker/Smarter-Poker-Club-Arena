#!/bin/bash
while true; do
  echo "Trying deployment..."
  URL="https://kuklfnapbkmacvwxktbh.supabase.co/rest/v1/rpc/exec_sql"
  KEY="sb_secret_-JMU3PyMvxxkGYzKLTzrbQ_OZPZQuYW"
  jq -n --arg q "$(cat get_club_home_fixed.sql)" '{query: $q}' > payload.json
  
  # Run curl with a 5 second timeout so we don't get stuck waiting for 524
  # Write stdout and HTTP code
  curl -6 -s -w "%{http_code}" --max-time 5 -X POST "$URL" \
    -H "apikey: $KEY" \
    -H "Authorization: Bearer $KEY" \
    -H "Content-Type: application/json" \
    -d @payload.json > response.out
    
  HTTP_CODE=$(tail -c 3 response.out)
  if [ "$HTTP_CODE" = "200" ]; then
    echo "SUCCESS!!! Migration applied."
    cat response.out
    exit 0
  fi
  echo "Failed with HTTP $HTTP_CODE. Retrying..."
  sleep 1
done
