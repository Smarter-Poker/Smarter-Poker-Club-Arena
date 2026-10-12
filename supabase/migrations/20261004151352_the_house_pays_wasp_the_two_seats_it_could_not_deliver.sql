-- 20261004151352_the_house_pays_wasp_the_two_seats_it_could_not_deliver.sql
--
-- Version reserved by scripts/reserve-migration-version.sh against origin/main
-- and every sibling worktree, so it cannot collide with another agent's work.
--
-- THE HOUSE PAYS WASP THE TWO SEATS IT COULD NOT DELIVER (2026-10-04).
-- Replaces 20261003132723_a_seat_already_bought_is_paid_in_cash_for_two_satellites,
-- which is merged on main and REFUSED ITSELF on apply (run 37209895373):
--   ERROR 55000: completed satellite transfer journal is immutable
--   WHERE: PL/pgSQL function fn_satellite_transfer_ledger_is_immutable() line 74
-- Full account: docs/changelog/2026-10-04-the-house-pays-wasp-the-two-seats-it-could-not-deliver.md.
--
-- WHAT IS OWED, READ FROM ROWS (production, 2026-10-04)
--   WASP (a497dbb8-a32c-4bb9-9ffa-beeea1d8c5d8, a horse fleet player, paid
--   exactly as a human is under CLAUDE.md 10.5) bought a seat in Friday Night
--   Feature cfcf5abc (27.00 + 3.00) with 30.00 of their own SHARK CLUB chips on
--   2026-09-03 18:49:26 (chip_ledger 1d53e688, player_wallet -> prize_liability,
--   tournament_buyin, 30.00, club SHARK CLUB). The same evening they won two
--   heads-up Friday Night Feature satellites (19.00 + 1.00, one 30.00 seat each),
--   both hosted by Midway Union fade0000:
--     0d29dd54-e25b-46e5-bc6e-3a51162c67e4  ended 22:30:18, runner-up 0097309f
--     781c8905-6882-4e1a-bb6c-1cd428cf89b2  ended 22:40:24, runner-up ...0045
--   Each satellite took 40.00 into its prize_liability, paid its runner-up the
--   8.00 remainder and Midway Union its 2.00 fee (rake_records, club fade0000).
--   The 30.00 seat value had nowhere to go: WASP already held the target seat,
--   and that seat carried no satellite origin, so the award called the origin
--   unknown, paid nothing and filed Satellite.seat_origin_unknown "needs a
--   human" (alerts 20abe32c, 2e2ecd9d). FeeReconciler then filed
--   satellite_conservation twice (25399c02, 71b057a7) for exactly these two
--   events: pool 38, seats 0/1, cash 8, one unpaid winner. tournament_payouts
--   carries a 30.00 satellite_seat row for WASP on each, written 2026-09-04
--   19:22 by agent_reconciliation with no seat and no credit behind it. The
--   30.00 is still in each satellite's prize_liability: 40 - 8 - 2 = 30.
--
--   This is the railbirdd case of 2026-09-05 (20260905195011) on two older
--   events: a winner who BOUGHT the target seat is paid the seat in cash. That
--   migration fixed the award itself, so this does not recur; it could not reach
--   these two, because both were already terminal when it landed.
--
-- WHY THE MERGED MIGRATION CANNOT WORK, AND IS NOT MADE TO
--   It paid each 30.00 out of that satellite's own prize_liability, writing the
--   leg with tournament_id NULL so no terminal-evidence guard would see the
--   tournament. fn_satellite_transfer_ledger_is_immutable sees it anyway, and by
--   design: "the seat transfer journal is queried by source liability and key,
--   not only by chip_ledger.tournament_id". It resolves the source satellite
--   from four witnesses - chip_ledger.tournament_id, from_entity_id whenever
--   from_type is prize_liability, a tourney:<id>:seat:%:pool_transfer key, and
--   metadata.satellite_id - and refuses any INSERT whose source tournament is
--   COMPLETED or CANCELLED, or carries a committed terminal receipt. Naming a
--   completed satellite's prize_liability is therefore exactly as forbidden as
--   naming the satellite itself. Its one bypass,
--   fn_ca_legacy_fee_resolution_write_is_exact, admits only an exact legacy fee
--   custody resolution (union rake wallet or chip retirement) with its own
--   resolution row in this transaction, and is not this case.
--   Measured on production for both satellites: status COMPLETED,
--   fn_ca_has_committed_tournament_receipt false, so it is the plain status
--   check at line 74 that refuses. The guard is correct and is not touched,
--   weakened, stubbed, bypassed or compared against NULL here. It follows that
--   each satellite's prize_liability can never be debited again, so the merged
--   migration's post-image ("each satellite's prize_liability reads 0.00") is
--   unreachable by any honest path. It is not reached here either; see below.
--
-- THE DOOR, WHICH THE ESTATE HAS ALREADY BLESSED TWICE. The event's books are
-- sealed and correct as sealed, so this is the house paying a ruling OUTSIDE
-- them, the same parts as 20260926085132 (the mystery-bounty make-good, club
-- treasury) and 20261002082429 (the PKO unclaimed bounty, club treasury), with
-- the union-bank bank of 20260926131530 because Midway Union, not a club, is
-- the house that hosted these two satellites and took their 2.00 fee each:
--   1. fn_ca_adjustment_under_10_9 writes the approved ca_manual_adjustments
--      row carrying the paragraph;
--   2. fn_ca_declare_ledger names the bank (union_bank, Midway Union) and
--      stands the union_wallets autoledger down, so the club_members journal
--      writes ONE leg union_bank(Midway Union) -> player_wallet(WASP), club
--      SHARK CLUB, tournament_id NULL, naming no tournament anywhere;
--   3. the union bank is debited, refusing if it cannot cover the amount;
--   4. fn_credit_and_log credits WASP under the key
--      satellite-seat-cash:<satellite>:<WASP>, so a replay pays nothing;
--   5. the adjustment is settled; the four alerts close carrying the receipts.
-- No obligation, no payout row, no award row, no tourney: key, no wallet row
-- and no journal leg names either satellite. Their journals, payouts, escrow
-- (they have none) and evidence are untouched, which is what the guards protect.
--
-- WHO PAYS, AND WHAT STAYS. Midway Union pays 60.00 from its bank. Each
-- satellite keeps the 30.00 of collected pool it never disbursed, permanently:
-- that is a true and now explained fact about a sealed event, not a number to
-- tidy. Total chip supply is unchanged by this transaction (union bank -60.00,
-- player wallet +60.00). No tournament_conservation_baseline row is written:
-- its amount is ADDED by fn_tournament_conservation_delta, which reads 0.00 for
-- both satellites today, so a -30.00 acknowledgement would clear
-- fn_satellite_conservation_audit by breaking the delta, and
-- tests/the-two-conservation-checks-agree-on-a-seat.law.test.ts exists to stop
-- exactly that. fn_satellite_conservation_audit only reads satellites that
-- ended inside its window (FeeReconciler passes 24 hours); these ended on
-- 2026-09-03, which is why it has filed nothing since 2026-09-04 21:00 and why
-- closing these alerts leaves no net firing.
--
-- No is_horse condition anywhere. Nothing is taken back from anyone.
-- PROOF: every pre-image is asserted (the bought seat, the four alerts open,
-- each satellite still COMPLETED with 40.00 in and 10.00 out and its 2.00 union
-- fee, the guard armed, no prior credit or adjustment under either key, the bank
-- able to cover it), and the post-image proves WASP's SHARK CLUB wallet moved
-- +60.00, the union bank -60.00, exactly two legs union_bank -> player_wallet of
-- 30.00 each, and that this transaction wrote NO row naming either satellite.
-- Run it rolled back with SET LOCAL ca.seat_cash_probe = 'on'.
-- @live-proof: (SELECT count(*) FROM public.financial_alerts WHERE context->'house_settlement'->>'migration' = '20261004151352_the_house_pays_wasp_the_two_seats_it_could_not_deliver') = 4

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $mig$
DECLARE
  c_mig     CONSTANT text := '20261004151352_the_house_pays_wasp_the_two_seats_it_could_not_deliver';
  c_old     CONSTANT text := '20261003132723_a_seat_already_bought_is_paid_in_cash_for_two_satellites';
  c_wasp    CONSTANT uuid := 'a497dbb8-a32c-4bb9-9ffa-beeea1d8c5d8';
  c_target  CONSTANT uuid := 'cfcf5abc-5cd0-41a2-8c34-882896b939c0';
  c_shark   CONSTANT uuid := 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
  c_union   CONSTANT uuid := 'fade0000-0000-0000-0000-000000000001';
  c_actor   CONSTANT uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
  c_sats    CONSTANT uuid[] := ARRAY['0d29dd54-e25b-46e5-bc6e-3a51162c67e4',
                                     '781c8905-6882-4e1a-bb6c-1cd428cf89b2']::uuid[];
  c_alerts  CONSTANT uuid[] := ARRAY['20abe32c-0c7c-479d-8783-7833d8743857',
                                     '2e2ecd9d-edb1-40f2-a328-b4078426c04a',
                                     '25399c02-7987-4840-a712-5c8b5ff624dd',
                                     '71b057a7-b0ff-43e7-8f9c-85564b3f8dc6']::uuid[];
  c_seat    CONSTANT numeric := 30.00;
  c_total   CONSTANT numeric := 60.00;
  v_probe   boolean := COALESCE(current_setting('ca.seat_cash_probe', true), '') = 'on';
  v_sat uuid; v_key text; v_desc text; v_reason text;
  v_adj uuid; v_ok boolean; v_leg uuid; v_wtx uuid;
  v_in numeric; v_out numeric; v_fee numeric;
  v_bank_before numeric; v_bank_mid numeric; v_bank_after numeric;
  v_bal_before numeric; v_bal_mid numeric; v_bal_after numeric;
  v_leg_from text; v_leg_to text; v_leg_club uuid; v_leg_tid uuid; v_leg_amt numeric;
  v_receipts jsonb := '[]'::jsonb;
  v_n int; v_legs int; v_sum numeric;
