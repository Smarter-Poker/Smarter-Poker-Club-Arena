-- Mirror of the live catalog (applied 2026-08-20 via mcp apply_migration).
-- Documents a decision, changes no data.
--
-- Dan, 2026-08-20, asked to LEAVE the historical duplicate rake rows alone.
-- Writing it down here so the next person to find the discrepancy does not
-- spend a day re-deriving it and does not "helpfully" delete them.

COMMENT ON TABLE public.rake_records IS
$c$Durable audit of every rake and BBJ contribution taken.

KNOWN HISTORICAL DISCREPANCY — deliberately left in place (Dan, 2026-08-20).
55 rows in this table are duplicates: the same hand had its rake banked twice,
over-crediting 237.95 chips in total. Cause: when logHandHistory failed, the
hand had no hand_history row, so atomic_distribute_rake and
bbj_record_contribution were called with p_hand_id = NULL — and both deduped on
a partial index predicated on `hand_id IS NOT NULL`, which means a hand with no
history row had no idempotency at all. The RPCs now key idempotency on
(table_id, hand_number) instead, so a null hand id is no longer dangerous, and
as of 2026-08-20 logHandHistory retries and queues rather than giving up (see
server/src/services/supabase/handHistory.ts). The bug cannot recur.

The 55 rows are NOT being deleted. The amount is immaterial, deleting them
would rewrite financial history, and rakeback_stats_applied rows point at them —
removing the rake rows would orphan player rakeback attribution that was
already paid out. Leave them. If a total must exclude them, dedupe on
(table_id, metadata->>'hand_number') rather than deleting anything.$c$;
