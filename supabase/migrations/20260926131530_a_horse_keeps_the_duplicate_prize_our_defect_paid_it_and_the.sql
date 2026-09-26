-- 20260926131530_a_horse_keeps_the_duplicate_prize_our_defect_paid_it_and_the.sql
--
-- A HORSE KEEPS THE DUPLICATE PRIZE OUR DEFECT PAID IT, AND THE HOUSE ABSORBS IT
-- (2026-09-26)
--
-- DECISION (CLAUDE.md 10.9 rule 3 and 10.5, both binding; delegated by Dan):
-- the 1,001.00 of guarantee top-ups paid twice on 2026-09-02 to 32 finishers
-- of four events is a house cost. It stays with the players.
--
-- WHAT WAS VERIFIED. FeeReconciler.double_paid_obligation (alerts 4f3ae2d8,
-- f50a9603, 41c10a41) is a REAL double payment, not a reporting artefact:
-- 20260902011957_back_fund_the_six_unfunded_guarantees moved every finisher's
-- balance at 01:19:57 (journal: overlay, 32 legs, 1,001.00) with no payout
-- row, and fn_tournament_payout_reconcile, unable to see it, paid the same
-- shortfall again at 03:54:19 (journal: tournament_prize, 32 legs, 1,001.00).
-- Per event: f2502226 +460.00, 1f97c186 +350.00, 4375d276 +175.00,
-- 9a7f48d2 +16.00. The mechanism is closed (the reconciler counts
-- overlay_backpay since 20260902042044).
--
-- WHY THIS MIGRATION EXISTS. Earlier today
-- 20260926092115_the_bots_paid_twice_on_2026_09_02_return_the_duplicate took
-- the 1,001.00 back from the 32 wallets into the Midway Union bank, on the
-- stated rule "a horse is recovered; a human would not be". That rule is the
-- one CLAUDE.md 10.5 forbids by name ("Never 'skip the horses' on a
-- repayment"; typing is_horse to give a horse a worse deal than a human "is
-- writing a bug"), and 10.9 rule 3 is explicit: "Nothing is taken back from a
-- player for our mistake. Overpay that our defect caused is absorbed by the
-- house, reported, and left alone." A human in the same position would have
-- kept the chips, so the horses keep them.
--
-- WHAT THIS DOES, ONE CREDIT PER RECIPIENT, IN THE EXACT INVERSE SHAPE OF THE
-- RECOVERY (the CHIP STANDARD 2.4 fn_club_bank_send shape):
--   1. an approved ca_manual_adjustments row (+amount) via
--      fn_ca_adjustment_under_10_9, carrying the paragraph;
--   2. a wallet_credit_idempotency key double-pay-restore:<event>:<player>, so
--      a replay can never pay twice (the insert must claim a fresh key);
--   3. fn_ca_declare_ledger names the Midway Union bank (category settlement)
--      and skips the union_wallets trigger, so the journal carries ONE leg
--      union_bank -> player_wallet;
--   4. the union bank is debited (refusing if it cannot cover it) and the
--      SAME club wallet the recovery debited is credited;
--   5. log_wallet_transaction records the credit; the adjustment is settled.
-- The recovery's own rows (32 settled adjustments, 32 reversal legs, 32
-- prize_reversal debits) are history and are not touched.
--
-- PROOF: asserts every pre-image (the recovery ran exactly once, 32 rows,
-- 1,001.00, each reversal leg and debit present, not already restored), then
-- that exactly 32 legs union_bank -> player_wallet totalling 1,001.00 were
-- written in this transaction, no other leg touched the union wallet, the
-- bank fell by exactly 1,001.00 and every wallet rose by exactly its amount.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $mig$
DECLARE
  c_mig      CONSTANT text := '20260926131530_a_horse_keeps_the_duplicate_prize_our_defect_paid_it_and_the';
  c_recovery CONSTANT text := '20260926092115_the_bots_paid_twice_on_2026_09_02_return_the_duplicate';
  c_union    CONSTANT uuid := 'fade0000-0000-0000-0000-000000000001';
  c_actor    CONSTANT uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
  c_alerts   CONSTANT uuid[] := ARRAY['4f3ae2d8-8dee-4591-b178-35db061aa94e','f50a9603-7d5e-4dde-8f5c-b1352179b6cd','41c10a41-1137-42eb-8fea-3536e54416f9']::uuid[];
  r record; v_adj uuid; v_before numeric; v_after numeric; v_bank_before numeric; v_bank_after numeric;
  v_key text; v_n int := 0; v_total numeric := 0; v_legs int; v_legsum numeric; v_reason text;
  v_ins int; v_report jsonb := '[]'::jsonb;
