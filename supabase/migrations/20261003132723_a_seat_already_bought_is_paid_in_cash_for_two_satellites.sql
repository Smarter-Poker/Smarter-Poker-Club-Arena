-- 20261003132723_a_seat_already_bought_is_paid_in_cash_for_two_satellites.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A SEAT ALREADY BOUGHT IS PAID IN CASH, FOR TWO SATELLITES (phase 6 of 9:
-- money edges, 2026-10-03). Full account:
-- docs/changelog/2026-10-03-a-seat-already-bought-is-paid-in-cash-for-two-satellites.md.
--
-- WHAT IS OWED, READ FROM ROWS (production, 2026-10-03)
--   WASP (a497dbb8-a32c-4bb9-9ffa-beeea1d8c5d8) bought a seat in Friday Night
--   Feature cfcf5abc (27.00 + 3.00) with 30.00 of their own SHARK CLUB chips
--   on 2026-09-03 18:49:26 (journal leg player_wallet -> prize_liability,
--   tournament_buyin, 30.00). The same evening they won two heads-up
--   Friday Night Feature satellites (19.00 + 1.00, one seat of 30.00 each):
--     0d29dd54-e25b-46e5-bc6e-3a51162c67e4  ended 22:30:18, runner-up 0097309f
--     781c8905-6882-4e1a-bb6c-1cd428cf89b2  ended 22:40:24, runner-up ...0045
--   Each satellite took 40.00 in, paid its runner-up the 8.00 remainder and
--   the union its 2.00 fee. The 30.00 seat value had nowhere to go: WASP
--   already held the target seat, and the seat they held carried no satellite
--   origin, so the award called the origin unknown, paid nothing and filed
--   Satellite.seat_origin_unknown "needs a human" (alerts 20abe32c, 2e2ecd9d).
--   FeeReconciler then filed satellite_conservation twice (25399c02, 71b057a7)
--   for exactly these two events: pool 38, seats 0/1, cash 8, one unpaid
--   winner. tournament_payouts carries a 30.00 satellite_seat row for WASP on
--   each, written 2026-09-04 19:22 with no seat and no credit behind it. The
--   30.00 is still in each satellite's prize_liability: 40 - 8 - 2 = 30.
--
--   This is the railbirdd case of 2026-09-05 (20260905195011) on two older
--   events: a winner who BOUGHT the target seat is paid the seat in cash.
--   That migration fixed the award (a bought seat is not "held from this
--   satellite"; the engine pays the cash itself), so this does not recur.
--   It could not reach these two: both satellites are terminal.
--
-- THE DOOR. Both satellites are COMPLETED and receipted, so nothing may name
-- them: no obligation, no tourney: key, no wallet row or journal leg with
-- their tournament id (terminal_tournament_evidence_is_immutable and its
-- siblings). The chips are paid from where they sit, by the platform's own
-- idempotent credit, per satellite:
--   1. fn_ca_adjustment_under_10_9 writes the approved ca_manual_adjustments
--      row carrying the paragraph;
--   2. fn_ca_declare_ledger names the counterparty: prize_liability of THAT
--      satellite, so the club_members journal writes ONE leg
--      prize_liability(satellite) -> player_wallet(WASP), club SHARK CLUB,
--      the club the 20.00 buy-in came from;
--   3. fn_credit_and_log credits WASP under the key
--      satellite-seat-cash:<satellite>:<WASP>, so a replay pays nothing;
--   4. the adjustment is settled; the four alerts close carrying the receipts.
-- The tournaments, their payouts and their evidence are not touched. Nobody
-- else is affected: both runners-up were paid their 8.00, the union its fee.
--
-- WHO PAYS. Nobody new: the 60.00 has sat in the two satellites' own
-- prize_liability since 2026-09-03. Afterwards each reads 0.00.
--
-- No is_horse condition anywhere. Nothing is taken back from anyone.
-- PROOF: every pre-image is asserted (the four alerts open, the bought seat,
-- each satellite still 40 in, 8 + 2 out, no credit under the key), and the
-- post-image proves WASP's SHARK CLUB wallet moved +60.00, each satellite's
-- prize_liability reads 0.00, and exactly one leg of 30.00 per satellite.
-- @live-proof: (SELECT count(*) FROM public.financial_alerts WHERE context->'settlement'->>'migration' = '20261003132723_a_seat_already_bought_is_paid_in_cash_for_two_satellites') = 4

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $mig$
DECLARE
  c_mig     CONSTANT text := '20261003132723_a_seat_already_bought_is_paid_in_cash_for_two_satellites';
  c_wasp    CONSTANT uuid := 'a497dbb8-a32c-4bb9-9ffa-beeea1d8c5d8';
  c_target  CONSTANT uuid := 'cfcf5abc-5cd0-41a2-8c34-882896b939c0';
  c_shark   CONSTANT uuid := 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
  c_actor   CONSTANT uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
  c_sats    CONSTANT uuid[] := ARRAY['0d29dd54-e25b-46e5-bc6e-3a51162c67e4',
                                     '781c8905-6882-4e1a-bb6c-1cd428cf89b2']::uuid[];
  c_alerts  CONSTANT uuid[] := ARRAY['20abe32c-0c7c-479d-8783-7833d8743857',
                                     '2e2ecd9d-edb1-40f2-a328-b4078426c04a',
                                     '25399c02-7987-4840-a712-5c8b5ff624dd',
                                     '71b057a7-b0ff-43e7-8f9c-85564b3f8dc6']::uuid[];
  c_seat    CONSTANT numeric := 30.00;
  v_probe   boolean := COALESCE(current_setting('ca.seat_cash_probe', true), '') = 'on';
  v_sat uuid; v_key text; v_desc text; v_reason text;
  v_adj uuid; v_ok boolean; v_leg uuid; v_wtx uuid;
  v_in numeric; v_out numeric;
  v_bal_before numeric; v_bal_mid numeric; v_bal_after numeric;
  v_receipts jsonb := '[]'::jsonb;
  v_n int;
BEGIN
  ---------------------------------------------------------------------------
  -- 0. PRE-IMAGE.
  ---------------------------------------------------------------------------
  IF (SELECT count(*) FROM public.chip_ledger l
       WHERE l.tournament_id = c_target AND l.from_type = 'player_wallet'
         AND l.from_entity_id = c_wasp AND l.to_type = 'prize_liability'
         AND l.category = 'tournament_buyin' AND l.amount = 30.00
         AND l.club_id = c_shark AND l.created_at < '2026-09-03 22:00:00+00') <> 1 THEN
    RAISE EXCEPTION 'seat cash pre-image: WASP no longer reads as having bought the cfcf5abc seat with 30.00 of SHARK CLUB chips before the satellites';
  END IF;

  IF (SELECT count(*) FROM public.financial_alerts
       WHERE id = ANY (c_alerts) AND resolved IS NOT TRUE) <> 4 THEN
    RAISE EXCEPTION 'seat cash pre-image: the four alerts are no longer all open - refusing to pay twice';
  END IF;

  FOREACH v_sat IN ARRAY c_sats LOOP
    IF NOT EXISTS (SELECT 1 FROM public.tournaments t
                    WHERE t.id = v_sat AND upper(t.status::text) = 'COMPLETED'
                      AND t.tournament_type::text = 'SATELLITE'
                      AND t.buy_in_amount = 19.00 AND t.buy_in_fee = 1.00) THEN
      RAISE EXCEPTION 'seat cash pre-image: % is no longer a COMPLETED 19.00 + 1.00 satellite', v_sat;
    END IF;
    IF (SELECT count(*) FROM public.tournament_players tp WHERE tp.tournament_id = v_sat) <> 2
       OR NOT EXISTS (SELECT 1 FROM public.tournament_players tp
                       WHERE tp.tournament_id = v_sat AND tp.user_id = c_wasp AND tp.position = 1
                         AND tp.club_id = c_shark) THEN
      RAISE EXCEPTION 'seat cash pre-image: WASP is no longer the SHARK CLUB winner of the two-player satellite %', v_sat;
    END IF;
    SELECT COALESCE(sum(l.amount) FILTER (WHERE l.to_type = 'prize_liability' AND l.to_entity_id = v_sat), 0),
           COALESCE(sum(l.amount) FILTER (WHERE l.from_type = 'prize_liability' AND l.from_entity_id = v_sat), 0)
      INTO v_in, v_out
      FROM public.chip_ledger l
     WHERE (l.to_type = 'prize_liability' AND l.to_entity_id = v_sat)
        OR (l.from_type = 'prize_liability' AND l.from_entity_id = v_sat);
    IF v_in <> 40.00 OR v_out <> 10.00 THEN
      RAISE EXCEPTION 'seat cash pre-image: % prize_liability reads in % out %, not 40.00 and 10.00', v_sat, v_in, v_out;
    END IF;
    IF EXISTS (SELECT 1 FROM public.wallet_transactions w
                WHERE w.related_entity_id = v_sat AND w.user_id = c_wasp AND w.type = 'credit') THEN
      RAISE EXCEPTION 'seat cash pre-image: WASP already holds a credit from %', v_sat;
    END IF;
    v_key := 'satellite-seat-cash:' || v_sat::text || ':' || c_wasp::text;
    IF EXISTS (SELECT 1 FROM public.wallet_credit_idempotency k WHERE k.key = v_key)
       OR EXISTS (SELECT 1 FROM public.ca_manual_adjustments a
                   WHERE a.tournament_id = v_sat AND a.target_id = c_wasp) THEN
      RAISE EXCEPTION 'seat cash pre-image: WASP was already paid for %', v_sat;
    END IF;
  END LOOP;

  IF public.fn_player_home_club(c_wasp, NULL) IS DISTINCT FROM c_shark THEN
    RAISE EXCEPTION 'seat cash pre-image: WASP no longer resolves to SHARK CLUB; the credit would land in another club than the buy-ins came from';
  END IF;
  SELECT chip_balance INTO v_bal_before FROM public.club_members
   WHERE user_id = c_wasp AND club_id = c_shark FOR NO KEY UPDATE;
  IF v_bal_before IS NULL THEN
    RAISE EXCEPTION 'seat cash pre-image: WASP holds no SHARK CLUB wallet';
  END IF;

  ---------------------------------------------------------------------------
  -- 1. PER SATELLITE: ONE CREDIT, ONE LEG, FROM ITS OWN PRIZE LIABILITY.
  ---------------------------------------------------------------------------
  FOREACH v_sat IN ARRAY c_sats LOOP
    v_key := 'satellite-seat-cash:' || v_sat::text || ':' || c_wasp::text;
    v_desc := 'Satellite seat paid in cash: Friday Night Feature Satellite Heads-Up ('
              || left(v_sat::text, 8) || '), target seat already bought';
    v_reason := format(
      'WASP (%s) won Friday Night Feature Satellite Heads-Up %s on 2026-09-03 (one 30.00 seat into Friday Night Feature cfcf5abc). '
      || 'WASP had already bought that seat with 30.00 of their own SHARK CLUB chips at 18:49, so the award called the seat origin unknown and paid nothing; '
      || 'the 30.00 stayed in the satellite''s prize_liability (40.00 in, 8.00 to the runner-up, 2.00 union fee). '
      || 'A winner who bought the target seat is paid the seat in cash (the railbirdd ruling, 20260905195011, which also fixed the award). '
      || 'Paid 30.00 from this satellite''s own prize_liability to WASP''s SHARK CLUB wallet; nobody else is affected and nothing is taken back. Migration %s carries this.',
      c_wasp, v_sat, c_mig);
    v_adj := public.fn_ca_adjustment_under_10_9(v_sat, c_wasp, c_seat, v_reason, c_mig,
               'claude-opus-5.5 under CLAUDE.md 10.9 (phase 6 money edges 2026-10-03)');

    SELECT chip_balance INTO v_bal_mid FROM public.club_members WHERE user_id = c_wasp AND club_id = c_shark;

    PERFORM public.fn_ca_declare_ledger('settlement', 'prize_liability', v_sat, NULL, v_key, NULL);
    PERFORM set_config('app.ledger_correlation', v_adj::text, true);
    v_ok := public.fn_credit_and_log(c_wasp, c_seat, v_key, 'settlement', v_desc, NULL);
    PERFORM set_config('app.ledger_counterparty', '', true);
    PERFORM set_config('app.ledger_counterparty_entity', '', true);
    PERFORM set_config('app.ledger_category', '', true);
    PERFORM set_config('app.ledger_idempotency_key', '', true);
    PERFORM set_config('app.ledger_correlation', '', true);
    IF v_ok IS NOT TRUE THEN
      RAISE EXCEPTION 'seat cash: the wallet door refused key %', v_key;
    END IF;

    SELECT chip_balance INTO v_bal_after FROM public.club_members WHERE user_id = c_wasp AND club_id = c_shark;
    IF round(v_bal_after - v_bal_mid, 2) <> c_seat THEN
      RAISE EXCEPTION 'seat cash: WASP''s SHARK CLUB wallet moved % for %, expected 30.00', v_bal_after - v_bal_mid, v_sat;
    END IF;

    SELECT l.id INTO v_leg FROM public.chip_ledger l
     WHERE l.created_at = now() AND l.from_type = 'prize_liability' AND l.from_entity_id = v_sat
       AND l.to_type = 'player_wallet' AND l.to_entity_id = c_wasp
       AND l.amount = c_seat AND l.club_id = c_shark AND l.tournament_id IS NULL
     ORDER BY l.id LIMIT 1;
    IF v_leg IS NULL THEN
      RAISE EXCEPTION 'seat cash: no journal leg prize_liability(%) -> player_wallet of 30.00', v_sat;
    END IF;
    SELECT w.id INTO v_wtx FROM public.wallet_transactions w
     WHERE w.created_at = now() AND w.user_id = c_wasp AND w.type = 'credit'
       AND w.category = 'settlement' AND w.amount = c_seat AND w.description = v_desc
     ORDER BY w.id LIMIT 1;
    IF v_wtx IS NULL THEN
      RAISE EXCEPTION 'seat cash: no wallet receipt for %', v_key;
    END IF;

    UPDATE public.ca_manual_adjustments SET status = 'settled' WHERE id = v_adj AND status = 'approved';
    IF NOT FOUND THEN RAISE EXCEPTION 'seat cash: adjustment % did not settle', v_adj; END IF;

    v_receipts := v_receipts || jsonb_build_object(
      'satellite_id', v_sat, 'amount', c_seat, 'adjustment_id', v_adj,
      'idempotency_key', v_key, 'ledger_id', v_leg, 'wallet_transaction_id', v_wtx);
  END LOOP;

  ---------------------------------------------------------------------------
  -- 2. THE FOUR ALERTS CLOSE, CARRYING THE RECEIPTS.
  ---------------------------------------------------------------------------
  UPDATE public.financial_alerts
     SET context = context || jsonb_build_object(
           'settlement', jsonb_build_object(
             'decision', 'bought_seat_paid_in_cash',
             'basis', 'a winner who bought the target seat is paid the seat in cash (20260905195011)',
             'recipient', c_wasp, 'club_id', c_shark, 'amount_total', 60.00,
             'funded_by', 'each satellite''s own prize_liability',
             'receipts', v_receipts, 'unattributed', 0,
             'migration', c_mig, 'paid_at', now())),
         resolved = true, resolved_at = now(), resolved_by = c_actor,
         resolution = format(
           'Paid. WASP (%s) had bought the Friday Night Feature cfcf5abc seat with 30.00 of own SHARK CLUB chips before winning satellites 0d29dd54 and 781c8905, so neither seat could be delivered and 30.00 stayed in each satellite''s prize_liability. '
           || 'Each 30.00 was paid in cash to WASP''s SHARK CLUB wallet from that satellite''s own prize_liability (keys satellite-seat-cash:<satellite>:<WASP>, adjustments settled); both satellites now conserve: 40.00 in, 30.00 seat cash, 8.00 runner-up, 2.00 fee. '
           || 'The award was fixed on 2026-09-05 (20260905195011): a bought seat is paid in cash by the engine. Migration %s.',
           c_wasp, c_mig)
   WHERE id = ANY (c_alerts) AND resolved IS NOT TRUE;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 4 THEN RAISE EXCEPTION 'seat cash: expected to resolve 4 alerts, resolved %', v_n; END IF;

  ---------------------------------------------------------------------------
  -- 3. POST-IMAGE. Conserved to the cent.
  ---------------------------------------------------------------------------
  SELECT chip_balance INTO v_bal_after FROM public.club_members WHERE user_id = c_wasp AND club_id = c_shark;
  IF round(v_bal_after - v_bal_before, 2) <> 60.00 THEN
    RAISE EXCEPTION 'seat cash post-image: WASP''s wallet moved % (expected 60.00)', v_bal_after - v_bal_before;
  END IF;
  FOREACH v_sat IN ARRAY c_sats LOOP
    SELECT COALESCE(sum(l.amount) FILTER (WHERE l.to_type = 'prize_liability' AND l.to_entity_id = v_sat), 0)
         - COALESCE(sum(l.amount) FILTER (WHERE l.from_type = 'prize_liability' AND l.from_entity_id = v_sat), 0)
      INTO v_in
      FROM public.chip_ledger l
     WHERE (l.to_type = 'prize_liability' AND l.to_entity_id = v_sat)
        OR (l.from_type = 'prize_liability' AND l.from_entity_id = v_sat);
    IF v_in <> 0 THEN
      RAISE EXCEPTION 'seat cash post-image: % prize_liability still reads %', v_sat, v_in;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.chip_ledger l
       WHERE l.created_at = now() AND (l.from_entity_id = c_wasp OR l.to_entity_id = c_wasp)) <> 2 THEN
    RAISE EXCEPTION 'seat cash post-image: WASP carries other than exactly two journal legs in this transaction';
  END IF;

  RAISE NOTICE 'seat cash: paid 60.00 to WASP (%); receipts %', c_wasp, v_receipts;
  IF v_probe THEN
    RAISE EXCEPTION 'PROBE OK (rolled back): WASP % -> %; receipts %', v_bal_before, v_bal_after, v_receipts;
  END IF;
END
$mig$;

COMMIT;
