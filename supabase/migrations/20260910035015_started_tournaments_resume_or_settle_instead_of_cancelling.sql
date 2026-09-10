-- Preserve the existing receipt replay and unstarted expiry authority.
-- Dan's never-cancel rule is recorded in tests/unit/tournamentsNeverCancel.test.ts.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='10s';

DO $migration$
DECLARE
  v_oid oid:=to_regprocedure('public.atomic_cancel_tournament(uuid,uuid)');
  v_body text;
  v_definition text;
  v_guard text:=$guard$  -- A tournament that has started is resumed or settled, never voided.
  -- start_time is a schedule/fill deadline; it is not proof that play began.
  -- The stored receipt above remains replayable without another cancellation.
  IF v_t.started_at IS NOT NULL
     OR upper(COALESCE(v_t.status::text,'')) IN ('RUNNING','BREAK')
     OR COALESCE(v_t.spin_multiplier,0)>0
     OR EXISTS (SELECT 1 FROM public.tournament_launch_receipts r
                 WHERE r.tournament_id=p_tournament_id AND r.completed_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.spin_draw_receipts r
                 WHERE r.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.spin_reserve_ledger r
                 WHERE r.tournament_id=p_tournament_id AND r.kind='jackpot_draw')
     OR EXISTS (SELECT 1 FROM public.hand_history hh
                 WHERE hh.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tables tb
                 JOIN public.hand_history hh ON hh.table_id=tb.id
                 WHERE tb.tournament_id=p_tournament_id)
     OR EXISTS (SELECT 1 FROM public.tournament_obligations o
                 WHERE o.tournament_id=p_tournament_id
                   AND o.kind<>'refund' AND o.amount_paid>0) THEN
    RAISE EXCEPTION
      'Tournament has started or committed awards; resume or settle it instead of cancelling'
      USING ERRCODE='55000';
  END IF;

$guard$;
BEGIN
  SELECT p.prosrc,pg_get_functiondef(p.oid) INTO v_body,v_definition
    FROM pg_catalog.pg_proc p
   WHERE p.oid=v_oid
     AND p.proowner='postgres'::regrole
       AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}'
       AND p.prosecdef
       AND NOT p.proisstrict
       AND p.provolatile='v'
       AND p.proargnames=ARRAY['p_tournament_id','p_admin_id']::text[]
       AND p.proargmodes IS NULL AND p.proallargtypes IS NULL
       AND p.pronargdefaults=0
       AND p.proargdefaults IS NULL
       AND NOT p.proretset
       AND p.prorettype='jsonb'::regtype
       AND p.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
       AND p.proconfig=ARRAY['search_path=public, extensions, pg_temp','statement_timeout=120s']::text[];
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Atomic cancellation authority changed; review owner, ACL and function configuration'
      USING ERRCODE='55000';
  END IF;
  IF md5(v_body)='16ea7acbbf76613a0a1193dff18f1330' THEN RETURN; END IF;
  IF v_body IS NULL OR md5(v_body)<>'8c2641c634de919487c7bbb7eb8c5c22' THEN
    RAISE EXCEPTION 'atomic cancellation source changed; review its composed authority before applying';
  END IF;
  EXECUTE replace(v_definition,v_body,
    replace(v_body,'  -- Freeze every identity before any payer runs.',
      v_guard||'  -- Freeze every identity before any payer runs.'));
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc WHERE oid=v_oid AND md5(prosrc)='16ea7acbbf76613a0a1193dff18f1330') THEN
    RAISE EXCEPTION 'atomic cancellation refusal body did not match its reviewed definition';
  END IF;
END;
$migration$;

-- Restate the current authority explicitly; no new caller is admitted.
REVOKE ALL ON FUNCTION public.atomic_cancel_tournament(uuid,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_cancel_tournament(uuid,uuid)
  TO service_role;

DO $postflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid=to_regprocedure('public.atomic_cancel_tournament(uuid,uuid)')
       AND md5(p.prosrc)='16ea7acbbf76613a0a1193dff18f1330'
       AND p.proowner='postgres'::regrole
       AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}'
       AND p.prosecdef
       AND NOT p.proisstrict
       AND p.provolatile='v'
       AND p.proargnames=ARRAY['p_tournament_id','p_admin_id']::text[]
       AND p.proargmodes IS NULL AND p.proallargtypes IS NULL
       AND p.pronargdefaults=0
       AND p.proargdefaults IS NULL
       AND NOT p.proretset
       AND p.prorettype='jsonb'::regtype
       AND p.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
       AND p.proconfig=ARRAY['search_path=public, extensions, pg_temp','statement_timeout=120s']::text[]
  ) THEN
    RAISE EXCEPTION 'Reviewed function body or authority changed during migration'
      USING ERRCODE='55000';
  END IF;
END;
$postflight$;
COMMIT;
