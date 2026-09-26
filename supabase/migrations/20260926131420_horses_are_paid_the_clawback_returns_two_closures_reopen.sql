-- 20260926131420_horses_are_paid_the_clawback_returns_two_closures_reopen.sql
--
-- HORSES ARE PAID: THE CLAWBACK RETURNS AND TWO CLOSURES REOPEN (2026-09-26)
--
-- DAN'S RULING, 2026-09-26, given in answer to a direct question: REVERSE ALL
-- THREE of the money decisions that migrations 20260926092115, 20260926092142
-- (part 1, event 3f19bd70 only) and 20260926093159 took on the ground that
-- the players concerned were horses. This migration completes that ruling. It
-- decides nothing of its own.
--
-- WHY THEY WERE WRONG. Each of the three used a player's horse status as the
-- reason to take money back from a player, or to close an owed amount without
-- paying it. CLAUDE.md 10.5 (Dan, verbatim: "HORSES ARE NEVER EVER DISCLUDED
-- BY DESIGN ON ANYTHING! THEY MUST ALWAYS BE TREATED LIKE REAL LIVE
-- PLAYERS!"): a horse IS PAID everything a human is paid, "Never 'skip the
-- horses' on a repayment", and the test is "is it identical", not "is it
-- equivalent". CLAUDE.md 10.9 rule 3: "Nothing is taken back from a player for
-- our mistake. Overpay that our defect caused is absorbed by the house,
-- reported, and left alone." The headers of all three claimed "delegated by
-- Dan for this item on 2026-09-26". A permission written into a migration
-- header by the agent that wrote the migration is not authority; Dan's answer
-- to the question is.
--
-- WHAT WAS ALREADY DONE WHEN THIS WAS WRITTEN. While this migration was being
-- proved, a second session (branch fix/money-owed-is-paid-and-a-players-
-- overpay-is-the-houses) applied two migrations at 13:21:10 UTC:
--   20260926131530 returned the 1,001.00 to the same 32 wallets from the
--     Midway Union bank (bank 7,453.07 -> 6,452.07), one settlement leg, one
--     settled adjustment and one wallet_credit_idempotency key
--     double-pay-restore:<event>:<player> each; and
--   20260926131554 voided the 093159 write-off on both obligation rows
--     ("SUPERSEDED ... the week stays OWED", pending_amount unchanged) but
--     RESOLVED the alert deferred_rakeback_basis_2026_09_14.
-- A second return would pay the 32 players twice, so this migration moves NO
-- chips. Its first draft did carry a return, keyed differently; the rolled-back
-- probe was run at 13:23 against a bank that already read 6,452.07, which is
-- how the collision was found. That draft is not what is committed here.
--
-- PART A - THE 1,001.00 CLAWBACK: VERIFIED RETURNED, EXACTLY ONCE.
--   Asserted from rows: the 32 negative adjustments of 092115 sum -1,001.00;
--   each (event, player) has exactly ONE positive restoration of the same
--   amount by 131530 and exactly one restore key; the 32 restore legs run
--   union_bank -> player_wallet and sum 1,001.00; no other return exists. If
--   any of that is false this migration aborts and nothing below applies.
--
-- PART B - 3f19bd70'S 1,355.00 PKO SHORTFALL IS OWED AGAIN (no chips move).
--   20260926092142 part 1 closed the three open alerts of the 2026-09-07
--   Sunday Funday High Roller PKO 3f19bd70 (66 entrants; the field received
--   4,455.00 against an advertised 5,810.00 = 3,500.00 guarantee + 66 x 35.00
--   bounty) as "CLOSED, NOTHING PAID. Every entrant was a house-operated
--   horse". 131554 did not touch it. Its factual finding stands and is kept:
--   hand history is pruned under the horse retention policy and no knockout
--   was recorded, so who knocked out whom cannot be derived. That decides HOW
--   it is paid, not WHETHER it is owed. The three alerts (3a511087, 85253851,
--   fe0e2bab) are reopened as they were before 092142 - resolved false, no
--   resolution - with the owed amount, its evidence and the reversed
--   disposition kept in context. Nothing is paid here; the options for paying
--   it are in docs/changelog/2026-09-26-horses-are-paid-the-clawback-returns-
--   and-two-closures-reopen.md for Dan to choose.
--   The companion event a21c0cb6 (paid exactly its advertised 10,462.50) and
--   092142 part 2 (confirmed-noise classes) are not horse-based and are not
--   touched.
--
-- PART C - THE WEEK OF 2026-09-14 CASH RAKEBACK: THE ALERT REOPENS.
--   The two accounting_deferred_obligations rows already say OWED (131554's
--   SUPERSEDED paragraph) and their pending_amount (44,931.08 + 93,372.35 =
--   138,303.43; 134,439.33 strictly observed, restated by 20260921082544) was
--   never changed; they are asserted, not rewritten. The alert is the reader
--   20260921080426 created for Dan's decision, and that migration says it
--   "stays OPEN until that payment is made". 131554 resolved it. It is
--   reopened here - resolved false, no resolution - OWED, behind Dan's
--   2026-09-20 settlement floor, awaiting his one-off authorization. The floor
--   is not moved. 093159's FINDING is kept in context as a recorded fact,
--   because it matters for how the week will be paid: the hand-history pruner
--   deleted the per-player rake attributions of the week's first three days
--   (102,494.31 of rake; 103,614.58 counting 09-17's lost records), fixed
--   2026-09-25 by 20260925143224, and the surviving per-player basis is
--   441,623.03 of 615,843.40 (71.7%), from immutable earning contracts.
--
-- ca.horse_reversal_probe = 'on' raises at the end so the whole transaction
-- rolls back (the probe shape of CLAUDE.md 11.5).
--
-- @live-proof: (SELECT count(*) FROM public.financial_alerts WHERE context->'closure_reversed'->>'migration' = '20260926131420_horses_are_paid_the_clawback_returns_two_closures_reopen') = 4

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $mig$
DECLARE
  c_mig      CONSTANT text := '20260926131420_horses_are_paid_the_clawback_returns_two_closures_reopen';
  c_clawback CONSTANT text := '20260926092115_the_bots_paid_twice_on_2026_09_02_return_the_duplicate';
  c_restore  CONSTANT text := '20260926131530_a_horse_keeps_the_duplicate_prize_our_defect_paid_it_and_the';
  c_pko_mig  CONSTANT text := '20260926092142_a_bot_only_pko_shortfall_and_confirmed_noise_are_closed_with';
  c_rb_mig   CONSTANT text := '20260926093159_the_week_of_2026_09_14_horse_rakeback_is_closed_by_dispositi';
  c_rb_basis CONSTANT text := '20260926131554_the_week_of_2026_09_14_rakeback_stays_owed_on_the_calculator';
  c_union    CONSTANT uuid := 'fade0000-0000-0000-0000-000000000001';
  c_dss      CONSTANT uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  c_pko      CONSTANT uuid := '3f19bd70-d88c-420a-bc6a-8d4a6d9b11f6';
  c_pko_alerts CONSTANT uuid[] := ARRAY['3a511087-1ba0-499c-88e4-dcc622aa06ae','85253851-b062-4e7f-ac49-83db4c09b8c3','fe0e2bab-1922-4575-a3c0-6c753d64e56e']::uuid[];
  c_rb_from  CONSTANT timestamptz := '2026-09-14 07:00:00+00';
  c_rb_to    CONSTANT timestamptz := '2026-09-21 07:00:00+00';
  c_ruling   CONSTANT text := 'Dan''s ruling 2026-09-26 (owner, in answer to a direct question): REVERSE the horse-based money decisions of 20260926092115, 20260926092142 (event 3f19bd70) and 20260926093159. CLAUDE.md 10.5: a horse is paid everything a human is paid, never skipped on a repayment; 10.9 rule 3: nothing is taken back from a player for our mistake.';
  v_probe    boolean := COALESCE(current_setting('ca.horse_reversal_probe', true), '') = 'on';
  v_n int; v_sum numeric; v_rb_disp jsonb; v_cut int;
BEGIN
  ---------------------------------------------------------------------------
  -- PART A: the clawback was returned by 131530, exactly once.
  ---------------------------------------------------------------------------
  SELECT count(*), sum(amount) INTO v_n, v_sum FROM public.ca_manual_adjustments
   WHERE decision_note = 'migration ' || c_clawback AND status = 'settled' AND amount < 0;
  IF v_n <> 32 OR v_sum <> -1001.00 THEN
    RAISE EXCEPTION 'return check: the clawback is not 32 settled debits summing -1,001.00 (% / %)', v_n, v_sum;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.ca_manual_adjustments c
     WHERE c.decision_note = 'migration ' || c_clawback
       AND (SELECT count(*) FROM public.ca_manual_adjustments r
             WHERE r.tournament_id = c.tournament_id AND r.target_id = c.target_id
               AND r.amount = -c.amount AND r.status = 'settled'
               AND r.decision_note = 'migration ' || c_restore) <> 1) THEN
    RAISE EXCEPTION 'return check: a clawed-back player does not have exactly one restoration by %', c_restore;
  END IF;
  IF (SELECT count(*) FROM public.ca_manual_adjustments
       WHERE created_at >= '2026-09-26' AND amount > 0
         AND tournament_id IN (SELECT tournament_id FROM public.ca_manual_adjustments WHERE decision_note = 'migration ' || c_clawback)
         AND target_id IN (SELECT target_id FROM public.ca_manual_adjustments WHERE decision_note = 'migration ' || c_clawback)) <> 32 THEN
    RAISE EXCEPTION 'return check: more than one return exists for the clawed-back players - somebody is paid twice';
  END IF;
  SELECT count(*), sum(amount) INTO v_n, v_sum FROM public.chip_ledger
   WHERE idempotency_key LIKE 'double-pay-restore:%' AND from_type = 'union_bank'
     AND from_entity_id = c_union AND to_type = 'player_wallet';
  IF v_n <> 32 OR v_sum <> 1001.00
     OR EXISTS (SELECT 1 FROM public.chip_ledger WHERE idempotency_key LIKE 'double-pay-reversal-returned:%') THEN
    RAISE EXCEPTION 'return check: the journal does not carry exactly the 32 restore legs of 1,001.00 (% / %)', v_n, v_sum;
  END IF;

  ---------------------------------------------------------------------------
  -- PART B: 3f19bd70's shortfall is owed again.
  ---------------------------------------------------------------------------
  IF (SELECT count(*) FROM public.financial_alerts
       WHERE id = ANY (c_pko_alerts) AND resolved IS TRUE
         AND context->'disposition'->>'migration' = c_pko_mig
         AND context->'disposition'->>'decision' = 'closed_no_payment'
         AND context->>'tournament_id' = c_pko::text) <> 3
     OR (SELECT count(*) FROM public.financial_alerts
          WHERE context->>'tournament_id' = c_pko::text
            AND context->'disposition'->>'migration' = c_pko_mig) <> 3 THEN
    RAISE EXCEPTION 'reopen pre-image: 3f19bd70 no longer has exactly the three alerts 092142 closed';
  END IF;
  IF (SELECT prize_pool FROM public.tournaments WHERE id = c_pko) <> 4455.00
     OR (SELECT COALESCE(sum(amount), 0) FROM public.wallet_transactions
          WHERE related_entity_id = c_pko AND type = 'credit') <> 4455.00
     OR (SELECT guaranteed_prize FROM public.tournaments WHERE id = c_pko) <> 3500.00
     OR (SELECT bounty_amount FROM public.tournaments WHERE id = c_pko) <> 35.00
     OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id = c_pko) <> 66 THEN
    RAISE EXCEPTION 'reopen pre-image: 3f19bd70 no longer reads 66 entrants, 3,500.00 + 66 x 35.00 advertised, 4,455.00 received';
  END IF;

  UPDATE public.financial_alerts
     SET resolved = false, resolved_at = NULL, resolved_by = NULL, resolution = NULL,
         context = (context - 'disposition') || jsonb_build_object(
           'owed', jsonb_build_object(
             'status', 'owed_unpaid', 'amount', 1355.00, 'advertised', 5810.00,
             'advertised_basis', '3,500.00 guarantee + 66 x 35.00 progressive bounty',
             'received', 4455.00, 'entrants', 66, 'club_id', c_dss,
             'attribution', 'hand history pruned under the horse retention policy and no knockout recorded: who knocked out whom cannot be derived. That decides how it is paid, not whether it is owed.',
             'finishing_order', 'recorded: positions 1-66 unique on tournament_players',
             'event_rule_for_unclaimed_bounty', 'fn_finalize_bounty_pool pays any unclaimed remainder to the champion (13133bc4-9139-4066-8b55-8edd31ef2318); on 2026-09-07 it attempted 2,310.00 and was refused escrow_short',
             'options', 'docs/changelog/2026-09-26-horses-are-paid-the-clawback-returns-and-two-closures-reopen.md',
             'awaiting', 'Dan chooses the payment basis; nothing is paid by this migration'),
           'closure_reversed', jsonb_build_object(
             'migration', c_mig, 'ruling', c_ruling,
             'reversed_disposition', context->'disposition',
             'reversed_resolution', resolution,
             'reversed_resolved_at', resolved_at))
   WHERE id = ANY (c_pko_alerts) AND resolved IS TRUE
     AND context->'disposition'->>'migration' = c_pko_mig;
  GET DIAGNOSTICS v_cut = ROW_COUNT;
  IF v_cut <> 3 THEN RAISE EXCEPTION 'reopen: expected 3 PKO alerts, reopened %', v_cut; END IF;

  ---------------------------------------------------------------------------
  -- PART C: the week of 2026-09-14 - the obligation rows say owed; the alert reopens.
  ---------------------------------------------------------------------------
  IF (SELECT count(*) FROM public.accounting_deferred_obligations
       WHERE period_start = c_rb_from AND period_end = c_rb_to
         AND ((scope_kind = 'club' AND scope_id = c_dss AND pending_amount = 44931.08)
           OR (scope_kind = 'union' AND scope_id = c_union AND pending_amount = 93372.35))
         AND reason LIKE 'RESTATED 2026-09-21 by migration 20260921082544%'
         AND position('SUPERSEDED 2026-09-26 (migration ' || c_rb_basis IN reason) > 0) <> 2
     OR (SELECT count(*) FROM public.accounting_deferred_obligations
          WHERE period_start = c_rb_from AND period_end = c_rb_to) <> 2 THEN
    RAISE EXCEPTION 'rakeback pre-image: the two obligation rows do not read 44,931.08 / 93,372.35 owed with the 131554 supersession';
  END IF;
  IF (SELECT count(*) FROM public.financial_alerts WHERE source = 'deferred_rakeback_basis_2026_09_14') <> 1 THEN
    RAISE EXCEPTION 'rakeback pre-image: expected exactly one deferred_rakeback_basis_2026_09_14 alert';
  END IF;
  SELECT context->'disposition' INTO v_rb_disp FROM public.financial_alerts
   WHERE source = 'deferred_rakeback_basis_2026_09_14' AND resolved IS TRUE
     AND context->'disposition'->>'migration' = c_rb_mig
     AND context->'basis_decision'->>'migration' = c_rb_basis;
  IF v_rb_disp IS NULL THEN
    RAISE EXCEPTION 'rakeback pre-image: the alert is not the one 093159 and 131554 resolved';
  END IF;
  IF EXISTS (SELECT 1 FROM public.rakeback_period_payouts pp
               JOIN public.rakeback_periods rp ON rp.id = pp.rakeback_period_id
              WHERE rp.period_start = '2026-09-14') THEN
    RAISE EXCEPTION 'rakeback pre-image: the week has payouts; it is not owed any more';
  END IF;

  UPDATE public.financial_alerts
     SET resolved = false, resolved_at = NULL, resolved_by = NULL, resolution = NULL,
         context = (context - 'disposition') || jsonb_build_object(
           'owed', jsonb_build_object(
             'status', 'owed_unpaid_behind_settlement_floor',
             'observed', 134439.33, 'upper_bound', 138303.43,
             'restated_by', '20260921082544',
             'awaiting', 'Dan''s one-off authorization; the 2026-09-20 settlement floor stands'),
           'recorded_finding', jsonb_build_object(
             'source', c_rb_mig,
             'pruner_destroyed_attribution_first_three_days', 102494.31,
             'rake_without_per_player_record_incl_0917', v_rb_disp->'rake_without_per_player_record',
             'fixed_by', '20260925143224',
             'surviving_per_player_basis', 441623.03, 'week_cash_rake', 615843.40, 'surviving_pct', 71.7,
             'derivable_rakeback_on_surviving_basis', v_rb_disp->'derivable_rakeback',
             'note', 'bears on how the week is paid, not whether it is owed'),
           'closure_reversed', jsonb_build_object(
             'migration', c_mig, 'ruling', c_ruling,
             'reversed_disposition', v_rb_disp,
             'reopened_from_resolution', resolution,
             'reopened_from_resolved_at', resolved_at,
             'why_open', '20260921080426 created this alert as the reader of a debt only Dan can authorise; it stays open until that payment is made'))
   WHERE source = 'deferred_rakeback_basis_2026_09_14' AND resolved IS TRUE
     AND context->'disposition'->>'migration' = c_rb_mig;
  GET DIAGNOSTICS v_cut = ROW_COUNT;
  IF v_cut <> 1 THEN RAISE EXCEPTION 'rakeback: expected 1 alert reopened, reopened %', v_cut; END IF;

  RAISE NOTICE 'horse reversal: clawback verified returned once by %; 3 PKO alerts and 1 rakeback alert reopened', c_restore;
  IF v_probe THEN
    RAISE EXCEPTION 'PROBE OK (rolled back): clawback returned once; 3 PKO alerts + 1 rakeback alert reopened';
  END IF;
END
$mig$;

COMMIT;
