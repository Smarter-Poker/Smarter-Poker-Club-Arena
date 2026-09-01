-- Four tournaments settled and paid without dealing a hand. Dan's ruling,
-- 2026-09-01: treat them as never having happened - refund every entrant,
-- reverse the two payouts.
--
--   Friday Six-Card Nightcap        2026-08-29  24 entrants  216.00 paid
--   Sunday Deep Stack Satellite $5  2026-08-28  24 entrants  108.00 paid
--   $100 Freeroll 6:00 PM           2026-08-30 313 entrants    0.00 paid
--   $100 Freeroll 12:00 PM          2026-08-30 326 entrants    0.00 paid
--
-- Each ended 58 to 216 seconds after it started with hand_history empty. The
-- cause was the retired legacy engine in the World Hub process claiming live
-- tournament tables and closing them as 'stale and empty' - empty being true
-- only of its own in-memory Table object - which released the seats and left
-- the deal loop in idle_not_enough_players. Migration 20260830180715 stopped
-- the unseating; these four are everything the detector can see inside the
-- six days hand history is retained for, and there has been none since
-- 2026-08-30 23:01 UTC.
--
-- WHAT MOVES, and where it comes from. Nothing is minted:
--
--   prize clawback   player_wallet -> prize_liability     324.00  (14 rows)
--   fee reversal     union_wallet  -> prize_liability      36.00  (2 rows)
--   refunds          prize_liability -> player_wallet     360.00  (48 rows)
--
-- 324 + 36 = 360. prize_liability nets to exactly zero and every leg names a
-- real counterparty, so none of this lands in settlement_suspense.
--
-- All 48 entrants are horses. They are refunded identically to a human, per
-- CLAUDE.md 10.5 - no is_horse branch appears anywhere below.
--
-- Every entrant's wallet is resolved by fn_credit_and_log exactly as
-- atomic_cancel_tournament resolves it, and every clawback debits the same
-- club the prize was credited to (tournament_players.club_id, confirmed
-- against the chip_ledger rows written at payout time). All 48 have a live
-- wallet in that club; the smallest balance behind a clawback is 24,543.32
-- against a 32.40 debit.
--
-- Idempotent: fn_credit_and_log refuses a repeated key, so a second run of
-- this migration aborts on the first refund rather than paying twice, and
-- fn_union_debit_wallet is claimed under op_id zerohand:<tid>:rake.
--
-- Probed first inside a DO block ending in RAISE EXCEPTION, per CLAUDE.md
-- 11.5: it reported 48/360.00, 14/324.00, 36.00 and rolled every chip back.

