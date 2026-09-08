-- Live traffic: build CONCURRENTLY using the companion SQL first.
-- Fresh/small databases can create directly; the guard refuses a blocking
-- build on a large populated table. No financial data or audit predicate changes.
DO $migration$
BEGIN
 IF to_regclass('public.idx_ca_hand_facts_runout_time_cover') IS NULL THEN
  IF pg_relation_size('public.ca_hand_facts') > 67108864 THEN
   RAISE EXCEPTION 'Build idx_ca_hand_facts_runout_time_cover CONCURRENTLY before this migration';
  END IF;
CREATE INDEX idx_ca_hand_facts_runout_time_cover
 ON public.ca_hand_facts (played_at)
 INCLUDE (hand_id, all_in_equity)
 WHERE was_all_in = true AND went_to_showdown
   AND coalesce(all_in_street, '') <> 'river';
 END IF;
 IF NOT EXISTS (
  SELECT 1 FROM pg_index i
  WHERE i.indexrelid='public.idx_ca_hand_facts_runout_time_cover'::regclass
   AND i.indrelid='public.ca_hand_facts'::regclass
   AND i.indisvalid AND i.indisready AND NOT i.indisunique
   AND i.indnkeyatts=1 AND i.indnatts=3
   AND pg_get_indexdef(i.indexrelid,1,true)='played_at'
   AND pg_get_indexdef(i.indexrelid,2,true)='hand_id'
   AND pg_get_indexdef(i.indexrelid,3,true)='all_in_equity'
   AND pg_get_expr(i.indpred,i.indrelid) =
     '((was_all_in = true) AND went_to_showdown AND (COALESCE(all_in_street, ''''::text) <> ''river''::text))'
 ) THEN
  RAISE EXCEPTION 'Runout covering index is missing, invalid, or has a different definition';
 END IF;
END $migration$;
