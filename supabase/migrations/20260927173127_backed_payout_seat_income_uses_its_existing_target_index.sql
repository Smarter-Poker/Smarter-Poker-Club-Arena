-- The incoming satellite-seat join can match only a non-NULL target key.
-- Spell out that already implied condition so PostgreSQL can bound the
-- existing target-expression index instead of reading unrelated payout rows.
-- Preserve text equality (no UUID cast), NULL/malformed metadata semantics,
-- every ticket/cash rule and all outgoing/financial/authority/timeout bytes.
-- No index, schedule, grant, financial invocation or retention change.
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure)) = '9078403312e51a873e6e7462555dcf7e')
BEGIN;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '8s';
DO $patch$
DECLARE
  v_target regprocedure := 'public.fn_pay_backed_payout_shortfalls(boolean,integer)'::regprocedure;
  v_old text := pg_get_functiondef(v_target);
  v_new text;
  v_start integer;
  v_end integer;
  v_income text;
  v_catalog record;
BEGIN
  IF md5(v_old) IS DISTINCT FROM '997e5e7b816c12f7a17c30454806da0b'
     OR md5(pg_get_functiondef('public.fn_tournament_conservation_delta(uuid)'::regprocedure))
        IS DISTINCT FROM '46647067aa049dcb9bda93fa0a1a35b3' THEN
    RAISE EXCEPTION 'BACKED_SEAT_INCOME_PREIMAGE_CHANGED' USING ERRCODE='55000';
  END IF;
  SELECT oid,proowner,proacl,proconfig,prosecdef,provolatile INTO STRICT v_catalog
    FROM pg_proc WHERE oid=v_target;
  IF v_catalog.proowner <> 'postgres'::regrole OR NOT v_catalog.prosecdef
     OR v_catalog.provolatile <> 'v'
     OR has_function_privilege('anon',v_target,'EXECUTE')
     OR has_function_privilege('authenticated',v_target,'EXECUTE')
     OR NOT has_function_privilege('service_role',v_target,'EXECUTE') THEN
    RAISE EXCEPTION 'BACKED_SEAT_INCOME_AUTHORITY_CHANGED' USING ERRCODE='55000';
  END IF;
  IF EXISTS (
    SELECT FROM (VALUES ('public.tournament_guarantee_overlays'::regclass),
                        ('public.tournament_conservation_baseline'::regclass)) singleton(rel)
    WHERE NOT EXISTS (
      SELECT FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid
        AND a.attname='tournament_id' AND a.attnum=i.indkey[0]
      WHERE i.indrelid=singleton.rel AND i.indisunique AND i.indisvalid
        AND i.indisready AND i.indislive AND i.indimmediate
        AND i.indnkeyatts=1 AND i.indpred IS NULL AND i.indexprs IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'BACKED_SEAT_INCOME_SINGLETON_KEYS_CHANGED' USING ERRCODE='55000';
  END IF;
  IF EXISTS (
    SELECT FROM (VALUES
      ('public.idx_rake_records_club_data_tournament_window','public.rake_records'::regclass,'6d9d8de5ba1748d29a87d3ddade323d3'),
      ('public.idx_chip_ledger_reviewed_overlay_returns','public.chip_ledger'::regclass,'6691784c84cb002e628f2c23a944429d'),
      ('public.idx_tournament_payouts_satellite_target','public.tournament_payouts'::regclass,'db3e950667c8ef905d3e8f8747108aa4')
    ) expected(name,rel,digest)
    WHERE NOT EXISTS (SELECT FROM pg_index i WHERE i.indexrelid=to_regclass(expected.name)
      AND i.indrelid=expected.rel AND i.indisvalid AND i.indisready AND i.indislive
      AND md5(pg_get_indexdef(i.indexrelid))=expected.digest)
  ) THEN
    RAISE EXCEPTION 'BACKED_SEAT_INCOME_COVER_CHANGED' USING ERRCODE='55000';
  END IF;
  v_start := strpos(v_old,'    ), seat_income AS MATERIALIZED (');
  v_end := strpos(v_old,'    ), seat_outgoing AS MATERIALIZED (');
  v_income := substring(v_old FROM v_start FOR v_end-v_start);
  IF md5(v_income) IS DISTINCT FROM '6836dfe2d04f88301f41f83b7ba27d17' THEN
    RAISE EXCEPTION 'BACKED_SEAT_INCOME_SELECTION_CHANGED' USING ERRCODE='55000';
  END IF;
  v_new := substring(v_old FROM 1 FOR v_start-1)
    || replace(v_income,$before$WHERE sp.source IN ('satellite_seat','satellite_ticket')$before$,
      $after$WHERE sp.source IN ('satellite_seat','satellite_ticket')
        AND sp.metadata->>'satellite_target_id' IS NOT NULL$after$)
    || substring(v_old FROM v_end);
  IF md5(v_new) IS DISTINCT FROM '9078403312e51a873e6e7462555dcf7e' THEN
    RAISE EXCEPTION 'BACKED_SEAT_INCOME_RESULT_CHANGED' USING ERRCODE='55000';
  END IF;
  EXECUTE v_new;
  IF NOT EXISTS (SELECT FROM pg_proc WHERE oid=v_catalog.oid
      AND proowner=v_catalog.proowner AND proacl IS NOT DISTINCT FROM v_catalog.proacl
      AND proconfig IS NOT DISTINCT FROM v_catalog.proconfig
      AND prosecdef=v_catalog.prosecdef AND provolatile=v_catalog.provolatile)
     OR md5(pg_get_functiondef(v_target)) IS DISTINCT FROM '9078403312e51a873e6e7462555dcf7e'
     OR md5(pg_get_functiondef('public.fn_tournament_conservation_delta(uuid)'::regprocedure))
        IS DISTINCT FROM '46647067aa049dcb9bda93fa0a1a35b3' THEN
    RAISE EXCEPTION 'BACKED_SEAT_INCOME_READBACK_CHANGED' USING ERRCODE='55000';
  END IF;
END
$patch$;
COMMIT;