DO $unwind$
DECLARE
  v_union uuid := 'fade0000-0000-0000-0000-000000000001';
  v_paid  uuid[] := ARRAY['03caef9e-6138-4d31-bd7a-9af291377898','b9803055-4a7c-45d7-9efb-786e14bbcbf2']::uuid[];
  v_free  uuid[] := ARRAY['9be94e4f-7331-4407-8a61-c114879ec585','5b1ecc7a-408e-4cfa-9210-c25b15490887']::uuid[];
  r record; v_ok boolean; v_res jsonb;
  v_ref_n int := 0;  v_ref_total numeric := 0;
  v_claw_n int := 0; v_claw_total numeric := 0;
  v_rake numeric := 0; v_left int;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- 1. The prizes go back to the pool they came from.
  FOR r IN
    SELECT tp.tournament_id, tp.user_id, tp.club_id, round(sum(w.amount),2) AS prize
      FROM wallet_transactions w
      JOIN tournament_players tp ON tp.tournament_id = w.related_entity_id AND tp.user_id = w.user_id
     WHERE w.related_entity_id = ANY(v_paid) AND w.type='credit' AND w.category='prize'
     GROUP BY 1,2,3
  LOOP
    PERFORM public.fn_ca_declare_ledger('reversal','prize_liability');
    v_res := public.fn_debit_chips(r.club_id, r.user_id, r.prize,
              'Zero-hand tournament unwound: prize returned to the pool',
              jsonb_build_object('transaction_type','tournament_prize_reversal','tournament_id', r.tournament_id));
    IF COALESCE(v_res->>'success','') <> 'true' THEN
      RAISE EXCEPTION 'clawback failed for % in %: %', r.user_id, r.club_id, v_res::text;
    END IF;
    PERFORM public.log_wallet_transaction(r.user_id, 'PLAYER', r.prize, 'debit', 'prize_reversal',
      'Tournament cancelled after settling with no hand dealt: prize returned',
      NULL, NULL, r.tournament_id);
    v_claw_n := v_claw_n + 1; v_claw_total := v_claw_total + r.prize;
  END LOOP;

  -- 2. The entry fees come back out of the union rake wallet.
  FOR r IN SELECT tournament_id, amount FROM tournament_rake_settlements WHERE tournament_id = ANY(v_paid)
  LOOP
    PERFORM public.fn_ca_declare_ledger('reversal','prize_liability');
    v_res := public.fn_union_debit_wallet(v_union, 'rake_wallet', r.amount, 'tournament_fee_refund',
               NULL, NULL, 'Zero-hand tournament unwound: entry fees returned to entrants', NULL,
               'zerohand:' || r.tournament_id || ':rake');
    IF COALESCE(v_res->>'success','') <> 'true' THEN
      RAISE EXCEPTION 'rake reversal failed for %: %', r.tournament_id, v_res::text;
    END IF;
    INSERT INTO rake_records (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
                              bbj_contribution, is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, v_union, -r.amount, r.amount, 1, 0, true, r.tournament_id,
            'zero_hand_unwind', jsonb_build_object('kind','tournament_fee_refund'));
    v_rake := v_rake + r.amount;
  END LOOP;

  -- 3. Every entrant gets back exactly what they paid.
  FOR r IN
    SELECT tp.id AS tp_id, tp.tournament_id, tp.user_id, t.name,
           round(COALESCE(sum(CASE WHEN w.type='debit'  AND w.category IN ('tournament_buyin','rebuy','addon') THEN w.amount
                                   WHEN w.type='credit' AND w.category='refund' THEN -w.amount ELSE 0 END),0),2) AS net
      FROM tournament_players tp
      JOIN tournaments t ON t.id = tp.tournament_id
      LEFT JOIN wallet_transactions w ON w.related_entity_id = tp.tournament_id AND w.user_id = tp.user_id
     WHERE tp.tournament_id = ANY(v_paid)
     GROUP BY 1,2,3,4
    HAVING round(COALESCE(sum(CASE WHEN w.type='debit'  AND w.category IN ('tournament_buyin','rebuy','addon') THEN w.amount
                                   WHEN w.type='credit' AND w.category='refund' THEN -w.amount ELSE 0 END),0),2) > 0
  LOOP
    PERFORM public.fn_ca_declare_ledger('refund','prize_liability');
    v_ok := public.fn_credit_and_log(r.user_id, r.net,
              'tourney:' || r.tournament_id || ':zerohandrefund:' || r.tp_id, 'refund',
              'Tournament cancelled after settling with no hand dealt: buy-in refunded - ' || COALESCE(r.name,''),
              r.tournament_id);
    IF NOT COALESCE(v_ok,false) THEN RAISE EXCEPTION 'refund already claimed for tp % - this migration has run before', r.tp_id; END IF;
    v_ref_n := v_ref_n + 1; v_ref_total := v_ref_total + r.net;
  END LOOP;

  -- 4. Cancel all four. trg_tournaments_cancel_must_refund re-checks, on its
  --    own terms, that no entrant is left holding an unrefunded buy-in.
  UPDATE tournaments SET status='CANCELLED', prize_pool=0, total_rake=0, updated_at=now()
   WHERE id = ANY(v_paid || v_free);

  -- 5. Prove it, on the amounts this migration moved rather than on a global
  --    sum: the floor is live and other tables move chips while this runs.
  IF v_ref_total <> 360.00 OR v_claw_total <> 324.00 OR v_rake <> 36.00 THEN
    RAISE EXCEPTION 'unwind does not match the measured event: refunds % / clawbacks % / rake %',
      v_ref_total, v_claw_total, v_rake;
  END IF;
  IF round(v_ref_total - v_claw_total - v_rake, 2) <> 0 THEN
    RAISE EXCEPTION 'unwind does not balance: % out, % + % back', v_ref_total, v_claw_total, v_rake;
  END IF;
  IF v_ref_n <> 48 OR v_claw_n <> 14 THEN
    RAISE EXCEPTION 'expected 48 refunds and 14 clawbacks, got % and %', v_ref_n, v_claw_n;
  END IF;

  SELECT count(*) INTO v_left FROM tournaments
   WHERE id = ANY(v_paid || v_free) AND status <> 'CANCELLED';
  IF v_left > 0 THEN
    RAISE EXCEPTION '% of the four are still not CANCELLED', v_left;
  END IF;

  -- 6. Close the four incidents. No correction row is posted: the movements
  --    above are real ledger entries, and fn_ca_post_correction would add a
  --    second, phantom one on top of them.
  FOR r IN SELECT id, tournament_id FROM ca_drift_incidents
            WHERE status <> 'resolved' AND source = 'financial_alerts:fn_detect_results_without_a_hand'
  LOOP
    PERFORM public.fn_ca_incident_action(r.id, 'resolve',
      'Unwound per Dan''s ruling of 2026-09-01: refund the buy-ins, reverse the payouts.',
      NULL,
      'The event settled and ranked its field without a hand being dealt, because the retired legacy engine claimed its tables and closed them as stale and empty, releasing the seats. Migration 20260830180715 stopped the unseating and there has been no recurrence since 2026-08-30 23:01 UTC. Unwound in migration unwind_the_four_zero_hand_tournaments: 48 entrants refunded 360.00 in total, 14 prize payments totalling 324.00 clawed back to the pool, and 36.00 of entry fees taken back out of the Midway union rake wallet. 324 + 36 = 360, prize_liability nets to zero, nothing was minted and no chip was created or destroyed. All four are now CANCELLED, which trg_tournaments_cancel_must_refund independently verified by refusing to accept the status until every entrant was whole.',
      'migration unwind_the_four_zero_hand_tournaments');
  END LOOP;

  RAISE NOTICE 'unwound: % refunds / %, % clawbacks / %, rake %', v_ref_n, v_ref_total, v_claw_n, v_claw_total, v_rake;
END $unwind$;
