-- Stage-one cash cutover proof. The atomic terminal wrapper is the new engine
-- authority, while the legacy reconciler and generic obligation payer remain
-- available to an old process during the rolling deployment. This probe is
-- deliberately self-aborting so it changes nothing.
DO $probe$
DECLARE
  v_terminal text;
  v_reconciler text;
  v_obligation text;
BEGIN
  IF to_regprocedure(
       'public.fn_settle_tournament_places(uuid,uuid)') IS NULL
     OR to_regprocedure(
       'public.fn_settle_tournament_final_table_deal(uuid)') IS NULL
     OR to_regprocedure(
       'public.fn_complete_tournament_terminal(uuid,uuid,text)') IS NULL
     OR to_regprocedure(
       'public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)') IS NULL
     OR to_regclass('public.tournament_terminal_settlements') IS NULL THEN
    RAISE EXCEPTION 'FAIL a stage-one atomic cash authority or receipt is missing';
  END IF;

  SELECT prosrc INTO v_terminal
    FROM pg_proc
   WHERE oid =
     'public.fn_complete_tournament_terminal(uuid,uuid,text)'::regprocedure;
  IF v_terminal !~ 'IF v_mode = ''places'' THEN'
     OR v_terminal !~ 'public.fn_settle_tournament_places\('
     OR v_terminal !~ 'public.fn_settle_tournament_final_table_deal\('
     OR v_terminal !~ 'INSERT INTO public.tournament_terminal_settlements'
     OR v_terminal !~ 'SET status = ''COMPLETED'''
     OR v_terminal ~* 'EXCEPTION\s+WHEN' THEN
    RAISE EXCEPTION 'FAIL terminal wrapper lost its single atomic sequence';
  END IF;

  IF NOT has_function_privilege(
       'service_role',
       'public.fn_complete_tournament_terminal(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege(
       'authenticated',
       'public.fn_complete_tournament_terminal(uuid,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_settle_tournament_places(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_settle_tournament_final_table_deal(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL terminal wrapper or component authority ACLs are wrong';
  END IF;

  IF to_regprocedure(
       'public.fn_tournament_payout_reconcile(uuid,boolean)') IS NULL
     OR to_regprocedure(
       'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)')
          IS NULL
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_tournament_payout_reconcile(uuid,boolean)', 'EXECUTE')
     OR NOT has_function_privilege(
       'service_role',
       'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)',
       'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL rolling cash compatibility was retired before engine cutover';
  END IF;

  SELECT prosrc INTO v_reconciler
    FROM pg_proc
   WHERE oid =
     'public.fn_tournament_payout_reconcile(uuid,boolean)'::regprocedure;
  SELECT prosrc INTO v_obligation
    FROM pg_proc
   WHERE oid =
     'public.fn_settle_tournament_obligation(uuid,text,integer,uuid,numeric,text,text,uuid)'::regprocedure;
  IF v_reconciler !~ 'public.fn_settle_tournament_obligation\('
     OR v_reconciler ~* '(PERFORM|SELECT)\s+(public\.)?credit_player_wallet\s*\('
     OR v_obligation !~ 'public.fn_credit_and_log\('
     OR v_obligation ~* '(PERFORM|SELECT)\s+(public\.)?credit_player_wallet\s*\(' THEN
    RAISE EXCEPTION 'FAIL a rolling compatibility path can split credit from evidence';
  END IF;

  RAISE EXCEPTION
    'AUDIT_TEST_PASS: stage-one atomic cash authority and rolling compatibility pass; all probe work rolled back';
END;
$probe$;
