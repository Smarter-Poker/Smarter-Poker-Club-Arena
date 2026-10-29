-- Owner October 29: use 15% for new and unfinalized MTTs, preserve finalized ladders.
-- DML only. One bounded pass through existing configuration and provisional-ladder
-- authorities, no retry, background repair, chip movement or finalized repricing.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '10s';
DO $configuration$
DECLARE r record; v_event record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
('public.fn_ca_provisional_payout_structure(uuid)', '2778bffc26f28037bc4c5f0852364af9'),
('public.fn_ca_refresh_provisional_payout_structure(uuid)', '04ee48606eddece40a6b953f0e14605f'),
('public.fn_safe_jsonb_array(text)', 'bf969d8c46cd2ff96f92643b7712bdaf'),
('public.fn_tournament_payout_terms_committed_v1(uuid)', '918c62cbcc182d43a6a27edeb2c1c107'),
('public.fn_ca_mtt_payout_depth_guard()', '83b17642b8aba085666fa8261bf165bd')
  ) AS x(signature, definition_md5)
  LOOP
    IF md5(pg_get_functiondef(r.signature::regprocedure)) <> r.definition_md5 THEN
      RAISE EXCEPTION 'MTT_FIFTEEN_UNFINALIZED_AUTHORITY_DRIFT: %', r.signature;
    END IF;
  END LOOP;
  FOR v_event IN
    SELECT t.id FROM public.tournaments t
     WHERE upper(COALESCE(t.tournament_type,''))='MTT'
       AND lower(COALESCE(t.variant,'')) NOT IN ('spin','sng','satellite')
       AND t.satellite_target_id IS NULL AND t.satellite_target IS NULL
       AND NOT COALESCE(t.is_premium_spin,false)
       AND t.status IN ('ANNOUNCED','SCHEDULED','PENDING','REGISTERING','RUNNING','PAUSED')
       AND NOT COALESCE(t.prize_pool_finalized,false)
       AND NOT public.fn_tournament_payout_terms_committed_v1(t.id)
       AND (t.payout_depth_percent IS DISTINCT FROM 15 OR t.payout_percent IS DISTINCT FROM 15)
     ORDER BY t.id FOR UPDATE OF t NOWAIT
  LOOP
    UPDATE public.tournaments SET payout_depth_percent=15,payout_percent=15
     WHERE id=v_event.id AND NOT COALESCE(prize_pool_finalized,false)
       AND NOT public.fn_tournament_payout_terms_committed_v1(id);
    IF FOUND THEN
      PERFORM public.fn_ca_refresh_provisional_payout_structure(v_event.id);
    END IF;
  END LOOP;
END $configuration$;
COMMIT;
