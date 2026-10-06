-- 20261003232001_the_commission_key_wait_is_reverted
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-03 23:20:01 UTC.
--
-- WHY. 20261003201157 (installed 21:17 UTC) made a finish wait for busy club
-- commission keys holding nothing, before its lane and before the union
-- credit. Measured 21:18-21:50 UTC against 21:10-21:17: Spin/SNG decided ->
-- receipt p50 rose from 2.8-2.9 s to 10.2-11.2 s (p95 42-47 s -> 32-33 s),
-- union_wallets statement timeouts stayed at 1-13 per 10 min, and the
-- in-finish commission-key waits did NOT go away (0-40 per 10 min) while the
-- new holding-nothing wait added 40-94 per 10 min (~263 s). A cash batch
-- re-takes the key between the early wait and the rollup trigger, so a
-- finish waited twice; and the engine sends one finish per club at a time, so
-- a wait before the lane still holds the club's queue. Approved revert.
--
-- WHAT. The exact inverse substitutions, each guarded by the installed
-- postimage md5 and verified to land on the exact pre-20261003201157 md5:
--   fn_complete_tournament_terminal  489b37dd... -> c64e049911fd99c1d784cdb042ca714b
--   fn_settle_tournament_rake        166b754c... -> 15acb041213e75e30cefdff37e04179b
-- then fn_ca_await_commission_keys_free, which nothing else calls, is
-- dropped. No money path, check or grant of either function changes.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_settle_tournament_rake(uuid,text)'::regprocedure)) = '15acb041213e75e30cefdff37e04179b' AND md5(pg_get_functiondef('public.fn_complete_tournament_terminal(uuid,uuid,text)'::regprocedure)) = 'c64e049911fd99c1d784cdb042ca714b' AND to_regprocedure('public.fn_ca_await_commission_keys_free(uuid)') IS NULL)

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $mig$
DECLARE s regprocedure; d text; a text; r text;
BEGIN
  s := 'public.fn_complete_tournament_terminal(uuid,uuid,text)'::regprocedure;
  d := pg_get_functiondef(s);
  IF md5(d) <> '489b37dd61b45a464a8f6ae8f6ce8972' THEN
    RAISE EXCEPTION 'finish wrapper postimage %', md5(d);
  END IF;
  a := E'  -- A busy commission key is waited for here, holding nothing (2026-10-03).\n'
    || E'  PERFORM public.fn_ca_await_commission_keys_free(p_tournament_id);\n'
    || E'  PERFORM public.fn_ca_lock_settlement_lane_for_finish(p_tournament_id);\n';
  r := E'  PERFORM public.fn_ca_lock_settlement_lane_for_finish(p_tournament_id);\n';
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION 'finish wrapper revert anchor count';
  END IF;
  d := replace(d, a, r);
  IF md5(d) <> 'c64e049911fd99c1d784cdb042ca714b' THEN
    RAISE EXCEPTION 'finish wrapper revert is not the exact preimage: %', md5(d);
  END IF;
  EXECUTE d;
  IF md5(pg_get_functiondef(s)) <> 'c64e049911fd99c1d784cdb042ca714b' THEN
    RAISE EXCEPTION 'finish wrapper installed body is not the exact preimage';
  END IF;

  s := 'public.fn_settle_tournament_rake(uuid,text)'::regprocedure;
  d := pg_get_functiondef(s);
  IF md5(d) <> '166b754c14d82599ea15db319279e69c' THEN
    RAISE EXCEPTION 'rake settle postimage %', md5(d);
  END IF;
  a := E'  IF v_union IS NOT NULL THEN\n'
    || E'   -- THE UNION ROW IS NOT HELD THROUGH A WAIT FOR A CASH BATCH (2026-10-03):\n'
    || E'   -- recognition below takes the commission keys; wait for them first,\n'
    || E'   -- holding nothing new, so the union row is taken last.\n'
    || E'   PERFORM public.fn_ca_await_commission_keys_free(p_tournament_id);\n'
    || E'   v_res:=public.increment_union_wallet(v_union,v_net,v_t.club_id,\n';
  r := E'  IF v_union IS NOT NULL THEN\n'
    || E'   v_res:=public.increment_union_wallet(v_union,v_net,v_t.club_id,\n';
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION 'rake settle revert anchor count';
  END IF;
  d := replace(d, a, r);
  IF md5(d) <> '15acb041213e75e30cefdff37e04179b' THEN
    RAISE EXCEPTION 'rake settle revert is not the exact preimage: %', md5(d);
  END IF;
  EXECUTE d;
  IF md5(pg_get_functiondef(s)) <> '15acb041213e75e30cefdff37e04179b' THEN
    RAISE EXCEPTION 'rake settle installed body is not the exact preimage';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.prosrc LIKE '%fn_ca_await_commission_keys_free%'
                AND p.proname <> 'fn_ca_await_commission_keys_free') THEN
    RAISE EXCEPTION 'fn_ca_await_commission_keys_free still has a caller';
  END IF;
END
$mig$;

DROP FUNCTION public.fn_ca_await_commission_keys_free(uuid);

DO $post$
DECLARE v jsonb := public.fn_ca_settlement_lane_doctrine();
BEGIN
  IF COALESCE((v->>'ok')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'settlement lane doctrine refused: %', v->'violations' USING ERRCODE = '55000';
  END IF;
END
$post$;

COMMIT;
