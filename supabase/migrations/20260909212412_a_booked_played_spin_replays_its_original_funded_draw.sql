-- 20260909193732_a_booked_played_spin_replays_its_original_funded_draw.sql
--
-- The immutable funded-draw authority introduced at 20260909174722 proved
-- only registered/playing rows before it looked for its saved receipt. That
-- is correct for a fresh Spin, but it also refused the one crash-recovery
-- state proved by 20260909183217: three originally paid entrants, a committed
-- draw and persisted hand, then exactly one zero-stack player eliminated and
-- vacated while the tournament's launch receipt is still incomplete.
--
-- This hardens the one draw authority at its root. It keeps the ordinary
-- three-active-player rule unchanged. Only when exactly two active rows remain
-- does it invoke the existing service-only played-Spin proof. If that proof is
-- exact, the authority rebuilds the entrant identity from the two playing and
-- one eliminated original rows, then runs the SAME escrow, net-payment,
-- unconsumed-entitlement and immutable-receipt comparisons as an ordinary
-- launch. An old committed draw can therefore be adopted once; a saved draw
-- can be replayed; neither path can redraw, refund, mint, or admit a fresh
-- two-player Spin. Heads-Up SNG remains a separate two-seat format and cannot
-- pass the Spin contract or played-Spin proof.
--
-- This is a synchronous source fix. It adds no watcher, reconciler, retry job,
-- backfill, repair path or historical mutation.

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '10s';

DO $patch_atomic_spin_draw$
DECLARE
  v_src text;
  v_new text;
  v_declaration_old CONSTANT text :=
'  v_weight numeric;
BEGIN';
  v_declaration_new CONSTANT text :=
'  v_weight numeric;
  v_played_recovery boolean := false;
  v_recovery jsonb;
BEGIN';
  v_roster_old CONSTANT text :=
'  SELECT count(*), jsonb_agg(jsonb_build_object(''registration_id'', p.id,
           ''user_id'', p.user_id) ORDER BY p.user_id, p.id)
    INTO v_count, v_entrants
    FROM public.tournament_players p WHERE p.tournament_id = p_tournament_id
     AND p.status IN (''registered'', ''playing'');
  IF v_count <> 3 OR (SELECT count(DISTINCT p.user_id)
      FROM public.tournament_players p WHERE p.tournament_id = p_tournament_id
       AND p.status IN (''registered'', ''playing'')) <> 3 THEN
    RETURN jsonb_build_object(''ok'', false, ''reason'', ''spin_field_unproven'');
  END IF;';
  v_roster_new CONSTANT text :=
'  SELECT count(*), jsonb_agg(jsonb_build_object(''registration_id'', p.id,
           ''user_id'', p.user_id) ORDER BY p.user_id, p.id)
    INTO v_count, v_entrants
    FROM public.tournament_players p WHERE p.tournament_id = p_tournament_id
     AND p.status IN (''registered'', ''playing'');

  -- A dealt Spin may have one proven busted/vacated original seat. This does
  -- not lower the fresh-launch field: the proof requires the original three
  -- paid identities, immutable money journals, a persisted hand, two exact
  -- live seats and conservation of all three bought starting stacks.
  IF v_count = 2 THEN
    v_recovery := public.fn_prove_played_spin_launch_recovery(p_tournament_id);
    IF COALESCE((v_recovery->>''ok'')::boolean, false) THEN
      v_played_recovery := true;
      SELECT count(*), jsonb_agg(jsonb_build_object(''registration_id'', p.id,
               ''user_id'', p.user_id) ORDER BY p.user_id, p.id)
        INTO v_count, v_entrants
        FROM public.tournament_players p
       WHERE p.tournament_id = p_tournament_id
         AND p.status IN (''playing'', ''eliminated'');
    END IF;
  END IF;

  IF v_count <> 3 OR (SELECT count(DISTINCT p.user_id)
      FROM public.tournament_players p WHERE p.tournament_id = p_tournament_id
       AND (p.status IN (''registered'', ''playing'')
            OR (v_played_recovery AND p.status = ''eliminated''))) <> 3 THEN
    RETURN jsonb_build_object(''ok'', false, ''reason'', ''spin_field_unproven'');
  END IF;';
  v_payment_old CONSTANT text :=
'  FOR v_player IN SELECT p.user_id FROM public.tournament_players p
    WHERE p.tournament_id = p_tournament_id AND p.status IN (''registered'', ''playing'')
    ORDER BY p.user_id LOOP';
  v_payment_new CONSTANT text :=
'  FOR v_player IN SELECT p.user_id FROM public.tournament_players p
    WHERE p.tournament_id = p_tournament_id
      AND (p.status IN (''registered'', ''playing'')
           OR (v_played_recovery AND p.status = ''eliminated''))
    ORDER BY p.user_id LOOP';
BEGIN
  IF to_regprocedure(
       'public.fn_prove_played_spin_launch_recovery(uuid)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'played Spin recovery proof must exist before composing the funded draw authority';
  END IF;

  v_src := pg_get_functiondef(
    'public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)'::regprocedure
  );

  IF md5(v_src) IS DISTINCT FROM '71e869039854497e472ed20e259be4db' THEN
    RAISE EXCEPTION
      'atomic Spin draw authority changed since the played-recovery composition was reviewed';
  END IF;

  IF position(v_declaration_old IN v_src) = 0
     OR position(v_roster_old IN v_src) = 0
     OR position(v_payment_old IN v_src) = 0 THEN
    RAISE EXCEPTION
      'atomic Spin draw authority no longer has the reviewed composition anchors';
  END IF;

  v_new := replace(v_src, v_declaration_old, v_declaration_new);
  v_new := replace(v_new, v_roster_old, v_roster_new);
  v_new := replace(v_new, v_payment_old, v_payment_new);

  IF position('fn_prove_played_spin_launch_recovery' IN v_new) = 0
     OR position('v_played_recovery AND p.status = ''eliminated''' IN v_new) = 0
     OR position('spin_entry_escrow_unproven' IN v_new) = 0
     OR position('spin_paid_entry_unproven' IN v_new) = 0
     OR position('spin_receipt_roster_mismatch' IN v_new) = 0
     OR position('spin_rule_manifest_invalid' IN v_new) = 0
     OR position('Spin contribution does not prove the three funded entries' IN v_new) = 0 THEN
    RAISE EXCEPTION
      'played Spin composition dropped an existing funded-draw proof';
  END IF;

  EXECUTE v_new;
END;
$patch_atomic_spin_draw$;

REVOKE ALL ON FUNCTION public.fn_spin_draw_and_settle_atomic(uuid, uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_draw_and_settle_atomic(uuid, uuid, uuid, jsonb)
  TO service_role;

DO $post_install_guard$
DECLARE
  v_src text := pg_get_functiondef(
    'public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)'::regprocedure
  );
BEGIN
  IF md5(v_src) IS DISTINCT FROM '1c911e3ada50ffe0493b9b375e3fa9ae'
     OR position('fn_prove_played_spin_launch_recovery' IN v_src) = 0
     OR position('v_played_recovery AND p.status = ''eliminated''' IN v_src) = 0
     OR position('spin_entry_escrow_unproven' IN v_src) = 0
     OR position('spin_paid_entry_unproven' IN v_src) = 0
     OR position('spin_receipt_roster_mismatch' IN v_src) = 0 THEN
    RAISE EXCEPTION 'played Spin funded-draw composition did not persist';
  END IF;
END;
$post_install_guard$;

COMMIT;
