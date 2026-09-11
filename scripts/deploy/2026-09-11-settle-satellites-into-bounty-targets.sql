-- 2026-09-11-settle-satellites-into-bounty-targets.sql
--
-- RULING (CLAUDE.md 10.9). Applied by the orchestrator as ONE transaction,
-- after migration 20260911110907_a_satellite_never_feeds_a_target_its_finish_refuses
-- (so no new satellite can be opened into a PKO while this runs), outside the
-- :50-:03 break window, once. Run the preflight in
-- 2026-09-11-settle-satellites-into-bounty-targets.checks.sql immediately
-- before, and set c_expected_settle / c_expected_cancel / c_expected_in_play
-- below to the three numbers it returns. Any difference aborts with nothing
-- written.
--
-- WHAT HAPPENED. From 03:01 UTC on 2026-09-11 the heads-up satellite feeder
-- opened "Sunday Funday High Roller PKO Satellite Heads-Up" games into the two
-- Sunday Funday High Roller PKOs, e9541c66 (Midway Union, fade0000) and
-- 8171f9f6 (Deep Stack Society, 2a1132b9): 47.50 + 2.50 each, two seats, one
-- guaranteed seat worth the target's 67.50 + 7.50 = 75.00 entry, of which
-- 35.00 is the PKO bounty. Every one was played to a winner (600 chips, the
-- loser eliminated in place 2, pool 95.00 finalized, escrow 95.00 prize /
-- 5.00 fee) and then refused by fn_settle_satellite_tournament: "target uses
-- an unsupported bounty or Spin entry split". That refusal is correct: the
-- authority cannot book a seat's 35.00 bounty slice as bounty, and booking it
-- as prize is how the 2026-09-07 PKOs ended with 2310.00 and 5425.00 bounty
-- pools that held no money. The fault is the feeder, which never read the
-- bounty flags (fixed in this branch, engine and database).
--
-- THE FIVE CONDITIONS.
--   1. READ: each satellite's two roster rows, the felt (winner's seat is the
--      only live stack), escrow 100.00 in / 95.00 prize / 5.00 fee, 5.00 in
--      rake records, no payout, obligation, rake settlement, header, pool
--      transfer or wallet key yet. Both targets REGISTERING, starting
--      2026-09-14 03:00 UTC, one entrant each, escrow consistent. No winner
--      holds a target registration. All 28 entrants are horses (10.5: owed
--      exactly what a human is owed, and paid exactly as a human would be).
--   2. NOBODY PAID TWICE: every credit is fn_credit_and_log under the per-place
--      satellite keys the authority itself uses; the stored v2 receipt is then
--      what fn_settle_satellite_tournament returns to the engine's retry.
--   3. NOTHING TAKEN BACK: credits only; the optional seat purchase debits the
--      75.00 the same transaction credited, through the ordinary paid door.
--   4. PROVED ROLLED BACK: rehearsed on a local PostgreSQL 17 copy of the live
--      schema and these exact production rows: 13 settled, 13 seated, 2
--      cancelled, receipts verified by the unchanged reader and by the engine's
--      TypeScript verifier, engine replay and resolver adopt every receipt,
--      target refund plans agree with escrow, guard refuses a new PKO satellite.
--   5. THE PARAGRAPH: each decided satellite's winner is owed a seat in the
--      PKO, worth its full 75.00 entry. The satellite authority cannot deliver
--      a bounty seat, so the seat is paid at exact price (the authority's own
--      cash rule, receipt v2, cash_ticket_count 1) and, with c_deliver_seats,
--      immediately bought through fn_register_horse_for_tournament: 32.50 to
--      the PKO prize pool, 35.00 to its bounty rail with the head seeded at
--      35.00, 7.50 fee. The loser in place 2 is owed the pool remainder, 20.00.
--      5.00 rake settles to the club treasury (2a1132b9) or the union
--      (fade0000). Satellites that never started and hold no entrant are
--      cancelled through the atomic cancellation authority (nothing to refund).
--      At 11:22 UTC: 7f9d37d3 MUCKBANDIT/BigRachel, af821684 FISH/PHLBandit,
--      5a600bc0 DrDoc/Jen96, fd092efd squeeze777/xtrey, b1bf0a78 RobD/xrat,
--      372f3fdc slowninja/Rake710, 78d1b024 maniacc/grace1990, 165abcf0
--      ACEWHALE/Ingrid, 9db7f5e3 m.rossi83/FLOPGHOST, d279d771
--      LazyChamp/brad1978, b997c079 LAKenji/MERCHANT, 46d7e8bc
--      float420/xrungood, 9ce2e5a7 burrito/MamaVinny, cc8e105a
--      TheMachine/lake11 (winner/bubble); empty: aa7b7b59, b9af829c.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $ruling$
DECLARE
  -- ── Set these three from the preflight query, immediately before applying.
  c_expected_settle   constant integer := 14;  -- decided: 1 live + 1 eliminated
  c_expected_cancel   constant integer := 2;   -- never started, no entrant: cancelled
  c_expected_in_play  constant integer := 0;   -- still being played or filling: left alone, re-run later
  -- ── true: each winner is then entered in the PKO through the ordinary paid
  --    horse door, 75.00 = 32.50 prize + 35.00 funded bounty head + 7.50 fee.
  c_deliver_seats     constant boolean := true;
  c_pool      constant numeric := 95.00;
  c_rake      constant numeric := 5.00;
  c_buy_in    constant numeric := 67.50;
  c_fee       constant numeric := 7.50;
  c_bounty    constant numeric := 35.00;
  c_ticket    constant numeric := 75.00;
  c_remainder constant numeric := 20.00;
  c_note      constant text := 'atomic satellite terminal receipt: exact zero';
  c_ref       constant text := 'ruling 2026-09-11 satellites into bounty targets (fix/satellites-never-feed-a-bounty-target)';
  v_closeout_at timestamptz := transaction_timestamp();
  v_sat uuid; v_target uuid; v_win uuid; v_bub uuid;
  v_s record; v_t record; v_reg jsonb;
  v_esc public.tournament_escrow%ROWTYPE;
  v_winner public.tournament_players%ROWTYPE;
  v_bubble public.tournament_players%ROWTYPE;
  v_obl public.tournament_obligations%ROWTYPE;
  v_table_ids uuid[]; v_seat_ids uuid[]; v_released_ids uuid[];
  v_rows integer; v_n integer; v_paid numeric; v_key text; v_payout uuid;
  v_credited boolean; v_rake jsonb; v_receipt jsonb; v_cancel jsonb;
  v_w_before numeric; v_b_before numeric; v_w_after numeric; v_b_after numeric;
  v_settled uuid[] := ARRAY[]::uuid[]; v_winners uuid[] := ARRAY[]::uuid[]; v_targets uuid[] := ARRAY[]::uuid[];
  v_cancelled uuid[] := ARRAY[]::uuid[]; v_in_play integer := 0; v_seated integer := 0;
