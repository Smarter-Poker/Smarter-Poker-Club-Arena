-- 20260911094503_a_bust_belongs_to_the_phase_its_hand_was_played_in.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A BUST BELONGS TO THE PHASE ITS HAND WAS PLAYED IN.
--
-- MEASURED 2026-09-11 (read-only). Midweek Mystery 5aa7eeba activated at
-- 2026-09-10 06:55:55 with six players left and five chests (8400c). Eight
-- busts played at 06:27-06:34 were not RECORDED until 13:57-15:45. The claim
-- door read mystery_bounty_stage at record time ('active') and wrote them as
-- mystery_chest: four of them drew four of the five chests (6200c to two
-- knockers who were owed a 6.00 head each), and three true post-activation
-- knockouts (hands 8971419/8971861/8972265) sit pending on
-- 'reserve refused: inventory_exhausted' with ~1,000 attempts each, so the
-- event cannot finish. DSS Wednesday 9536150e has the same fault once
-- (8339a681, bust 04:19, recorded 13:05, drew the 540c chest that the 06:42
-- knockout is still waiting for).
--
-- THREE DEFECTS ON ONE MONEY PATH. Fixing only the first moves the freeze:
--   1. fn_claim_bounty_legacy_candidate_20260907 decides the mode from the
--      stage AT RECORD TIME. The bust hand is already loaded and
--      identity-verified in that function (v_atomic) and never consulted.
--   2. fn_collect_bounty refuses every non-chest obligation while the stage is
--      'active' ('mystery_phase_active'). A late pre-activation bust that is
--      correctly written as mystery_pre would therefore still never settle -
--      the same freeze under a different reason.
--   3. fn_mystery_bounty_seed seals the chest pool as bounty_pool minus
--      bounty_pool_paid. A head that was EARNED before activation but not yet
--      RECORDED is not in bounty_pool_paid, so it is swept into the chests
--      (5aa7eeba: 48.00 of unrecorded heads made an 84.00 inventory that
--      should have been 42.00), and paying that head later overdraws the pool.
--      It also stamps activated_at with now() - its transaction START - which
--      is not ordered against a hand commit it waited behind.
--
-- WHAT CHANGES
--   1. claim: for a mystery event past 'pending', the mode is decided by
--      hand_atomic_commits.committed_at of the claimed bust hand (v_atomic,
--      already proven to be the exact hand) against the sealed activation
--      receipt of the current generation. Earlier -> the pre-activation mode
--      the bust would have had (mystery_pre; pko for a hybrid), generation 0.
--      Later -> mystery_chest. No receipt -> refused, as before. Order not
--      provable -> placed, NO obligation, alert (A PLACE IS NOT A BOUNTY):
--      nobody is paid on an unproven phase.
--   2. collect: a persisted mystery_pre obligation is collectable while the
--      stage is active. It is paid from the regular half, which (3) keeps.
--   3. seed: takes the tournament settlement lane before the row lock - every
--      hand commit takes the same lane SHARED before it writes, so no hand of
--      this event can commit while the seed runs - reserves the head of every
--      bust still unrecorded (knockout candidate pending, player still
--      'playing') OUTSIDE the chest pool, and stamps activated_at with
--      clock_timestamp() taken after those locks. A hand therefore either
--      committed entirely before the stamp or starts after the seed commits:
--      committed_at < activated_at is exact for every receipt this seed writes.
--
-- ENGINE (follow-up, not required for safety): maybeActivateMysteryBounty
-- builds the inventory from bounty_pool - bounty_pool_paid. While any bust is
-- unrecorded the seed now computes a smaller pool and refuses with
-- inventory_mismatch (it reports unrecorded_head_cents), so activation waits
-- for the backlog to be recorded - safe, never over-allocated, but it can
-- delay activation. Passing bounty_pool_paid + fn_mystery_bounty_unrecorded_head_cents
-- as alreadyPaidCents to mysteryPoolCents removes the wait.
--
-- NOT CHANGED: every evidence gate of the claim door, the CAS, the PKO order
-- rules, the obligation state machine ('pending','settled'), the reserve/pay
-- path, and every row already written. Money already paid is not touched.
--
-- Asserted text substitution on the live definitions: every anchor must appear
-- EXACTLY ONCE, and post-conditions check what must be gone and what must
-- remain. One transaction (one schema-cache reload).

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_mystery_bounty_unrecorded_head_cents(p_tournament_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
  -- Heads earned by a bust the hand commit has proven (knockout candidate
  -- 'pending') that the claim door has not yet recorded (player still
  -- 'playing'). Same head expression as fn_claim_bounty_legacy_candidate_20260907
  -- and fn_collect_bounty, so the reserve is exactly what will be collected.
  SELECT COALESCE(sum(round(COALESCE(NULLIF(tp.current_bounty,0),
                                     t.bounty_amount, 0) * 100)), 0)::bigint
    FROM public.tournament_players tp
    JOIN public.tournaments t ON t.id = tp.tournament_id
   WHERE tp.tournament_id = p_tournament_id
     AND tp.status = 'playing'
     AND EXISTS (
       SELECT 1 FROM public.tournament_knockout_candidates c
        WHERE c.tournament_id = tp.tournament_id
          AND c.eliminated_user_id = tp.user_id
          AND c.state = 'pending');
$fn$;
REVOKE ALL ON FUNCTION public.fn_mystery_bounty_unrecorded_head_cents(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_mystery_bounty_unrecorded_head_cents(uuid) TO service_role;

DO $body$
DECLARE
  v_def text;
  v_n integer;
  v_i integer;
  v_claim text[][] := ARRAY[
    ARRAY[
$o1$  v_bounty_blocked text := NULL;
BEGIN
$o1$,
$n1$  v_bounty_blocked text := NULL;
  v_activated_at timestamptz;
BEGIN
$n1$],
    ARRAY[
$o2$  v_mode:=CASE
    WHEN coalesce(v_t.is_mystery_bounty,false)
         AND v_t.mystery_bounty_stage='active' THEN 'mystery_chest'
    WHEN coalesce(v_t.is_pko,false) THEN 'pko'
    WHEN coalesce(v_t.is_mystery_bounty,false) THEN 'mystery_pre'
    ELSE 'regular'
  END;
  v_activation_generation:=CASE WHEN v_mode='mystery_chest'
    THEN v_t.mystery_bounty_activation_generation ELSE 0 END;
  IF v_mode='mystery_chest' AND (
       v_activation_generation<=0 OR NOT EXISTS (
         SELECT 1 FROM public.tournament_mystery_activation_receipts ar
          WHERE ar.tournament_id=p_tournament_id
            AND ar.activation_generation=v_activation_generation
       )) THEN
    RETURN jsonb_build_object(
      'ok',false,'reason','mystery_activation_evidence_missing');
  END IF;
$o2$,
$n2$  /* A BUST BELONGS TO THE PHASE ITS HAND WAS PLAYED IN (2026-09-11).
     The stage at the moment a claim is RECORDED says nothing about when the
     bust happened: a claim backlog recorded 06:27 busts at 13:57 as chest
     knockouts and spent another event's chests on them. v_atomic is the exact,
     identity-verified hand_atomic_commits row of the claimed hand; the sealed
     activation receipt of the current generation is the other end. Earlier ->
     the pre-activation mode the bust would have had. Later -> a chest. No
     receipt -> refused, as before. Order not provable -> the place is
     recorded and no bounty is paid (A PLACE IS NOT A BOUNTY). */
  IF coalesce(v_t.is_mystery_bounty,false)
     AND coalesce(v_t.mystery_bounty_stage,'pending')<>'pending' THEN
    v_activation_generation:=coalesce(v_t.mystery_bounty_activation_generation,0);
    SELECT ar.activated_at INTO v_activated_at
      FROM public.tournament_mystery_activation_receipts ar
     WHERE ar.tournament_id=p_tournament_id
       AND ar.activation_generation=v_activation_generation;
    IF v_activation_generation<=0 OR v_activated_at IS NULL THEN
      RETURN jsonb_build_object(
        'ok',false,'reason','mystery_activation_evidence_missing');
    END IF;
    IF v_atomic.committed_at IS NOT NULL
       AND v_atomic.committed_at>v_activated_at THEN
      v_mode:='mystery_chest';
    ELSE
      v_mode:=CASE WHEN coalesce(v_t.is_pko,false) THEN 'pko'
                   ELSE 'mystery_pre' END;
      v_activation_generation:=0;
      IF v_atomic.committed_at IS NULL
         OR v_atomic.committed_at>=v_activated_at THEN
        v_bounty_blocked:=COALESCE(v_bounty_blocked,
                                   'mystery_phase_of_bust_not_proven');
      END IF;
    END IF;
  ELSE
    v_mode:=CASE
      WHEN coalesce(v_t.is_pko,false) THEN 'pko'
      WHEN coalesce(v_t.is_mystery_bounty,false) THEN 'mystery_pre'
      ELSE 'regular'
    END;
    v_activation_generation:=0;
  END IF;
$n2$]
  ];
  v_collect text[][] := ARRAY[
    ARRAY[
$o3$    IF COALESCE(v_t.is_mystery_bounty, false)
       AND v_t.mystery_bounty_stage = 'active' THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'mystery_phase_active');
$o3$,
$n3$    /* A BUST BELONGS TO THE PHASE ITS HAND WAS PLAYED IN (2026-09-11). A
       persisted mystery_pre obligation is a head earned before activation;
       the seed keeps it outside the chest pool, so it is paid from the
       regular half after the chests open. Refusing it only strands it. */
    IF COALESCE(v_t.is_mystery_bounty, false)
       AND v_t.mystery_bounty_stage = 'active'
       AND o.mode IS DISTINCT FROM 'mystery_pre' THEN
      v_result := jsonb_build_object('ok', false, 'reason', 'mystery_phase_active');
$n3$]
  ];
  v_seed text[][] := ARRAY[
    ARRAY[
$o4$  v_sum bigint; v_count int;
BEGIN
  SELECT id, is_mystery_bounty, prize_pool_finalized, bounty_pool,
$o4$,
$n4$  v_sum bigint; v_count int;
  v_unrecorded_cents bigint := 0;
BEGIN
  /* A BUST BELONGS TO THE PHASE ITS HAND WAS PLAYED IN (2026-09-11). The
     tournament lane first: every hand commit takes it SHARED before writing,
     so no hand of this event commits while the inventory is sealed, and the
     activated_at stamped below orders every bust hand exactly. */
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
  SELECT id, is_mystery_bounty, prize_pool_finalized, bounty_pool,
$n4$],
    ARRAY[
$o5$  IF v_pool_cents > v_bounty_cents - round(COALESCE(v_t.bounty_pool_paid, 0) * 100)::bigint THEN
    v_pool_cents := GREATEST(0, v_bounty_cents - round(COALESCE(v_t.bounty_pool_paid, 0) * 100)::bigint);
  END IF;
$o5$,
$n5$  IF v_pool_cents > v_bounty_cents - round(COALESCE(v_t.bounty_pool_paid, 0) * 100)::bigint THEN
    v_pool_cents := GREATEST(0, v_bounty_cents - round(COALESCE(v_t.bounty_pool_paid, 0) * 100)::bigint);
  END IF;

  -- A head earned before this moment but not yet recorded is owed from the
  -- regular half. Keep it out of the sealed chests or it is paid twice.
  v_unrecorded_cents := public.fn_mystery_bounty_unrecorded_head_cents(p_tournament_id);
  IF v_pool_cents > v_bounty_cents - round(COALESCE(v_t.bounty_pool_paid, 0) * 100)::bigint
                    - v_unrecorded_cents THEN
    v_pool_cents := GREATEST(0, v_bounty_cents
                    - round(COALESCE(v_t.bounty_pool_paid, 0) * 100)::bigint
                    - v_unrecorded_cents);
  END IF;
$n5$],
    ARRAY[
$o6$    RETURN jsonb_build_object('ok', false, 'reason', 'inventory_mismatch',
      'inventory_cents', v_sum, 'pool_cents', v_pool_cents);
$o6$,
$n6$    RETURN jsonb_build_object('ok', false, 'reason', 'inventory_mismatch',
      'inventory_cents', v_sum, 'pool_cents', v_pool_cents,
      'unrecorded_head_cents', v_unrecorded_cents);
$n6$],
    ARRAY[
$o7$         mystery_bounty_activated_at = now(),
$o7$,
$n7$         mystery_bounty_activated_at = clock_timestamp(),
$n7$]
  ];
BEGIN
  ---------------------------------------------------------------- 1. claim
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_claim_bounty_legacy_candidate_20260907';
  IF v_n<>1 THEN RAISE EXCEPTION 'claim door has % definitions, expected 1', v_n; END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_claim_bounty_legacy_candidate_20260907';
  IF position('A BUST BELONGS TO THE PHASE' IN v_def)=0 THEN
    FOR v_i IN 1..array_length(v_claim,1) LOOP
      v_n := (length(v_def)-length(replace(v_def,v_claim[v_i][1],'')))/length(v_claim[v_i][1]);
      IF v_n<>1 THEN RAISE EXCEPTION 'claim anchor % appears % times, expected 1', v_i, v_n; END IF;
      v_def := replace(v_def,v_claim[v_i][1],v_claim[v_i][2]);
    END LOOP;
    EXECUTE v_def;
    SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='fn_claim_bounty_legacy_candidate_20260907';
  END IF;
  IF position($x$v_t.mystery_bounty_stage='active' THEN 'mystery_chest'$x$ IN v_def)<>0 THEN
    RAISE EXCEPTION 'the claim door still classifies by the stage at record time';
  END IF;
  IF position('v_atomic.committed_at>v_activated_at' IN v_def)=0
     OR position('mystery_phase_of_bust_not_proven' IN v_def)=0
     OR position('mystery_activation_evidence_missing' IN v_def)=0 THEN
    RAISE EXCEPTION 'the bust-hand classification is not wired';
  END IF;
  IF position('atomic_knockout_evidence_required' IN v_def)=0
     OR position('accepted_zero_settlement_not_found' IN v_def)=0
     OR position('exact_knockout_history_not_found' IN v_def)=0
     OR position('atomic_knockout_candidate_identity_conflict' IN v_def)=0
     OR position('player_has_chips' IN v_def)=0
     OR position('status_not_claimable' IN v_def)=0
     OR position('obligation_identity_conflict' IN v_def)=0
     OR position('pending_pko_predecessor' IN v_def)=0
     OR position('same_hand_pko_predecessor' IN v_def)=0
     OR position('bounty elimination CAS missed after locked claim' IN v_def)=0
     OR position('bounty_head_not_attributed' IN v_def)=0 THEN
    RAISE EXCEPTION 'an evidence or ordering gate of the claim door was lost';
  END IF;

  -------------------------------------------------------------- 2. collect
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_collect_bounty';
  IF v_n<>1 THEN RAISE EXCEPTION 'fn_collect_bounty has % definitions, expected 1', v_n; END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_collect_bounty';
  IF position('A BUST BELONGS TO THE PHASE' IN v_def)=0 THEN
    FOR v_i IN 1..array_length(v_collect,1) LOOP
      v_n := (length(v_def)-length(replace(v_def,v_collect[v_i][1],'')))/length(v_collect[v_i][1]);
      IF v_n<>1 THEN RAISE EXCEPTION 'collect anchor % appears % times, expected 1', v_i, v_n; END IF;
      v_def := replace(v_def,v_collect[v_i][1],v_collect[v_i][2]);
    END LOOP;
    EXECUTE v_def;
    SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='fn_collect_bounty';
  END IF;
  IF position($x$o.mode IS DISTINCT FROM 'mystery_pre'$x$ IN v_def)=0
     OR position('mystery_phase_active' IN v_def)=0
     OR position('undefined_pko_mystery_hybrid' IN v_def)=0
     OR position('bounty_pool_underfunded' IN v_def)=0
     OR position('head_snapshot_changed' IN v_def)=0 THEN
    RAISE EXCEPTION 'fn_collect_bounty lost a gate or the mystery_pre admission';
  END IF;

  ----------------------------------------------------------------- 3. seed
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_mystery_bounty_seed';
  IF v_n<>1 THEN RAISE EXCEPTION 'fn_mystery_bounty_seed has % definitions, expected 1', v_n; END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_mystery_bounty_seed';
  IF position('A BUST BELONGS TO THE PHASE' IN v_def)=0 THEN
    FOR v_i IN 1..array_length(v_seed,1) LOOP
      v_n := (length(v_def)-length(replace(v_def,v_seed[v_i][1],'')))/length(v_seed[v_i][1]);
      IF v_n<>1 THEN RAISE EXCEPTION 'seed anchor % appears % times, expected 1', v_i, v_n; END IF;
      v_def := replace(v_def,v_seed[v_i][1],v_seed[v_i][2]);
    END LOOP;
    EXECUTE v_def;
    SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='fn_mystery_bounty_seed';
  END IF;
  IF position('mystery_bounty_activated_at = now()' IN v_def)<>0
     OR position('mystery_bounty_activated_at = clock_timestamp()' IN v_def)=0
     OR position('fn_ca_lock_settlement_lane_for_tournament(p_tournament_id)' IN v_def)=0
     OR position('fn_mystery_bounty_unrecorded_head_cents(p_tournament_id)' IN v_def)=0
     OR position('entry_still_open' IN v_def)=0
     OR position('chest_count_mismatch' IN v_def)=0 THEN
    RAISE EXCEPTION 'fn_mystery_bounty_seed is not lane-ordered, not reserving, or lost a gate';
  END IF;
END
$body$;

COMMIT;
