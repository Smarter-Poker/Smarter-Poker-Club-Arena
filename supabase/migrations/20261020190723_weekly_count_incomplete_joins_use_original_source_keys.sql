-- @live-proof: md5(pg_get_functiondef('public.fn_rakeback_split_counts(uuid,timestamptz,timestamptz,timestamptz,timestamptz)'::regprocedure))='fa1b78510793794061710a7e1fe1c5d3'
-- Version 20261020190723: maintained allocator; original count owner only.
-- Correlated indexed joins preserve the original full-week source matching,
-- NULL-extended missing records, duplicate multiplicity and all three counts.
BEGIN;
SET LOCAL statement_timeout='15s';
SET LOCAL lock_timeout='2s';
DO $indexed_counts$
DECLARE owner_oid oid:='public.fn_rakeback_split_counts(uuid,timestamptz,timestamptz,timestamptz,timestamptz)'::regprocedure;
 before_meta jsonb;after_meta jsonb;original text;candidate text;
 old_join constant text:=$old$LEFT JOIN week_sources s ON s.rake_record_id=r.id AND s.player_id=a.player_id
   LEFT JOIN week_batches b ON b.rake_record_id=r.id$old$;
 new_join constant text:=$new$-- r already belongs to week_records: its equality proves the original
   -- source/batch keyset membership. Keep full-week source scope and every
   -- LEFT missing-row/multiplicity rule, using the original unique indexes.
   LEFT JOIN LATERAL (
    SELECT s0.id,s0.rake_record_id,s0.player_id,s0.club_id,s0.earned_at,s0.rake_credit,
     s0.contract->>'attribution_id' c_attribution,s0.contract->>'player_id' c_player,s0.contract->>'club_id' c_club
    FROM public.accounting_cash_rake_sources s0
    WHERE s0.rake_record_id=r.id AND s0.player_id=a.player_id
     AND s0.club_id=p_club_id AND s0.earned_at>=v_from AND s0.earned_at<v_to OFFSET 0
   )s ON true
   LEFT JOIN LATERAL (
    SELECT b0.rake_record_id,b0.status FROM public.accounting_cash_accrual_batches b0
    WHERE b0.rake_record_id=r.id OFFSET 0
   )b ON true$new$;
BEGIN
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RAISE EXCEPTION 'weekly_count_installation_frozen';END IF;
 SELECT pg_get_functiondef(p.oid),jsonb_build_array(p.proowner,p.proacl,p.prosecdef,p.provolatile,p.proconfig,p.proparallel,p.proisstrict)
 INTO original,before_meta FROM pg_proc p WHERE p.oid=owner_oid;
 IF md5(original) IS DISTINCT FROM '51416775308c98140c35071c40896dcf' THEN RAISE EXCEPTION 'weekly_count_indexed_join_preimage_changed';END IF;
 IF before_meta IS DISTINCT FROM jsonb_build_array('postgres'::regrole::oid,'{postgres=X/postgres,service_role=X/postgres}'::aclitem[],false,'s'::text,ARRAY['search_path=public']::text[],'u'::text,false)
 THEN RAISE EXCEPTION 'weekly_count_indexed_join_metadata_changed';END IF;
 IF (length(original)-length(replace(original,old_join,'')))/length(old_join) IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'weekly_count_indexed_join_owner_shape_changed';END IF;
 candidate:=replace(original,old_join,new_join);
 EXECUTE candidate;
 SELECT jsonb_build_array(p.proowner,p.proacl,p.prosecdef,p.provolatile,p.proconfig,p.proparallel,p.proisstrict) INTO after_meta FROM pg_proc p WHERE p.oid=owner_oid;
 IF before_meta IS DISTINCT FROM after_meta OR md5(pg_get_functiondef(owner_oid)) IS DISTINCT FROM 'fa1b78510793794061710a7e1fe1c5d3' THEN RAISE EXCEPTION 'weekly_count_indexed_join_postimage_changed';END IF;
END $indexed_counts$;
COMMIT;
