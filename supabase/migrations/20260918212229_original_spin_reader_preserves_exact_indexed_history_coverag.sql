-- Original Spin current-case evidence was scanning the global history by id.
-- Production EXPLAIN: OR/IN estimated 1,044,552 rows, total cost 840561.89;
-- disjoint branches use existing tournament and table/hand indexes, cost 346.49.
-- Preserve every original row, NULL/mismatched tournament links, boundary and
-- deterministic id order. This changes no financial authority or business row.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='8s';
DO $reader$
DECLARE definition text; prior text:=$prior$SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),''[]'') FROM public.hand_history r WHERE (r.tournament_id=$1 OR r.table_id IN(SELECT id FROM public.tables WHERE tournament_id=$1)) AND r.hand_number >= $2$prior$;
 successor text:=$successor$SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),''[]'') FROM (SELECT h.* FROM public.hand_history h WHERE h.tournament_id=$1 AND h.hand_number >= $2 UNION ALL SELECT h.* FROM public.tables t JOIN public.hand_history h ON h.table_id=t.id WHERE t.tournament_id=$1 AND h.tournament_id IS DISTINCT FROM $1 AND h.hand_number >= $2) r$successor$;
BEGIN
 SELECT pg_get_functiondef(p.oid) INTO definition FROM pg_proc p
 WHERE p.oid='smarter_private.spin_original_current_case(uuid)'::regprocedure
 AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
 AND p.proconfig=ARRAY['search_path=pg_catalog, public']
 AND (SELECT jsonb_agg(a::text ORDER BY a::text) FROM unnest(p.proacl) a)='["postgres=X/postgres"]'::jsonb;
 IF definition IS NULL OR md5(definition)<>'54bc16e3aa98c131f9d4995b85733e81'
 OR (length(definition)-length(replace(definition,prior,'')))/length(prior)<>1 THEN
  RAISE EXCEPTION 'SPIN_ORIGINAL_READER_PREIMAGE_CHANGED' USING ERRCODE='55000';
 END IF;
 EXECUTE replace(definition,prior,successor);
END $reader$;
REVOKE ALL ON FUNCTION smarter_private.spin_original_current_case(uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
