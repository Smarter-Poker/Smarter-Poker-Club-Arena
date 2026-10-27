-- Original count owner only; preserve all three exact source-proof counts.
-- Full keyset hash/merge joins behind materialization preserve LEFT misses and
-- source/batch bag multiplicity without per-attribution random index reads.
-- @live-proof: md5(pg_get_functiondef('public.fn_rakeback_split_counts(uuid,timestamptz,timestamptz,timestamptz,timestamptz)'::regprocedure))='cc867dea81e8737ae29af82c1d58623e'
BEGIN;
SET LOCAL statement_timeout='15s';
SET LOCAL lock_timeout='2s';
DO $bulk_counts$
DECLARE owner_oid oid:='public.fn_rakeback_split_counts(uuid,timestamptz,timestamptz,timestamptz,timestamptz)'::regprocedure;
 original text;candidate text;before_meta jsonb;after_meta jsonb;
 old_query constant text:=$old$ ), incomplete AS (
  SELECT count(*) AS n FROM club_attributions a JOIN week_records r ON r.id=a.rake_record_id
   -- r already belongs to week_records: its equality proves the original
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
   )b ON true
   WHERE s.id IS NULL OR b.status IS DISTINCT FROM 'accrued' OR s.club_id IS DISTINCT FROM a.club_id
     OR s.earned_at IS DISTINCT FROM r.created_at OR s.rake_credit IS DISTINCT FROM a.weighted_rake_credit
     OR s.c_attribution IS DISTINCT FROM a.id::text
     OR s.c_player IS DISTINCT FROM a.player_id::text OR s.c_club IS DISTINCT FROM a.club_id::text
$old$;
 new_query constant text:=$new$ ), incomplete_source_pairs AS MATERIALIZED (
  -- Preserve the original LEFT join's full-week sources and bag matches.
  -- A full join held behind this materialization cannot become a repeated
  -- scan of either unindexed CTE. Unmatched right rows are discarded only
  -- after the complete join, by the original non-null attribution identity.
  SELECT a.id AS attribution_id,a.player_id AS attribution_player,
   a.club_id AS attribution_club,a.weighted_rake_credit AS attribution_credit,
   r.id AS record_id,r.created_at AS record_at,
   s.id AS source_id,s.club_id AS source_club,s.earned_at AS source_at,
   s.rake_credit AS source_credit,s.c_attribution,s.c_player,s.c_club
  FROM (club_attributions a JOIN week_records r ON r.id=a.rake_record_id)
  FULL JOIN week_sources s ON s.rake_record_id=r.id AND s.player_id=a.player_id
 ), incomplete_batch_pairs AS MATERIALIZED (
  SELECT j.*,b.status AS batch_status
  FROM incomplete_source_pairs j
  FULL JOIN week_batches b ON b.rake_record_id=j.record_id
 ), incomplete AS (
  SELECT count(*) AS n FROM incomplete_batch_pairs j
   WHERE j.attribution_id IS NOT NULL AND (
    j.source_id IS NULL OR j.batch_status IS DISTINCT FROM 'accrued'
    OR j.source_club IS DISTINCT FROM j.attribution_club
    OR j.source_at IS DISTINCT FROM j.record_at
    OR j.source_credit IS DISTINCT FROM j.attribution_credit
    OR j.c_attribution IS DISTINCT FROM j.attribution_id::text
    OR j.c_player IS DISTINCT FROM j.attribution_player::text
    OR j.c_club IS DISTINCT FROM j.attribution_club::text)
$new$;
BEGIN
 IF public.fn_platform_frozen() IS DISTINCT FROM false THEN RAISE EXCEPTION 'weekly_count_bulk_installation_frozen';END IF;
 SELECT pg_get_functiondef(p.oid),jsonb_build_array(p.proowner,p.proacl,p.prosecdef,p.provolatile,p.proconfig,p.proparallel,p.proisstrict)
 INTO original,before_meta FROM pg_proc p WHERE p.oid=owner_oid;
 IF md5(original) IS DISTINCT FROM 'fa1b78510793794061710a7e1fe1c5d3' THEN RAISE EXCEPTION 'weekly_count_bulk_join_preimage_changed';END IF;
 IF before_meta IS DISTINCT FROM jsonb_build_array('postgres'::regrole::oid,'{postgres=X/postgres,service_role=X/postgres}'::aclitem[],false,'s'::text,ARRAY['search_path=public']::text[],'u'::text,false)
 THEN RAISE EXCEPTION 'weekly_count_bulk_join_metadata_changed';END IF;
 IF (length(original)-length(replace(original,old_query,'')))/length(old_query) IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'weekly_count_bulk_join_owner_shape_changed';END IF;
 candidate:=replace(original,old_query,new_query);EXECUTE candidate;
 SELECT jsonb_build_array(p.proowner,p.proacl,p.prosecdef,p.provolatile,p.proconfig,p.proparallel,p.proisstrict) INTO after_meta FROM pg_proc p WHERE p.oid=owner_oid;
 IF before_meta IS DISTINCT FROM after_meta OR md5(pg_get_functiondef(owner_oid)) IS DISTINCT FROM 'cc867dea81e8737ae29af82c1d58623e' THEN RAISE EXCEPTION 'weekly_count_bulk_join_postimage_changed';END IF;
END $bulk_counts$;
COMMIT;
