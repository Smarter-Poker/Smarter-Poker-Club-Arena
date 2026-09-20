-- Declare the two reviewed, postgres-only legacy fee-custody children.
-- Hold is called only by the existing terminal body; resolution only by the
-- existing rake owner. Both re-enter that owner's lane. The global helper
-- retains G-shared/F/T for an existing finish and G/B for a global owner.
-- No caller, lock order, financial proof, access or doctrine rule changes.
-- In particular rolling -> either child -> global remains prohibited by rule4.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='8s';
DO $reviewed$
DECLARE source text; item record;
 prior text:=$prior$'fn_settle_tournament_places','fn_settle_tournament_rake','fn_sweep_unsettled_tournament_rake'$prior$;
 successor text:=$successor$'fn_ca_begin_legacy_fee_resolution','fn_ca_hold_legacy_tournament_fee',
    'fn_settle_tournament_places','fn_settle_tournament_rake','fn_sweep_unsettled_tournament_rake'$successor$;
BEGIN
 FOR item IN SELECT * FROM (VALUES
 ('public.fn_ca_hold_legacy_tournament_fee(uuid,text)','fde5202722d449e3361102861edf46a1'),
 ('public.fn_ca_begin_legacy_fee_resolution(uuid)','bdcedd8acbf81c2f925d390d825d422c')
 ) reviewed(signature,definition_hash) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(item.signature)
   AND md5(pg_get_functiondef(p.oid))=item.definition_hash AND pg_get_userbyid(p.proowner)='postgres'
   AND p.prosecdef AND p.proconfig=ARRAY['search_path=public']
   AND (SELECT jsonb_agg(a::text ORDER BY a::text) FROM unnest(p.proacl) a)='["postgres=X/postgres"]'::jsonb) THEN
   RAISE EXCEPTION 'LEGACY_CUSTODY_LANE_REVIEW_CHANGED: %',item.signature USING ERRCODE='55000';
  END IF;
 END LOOP;
 SELECT pg_get_functiondef(p.oid) INTO source FROM pg_proc p
 WHERE p.oid='public.fn_ca_settlement_lane_doctrine()'::regprocedure
 AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef AND p.provolatile='s'
 AND p.proconfig=ARRAY['search_path=public, pg_temp']
 AND (SELECT jsonb_agg(a::text ORDER BY a::text) FROM unnest(p.proacl) a)='["postgres=X/postgres","service_role=X/postgres"]'::jsonb;
 IF source IS NULL OR md5(source)<>'d6885832ceaa6c071d40bdc26a0b16fa'
 OR (length(source)-length(replace(source,prior,'')))/length(prior)<>1 THEN
  RAISE EXCEPTION 'LEGACY_CUSTODY_LANE_DOCTRINE_CHANGED' USING ERRCODE='55000';
 END IF;
 EXECUTE replace(source,prior,successor);
END $reviewed$;
REVOKE ALL ON FUNCTION public.fn_ca_settlement_lane_doctrine() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_settlement_lane_doctrine() TO service_role;
COMMIT;
