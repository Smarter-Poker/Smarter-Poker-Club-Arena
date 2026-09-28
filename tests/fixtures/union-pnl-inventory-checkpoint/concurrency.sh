#!/usr/bin/env bash
# A seal waits for an in-flight writer whose frame precedes the boundary, and
# its checkpoint contains that writer's event. Args: psql socketdir port db
set -euo pipefail
psql=$1; s=$2; port=$3; db=$4
q() { "$psql" -X -q -At -v ON_ERROR_STOP=1 -U postgres -h "$s" -p "$port" -d "$db" "$@"; }
q -c "SELECT public.fixture_generate(0.77, 200)->>'events'" >/dev/null
row=$(q -c "SELECT row_id FROM public.union_pnl_inventory_events WHERE source_name='table_seats' AND observed_at<'2026-08-12' AND after_row IS NOT NULL ORDER BY event_id DESC LIMIT 1")
# The writer: frame observed 2026-08-15 (book of 08-10), commits 3s later.
q -c "BEGIN;
 SELECT pg_advisory_xact_lock_shared(hashtextextended('union-pnl-inventory:'||extract(epoch FROM public.fn_union_week_start('2026-08-15 12:00+00'))::bigint::text,0));
 SELECT pg_sleep(3);
 INSERT INTO public.union_pnl_inventory_events(source_name,row_id,observed_at,transaction_id,operation,before_row,after_row)
  SELECT source_name,row_id,'2026-08-15 12:00+00',pg_current_xact_id(),'UPDATE',after_row,jsonb_set(after_row,'{stack}','424242')
  FROM public.union_pnl_inventory_events WHERE row_id='$row' ORDER BY event_id DESC LIMIT 1;
 COMMIT;" >/dev/null &
w=$!
sleep 1
start=$(date +%s)
q -c "SELECT public.fn_union_pnl_inventory_checkpoint_seal('2026-08-17 07:00+00')->>'status'" >/dev/null
waited=$(( $(date +%s) - start ))
wait $w
got=$(q -c "SELECT count(*) FROM public.union_pnl_inventory_checkpoint_rows WHERE boundary='2026-08-17 07:00+00' AND row_id='$row' AND after_row->>'stack'='424242'")
same=$(q -c "SELECT public.fn_union_pnl_inventory_as_of('2026-08-17 07:00+00') = public.fn_union_pnl_inventory_as_of_legacy('2026-08-17 07:00+00')")
if [ "$got" = 1 ] && [ "$same" = t ] && [ "$waited" -ge 1 ]; then
  echo "PASS the seal waited ${waited}s for the in-flight writer of an earlier frame and sealed its event"
else
  echo "FAIL concurrency: waited=${waited}s event_in_checkpoint=$got equals_legacy=$same"; exit 1
fi
