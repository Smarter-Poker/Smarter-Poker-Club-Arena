-- 20260926092115_the_bots_paid_twice_on_2026_09_02_return_the_duplicate.sql
--
-- THE BOTS PAID TWICE ON 2026-09-02 RETURN THE DUPLICATE (2026-09-26)
--
-- DECISION (CLAUDE.md 10.9, delegated by Dan for this item on 2026-09-26): a
-- duplicate prize paid to a HORSE fleet player is recovered through an audited
-- reversal with a receipt; a duplicate paid to a human is never clawed back and
-- is recorded as a house cost. All 32 recipients here are horses, so all 32 are
-- recovered. No human was paid twice in this class.
--
-- WHAT HAPPENED, READ FROM THE ROWS (FeeReconciler.double_paid_obligation,
-- alerts 4f3ae2d8 / f50a9603 / 41c10a41, the same 32 obligations each time):
--   01:19:57  migration 20260902011957_back_fund_the_six_unfunded_guarantees
--             UPDATEd club_members.chip_balance for every finisher of four
--             under-guaranteed events (journal: category overlay,
--             prize_liability -> player_wallet, 32 legs, 1,001.00), funded by
--             the Midway Union bank, and wrote no tournament_payouts row;
--   03:54:19  fn_tournament_payout_reconcile, seeing no payout row for that
--             top-up, paid the same shortfall again through fn_credit_and_log
--             (journal: tournament_prize, 32 legs, 1,001.00);
--   04:19:07  migration 20260902041907 back-filled overlay_backpay payout rows
--             for the 01:19 payment.
-- So every finisher was credited structure + shortfall + shortfall:
--   Union Grand Championship (NLH) f2502226  pool 2,500.00  paid 2,960.00  +460.00
--   Union Mystery Bounty (PLO5)    1f97c186  pool   800.00  paid 1,150.00  +350.00
--   Evening Mystery Bounty (PLO5)  4375d276  pool   400.00  paid   575.00  +175.00
--   Turbo Tuesday Opener           9a7f48d2  pool   250.00  paid   266.00   +16.00
--                                                                total  1,001.00
-- (20260909090022 concluded "not one chip was paid twice" by counting only
-- credits that spent a wallet_credit_idempotency key; the 01:19 credits spent
-- none, but the balance moved and the journal recorded it. The chips were paid
-- twice.)
--
-- THE REVERSAL, ONE PER OBLIGATION. For each of the 32: the approved
-- ca_manual_adjustments row (negative, the receipt of the decision) via
-- fn_ca_adjustment_under_10_9; fn_ca_declare_ledger names the Midway Union
-- bank as counterparty (category reversal) and skips the union_wallets
-- trigger, so the journal carries ONE leg player_wallet -> union_bank; the
-- player's wallet in the club that received the duplicate is debited
-- (refusing if it cannot cover it) and the union bank that funded the top-up
-- is credited; log_wallet_transaction records a prize_reversal debit. The
-- chips return to the account that paid them. The tournaments' own records are
-- sealed (terminal_wallet_transaction_is_immutable), so no row names them.
--
-- PROOF: asserts every pre-image (alerts open, the 32 rows, all horses, each
-- event still overpaid by exactly its duplicate), then that 32 legs totalling
-- 1,001.00 were written, the union bank rose by exactly 1,001.00 and every
-- wallet fell by exactly its amount. ca.money7_probe = 'on' rolls it back.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $mig$
DECLARE
  c_mig    CONSTANT text := '20260926092115_the_bots_paid_twice_on_2026_09_02_return_the_duplicate';
  c_union  CONSTANT uuid := 'fade0000-0000-0000-0000-000000000001';
  c_actor  CONSTANT uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
  c_alerts CONSTANT uuid[] := ARRAY['4f3ae2d8-8dee-4591-b178-35db061aa94e','f50a9603-7d5e-4dde-8f5c-b1352179b6cd','41c10a41-1137-42eb-8fea-3536e54416f9']::uuid[];
  v_probe  boolean := COALESCE(current_setting('ca.money7_probe', true), '') = 'on';
  r record; v_adj uuid; v_before numeric; v_after numeric; v_bank_before numeric; v_bank_after numeric;
  v_key text; v_n int := 0; v_total numeric := 0; v_legs int; v_legsum numeric; v_reason text;
  v_report jsonb := '[]'::jsonb;
