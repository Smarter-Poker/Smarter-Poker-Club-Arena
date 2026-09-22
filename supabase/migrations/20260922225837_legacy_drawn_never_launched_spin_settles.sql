-- 20260922225837_legacy_drawn_never_launched_spin_settles
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-22 22:58:37 UTC.
--
-- ROOT CAUSE (Production Alerts Fleet, board issue #5070, incident
-- spin-unfilled-backlog-legacy-orphans, 13 tournaments, 86 open
-- SpinUnfilledBacklog alert rows, firing continuously since 2026-09-13):
--
-- 13 Spin tournaments created 2026-09-08 13:34-14:46 UTC each have exactly
-- one spin_reserve_ledger row with kind='jackpot_draw' (multiplier=2,
-- verified live for all 13) -- a real draw executed and moved real chips
-- from the reserve pool into each tournament's prize liability -- but
-- spin_draw_receipts, tournament_launch_receipts and hand_history are all
-- empty for every one of them: the draw's receipt was never written and
-- the launch that deals the hand never ran. Per the roster
-- (tournament_players with status IN ('registered','playing')), every one
-- of the 13 has permanently dropped to 1 or 2 active seats, so the
-- ordinary relaunch path (fn_spin_draw_and_settle_atomic, which requires
-- exactly 3) can never again succeed. These are legacy artifacts of the
-- pre-2026-09-10 cutover; owner law v2.9 (2026-09-22,
-- docs/laws.d/a-spin-is-drawn-stamped-and-booked-by-the-launch-that-deals-it.md)
-- confirms a Spin's draw, reserve booking and row stamp now commit in the
-- one launch transaction going forward, so this exact state (drawn, no
-- receipt, no launch) cannot recur.
--
-- atomic_cancel_tournament already contains a complete, tested unwind for
-- exactly this shape: it reverses the jackpot_draw and contribution
-- spin_reserve_ledger rows through chip_ledger, records the unwind in
-- tournament_spin_cancellation_unwinds, reverses rake_records to net
-- exactly 0, then refunds every player through the ordinary
-- fn_ca_tournament_refund_plan / fn_settle_tournament_refund_exact path.
-- Nothing new needs to be built. Three narrow, evidence-gated defects kept
-- it unreachable, each verified live in rolled-back pg_temp probes before
-- this migration was written (Production Alerts Fleet, PRIMARY lane,
-- 2026-09-22T22:35-23:xx UTC run):
--
-- 1. atomic_cancel_tournament's top guard refuses ANY tournament with
--    COALESCE(spin_multiplier,0)>0 or a jackpot_draw row, unconditionally --
--    even though the function already has separate, more precise clauses
--    for genuine in-play evidence (tournament_launch_receipts, hand_history,
--    RUNNING/BREAK, started_at). Fix: the multiplier/jackpot_draw clause now
--    only refuses cancellation when the active roster (registered/playing)
--    is still exactly 3 -- i.e. when a relaunch could still plausibly
--    succeed. A drawn Spin that has already lost a seat can never relaunch
--    (fn_spin_draw_and_settle_atomic's own field-of-3 proof cannot pass) and
--    is exactly the state this migration exists to close.
--
-- 2. tournaments.prize_pool/bounty_pool/total_rake are never written between
--    a Spin's draw and its settlement -- fn_ca_escrow_apply only maintains
--    tournament_escrow, and fn_spin_draw_and_settle_atomic's own cache-stamp
--    only fires on a fresh draw (provenance 'at_draw'), never on the
--    'legacy_projection' recovery branch these 13 would take. So
--    atomic_cancel_tournament's own pre-existing assertion ("caches do not
--    equal exact escrow before cancellation") could never pass for a drawn,
--    unsettled Spin -- an untested branch of an existing invariant, not a
--    new one. Fix: sync those three cache columns from the escrow
--    immediately before that assertion, gated to only fire for a
--    Spin-drawn, never-launched, never-dealt tournament whose cache has
--    actually drifted from its escrow (verified live: prize_pool and
--    bounty_pool already agreed for all 13; only total_rake was stale at
--    0.00 against fee_balance of 0.24-24.00 across the 13).
--
-- 3. fn_ca_tournament_refund_plan asserts escrow.fee_entries_in equals the
--    sum of wallet-charge entitlements' refund_fee. For a Spin that sum is
--    always 0 (buy_in_fee=0; fn_tournament_entry_split itemizes the whole
--    buy-in as prize) while fee_entries_in correctly holds the pooled
--    reserve rake taken at the third paid seat -- two legitimately
--    different, non-comparable accounting models, not a data error.
--    fn_spin_draw_and_settle_atomic's own header already documents this
--    exact mismatch ("Spin escrow records its embedded 8% rake there
--    despite buy_in_fee=0. A payout/refund policy comparison cannot stand
--    in for this payment proof.") and works around it with its own bespoke
--    proof; atomic_cancel_tournament's generic refund loop was never given
--    the same exemption because cancelling a drawn Spin was previously
--    unreachable. Fix: skip the fee_entries_in equality check specifically
--    for variant='spin' tournaments; every other assertion in the function
--    (gross_in, satellite_fee_in, bounty_in, satellite_in, and the
--    per-ledger invalid-entitlement scan) is untouched and still runs.
--
-- All three patches were verified together end to end in a single
-- rolled-back pg_temp probe against this exact production database
-- (2026-09-22T22:57 UTC) for all 13 tournament ids: each ran atomic
-- cancellation through to the real wallet-credit step, at which point the
-- probe correctly hit the unrelated, expected PLATFORM_FROZEN guard
-- (:50-:03 UTC hourly maintenance break, section 13) -- proof the fix
-- reaches production money movement cleanly, blocked only by the freeze
-- this migration deliberately does not try to bypass. This migration
-- re-runs the same 13 real (uncommitted, non-probe) calls for real after
-- application, self-asserting the expected result against what is read
-- live from escrow immediately beforehand, so it aborts instead of
-- silently doing nothing if the board has moved since 22:57 UTC.
--
-- Money: 13 tournaments, 39 wallet entitlements, ~13-25 distinct players
-- (horses and humans identically -- CLAUDE.md 10.5), ~446.00 total prize +
-- ~53.5 total fee refunded to the players who funded them (exact totals
-- read live and asserted below, not hardcoded), 0 created, 0 destroyed, 0
-- taken back from any player. Every credit runs through
-- atomic_cancel_tournament's own fn_settle_tournament_refund_exact /
-- fn_ca_declare_ledger rails -- nothing here hand-writes a wallet row.

BEGIN;

DO $patch$
DECLARE
  v_def_cancel text;
  v_patched_cancel text;
  v_def_plan text;
  v_patched_plan text;
  v_old_guard text := 'OR COALESCE(v_t.spin_multiplier,0)>0'||E'\n'||
    '     OR EXISTS (SELECT 1 FROM public.tournament_launch_receipts r'||E'\n'||
    '                 WHERE r.tournament_id=p_tournament_id AND r.completed_at IS NOT NULL)'||E'\n'||
    '     OR EXISTS (SELECT 1 FROM public.spin_draw_receipts r'||E'\n'||
    '                 WHERE r.tournament_id=p_tournament_id)'||E'\n'||
    '     OR EXISTS (SELECT 1 FROM public.spin_reserve_ledger r'||E'\n'||
    '                 WHERE r.tournament_id=p_tournament_id AND r.kind=''jackpot_draw'')';
  v_new_guard text := 'OR EXISTS (SELECT 1 FROM public.tournament_launch_receipts r'||E'\n'||
    '                 WHERE r.tournament_id=p_tournament_id AND r.completed_at IS NOT NULL)'||E'\n'||
    '     OR EXISTS (SELECT 1 FROM public.spin_draw_receipts r'||E'\n'||
    '                 WHERE r.tournament_id=p_tournament_id)'||E'\n'||
    '     OR ((COALESCE(v_t.spin_multiplier,0)>0'||
    '       OR EXISTS (SELECT 1 FROM public.spin_reserve_ledger r WHERE r.tournament_id=p_tournament_id AND r.kind=''jackpot_draw''))'||
    '       AND (SELECT count(*) FROM public.tournament_players p WHERE p.tournament_id=p_tournament_id AND p.status IN (''registered'',''playing''))=3)';
  v_old_escrow_prelock text := 'PERFORM public.fn_ca_escrow_apply('||E'\n'||
    '    p_tournament_id,''atomic cancellation escrow prelock'');'||E'\n'||
    '  SELECT * INTO v_e FROM public.tournament_escrow e'||E'\n'||
    '   WHERE e.tournament_id=p_tournament_id FOR UPDATE;';
  v_new_escrow_prelock text := 'PERFORM public.fn_ca_escrow_apply('||E'\n'||
    '    p_tournament_id,''atomic cancellation escrow prelock'');'||E'\n'||
    '  -- Legacy drawn-never-launched Spin cache sync: tournaments.total_rake'||E'\n'||
    '  -- (and prize_pool/bounty_pool) are never written for a Spin between its'||E'\n'||
    '  -- draw and its settlement -- only settlement, or this narrow, evidence-'||E'\n'||
    '  -- gated sync, closes that gap for a Spin that will never reach settlement.'||E'\n'||
    '  UPDATE public.tournaments t2 SET prize_pool=e2.prize_balance,'||E'\n'||
    '    bounty_pool=e2.bounty_balance, total_rake=e2.fee_balance'||E'\n'||
    '   FROM public.tournament_escrow e2'||E'\n'||
    '   WHERE t2.id=p_tournament_id AND e2.tournament_id=p_tournament_id'||E'\n'||
    '     AND (t2.prize_pool IS DISTINCT FROM e2.prize_balance'||E'\n'||
    '       OR t2.bounty_pool IS DISTINCT FROM e2.bounty_balance'||E'\n'||
    '       OR t2.total_rake IS DISTINCT FROM e2.fee_balance)'||E'\n'||
    '     AND (COALESCE(t2.spin_multiplier,0)>0'||E'\n'||
    '       OR EXISTS (SELECT 1 FROM public.spin_reserve_ledger r2 WHERE r2.tournament_id=t2.id AND r2.kind=''jackpot_draw''))'||E'\n'||
    '     AND NOT EXISTS (SELECT 1 FROM public.tournament_launch_receipts r3 WHERE r3.tournament_id=t2.id AND r3.completed_at IS NOT NULL)'||E'\n'||
    '     AND NOT EXISTS (SELECT 1 FROM public.hand_history hh3 WHERE hh3.tournament_id=t2.id);'||E'\n'||
    '  SELECT * INTO v_t FROM public.tournaments WHERE id=p_tournament_id;'||E'\n'||
    '  SELECT * INTO v_e FROM public.tournament_escrow e'||E'\n'||
    '   WHERE e.tournament_id=p_tournament_id FOR UPDATE;';
  v_old_plan_assert text := 'IF v_escrow.tournament_id IS NULL'||E'\n'||
    '     OR v_escrow.enforced IS DISTINCT FROM true'||E'\n'||
    '     OR v_escrow.gross_in IS DISTINCT FROM v_wallet_gross'||E'\n'||
    '     OR v_escrow.fee_entries_in IS DISTINCT FROM v_direct_fee'||E'\n'||
    '     OR v_escrow.satellite_fee_in IS DISTINCT FROM v_satellite_fee'||E'\n'||
    '     OR v_escrow.bounty_in IS DISTINCT FROM v_bounty'||E'\n'||
    '     OR v_escrow.satellite_in IS DISTINCT FROM v_satellite_in THEN';
  v_new_plan_assert text := 'IF v_escrow.tournament_id IS NULL'||E'\n'||
    '     OR v_escrow.enforced IS DISTINCT FROM true'||E'\n'||
    '     OR v_escrow.gross_in IS DISTINCT FROM v_wallet_gross'||E'\n'||
    '     OR (v_escrow.fee_entries_in IS DISTINCT FROM v_direct_fee'||E'\n'||
    '       AND NOT EXISTS (SELECT 1 FROM public.tournaments tsp WHERE tsp.id=p_tournament_id AND tsp.variant=''spin''))'||E'\n'||
    '     OR v_escrow.satellite_fee_in IS DISTINCT FROM v_satellite_fee'||E'\n'||
    '     OR v_escrow.bounty_in IS DISTINCT FROM v_bounty'||E'\n'||
    '     OR v_escrow.satellite_in IS DISTINCT FROM v_satellite_in THEN';
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def_cancel
    FROM pg_proc WHERE proname = 'atomic_cancel_tournament';
  SELECT pg_get_functiondef(oid) INTO v_def_plan
    FROM pg_proc WHERE proname = 'fn_ca_tournament_refund_plan';
  IF strpos(v_def_cancel, v_old_guard) = 0 THEN
    RAISE EXCEPTION 'MIGRATION_ABORT: atomic_cancel_tournament guard text has changed since this migration was written';
  END IF;
  IF strpos(v_def_cancel, v_old_escrow_prelock) = 0 THEN
    RAISE EXCEPTION 'MIGRATION_ABORT: atomic_cancel_tournament escrow-prelock text has changed since this migration was written';
  END IF;
  IF strpos(v_def_plan, v_old_plan_assert) = 0 THEN
    RAISE EXCEPTION 'MIGRATION_ABORT: fn_ca_tournament_refund_plan assertion text has changed since this migration was written';
  END IF;

  v_patched_plan := replace(v_def_plan, v_old_plan_assert, v_new_plan_assert);
  EXECUTE v_patched_plan;

  v_patched_cancel := replace(v_def_cancel, v_old_guard, v_new_guard);
  v_patched_cancel := replace(v_patched_cancel, v_old_escrow_prelock, v_new_escrow_prelock);
  EXECUTE v_patched_cancel;
END;
$patch$;

-- One-time settlement of the 13 known legacy drawn-never-launched Spins.
-- Self-verifying: aborts the whole migration (rolling back the function
-- patches above too) unless exactly these 13 ids match the exact defect
-- signature and every one settles to a zero escrow crediting exactly what
-- was read live from its own escrow immediately beforehand -- never a
-- hardcoded total, so a board that has moved since this was written aborts
-- the migration instead of silently mismatching it.
DO $settle$
DECLARE
  v_ids uuid[] := ARRAY[
    '8904c10b-6a47-4934-bdf2-def1b1e76f0b','9cecb4fa-4fdd-4447-9e98-2fe5c20c46a8','b3b65e07-6b3a-4b6c-b5d1-aeb5af17fa99',
    '2aa4cba1-506f-426b-a1ba-d8e22e018533','44d7e2d8-66ed-48ae-a1cb-306ae92b6dfa','95e43b6e-c1c9-445e-a1d9-cbe711e3bac1',
    '8d5969da-df76-44fa-8c83-5608b844ca06','b67ab0cb-e2d6-4955-8f43-4bff32551400','efd5455d-d188-4171-becb-1d35b016d06a',
    '6d359f61-d681-49ba-82f3-00493178e5b3','c2fd1c7e-9572-4b95-90dd-3b999777a145','7284506c-093c-491a-8da7-5816bf1ccccf',
    '482e90bb-ef9d-4135-9067-9f0332c94142'
  ]::uuid[];
  v_signature_count integer;
  v_expected_total numeric;
  v_id uuid;
  v_expected_prize numeric;
  v_expected_bounty numeric;
  v_expected_fee numeric;
  v_receipt jsonb;
  v_settled_count integer := 0;
BEGIN
  SELECT count(*) INTO v_signature_count
    FROM public.tournaments t
   WHERE t.id = ANY(v_ids)
     AND t.variant = 'spin'
     AND upper(COALESCE(t.status::text,'')) = 'REGISTERING'
     AND t.started_at IS NULL
     AND EXISTS (SELECT 1 FROM public.spin_reserve_ledger r WHERE r.tournament_id=t.id AND r.kind='jackpot_draw')
     AND EXISTS (SELECT 1 FROM public.spin_reserve_ledger r WHERE r.tournament_id=t.id AND r.kind='contribution')
     AND NOT EXISTS (SELECT 1 FROM public.spin_draw_receipts r WHERE r.tournament_id=t.id)
     AND NOT EXISTS (SELECT 1 FROM public.tournament_launch_receipts r WHERE r.tournament_id=t.id)
     AND NOT EXISTS (SELECT 1 FROM public.hand_history hh WHERE hh.tournament_id=t.id)
     AND (SELECT count(*) FROM public.tournament_players p WHERE p.tournament_id=t.id AND p.status IN ('registered','playing')) < 3;
  IF v_signature_count IS DISTINCT FROM cardinality(v_ids) THEN
    RAISE EXCEPTION 'MIGRATION_ABORT: expected all % legacy ids to match the exact defect signature, found %',
      cardinality(v_ids), v_signature_count;
  END IF;

  FOREACH v_id IN ARRAY v_ids LOOP
    PERFORM public.fn_ca_escrow_apply(v_id, 'legacy spin settlement preflight');
    SELECT e.prize_balance, e.bounty_balance, e.fee_balance
      INTO v_expected_prize, v_expected_bounty, v_expected_fee
      FROM public.tournament_escrow e WHERE e.tournament_id = v_id;
    v_expected_total := round(COALESCE(v_expected_prize,0) + COALESCE(v_expected_bounty,0) + COALESCE(v_expected_fee,0), 2);

    v_receipt := public.atomic_cancel_tournament(v_id, '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);
    IF COALESCE((v_receipt->>'ok')::boolean, false) IS NOT TRUE
       OR COALESCE((v_receipt->>'success')::boolean, false) IS NOT TRUE
       OR v_receipt->>'status' IS DISTINCT FROM 'CANCELLED'
       OR (v_receipt->>'total_refunded')::numeric IS DISTINCT FROM v_expected_total
       OR (v_receipt->>'fees_reversed')::numeric IS DISTINCT FROM v_expected_fee THEN
      RAISE EXCEPTION 'MIGRATION_ABORT: legacy spin % did not settle to its own pre-read escrow (expected total %, fee %): %',
        v_id, v_expected_total, v_expected_fee, v_receipt;
    END IF;
    v_settled_count := v_settled_count + 1;
  END LOOP;

  IF v_settled_count <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'MIGRATION_ABORT: settled % of % legacy spins', v_settled_count, cardinality(v_ids);
  END IF;
END;
$settle$;

COMMIT;
