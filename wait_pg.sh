#!/bin/bash
while true; do
  echo "Trying PG..."
  node run_sql_pg_v6.cjs
  if [ $? -eq 0 ]; then
    echo "SUCCESS!"
    exit 0
  fi
  sleep 3
done