BEGIN
  IF (SELECT count(*) FROM public.financial_alerts
       WHERE id = ANY (c_alerts) AND source = 'FeeReconciler.double_paid_obligation' AND resolved IS NOT TRUE) <> 3 THEN
    RAISE EXCEPTION 'double-pay pre-image: the three alerts are not all open';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_manual_adjustments WHERE decision_note = 'migration ' || c_mig) THEN
    RAISE EXCEPTION 'double-pay pre-image: this reversal already ran';
  END IF;

  CREATE TEMP TABLE zz_dup ON COMMIT DROP AS
  SELECT (x->>'tournament_id')::uuid AS tournament_id, x->>'tournament_name' AS tournament_name,
         (x->>'player_id')::uuid AS user_id, (x->>'finish_position')::int AS place,
         round((x->>'amount')::numeric, 2) AS amount, tp.club_id
    FROM public.financial_alerts a
    CROSS JOIN LATERAL jsonb_array_elements(a.context->'rows') x
    LEFT JOIN public.tournament_players tp
      ON tp.tournament_id = (x->>'tournament_id')::uuid AND tp.user_id = (x->>'player_id')::uuid
   WHERE a.id = '4f3ae2d8-8dee-4591-b178-35db061aa94e';

  IF (SELECT count(*) FROM zz_dup) <> 32 OR (SELECT sum(amount) FROM zz_dup) <> 1001.00
     OR EXISTS (SELECT 1 FROM zz_dup WHERE club_id IS NULL) THEN
    RAISE EXCEPTION 'double-pay pre-image: the alert no longer lists 32 obligations totalling 1,001.00 with a paying club';
  END IF;
  IF EXISTS (SELECT 1 FROM zz_dup d LEFT JOIN public.profiles p ON p.id = d.user_id WHERE p.is_horse IS NOT TRUE) THEN
    RAISE EXCEPTION 'double-pay pre-image: a recipient is not a horse; a human is never clawed back';
  END IF;
  -- Each recipient still holds the three credits (structure + two equal top-ups).
  IF EXISTS (
    SELECT 1 FROM zz_dup d
     WHERE (SELECT count(*) FROM public.wallet_transactions w
             WHERE w.related_entity_id = d.tournament_id AND w.user_id = d.user_id
               AND w.type = 'credit' AND w.category = 'prize' AND w.amount = d.amount) <> 2
        OR EXISTS (SELECT 1 FROM public.wallet_transactions w
                    WHERE w.related_entity_id = d.tournament_id AND w.user_id = d.user_id
                      AND w.type = 'debit' AND w.category IN ('prize', 'prize_reversal'))) THEN
    RAISE EXCEPTION 'double-pay pre-image: a recipient no longer shows exactly two equal top-up credits and no reversal';
  END IF;
  -- Each event is still overpaid by exactly its duplicate.
  IF EXISTS (
    SELECT 1 FROM (SELECT tournament_id, sum(amount) dup FROM zz_dup GROUP BY 1) e
      JOIN public.tournaments t ON t.id = e.tournament_id
     WHERE round((SELECT sum(w.amount) FROM public.wallet_transactions w
                   WHERE w.related_entity_id = t.id AND w.type = 'credit' AND w.category = 'prize') - t.prize_pool, 2)
           <> e.dup) THEN
    RAISE EXCEPTION 'double-pay pre-image: an event is no longer overpaid by exactly its duplicate';
  END IF;

  SELECT chip_balance INTO v_bank_before FROM public.union_wallets WHERE union_id = c_union FOR UPDATE;
  IF v_bank_before IS NULL THEN RAISE EXCEPTION 'double-pay: Midway Union bank not found'; END IF;

  FOR r IN SELECT d.*, p.username FROM zz_dup d JOIN public.profiles p ON p.id = d.user_id
            ORDER BY d.tournament_id, d.place LOOP
    v_key := 'double-pay-reversal:' || r.tournament_id::text || ':' || r.place::text || ':' || r.user_id::text;
    v_reason := format(
      '%s (%s), a HORSE fleet player, finished %s in %s (%s) and was credited its %s guarantee top-up twice on 2026-09-02: at 01:19:57 by migration 20260902011957_back_fund_the_six_unfunded_guarantees (balance moved, no payout row) and at 03:54:19 by fn_tournament_payout_reconcile, which could not see the first. '
      || 'The duplicate %s is returned from its wallet in club %s to the Midway Union bank that funded the top-up. A horse is recovered; a human would not be (10.9 rule 3). Migration %s carries this.',
      r.username, r.user_id, r.place, r.tournament_name, r.tournament_id, r.amount, r.amount, r.club_id, c_mig);
    v_adj := public.fn_ca_adjustment_under_10_9(r.tournament_id, r.user_id, -r.amount, v_reason, c_mig,
               'claude-opus-5.5 under CLAUDE.md 10.9 (money7)');

    SELECT chip_balance INTO v_before FROM public.club_members
     WHERE user_id = r.user_id AND club_id = r.club_id FOR UPDATE;
    IF v_before IS NULL OR v_before < r.amount THEN
      RAISE EXCEPTION 'double-pay: % holds % in club %, cannot return %', r.user_id, v_before, r.club_id, r.amount;
    END IF;

    PERFORM public.fn_ca_declare_ledger('reversal', 'union_bank', c_union, NULL, v_key, ARRAY['union_wallets']);
    PERFORM set_config('app.ledger_correlation', v_adj::text, true);
    UPDATE public.club_members SET chip_balance = chip_balance - r.amount, updated_at = now()
     WHERE user_id = r.user_id AND club_id = r.club_id AND chip_balance >= r.amount
     RETURNING chip_balance INTO v_after;
    UPDATE public.union_wallets SET chip_balance = chip_balance + r.amount, updated_at = now()
     WHERE union_id = c_union;
    PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);
    PERFORM set_config('app.ledger_counterparty', '', true);
    PERFORM set_config('app.ledger_counterparty_entity', '', true);
    PERFORM set_config('app.ledger_category', '', true);
    PERFORM set_config('app.ledger_idempotency_key', '', true);
    PERFORM set_config('app.ledger_correlation', '', true);
    IF v_after IS NULL OR round(v_before - v_after, 2) <> r.amount THEN
      RAISE EXCEPTION 'double-pay: % wallet moved % where % was returned', r.user_id, v_before - v_after, r.amount;
    END IF;

    PERFORM public.log_wallet_transaction(r.user_id, 'PLAYER', r.amount, 'debit', 'prize_reversal',
      format('Duplicate guarantee top-up returned: %s place %s was paid twice on 2026-09-02 (%s)', r.tournament_name, r.place, c_mig),
      NULL, NULL, NULL);

    UPDATE public.ca_manual_adjustments SET status = 'settled' WHERE id = v_adj AND status = 'approved';
    IF NOT FOUND THEN RAISE EXCEPTION 'double-pay: adjustment % did not settle', v_adj; END IF;

    v_n := v_n + 1; v_total := v_total + r.amount;
    v_report := v_report || jsonb_build_object('tournament_id', r.tournament_id, 'place', r.place,
      'user_id', r.user_id, 'club_id', r.club_id, 'returned', r.amount, 'adjustment_id', v_adj,
      'wallet_before', v_before, 'wallet_after', v_after);
  END LOOP;

  SELECT chip_balance INTO v_bank_after FROM public.union_wallets WHERE union_id = c_union;
  SELECT count(*), COALESCE(sum(amount), 0) INTO v_legs, v_legsum FROM public.chip_ledger l
   WHERE l.created_at = now() AND l.category = 'reversal' AND l.from_type = 'player_wallet'
     AND l.to_type = 'union_bank' AND l.to_entity_id = c_union;
  IF v_n <> 32 OR v_total <> 1001.00 OR round(v_bank_after - v_bank_before, 2) <> 1001.00
     OR v_legs <> 32 OR v_legsum <> 1001.00 THEN
    RAISE EXCEPTION 'double-pay post-image: % reversals of %, bank moved %, % legs of %',
      v_n, v_total, v_bank_after - v_bank_before, v_legs, v_legsum;
  END IF;
  IF EXISTS (SELECT 1 FROM public.chip_ledger l WHERE l.created_at = now()
              AND (l.from_type IN ('union_bank','union_wallet') OR l.to_type IN ('union_bank','union_wallet'))
              AND l.category <> 'reversal') THEN
    RAISE EXCEPTION 'double-pay post-image: a second leg touched the union wallet - the trigger was not skipped';
  END IF;

  UPDATE public.financial_alerts
     SET resolved = true, resolved_at = now(), resolved_by = c_actor,
         context = context || jsonb_build_object('recovered', jsonb_build_object(
                     'migration', c_mig, 'recovered_total', v_total, 'recipients', v_n,
                     'all_horses', true, 'returned_to', 'union_bank:' || c_union::text,
                     'union_bank_before', v_bank_before, 'union_bank_after', v_bank_after)),
         resolution = format(
           'Verified and recovered. All 32 obligations WERE paid twice (1,001.00): the 01:19:57 back-fund migration moved each balance with no payout row and fn_tournament_payout_reconcile paid the same shortfall again at 03:54:19. All 32 recipients are HORSE fleet players, so each duplicate was returned from the wallet that received it to the Midway Union bank that funded the top-up (union bank %s -> %s), one reversal leg and one settled ca_manual_adjustments receipt each, by migration %s. No human was paid twice in this class; nothing was taken from a human. The reconciler now counts overlay_backpay (20260902042044), so the mechanism is closed.',
           v_bank_before, v_bank_after, c_mig)
   WHERE id = ANY (c_alerts) AND resolved IS NOT TRUE;

  RAISE NOTICE 'double-pay reversal: bank % -> %, %', v_bank_before, v_bank_after, v_report;
  IF v_probe THEN
    RAISE EXCEPTION 'PROBE OK (rolled back): bank % -> %, % reversals, %', v_bank_before, v_bank_after, v_n, v_total;
  END IF;
END
$mig$;

COMMIT;
