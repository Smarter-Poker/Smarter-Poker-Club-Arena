-- 20261024204950_a_pre_money_mystery_rebuy_retires_its_old_head_snapshot
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-24 20:49:50 UTC.
--
-- WHAT WAS WRONG
--
-- 20261024075911 let a pre-money mystery-bounty bust be rebought: the bounty
-- claim records the bust and writes no obligation, and the rebuy step returned
-- no_bounty_head instead of demanding one. Before it returned, though, it
-- refused any entry whose tournament_players.current_bounty was not zero
-- ('Pre-money mystery rebuy found a live bounty head'). That assumption was
-- wrong. Every entry in a mystery event carries current_bounty = the event's
-- bounty_amount from registration (trg_seed_bounty_head), and a pre-money bust
-- leaves it there. On the first two mystery events after install (Union
-- Mystery Bounty PLO5, 2026-10-24 20:30 UTC, d8a59939 and 5b5ca8e1) every
-- rebuy attempt hit that refusal: 160 refusals in 20 minutes, 17 window busts,
-- zero rebuys.
--
-- WHY CLEARING IT MOVES NO MONEY
--
-- On a mystery event current_bounty is a snapshot of the head, not a balance.
-- The money lives in tournaments.bounty_pool. The residual is computed as
-- bounty_pool minus what the obligation ledger paid
-- (fn_finalize_bounty_pool_unguarded_20260907), and mystery payout is paid
-- from chests. The paid-mystery rebuy path in this same function already
-- clears the snapshot to zero once the chest is paid ("Mystery payout owns a
-- chest rather than current_bounty, so clear that same snapshotted
-- generation here"). process_tournament_rebuy then requires the new
-- generation's current_bounty to equal exactly the head this purchase funds
-- (current_bounty + bounty_head_funded, which is only right from zero), and
-- the money core adds that head to bounty_pool.
--
-- So a pre-money mystery rebuy leaves the old head's money in the pool as
-- residual (what an ordinary pre-money mystery elimination does), retires
-- the snapshot, and the purchase funds and records the new head.
--
-- THE FIX
--
-- In the pre-money branch, replace the refusal with the paid path's own exact
-- retirement. Lock the row, accept a snapshot of 0 or exactly the event's
-- bounty_amount, set it to 0 once, and refuse anything else ('old head changed
-- before retirement'). Measured: every entry in the last three days of mystery
-- events holds 0 or bounty_amount, and all of them are chests-only (regular
-- pool 0%). The answer now reports the retired snapshot in 'old_head'. Every
-- other part of the step, and every other bounty shape, is unchanged.
--
-- Patched by exact anchor with an md5 precondition on the measured live body.
-- One transaction, no hot-table lock. Pinned by
-- tests/a-pre-money-mystery-rebuy-retires-its-old-head-snapshot.law.test.ts.
--
-- @live-proof: (SELECT position('A PRE-MONEY MYSTERY REBUY RETIRES ITS OLD HEAD SNAPSHOT' IN pg_get_functiondef('public.fn_ca_settle_bounty_rebuy_generation_v1(uuid,uuid,uuid)'::regprocedure))>0 AND position('Pre-money mystery rebuy found a live bounty head' IN pg_get_functiondef('public.fn_ca_settle_bounty_rebuy_generation_v1(uuid,uuid,uuid)'::regprocedure))=0)

BEGIN;

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $a_pre_money_mystery_rebuy_retires_its_old_head$
DECLARE
  v_sig constant regprocedure :=
    'public.fn_ca_settle_bounty_rebuy_generation_v1(uuid,uuid,uuid)'::regprocedure;
  v_marker constant text := 'A PRE-MONEY MYSTERY REBUY RETIRES ITS OLD HEAD SNAPSHOT';
  v_src text;
  v_def text;
  v_old text;
  v_new text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_sig;
  IF position(v_marker IN v_src) > 0 THEN
    RETURN; -- already installed
  END IF;
  IF md5(v_src) <> 'b254f96b52b6ac9fb26a8a3e3994017b' THEN
    RAISE EXCEPTION 'fn_ca_settle_bounty_rebuy_generation_v1 body changed (md5 %); refusing to patch a body this migration did not measure', md5(v_src);
  END IF;

  v_def := pg_get_functiondef(v_sig);
  v_old := $old$      IF EXISTS (
        SELECT 1 FROM public.tournament_players tp
         WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
           AND round(COALESCE(tp.current_bounty,0),2)<>0) THEN
        RAISE EXCEPTION 'Pre-money mystery rebuy found a live bounty head'
          USING ERRCODE='P0404';
      END IF;
      RETURN jsonb_build_object(
        'ok',true,'obligation_id',NULL,'mode','mystery_pre',
        'no_bounty_head',true,'old_head',0,
$old$;
  IF (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) THEN
    RAISE EXCEPTION 'pre-money mystery head anchor is not present exactly once';
  END IF;
  v_new := $new$      -- A PRE-MONEY MYSTERY REBUY RETIRES ITS OLD HEAD SNAPSHOT (2026-10-24).
      -- Every mystery entry carries current_bounty = bounty_amount from
      -- registration, and a pre-money bust leaves it there. It is a snapshot,
      -- not a balance: the money stays in tournaments.bounty_pool as residual.
      -- Retire it exactly as the paid path below does, so the purchase can
      -- record the new generation's head from zero.
      SELECT tp.current_bounty INTO v_head_after
        FROM public.tournament_players tp
       WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
       FOR UPDATE;
      IF round(COALESCE(v_head_after,0),2)<>0
         AND round(COALESCE(v_head_after,0),2)<>round(COALESCE(v_t.bounty_amount,0),2) THEN
        RAISE EXCEPTION 'Bounty rebuy old head changed before retirement'
          USING ERRCODE='55000';
      END IF;
      UPDATE public.tournament_players tp
         SET current_bounty=0
       WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
         AND round(COALESCE(tp.current_bounty,0),2) IN
               (0,round(COALESCE(v_t.bounty_amount,0),2));
      GET DIAGNOSTICS v_rows=ROW_COUNT;
      IF v_rows<>1 OR EXISTS (
        SELECT 1 FROM public.tournament_players tp
         WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
           AND round(COALESCE(tp.current_bounty,0),2)<>0) THEN
        RAISE EXCEPTION 'Bounty rebuy old head was not retired exactly once'
          USING ERRCODE='P0404';
      END IF;
      RETURN jsonb_build_object(
        'ok',true,'obligation_id',NULL,'mode','mystery_pre',
        'no_bounty_head',true,'old_head',round(COALESCE(v_head_after,0),2),
$new$;
  EXECUTE replace(v_def, v_old, v_new);

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_sig;
  IF position(v_marker IN v_src) = 0
     OR position('Pre-money mystery rebuy found a live bounty head' IN v_src) > 0 THEN
    RAISE EXCEPTION 'patched pre-money mystery head retirement did not install';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = v_sig AND p.prosecdef
       AND p.proconfig = ARRAY['search_path=public, pg_temp','statement_timeout=30s']::text[]
       AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'patched rebuy step lost its security definer, settings or private grant';
  END IF;
END
$a_pre_money_mystery_rebuy_retires_its_old_head$;

COMMIT;