BEGIN
  ---------------------------------------------------------------------------
  -- 0. PRE-IMAGE. Every figure below is read from a row, never assumed.
  ---------------------------------------------------------------------------
  -- 0a. The seat WASP bought with their own chips, before the satellites ran.
  IF (SELECT count(*) FROM public.chip_ledger l
       WHERE l.tournament_id = c_target AND l.from_type = 'player_wallet'
         AND l.from_entity_id = c_wasp AND l.to_type = 'prize_liability'
         AND l.category = 'tournament_buyin' AND l.amount = c_seat
         AND l.club_id = c_shark AND l.created_at < '2026-09-03 22:00:00+00') <> 1 THEN
    RAISE EXCEPTION 'seat cash pre-image: WASP no longer reads as having bought the cfcf5abc seat with 30.00 of SHARK CLUB chips before the satellites';
  END IF;

  -- 0b. The four alerts are all still open, so nobody has settled this already.
  IF (SELECT count(*) FROM public.financial_alerts
       WHERE id = ANY (c_alerts) AND resolved IS NOT TRUE) <> 4 THEN
    RAISE EXCEPTION 'seat cash pre-image: the four alerts are no longer all open - refusing to pay twice';
  END IF;

  -- 0c. THE GUARD THAT CHOOSES THIS DOOR IS ARMED. If it has been removed or
  -- disabled, the reasoning in this header no longer describes the database and
  -- a human should read the case again before any money moves.
  IF NOT EXISTS (
       SELECT 1 FROM pg_trigger tg
        WHERE tg.tgrelid = 'public.chip_ledger'::regclass
          AND tg.tgname = 'satellite_transfer_ledger_is_immutable'
          AND tg.tgfoid = 'public.fn_satellite_transfer_ledger_is_immutable'::regproc
          AND NOT tg.tgisinternal AND tg.tgenabled = 'O') THEN
    RAISE EXCEPTION 'seat cash pre-image: satellite_transfer_ledger_is_immutable is not armed on chip_ledger; this settlement was written because it is';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM pg_trigger tg
        WHERE tg.tgrelid = 'public.wallet_transactions'::regclass
          AND tg.tgname = 'terminal_wallet_transaction_is_immutable'
          AND NOT tg.tgisinternal AND tg.tgenabled = 'O') THEN
    RAISE EXCEPTION 'seat cash pre-image: terminal_wallet_transaction_is_immutable is not armed on wallet_transactions';
  END IF;

  -- 0d. Per satellite: the event, its field, its money, its fee, and that
  -- nothing has been paid or recorded for WASP out of it.
  FOREACH v_sat IN ARRAY c_sats LOOP
    IF NOT EXISTS (SELECT 1 FROM public.tournaments t
                    WHERE t.id = v_sat AND upper(t.status::text) = 'COMPLETED'
                      AND t.tournament_type::text = 'SATELLITE'
                      AND t.buy_in_amount = 19.00 AND t.buy_in_fee = 1.00
                      AND t.satellite_target_id = c_target
                      AND t.club_id = c_union) THEN
      RAISE EXCEPTION 'seat cash pre-image: % is no longer a COMPLETED 19.00 + 1.00 Midway Union satellite into cfcf5abc', v_sat;
    END IF;
    IF public.fn_ca_has_committed_tournament_receipt(v_sat) IS NOT FALSE THEN
      RAISE EXCEPTION 'seat cash pre-image: % now carries a committed terminal receipt; re-read the case before paying', v_sat;
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
    -- The fee this satellite paid the house that is about to pay for it.
    SELECT COALESCE(round(sum(r.rake_amount), 2), 0) INTO v_fee
      FROM public.rake_records r
     WHERE r.tournament_id = v_sat AND r.is_tournament AND r.club_id = c_union;
    IF v_fee <> 2.00 THEN
      RAISE EXCEPTION 'seat cash pre-image: % no longer reads 2.00 of fee taken by Midway Union, it reads %', v_sat, v_fee;
    END IF;
    IF EXISTS (SELECT 1 FROM public.wallet_transactions w
                WHERE w.related_entity_id = v_sat AND w.user_id = c_wasp AND w.type = 'credit') THEN
      RAISE EXCEPTION 'seat cash pre-image: WASP already holds a credit from %', v_sat;
    END IF;
    v_key := 'satellite-seat-cash:' || v_sat::text || ':' || c_wasp::text;
    IF EXISTS (SELECT 1 FROM public.wallet_credit_idempotency k WHERE k.key = v_key)
       OR EXISTS (SELECT 1 FROM public.chip_ledger l WHERE l.idempotency_key = v_key)
       OR EXISTS (SELECT 1 FROM public.ca_manual_adjustments a
                   WHERE a.tournament_id = v_sat AND a.target_id = c_wasp) THEN
      RAISE EXCEPTION 'seat cash pre-image: WASP was already paid for %', v_sat;
    END IF;
  END LOOP;

  -- 0e. The credit lands in the club the buy-ins came from, and the bank that
  -- pays can cover it.
  IF public.fn_player_home_club(c_wasp, NULL) IS DISTINCT FROM c_shark THEN
    RAISE EXCEPTION 'seat cash pre-image: WASP no longer resolves to SHARK CLUB; the credit would land in another club than the buy-ins came from';
  END IF;
  SELECT chip_balance INTO v_bal_before FROM public.club_members
   WHERE user_id = c_wasp AND club_id = c_shark FOR NO KEY UPDATE;
  IF v_bal_before IS NULL THEN
    RAISE EXCEPTION 'seat cash pre-image: WASP holds no SHARK CLUB wallet';
  END IF;
  SELECT chip_balance INTO v_bank_before FROM public.union_wallets
   WHERE union_id = c_union FOR UPDATE;
  IF v_bank_before IS NULL OR v_bank_before < c_total THEN
    RAISE EXCEPTION 'seat cash: the Midway Union bank holds % and cannot fund 60.00', v_bank_before;
  END IF;

  ---------------------------------------------------------------------------
  -- 1. PER SATELLITE: ONE ADJUSTMENT, ONE BANK DEBIT, ONE IDEMPOTENT CREDIT,
  --    ONE JOURNAL LEG, AND NOTHING THAT NAMES THE SEALED EVENT.
  ---------------------------------------------------------------------------
  FOREACH v_sat IN ARRAY c_sats LOOP
    v_key := 'satellite-seat-cash:' || v_sat::text || ':' || c_wasp::text;
    v_desc := 'Satellite seat paid in cash by the house: Friday Night Feature Satellite Heads-Up ('
              || left(v_sat::text, 8) || '), target seat already bought';
    v_reason := format(
      'WASP (%s) won Friday Night Feature Satellite Heads-Up %s on 2026-09-03, one 30.00 seat into Friday Night Feature cfcf5abc. '
      || 'WASP had already bought that seat with 30.00 of their own SHARK CLUB chips at 18:49, so the award called the seat origin unknown and paid nothing, '
      || 'and the 30.00 stayed in this satellite''s prize liability (40.00 in, 8.00 to the runner-up, 2.00 fee to Midway Union). '
      || 'A winner who bought the target seat is paid the seat in cash: the railbirdd ruling of 2026-09-05, 20260905195011, which also fixed the award so this does not recur. '
      || 'This satellite is COMPLETED and its own journal is sealed: fn_satellite_transfer_ledger_is_immutable refuses any leg naming its prize liability, '
      || 'and the terminal evidence guards refuse an obligation, a payout row, an award row or a wallet row naming it. '
      || 'So Midway Union, the house that hosted this satellite and took its 2.00 fee, pays the 30.00 from its bank into WASP''s SHARK CLUB wallet, the club the buy-ins came from. '
      || 'The satellite keeps the 30.00 of pool it never disbursed and its books stay sealed as they are. '
      || 'WASP is a horse fleet player and is paid exactly as a human is (CLAUDE.md 10.5). '
      || 'Nobody else is affected: the runner-up was paid their 8.00 and the union its fee, and nothing is taken back from anyone. Migration %s carries this.',
      c_wasp, v_sat, c_mig);
    v_adj := public.fn_ca_adjustment_under_10_9(v_sat, c_wasp, c_seat, v_reason, c_mig,
               'claude-opus-5 under CLAUDE.md 10.9 (the house pays the two undeliverable seats, 2026-10-04)');

    SELECT chip_balance INTO v_bal_mid FROM public.club_members WHERE user_id = c_wasp AND club_id = c_shark;

    PERFORM public.fn_ca_declare_ledger('settlement', 'union_bank', c_union, NULL, v_key, ARRAY['union_wallets']);
    PERFORM set_config('app.ledger_correlation', v_adj::text, true);
    UPDATE public.union_wallets SET chip_balance = chip_balance - c_seat, updated_at = now()
     WHERE union_id = c_union AND chip_balance >= c_seat
     RETURNING chip_balance INTO v_bank_mid;
    IF v_bank_mid IS NULL THEN
      RAISE EXCEPTION 'seat cash: the Midway Union bank could not fund 30.00 for %', v_sat;
    END IF;
    v_ok := public.fn_credit_and_log(c_wasp, c_seat, v_key, 'settlement', v_desc, NULL);
    PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);
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

    -- The one leg this credit wrote, found by its own key, then judged field by
    -- field so a refusal says what it actually got.
    SELECT count(*) INTO v_legs FROM public.chip_ledger l WHERE l.idempotency_key = v_key;
    IF v_legs <> 1 THEN
      RAISE EXCEPTION 'seat cash: key % carries % journal legs, expected exactly one', v_key, v_legs;
    END IF;
    SELECT l.id, l.from_type, l.to_type, l.club_id, l.tournament_id, l.amount
      INTO v_leg, v_leg_from, v_leg_to, v_leg_club, v_leg_tid, v_leg_amt
      FROM public.chip_ledger l WHERE l.idempotency_key = v_key;
    IF v_leg_from <> 'union_bank' OR v_leg_to <> 'player_wallet'
       OR v_leg_club IS DISTINCT FROM c_shark OR v_leg_tid IS NOT NULL
       OR round(v_leg_amt, 2) <> c_seat THEN
      RAISE EXCEPTION 'seat cash: leg % reads % -> %, club %, tournament %, amount %; expected union_bank -> player_wallet, SHARK CLUB, no tournament, 30.00',
        v_leg, v_leg_from, v_leg_to, v_leg_club, v_leg_tid, v_leg_amt;
    END IF;
    SELECT w.id INTO v_wtx FROM public.wallet_transactions w
     WHERE w.created_at = now() AND w.user_id = c_wasp AND w.type = 'credit'
       AND w.category = 'settlement' AND w.amount = c_seat AND w.description = v_desc
       AND w.related_entity_id IS NULL
     ORDER BY w.id LIMIT 1;
    IF v_wtx IS NULL THEN
      RAISE EXCEPTION 'seat cash: no wallet receipt for %', v_key;
    END IF;

    UPDATE public.ca_manual_adjustments SET status = 'settled' WHERE id = v_adj AND status = 'approved';
    IF NOT FOUND THEN RAISE EXCEPTION 'seat cash: adjustment % did not settle', v_adj; END IF;

    v_receipts := v_receipts || jsonb_build_object(
      'satellite_id', v_sat, 'amount', c_seat, 'adjustment_id', v_adj,
      'idempotency_key', v_key, 'ledger_id', v_leg, 'wallet_transaction_id', v_wtx,
      'funded_by', 'union_bank:' || c_union::text,
      'credited_club_id', c_shark,
      'satellite_retains', 30.00);
  END LOOP;

  ---------------------------------------------------------------------------
  -- 2. THE FOUR ALERTS CLOSE, CARRYING THE RECEIPTS AND WHAT STAYS.
  ---------------------------------------------------------------------------
  UPDATE public.financial_alerts
     SET context = context || jsonb_build_object(
           'house_settlement', jsonb_build_object(
             'decision', 'bought_seat_paid_in_cash_by_the_house',
             'basis', 'a winner who bought the target seat is paid the seat in cash (20260905195011)',
             'recipient', c_wasp, 'credited_club_id', c_shark, 'amount_total', c_total,
             'funded_by', 'union_bank:' || c_union::text,
             'each_satellite_retains', 30.00,
             'sealed_journals_untouched', true,
             'receipts', v_receipts, 'unattributed', 0,
             'supersedes', c_old,
             'migration', c_mig, 'paid_at', now())),
         resolved = true, resolved_at = now(), resolved_by = c_actor,
         resolution = format(
           'Paid. WASP (%s) had bought the Friday Night Feature cfcf5abc seat with 30.00 of their own SHARK CLUB chips before winning satellites 0d29dd54 and 781c8905, '
           || 'so neither seat could be delivered and 30.00 stayed in each satellite''s prize liability. WASP is paid 60.00 in cash, 30.00 per satellite, into their SHARK CLUB wallet '
           || '(keys satellite-seat-cash:<satellite>:<WASP>, adjustments approved and settled under CLAUDE.md 10.9), funded by the Midway Union bank, the house that hosted both '
           || 'satellites and took their 2.00 fee each. Both satellites are COMPLETED, so their journals are sealed and nothing here names them: '
           || 'fn_satellite_transfer_ledger_is_immutable refuses a leg naming a completed satellite''s prize liability, which is why the earlier migration %s refused itself on apply and is superseded by this one. '
           || 'Each satellite therefore keeps the 30.00 of collected pool it never disbursed (40.00 in, 8.00 runner-up, 2.00 fee, 30.00 retained); the house paid the player instead. '
           || 'The runners-up 0097309f and ...0045 were each paid their 8.00 at the time and are not affected, nothing is taken back from anyone, and the award itself was fixed on 2026-09-05 (20260905195011). Migration %s.',
           c_wasp, c_old, c_mig)
   WHERE id = ANY (c_alerts) AND resolved IS NOT TRUE;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 4 THEN RAISE EXCEPTION 'seat cash: expected to resolve 4 alerts, resolved %', v_n; END IF;

  ---------------------------------------------------------------------------
  -- 3. POST-IMAGE. Conserved to the cent, and the sealed events untouched.
  ---------------------------------------------------------------------------
  SELECT chip_balance INTO v_bal_after FROM public.club_members WHERE user_id = c_wasp AND club_id = c_shark;
  IF round(v_bal_after - v_bal_before, 2) <> c_total THEN
    RAISE EXCEPTION 'seat cash post-image: WASP''s wallet moved % (expected 60.00)', v_bal_after - v_bal_before;
  END IF;
  SELECT chip_balance INTO v_bank_after FROM public.union_wallets WHERE union_id = c_union;
  IF round(v_bank_before - v_bank_after, 2) <> c_total THEN
    RAISE EXCEPTION 'seat cash post-image: the Midway Union bank moved % (expected -60.00)', v_bank_after - v_bank_before;
  END IF;

  SELECT count(*), COALESCE(round(sum(l.amount), 2), 0) INTO v_legs, v_sum
    FROM public.chip_ledger l
   WHERE l.created_at = now() AND l.category = 'settlement'
     AND l.from_type = 'union_bank' AND l.from_entity_id = c_union
     AND l.to_type = 'player_wallet' AND l.to_entity_id = c_wasp
     AND l.idempotency_key LIKE 'satellite-seat-cash:%';
  IF v_legs <> 2 OR v_sum <> c_total THEN
    RAISE EXCEPTION 'seat cash post-image: % legs of % (expected 2 of 60.00)', v_legs, v_sum;
  END IF;
  IF (SELECT count(*) FROM public.chip_ledger l
       WHERE l.created_at = now() AND (l.from_entity_id = c_wasp OR l.to_entity_id = c_wasp)) <> 2 THEN
    RAISE EXCEPTION 'seat cash post-image: WASP carries other than exactly two journal legs in this transaction';
  END IF;
  IF EXISTS (SELECT 1 FROM public.chip_ledger l
              WHERE l.created_at = now()
                AND (l.from_type IN ('union_bank','union_wallet') OR l.to_type IN ('union_bank','union_wallet'))
                AND NOT (l.category = 'settlement' AND l.idempotency_key LIKE 'satellite-seat-cash:%')) THEN
    RAISE EXCEPTION 'seat cash post-image: a second leg touched the union wallet - the autoledger was not stood down';
  END IF;

  -- NOTHING WRITTEN HERE NAMES EITHER SEALED SATELLITE, by every witness the
  -- satellite guard itself reads.
  IF EXISTS (SELECT 1 FROM public.chip_ledger l
              WHERE l.created_at = now()
                AND (l.tournament_id = ANY (c_sats)
                  OR (l.from_type = 'prize_liability' AND l.from_entity_id = ANY (c_sats))
                  OR (l.to_type = 'prize_liability' AND l.to_entity_id = ANY (c_sats))
                  OR (l.metadata->>'satellite_id')::uuid = ANY (c_sats))) THEN
    RAISE EXCEPTION 'seat cash post-image: this transaction wrote a journal leg naming a sealed satellite';
  END IF;
  IF EXISTS (SELECT 1 FROM public.wallet_transactions w
              WHERE w.created_at = now() AND w.related_entity_id = ANY (c_sats)) THEN
    RAISE EXCEPTION 'seat cash post-image: this transaction wrote a wallet row naming a sealed satellite';
  END IF;

  -- Each satellite's prize liability is UNCHANGED at 30.00, which is the honest
  -- end state: the pool it never disbursed stays recorded against it, and the
  -- house paid the player.
  FOREACH v_sat IN ARRAY c_sats LOOP
    SELECT COALESCE(sum(l.amount) FILTER (WHERE l.to_type = 'prize_liability' AND l.to_entity_id = v_sat), 0)
         - COALESCE(sum(l.amount) FILTER (WHERE l.from_type = 'prize_liability' AND l.from_entity_id = v_sat), 0)
      INTO v_in
      FROM public.chip_ledger l
     WHERE (l.to_type = 'prize_liability' AND l.to_entity_id = v_sat)
        OR (l.from_type = 'prize_liability' AND l.from_entity_id = v_sat);
    IF v_in <> 30.00 THEN
      RAISE EXCEPTION 'seat cash post-image: % prize_liability reads % and should still read 30.00', v_sat, v_in;
    END IF;
    IF public.fn_tournament_conservation_delta(v_sat) <> 0.00 THEN
      RAISE EXCEPTION 'seat cash post-image: % conservation delta moved to %, it must stay 0.00', v_sat, public.fn_tournament_conservation_delta(v_sat);
    END IF;
  END LOOP;

  RAISE NOTICE 'seat cash: the house paid 60.00 to WASP (%); receipts %', c_wasp, v_receipts;
  IF v_probe THEN
    RAISE EXCEPTION 'PROBE OK (rolled back): WASP % -> %, Midway Union bank % -> %; receipts %',
      v_bal_before, v_bal_after, v_bank_before, v_bank_after, v_receipts;
  END IF;
END
$mig$;

COMMIT;