BEGIN
  PERFORM set_config('app.money_path', 'fn_settle_satellite_tournament', true);
  PERFORM public.fn_ca_lock_settlement_lane_global();

  -- Nothing else may be in flight: no satellite into a refused target may be
  -- mid-settlement or in a state this ruling does not name.
  IF EXISTS (
    SELECT 1 FROM public.tournaments s JOIN public.tournaments t
      ON t.id = COALESCE(s.satellite_target_id, s.satellite_target)
     WHERE (t.is_bounty IS DISTINCT FROM false OR t.is_pko IS DISTINCT FROM false
         OR t.is_mystery_bounty IS DISTINCT FROM false OR t.is_premium_spin IS DISTINCT FROM false
         OR lower(COALESCE(t.variant,'')) = 'spin' OR upper(COALESCE(t.tournament_type,'')) = 'SPIN')
       AND upper(COALESCE(s.status,'')) NOT IN ('RUNNING','REGISTERING','ANNOUNCED','COMPLETED','CANCELLED','CANCELED')) THEN
    RAISE EXCEPTION 'a satellite into a refused target is in an unexpected state; nothing written';
  END IF;

  ------------------------------------------------------------------ settle
  FOR v_sat, v_target IN
    SELECT s.id, t.id FROM public.tournaments s JOIN public.tournaments t
      ON t.id = COALESCE(s.satellite_target_id, s.satellite_target)
     WHERE (t.is_bounty IS DISTINCT FROM false OR t.is_pko IS DISTINCT FROM false
         OR t.is_mystery_bounty IS DISTINCT FROM false OR t.is_premium_spin IS DISTINCT FROM false
         OR lower(COALESCE(t.variant,'')) = 'spin' OR upper(COALESCE(t.tournament_type,'')) = 'SPIN')
       AND s.status = 'RUNNING'
       AND (SELECT count(*) FROM public.tournament_players tp WHERE tp.tournament_id = s.id) = 2
       AND (SELECT count(*) FROM public.tournament_players tp WHERE tp.tournament_id = s.id AND tp.status = 'playing') = 1
       AND (SELECT count(*) FROM public.tournament_players tp WHERE tp.tournament_id = s.id AND tp.status = 'eliminated') = 1
     ORDER BY s.id
  LOOP
    IF EXISTS (SELECT 1 FROM public.tournament_satellite_settlements h WHERE h.tournament_id = v_sat) THEN
      RAISE EXCEPTION 'satellite % already has a settlement header; nothing written', v_sat;
    END IF;
    PERFORM 1 FROM public.tournaments t WHERE t.id IN (v_sat, v_target)
     ORDER BY CASE WHEN t.id = v_target THEN 0 ELSE 1 END, t.id FOR UPDATE;
    SELECT t.* INTO v_s FROM public.tournaments t WHERE t.id = v_sat;
    SELECT t.* INTO v_t FROM public.tournaments t WHERE t.id = v_target;
    SELECT tp.user_id INTO v_win FROM public.tournament_players tp WHERE tp.tournament_id = v_sat AND tp.status = 'playing';
    SELECT tp.user_id INTO v_bub FROM public.tournament_players tp WHERE tp.tournament_id = v_sat AND tp.status = 'eliminated';

    IF v_s.status <> 'RUNNING' OR v_s.prize_pool_finalized IS NOT TRUE
       OR upper(COALESCE(v_s.tournament_type,'')) <> 'SATELLITE' OR lower(COALESCE(v_s.variant,'')) <> 'sng'
       OR v_s.satellite_target_id IS DISTINCT FROM v_target
       OR (v_s.satellite_target IS NOT NULL AND v_s.satellite_target IS DISTINCT FROM v_target)
       OR COALESCE(v_s.satellite_seats,0) <> 1 OR v_s.max_players <> 2
       OR v_s.prize_pool IS DISTINCT FROM c_pool OR v_s.total_rake IS DISTINCT FROM c_rake
       OR COALESCE(v_s.is_bounty,false) OR COALESCE(v_s.is_pko,false)
       OR COALESCE(v_s.is_mystery_bounty,false) OR COALESCE(v_s.is_premium_spin,false) THEN
      RAISE EXCEPTION 'satellite % is not a RUNNING 2-seat 95.00 heads-up satellite into %; nothing written', v_sat, v_target;
    END IF;
    IF v_t.buy_in_amount IS DISTINCT FROM c_buy_in OR v_t.buy_in_fee IS DISTINCT FROM c_fee
       OR v_t.bounty_amount IS DISTINCT FROM c_bounty
       OR v_t.is_bounty IS NOT TRUE OR v_t.is_pko IS NOT TRUE
       OR v_t.is_mystery_bounty IS NOT FALSE OR v_t.is_premium_spin IS NOT FALSE THEN
      RAISE EXCEPTION 'target % is not the 67.50 + 7.50 PKO with a 35.00 bounty; nothing written', v_target;
    END IF;
    IF EXISTS (SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id = v_target AND tp.user_id = v_win) THEN
      RAISE EXCEPTION 'winner % of % already holds a registration in %; nothing written', v_win, v_sat, v_target;
    END IF;

    PERFORM public.fn_ca_escrow_apply(v_sat, 'atomic satellite settlement source lock');
    SELECT * INTO v_esc FROM public.tournament_escrow x WHERE x.tournament_id = v_sat FOR UPDATE;
    IF v_esc.tournament_id IS NULL OR v_esc.enforced IS NOT TRUE
       OR v_esc.closed_at IS NOT NULL OR v_esc.close_note IS NOT NULL
       OR v_esc.gross_in <> 100.00 OR v_esc.fee_entries_in <> 5.00
       OR v_esc.satellite_fee_in <> 0 OR v_esc.bounty_in <> 0 OR v_esc.overlay_in <> 0
       OR v_esc.satellite_in <> 0 OR v_esc.prize_out <> 0 OR v_esc.bounty_out <> 0
       OR v_esc.fee_out <> 0 OR v_esc.refund_prize <> 0 OR v_esc.refund_bounty <> 0
       OR v_esc.refund_fee <> 0 OR v_esc.reserve_out <> 0 OR v_esc.reserve_in <> 0
       OR v_esc.prize_balance <> c_pool OR v_esc.bounty_balance <> 0 OR v_esc.fee_balance <> c_rake THEN
      RAISE EXCEPTION 'satellite % escrow is not exactly 100.00 in / 95.00 prize / 5.00 fee; nothing written', v_sat;
    END IF;
    IF (SELECT round(COALESCE(sum(r.rake_amount),0),2) FROM public.rake_records r
         WHERE r.tournament_id = v_sat AND r.is_tournament) <> c_rake THEN
      RAISE EXCEPTION 'satellite % rake records do not total 5.00; nothing written', v_sat;
    END IF;

    PERFORM 1 FROM public.tournament_players tp
     WHERE tp.tournament_id IN (v_sat, v_target) ORDER BY tp.tournament_id, tp.id FOR UPDATE;
    PERFORM 1 FROM public.tables tb WHERE tb.tournament_id = v_sat ORDER BY tb.id FOR UPDATE;
    PERFORM 1 FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
     WHERE tb.tournament_id = v_sat ORDER BY ts.table_id, ts.id FOR UPDATE OF ts;
    SELECT COALESCE(array_agg(tb.id ORDER BY tb.id), ARRAY[]::uuid[]) INTO v_table_ids
      FROM public.tables tb WHERE tb.tournament_id = v_sat;
    SELECT COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id), ARRAY[]::uuid[]),
           COALESCE(array_agg(ts.id ORDER BY ts.table_id, ts.id) FILTER (WHERE ts.left_at IS NULL), ARRAY[]::uuid[])
      INTO v_seat_ids, v_released_ids
      FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
     WHERE tb.tournament_id = v_sat;
    IF cardinality(v_table_ids) <> 1 OR cardinality(v_seat_ids) <> 2 OR cardinality(v_released_ids) <> 1
       OR NOT EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.id = v_released_ids[1]
                       AND ts.user_id = v_win AND ts.stack > 0) THEN
      RAISE EXCEPTION 'satellite % felt is not one table, two seats, the winner the only live stack; nothing written', v_sat;
    END IF;

    SELECT * INTO v_winner FROM public.tournament_players tp WHERE tp.tournament_id = v_sat AND tp.user_id = v_win;
    SELECT * INTO v_bubble FROM public.tournament_players tp WHERE tp.tournament_id = v_sat AND tp.user_id = v_bub;
    IF v_winner.position IS NOT NULL OR v_winner.elimination_sequence IS NOT NULL OR COALESCE(v_winner.prize,0) <> 0
       OR v_bubble.position IS DISTINCT FROM 2 OR v_bubble.elimination_sequence IS NULL
       OR COALESCE(v_bubble.prize,0) <> 0 THEN
      RAISE EXCEPTION 'satellite % standings are not winner live / bubble eliminated at 2; nothing written', v_sat;
    END IF;
    IF EXISTS (SELECT 1 FROM public.tournament_payouts p WHERE p.tournament_id = v_sat)
       OR EXISTS (SELECT 1 FROM public.tournament_obligations o WHERE o.tournament_id = v_sat)
       OR EXISTS (SELECT 1 FROM public.tournament_rake_settlements r WHERE r.tournament_id = v_sat)
       OR EXISTS (SELECT 1 FROM public.chip_ledger l WHERE l.from_entity_id = v_sat
                   AND l.idempotency_key LIKE 'tourney:' || v_sat::text || ':seat:%:pool_transfer')
       OR EXISTS (SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id = v_target AND tp.source_satellite_id = v_sat)
       OR EXISTS (SELECT 1 FROM public.wallet_credit_idempotency k WHERE k.key LIKE 'tourney:' || v_sat::text || ':%') THEN
      RAISE EXCEPTION 'satellite % has partial settlement evidence; nothing written', v_sat;
    END IF;
    SELECT m.chip_balance INTO v_w_before FROM public.club_members m WHERE m.user_id = v_win AND m.club_id = v_winner.club_id;
    SELECT m.chip_balance INTO v_b_before FROM public.club_members m WHERE m.user_id = v_bub AND m.club_id = v_bubble.club_id;
    IF v_w_before IS NULL OR v_b_before IS NULL THEN
      RAISE EXCEPTION 'satellite % entrant wallets are not at their stamped clubs; nothing written', v_sat;
    END IF;

    UPDATE public.tournament_players
       SET status = 'winner', position = 1, eliminated_at = NULL, elimination_sequence = NULL
     WHERE id = v_winner.id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'satellite % winner promotion changed % rows', v_sat, v_rows; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:' || v_win::text, 0));

    INSERT INTO public.tournament_satellite_settlements
      (tournament_id, target_id, target_was_missing, target_contract_version,
       winner_id, field_size, advertised_seats, pool, target_buy_in, target_fee, ticket_cost,
       ticket_award_count, seat_count, cash_ticket_count, entry_ticket_count,
       remainder, bubble_user_id, bubble_position,
       source_table_count, source_table_ids, source_seat_count, source_seat_ids,
       released_seat_count, released_seat_ids, source_closed_at,
       source_escrow_closed_at, source_escrow_close_note, settled_at)
    VALUES
      (v_sat, v_target, false, NULL, v_win, 2, 1, c_pool, c_buy_in, c_fee, c_ticket,
       1, 0, 1, 0, c_remainder, v_bub, 2,
       1, v_table_ids, 2, v_seat_ids, 1, v_released_ids, v_closeout_at,
       v_closeout_at, c_note, v_closeout_at);

    UPDATE public.tournaments SET status = 'COMPLETING', updated_at = now()
     WHERE id = v_sat AND status = 'RUNNING' AND prize_pool_finalized;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'satellite % COMPLETING claim changed % rows', v_sat, v_rows; END IF;

    -- Place 1: the funded 75.00 target entry at exact price.
    INSERT INTO public.tournament_obligations
      (tournament_id, kind, place, user_id, amount_owed, amount_paid, source, settled_at)
    VALUES (v_sat, 'seat', 1, v_win, c_ticket, 0, 'engine.fn_settle_satellite_tournament', NULL)
    RETURNING * INTO v_obl;
    v_key := 'tourney:' || v_sat::text || ':satellite_ticket:place:1';
    v_credited := public.fn_credit_and_log(
      p_user_id => v_win, p_amount => c_ticket, p_idempotency_key => v_key, p_category => 'prize',
      p_description => 'Satellite ticket paid at exact price: the satellite authority cannot deliver a seat into a bounty target (' || c_ref || ')',
      p_related_entity_id => v_sat, p_wallet_type => 'PLAYER', p_table_id => NULL, p_hand_id => NULL,
      p_payout_position => 1, p_payout_source => 'satellite_ticket');
    IF v_credited IS NOT TRUE THEN RAISE EXCEPTION 'satellite % ticket credit was not a new exact credit', v_sat; END IF;
    UPDATE public.tournament_obligations o SET amount_paid = c_ticket, settled_at = now(), updated_at = now()
     WHERE o.id = v_obl.id AND o.amount_owed = c_ticket AND o.amount_paid = 0;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'satellite % could not close its ticket debt', v_sat; END IF;
    SELECT p.id INTO v_payout FROM public.tournament_payouts p
     WHERE p.idempotency_key = v_key AND p.tournament_id = v_sat AND p.user_id = v_win
       AND p."position" = 1 AND p.amount = c_ticket AND p.source = 'satellite_ticket';
    IF v_payout IS NULL THEN RAISE EXCEPTION 'satellite % ticket has no payout row', v_sat; END IF;
    INSERT INTO public.tournament_satellite_awards
      (tournament_id, place, user_id, delivery_kind, amount, payout_id, payout_source,
       idempotency_key, obligation_id, obligation_kind)
    VALUES (v_sat, 1, v_win, 'cash', c_ticket, v_payout, 'satellite_ticket', v_key, v_obl.id, 'seat');

    -- Place 2: the 20.00 pool remainder to the single bubble.
    INSERT INTO public.tournament_obligations
      (tournament_id, kind, place, user_id, amount_owed, amount_paid, source, settled_at)
    VALUES (v_sat, 'satellite_remainder', 2, v_bub, c_remainder, 0, 'engine.fn_settle_satellite_tournament', NULL)
    RETURNING * INTO v_obl;
    v_key := 'tourney:' || v_sat::text || ':satellite_remainder:place:2';
    v_credited := public.fn_credit_and_log(
      p_user_id => v_bub, p_amount => c_remainder, p_idempotency_key => v_key, p_category => 'prize',
      p_description => 'Satellite pool remainder paid to the single bubble',
      p_related_entity_id => v_sat, p_wallet_type => 'PLAYER', p_table_id => NULL, p_hand_id => NULL,
      p_payout_position => 2, p_payout_source => 'satellite_remainder');
    IF v_credited IS NOT TRUE THEN RAISE EXCEPTION 'satellite % remainder credit was not a new exact credit', v_sat; END IF;
    UPDATE public.tournament_obligations SET amount_paid = c_remainder, settled_at = now(), updated_at = now()
     WHERE id = v_obl.id AND tournament_id = v_sat AND kind = 'satellite_remainder' AND place = 2
       AND user_id = v_bub AND amount_owed = c_remainder AND amount_paid = 0;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'satellite % could not close its remainder debt', v_sat; END IF;
    SELECT p.id INTO v_payout FROM public.tournament_payouts p
     WHERE p.tournament_id = v_sat AND p.user_id = v_bub AND p."position" = 2
       AND p.amount = c_remainder AND p.source = 'satellite_remainder' AND p.idempotency_key = v_key;
    IF v_payout IS NULL THEN RAISE EXCEPTION 'satellite % remainder has no payout row', v_sat; END IF;
    INSERT INTO public.tournament_satellite_remainders
      (tournament_id, user_id, place, amount, payout_id, payout_source, payout_position,
       idempotency_key, obligation_id, obligation_kind, obligation_place, evidence_kind)
    VALUES (v_sat, v_bub, 2, c_remainder, v_payout, 'satellite_remainder', 2, v_key,
            v_obl.id, 'satellite_remainder', 2, 'atomic');

    UPDATE public.tournament_players SET prize = 0 WHERE tournament_id = v_sat;
    UPDATE public.tournament_players SET prize = c_ticket WHERE tournament_id = v_sat AND position = 1;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'satellite % stamped % ticket caches', v_sat, v_rows; END IF;
    UPDATE public.tournament_players SET prize = c_remainder WHERE tournament_id = v_sat AND user_id = v_bub AND position = 2;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'satellite % could not stamp the bubble cache', v_sat; END IF;
    SELECT count(*), round(COALESCE(sum(p.amount),0),2) INTO v_n, v_paid
      FROM public.tournament_payouts p WHERE p.tournament_id = v_sat;
    IF v_n <> 2 OR v_paid IS DISTINCT FROM c_pool THEN
      RAISE EXCEPTION 'satellite % paid % across % rows, expected 95.00 across 2', v_sat, v_paid, v_n;
    END IF;

    v_rake := public.fn_settle_tournament_rake(v_sat, 'engine.fn_settle_satellite_tournament');
    IF COALESCE((v_rake->>'ok')::boolean,false) IS NOT TRUE
       OR round((v_rake->>'amount')::numeric,2) IS DISTINCT FROM c_rake
       OR COALESCE((v_rake->>'attributed')::boolean,false) IS NOT TRUE THEN
      RAISE EXCEPTION 'satellite % rake did not settle and attribute 5.00 exactly: %', v_sat, v_rake;
    END IF;

    SELECT * INTO v_esc FROM public.tournament_escrow x WHERE x.tournament_id = v_sat FOR UPDATE;
    IF v_esc.prize_balance <> 0 OR v_esc.bounty_balance <> 0 OR v_esc.fee_balance <> 0
       OR v_esc.prize_out <> c_pool OR v_esc.fee_out <> c_rake THEN
      RAISE EXCEPTION 'satellite % escrow after settlement is % / % / %', v_sat, v_esc.prize_balance, v_esc.bounty_balance, v_esc.fee_balance;
    END IF;
    UPDATE public.tournament_escrow SET closed_at = v_closeout_at, close_note = c_note, updated_at = now()
     WHERE tournament_id = v_sat AND closed_at IS NULL AND close_note IS NULL
       AND prize_balance = 0 AND bounty_balance = 0 AND fee_balance = 0;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'satellite % could not close its escrow at zero', v_sat; END IF;

    UPDATE public.table_seats ts
       SET left_at = v_closeout_at, status = 'left', leave_pending = false, is_sitting_out = false,
           is_away = false, sit_out_at = NULL, scheduled_leave_hands = NULL
     WHERE ts.id = ANY(v_released_ids) AND ts.left_at IS NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'satellite % released % seats, expected 1', v_sat, v_rows; END IF;
    UPDATE public.table_seats ts
       SET status = 'left', leave_pending = false, is_sitting_out = false, is_away = false,
           sit_out_at = NULL, scheduled_leave_hands = NULL
     WHERE ts.id = ANY(v_seat_ids) AND ts.left_at IS NOT NULL
       AND (ts.status IS DISTINCT FROM 'left' OR ts.leave_pending IS DISTINCT FROM false
         OR ts.is_sitting_out IS DISTINCT FROM false OR ts.is_away IS DISTINCT FROM false
         OR ts.sit_out_at IS NOT NULL OR ts.scheduled_leave_hands IS NOT NULL);

    UPDATE public.tournaments
       SET status = 'COMPLETED', ended_at = now(), prize_pool_finalized = true, current_players = 0,
           on_break = false, break_started_at = NULL, break_ends_at = NULL, updated_at = now()
     WHERE id = v_sat AND status = 'COMPLETING';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'satellite % could not commit COMPLETED', v_sat; END IF;
    UPDATE public.tables tb
       SET status = 'closed', lifecycle = 'closed', current_players = 0,
           terminal_closed_at = v_closeout_at, updated_at = now()
     WHERE tb.id = ANY(v_table_ids) AND tb.tournament_id = v_sat;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN RAISE EXCEPTION 'satellite % closed % tables, expected 1', v_sat, v_rows; END IF;

    -- The unchanged receipt reader is the postcondition the engine will replay.
    v_receipt := public.fn_ca_satellite_settlement_receipt(v_sat, v_win);
    IF COALESCE((v_receipt->>'ok')::boolean,false) IS NOT TRUE OR v_receipt->>'status' <> 'COMPLETED'
       OR (v_receipt->>'seat_count')::int <> 0 OR (v_receipt->>'cash_ticket_count')::int <> 1
       OR (v_receipt->>'entry_ticket_count')::int <> 0
       OR round((v_receipt->>'pool')::numeric,2) <> c_pool
       OR round((v_receipt->>'winner_amount')::numeric,2) <> c_ticket
       OR round((v_receipt->'remainder'->>'amount')::numeric,2) <> c_remainder
       OR (v_receipt->'remainder'->>'user_id')::uuid <> v_bub THEN
      RAISE EXCEPTION 'satellite % receipt is not the expected cash receipt: %', v_sat, v_receipt;
    END IF;
    SELECT m.chip_balance INTO v_w_after FROM public.club_members m WHERE m.user_id = v_win AND m.club_id = v_winner.club_id;
    SELECT m.chip_balance INTO v_b_after FROM public.club_members m WHERE m.user_id = v_bub AND m.club_id = v_bubble.club_id;
    IF round(v_w_after - v_w_before, 2) <> c_ticket OR round(v_b_after - v_b_before, 2) <> c_remainder THEN
      RAISE EXCEPTION 'satellite % wallet deltas are % / %, expected 75.00 / 20.00', v_sat,
        round(v_w_after - v_w_before, 2), round(v_b_after - v_b_before, 2);
    END IF;
    v_settled := v_settled || v_sat; v_winners := v_winners || v_win; v_targets := v_targets || v_target;
    RAISE NOTICE 'RULING settled % -> 75.00 to % (club %), 20.00 to % (club %), rake 5.00 %',
      v_sat, v_win, v_winner.club_id, v_bub, v_bubble.club_id, v_rake->>'destination';
  END LOOP;

  ------------------------------------------------------- the seat, optional
  IF c_deliver_seats THEN
    FOR v_n IN 1..cardinality(v_settled) LOOP
      IF NOT COALESCE((SELECT p.is_horse FROM public.profiles p WHERE p.id = v_winners[v_n]), false) THEN
        RAISE NOTICE 'RULING % winner % is not a horse: keeps 75.00 and registers through the ordinary door', v_settled[v_n], v_winners[v_n];
        CONTINUE;
      END IF;
      v_reg := public.fn_register_horse_for_tournament(v_targets[v_n], v_winners[v_n]);
      IF COALESCE((v_reg->>'ok')::boolean,false) IS NOT TRUE
         OR round((v_reg->>'cost')::numeric,2) <> c_ticket
         OR round((v_reg->>'prize_contribution')::numeric,2) <> round(c_buy_in - c_bounty,2)
         OR round((v_reg->>'bounty_contribution')::numeric,2) <> c_bounty
         OR round((v_reg->>'rake')::numeric,2) <> c_fee THEN
        RAISE EXCEPTION 'seat for winner % of % was not the funded 32.50/35.00/7.50 entry: %', v_winners[v_n], v_settled[v_n], v_reg;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id = v_targets[v_n]
                      AND tp.user_id = v_winners[v_n] AND tp.status = 'registered' AND tp.current_bounty = c_bounty) THEN
        RAISE EXCEPTION 'winner % has no funded 35.00 bounty head in %', v_winners[v_n], v_targets[v_n];
      END IF;
      v_seated := v_seated + 1;
      RAISE NOTICE 'RULING seated % in % (registration %)', v_winners[v_n], v_targets[v_n], v_reg->>'registration_id';
    END LOOP;
  END IF;

  ------------------------------------------------ never started: cancel them
  FOR v_sat IN
    SELECT s.id FROM public.tournaments s JOIN public.tournaments t
      ON t.id = COALESCE(s.satellite_target_id, s.satellite_target)
     WHERE (t.is_bounty IS DISTINCT FROM false OR t.is_pko IS DISTINCT FROM false
         OR t.is_mystery_bounty IS DISTINCT FROM false OR t.is_premium_spin IS DISTINCT FROM false
         OR lower(COALESCE(t.variant,'')) = 'spin' OR upper(COALESCE(t.tournament_type,'')) = 'SPIN')
       AND upper(COALESCE(s.status,'')) IN ('REGISTERING','ANNOUNCED') AND s.started_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_id = s.id)
     ORDER BY s.id
  LOOP
    -- Exactly what fn_close_managed_game does for an empty managed tournament,
    -- without an operator session: the managed-lifecycle flag for this one
    -- call, the atomic cancellation authority, and its exact receipt.
    PERFORM set_config('app.managed_game_lifecycle', 'on', true);
    v_cancel := public.atomic_cancel_tournament(v_sat, NULL);
    PERFORM set_config('app.managed_game_lifecycle', '', true);
    IF v_cancel->>'ok' IS DISTINCT FROM 'true'
       OR v_cancel->>'fully_settled' IS DISTINCT FROM 'true'
       OR v_cancel->>'status' IS DISTINCT FROM 'CANCELLED'
       OR v_cancel->>'tournament_id' IS DISTINCT FROM v_sat::text
       OR (v_cancel->>'source_player_count')::integer IS DISTINCT FROM 0
       OR (SELECT status FROM public.tournaments WHERE id = v_sat) IS DISTINCT FROM 'CANCELLED' THEN
      RAISE EXCEPTION 'empty satellite % did not return its exact cancellation receipt: %', v_sat, v_cancel;
    END IF;
    v_cancelled := v_cancelled || v_sat;
    RAISE NOTICE 'RULING cancelled unstarted % : %', v_sat, v_cancel;
  END LOOP;

  SELECT count(*) INTO v_in_play FROM public.tournaments s JOIN public.tournaments t
    ON t.id = COALESCE(s.satellite_target_id, s.satellite_target)
   WHERE (t.is_bounty IS DISTINCT FROM false OR t.is_pko IS DISTINCT FROM false
       OR t.is_mystery_bounty IS DISTINCT FROM false OR t.is_premium_spin IS DISTINCT FROM false
       OR lower(COALESCE(t.variant,'')) = 'spin' OR upper(COALESCE(t.tournament_type,'')) = 'SPIN')
     AND upper(COALESCE(s.status,'')) NOT IN ('COMPLETED','CANCELLED','CANCELED');

  IF cardinality(v_settled) <> c_expected_settle OR cardinality(v_cancelled) <> c_expected_cancel
     OR v_in_play <> c_expected_in_play
     OR (c_deliver_seats AND v_seated <> cardinality(v_settled)) THEN
    RAISE EXCEPTION 'board moved: settled % (expected %), cancelled % (expected %), still in play % (expected %), seated %; nothing written',
      cardinality(v_settled), c_expected_settle, cardinality(v_cancelled), c_expected_cancel,
      v_in_play, c_expected_in_play, v_seated;
  END IF;

  ------------------------------------------------------------------ record
  UPDATE public.ca_drift_incidents i
     SET status = 'resolved', resolved_at = now(),
         root_cause = 'The heads-up satellite feeder (TournamentRecurringService.pickSatelliteTargets) chose the dearest open events without reading their bounty flags, so it opened satellites into the Sunday Funday High Roller PKOs (e9541c66, 8171f9f6). The one satellite settlement authority refuses a bounty target by design (a seat must not book its 35.00 bounty slice as prize), so every finished feeder was refused at settlement.',
         correction_ref = c_ref,
         resolution = 'Settled by ruling: each winner paid the exact 75.00 target entry (32.50 prize + 35.00 bounty + 7.50 fee) through fn_credit_and_log with a verified v2 cash receipt, the bubble paid the 20.00 remainder, 5.00 rake settled and attributed, escrow closed at zero'
           || CASE WHEN c_deliver_seats THEN '; each horse winner then entered the PKO through fn_register_horse_for_tournament with a funded 35.00 bounty head.' ELSE '.' END
           || ' Creation is now refused for any target the authority refuses (migration 20260911110907).'
   WHERE i.status = 'open'
     AND i.source = 'financial_alerts:Tournament.atomic_satellite_finish_refused'
     AND (i.tournament_id = ANY(v_settled) OR i.tournament_id = ANY(v_cancelled));
  UPDATE public.financial_alerts a
     SET resolved = true, resolved_at = now(),
         resolution = 'Settled by ' || c_ref || ': 75.00 exact target entry to the winner, 20.00 remainder to the bubble, 5.00 rake; receipt v2 verified.'
   WHERE a.resolved IS NOT TRUE
     AND a.source = 'Tournament.atomic_satellite_finish_refused'
     AND a.context->>'tournament_id' IN (SELECT unnest(v_settled || v_cancelled)::text);
  RAISE NOTICE 'RULING done: settled %, seated %, cancelled %, still in play %', cardinality(v_settled), v_seated, cardinality(v_cancelled), v_in_play;
END
$ruling$;

COMMIT;