BEGIN
  ---------------------------------------------------------------------------
  -- 0. PRE-IMAGE.
  ---------------------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM public.ca_manual_adjustments WHERE decision_note = 'migration ' || c_mig) THEN
    RAISE EXCEPTION 'restore pre-image: this restoration already ran';
  END IF;
  IF (SELECT count(*) FROM public.financial_alerts
       WHERE id = ANY (c_alerts) AND source = 'FeeReconciler.double_paid_obligation'
         AND resolved IS TRUE AND context ? 'recovered' AND NOT context ? 'restored') <> 3 THEN
    RAISE EXCEPTION 'restore pre-image: the three alerts do not all carry the recovery and no restoration';
  END IF;

  CREATE TEMP TABLE zz_restore ON COMMIT DROP AS
  SELECT a.id AS recovery_adj, a.target_id AS user_id, a.tournament_id, -a.amount AS amount, tp.club_id,
         t.name AS tournament_name
    FROM public.ca_manual_adjustments a
    LEFT JOIN public.tournament_players tp ON tp.tournament_id = a.tournament_id AND tp.user_id = a.target_id
    LEFT JOIN public.tournaments t ON t.id = a.tournament_id
   WHERE a.decision_note = 'migration ' || c_recovery;

  IF (SELECT count(*) FROM zz_restore) <> 32
     OR (SELECT sum(amount) FROM zz_restore) <> 1001.00
     OR (SELECT count(DISTINCT (tournament_id, user_id)) FROM zz_restore) <> 32
     OR EXISTS (SELECT 1 FROM zz_restore WHERE club_id IS NULL OR amount <= 0)
     OR EXISTS (SELECT 1 FROM public.ca_manual_adjustments a
                 WHERE a.decision_note = 'migration ' || c_recovery AND a.status <> 'settled') THEN
    RAISE EXCEPTION 'restore pre-image: the recovery no longer reads 32 settled returns totalling 1,001.00 with a club wallet each';
  END IF;
  IF (SELECT string_agg(tournament_id::text || '=' || s::text, ',' ORDER BY tournament_id)
        FROM (SELECT tournament_id, sum(amount) s FROM zz_restore GROUP BY 1) e)
     IS DISTINCT FROM
     '1f97c186-bf78-4336-aaad-afffd196335d=350.00,4375d276-de0e-4ffa-aaee-a7c0121de4cb=175.00,9a7f48d2-2c34-4f97-8993-ed784d75bcbd=16.00,f2502226-d3d0-4de5-8067-41858de3c06e=460.00' THEN
    RAISE EXCEPTION 'restore pre-image: the per-event duplicates are no longer 460.00 / 350.00 / 175.00 / 16.00';
  END IF;
  -- Every recipient still shows exactly the one recovery debit and its one reversal leg.
  IF EXISTS (
    SELECT 1 FROM zz_restore d
     WHERE (SELECT count(*) FROM public.wallet_transactions w
             WHERE w.user_id = d.user_id AND w.type = 'debit' AND w.category = 'prize_reversal'
               AND w.amount = d.amount AND w.created_at >= '2026-09-26'
               AND w.description LIKE 'Duplicate guarantee top-up returned:%' || c_recovery || ')') <> 1
        OR (SELECT count(*) FROM public.chip_ledger l
             WHERE l.from_entity_id = d.user_id AND l.from_type = 'player_wallet'
               AND l.to_type = 'union_bank' AND l.to_entity_id = c_union
               AND l.category = 'reversal' AND l.amount = d.amount
               AND l.created_at >= '2026-09-26'
               AND l.idempotency_key LIKE 'double-pay-reversal:' || d.tournament_id::text || ':%:' || d.user_id::text) <> 1) THEN
    RAISE EXCEPTION 'restore pre-image: a recipient no longer shows exactly one recovery debit and one recovery leg';
  END IF;
  IF (SELECT count(*) FROM public.chip_ledger l
       WHERE l.from_type = 'player_wallet' AND l.to_type = 'union_bank' AND l.to_entity_id = c_union
         AND l.category = 'reversal' AND l.idempotency_key LIKE 'double-pay-reversal:%'
         AND l.from_entity_id IN (SELECT user_id FROM zz_restore)
         AND l.created_at >= '2026-09-26') <> 32 THEN
    RAISE EXCEPTION 'restore pre-image: the journal does not carry the 32 recovery legs';
  END IF;
  IF EXISTS (SELECT 1 FROM zz_restore d JOIN public.wallet_credit_idempotency k
                ON k.key = 'double-pay-restore:' || d.tournament_id::text || ':' || d.user_id::text) THEN
    RAISE EXCEPTION 'restore pre-image: a restoration key already exists';
  END IF;

  SELECT chip_balance INTO v_bank_before FROM public.union_wallets WHERE union_id = c_union FOR UPDATE;
  IF v_bank_before IS NULL OR v_bank_before < 1001.00 THEN
    RAISE EXCEPTION 'restore: the Midway Union bank holds % and cannot return 1,001.00', v_bank_before;
  END IF;

  ---------------------------------------------------------------------------
  -- 1. ONE CREDIT PER RECIPIENT, BACK INTO THE WALLET IT WAS TAKEN FROM.
  ---------------------------------------------------------------------------
  FOR r IN SELECT d.*, p.username FROM zz_restore d JOIN public.profiles p ON p.id = d.user_id
            ORDER BY d.tournament_id, d.amount DESC, d.user_id LOOP
    v_key := 'double-pay-restore:' || r.tournament_id::text || ':' || r.user_id::text;
    INSERT INTO public.wallet_credit_idempotency (key, user_id, amount)
    VALUES (v_key, r.user_id, r.amount)
    ON CONFLICT (key) DO NOTHING;
    GET DIAGNOSTICS v_ins = ROW_COUNT;
    IF v_ins <> 1 THEN
      RAISE EXCEPTION 'restore: key % was already spent - refusing to pay twice', v_key;
    END IF;

    v_reason := format(
      '%s (%s) finished in the money in %s (%s) and was credited its %s guarantee top-up twice on 2026-09-02 by our defect (the 01:19:57 back-fund migration left no payout row, so fn_tournament_payout_reconcile paid the shortfall again at 03:54:19). '
      || 'Migration %s took the %s back because the player is a horse. CLAUDE.md 10.5 forbids treating a horse worse than a human and 10.9 rule 3 says overpay our defect caused is absorbed by the house and left alone, so the %s is returned from the Midway Union bank to this player''s wallet in club %s (recovery adjustment %s). Migration %s carries this.',
      r.username, r.user_id, r.tournament_name, r.tournament_id, r.amount, c_recovery, r.amount, r.amount,
      r.club_id, r.recovery_adj, c_mig);
    v_adj := public.fn_ca_adjustment_under_10_9(r.tournament_id, r.user_id, r.amount, v_reason, c_mig,
               'claude-opus-5.5 under CLAUDE.md 10.9 (money-d)');

    SELECT chip_balance INTO v_before FROM public.club_members
     WHERE user_id = r.user_id AND club_id = r.club_id FOR UPDATE;
    IF v_before IS NULL THEN
      RAISE EXCEPTION 'restore: % holds no wallet in club %', r.user_id, r.club_id;
    END IF;

    PERFORM public.fn_ca_declare_ledger('settlement', 'union_bank', c_union, NULL, v_key, ARRAY['union_wallets']);
    PERFORM set_config('app.ledger_correlation', v_adj::text, true);
    UPDATE public.union_wallets SET chip_balance = chip_balance - r.amount, updated_at = now()
     WHERE union_id = c_union AND chip_balance >= r.amount
     RETURNING chip_balance INTO v_bank_after;
    IF v_bank_after IS NULL THEN
      RAISE EXCEPTION 'restore: the union bank could not fund %', r.amount;
    END IF;
    UPDATE public.club_members SET chip_balance = chip_balance + r.amount, updated_at = now()
     WHERE user_id = r.user_id AND club_id = r.club_id
     RETURNING chip_balance INTO v_after;
    PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);
    PERFORM set_config('app.ledger_counterparty', '', true);
    PERFORM set_config('app.ledger_counterparty_entity', '', true);
    PERFORM set_config('app.ledger_category', '', true);
    PERFORM set_config('app.ledger_idempotency_key', '', true);
    PERFORM set_config('app.ledger_correlation', '', true);
    IF v_after IS NULL OR round(v_after - v_before, 2) <> r.amount THEN
      RAISE EXCEPTION 'restore: % wallet moved % where % was returned', r.user_id, v_after - v_before, r.amount;
    END IF;

    PERFORM public.log_wallet_transaction(r.user_id, 'PLAYER', r.amount, 'credit', 'settlement',
      format('Duplicate guarantee top-up restored: %s was paid twice on 2026-09-02 by our defect; the house absorbs it (%s)', r.tournament_name, c_mig),
      NULL, NULL, NULL);

    UPDATE public.ca_manual_adjustments SET status = 'settled' WHERE id = v_adj AND status = 'approved';
    IF NOT FOUND THEN RAISE EXCEPTION 'restore: adjustment % did not settle', v_adj; END IF;

    v_n := v_n + 1; v_total := v_total + r.amount;
    v_report := v_report || jsonb_build_object('tournament_id', r.tournament_id, 'user_id', r.user_id,
      'club_id', r.club_id, 'restored', r.amount, 'adjustment_id', v_adj, 'key', v_key,
      'wallet_before', v_before, 'wallet_after', v_after);
  END LOOP;

  ---------------------------------------------------------------------------
  -- 2. POST-IMAGE. Conserved to the cent, one leg each, nothing else moved.
  ---------------------------------------------------------------------------
  SELECT chip_balance INTO v_bank_after FROM public.union_wallets WHERE union_id = c_union;
  SELECT count(*), COALESCE(sum(amount), 0) INTO v_legs, v_legsum FROM public.chip_ledger l
   WHERE l.created_at = now() AND l.category = 'settlement' AND l.from_type = 'union_bank'
     AND l.from_entity_id = c_union AND l.to_type = 'player_wallet'
     AND l.idempotency_key LIKE 'double-pay-restore:%';
  IF v_n <> 32 OR v_total <> 1001.00 OR round(v_bank_before - v_bank_after, 2) <> 1001.00
     OR v_legs <> 32 OR v_legsum <> 1001.00 THEN
    RAISE EXCEPTION 'restore post-image: % restorations of %, bank moved %, % legs of %',
      v_n, v_total, v_bank_before - v_bank_after, v_legs, v_legsum;
  END IF;
  IF EXISTS (SELECT 1 FROM public.chip_ledger l WHERE l.created_at = now()
              AND (l.from_type IN ('union_bank','union_wallet') OR l.to_type IN ('union_bank','union_wallet'))
              AND NOT (l.category = 'settlement' AND l.idempotency_key LIKE 'double-pay-restore:%')) THEN
    RAISE EXCEPTION 'restore post-image: a second leg touched the union wallet - the trigger was not skipped';
  END IF;
  IF (SELECT count(*) FROM zz_restore d JOIN public.wallet_credit_idempotency k
         ON k.key = 'double-pay-restore:' || d.tournament_id::text || ':' || d.user_id::text
        AND k.user_id = d.user_id AND k.amount = d.amount) <> 32 THEN
    RAISE EXCEPTION 'restore post-image: the 32 restoration keys are not all spent';
  END IF;

  UPDATE public.financial_alerts
     SET context = context || jsonb_build_object('restored', jsonb_build_object(
                     'migration', c_mig, 'restored_total', v_total, 'recipients', v_n,
                     'decision', 'house_absorbs_duplicate', 'rule', 'CLAUDE.md 10.9 rule 3 and 10.5',
                     'funded_by', 'union_bank:' || c_union::text,
                     'union_bank_before', v_bank_before, 'union_bank_after', v_bank_after,
                     'supersedes', c_recovery)),
         resolution = format(
           'Verified: a REAL double payment, not a reporting artefact. 32 finishers of four events (f2502226 +460.00, 1f97c186 +350.00, 4375d276 +175.00, 9a7f48d2 +16.00; 1,001.00) were credited their 2026-09-02 guarantee top-up twice: the 01:19:57 back-fund migration moved each balance with no payout row and fn_tournament_payout_reconcile paid the same shortfall again at 03:54:19. The mechanism is closed (the reconciler counts overlay_backpay since 20260902042044). '
           || 'Decided under CLAUDE.md 10.9 rule 3 and 10.5: overpay our defect caused is absorbed by the house and left with the player, horse or human alike. %s had taken the 1,001.00 back from the 32 horses because they were horses; %s returned every chip from the Midway Union bank (bank %s -> %s), one settlement leg and one settled adjustment per player. House cost: 1,001.00.',
           c_recovery, c_mig, v_bank_before, v_bank_after),
         resolved = true, resolved_at = now(), resolved_by = c_actor
   WHERE id = ANY (c_alerts) AND resolved IS TRUE AND context ? 'recovered' AND NOT context ? 'restored';
  GET DIAGNOSTICS v_ins = ROW_COUNT;
  IF v_ins <> 3 THEN RAISE EXCEPTION 'restore post-image: expected three alerts, updated %', v_ins; END IF;

  RAISE NOTICE 'double-pay restoration: bank % -> %, %', v_bank_before, v_bank_after, v_report;
  IF COALESCE(current_setting('ca.money_d_probe', true), '') = 'on' THEN
    RAISE EXCEPTION 'PROBE OK (rolled back): bank % -> %, % restorations of %', v_bank_before, v_bank_after, v_n, v_total;
  END IF;
END
$mig$;

COMMIT;
