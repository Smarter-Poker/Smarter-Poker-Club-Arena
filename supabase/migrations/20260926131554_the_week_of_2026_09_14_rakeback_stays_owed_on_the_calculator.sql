-- 20260926131554_the_week_of_2026_09_14_rakeback_stays_owed_on_the_calculator.sql
--
-- THE WEEK OF 2026-09-14 RAKEBACK STAYS OWED ON THE CALCULATOR'S BASIS, AND
-- THE FLOORED WEEK'S ACCOUNTING RETRIES ARE CLOSED (2026-09-26)
--
-- PART 1. THE RAKEBACK BASIS FOR THE WEEK 2026-09-14 07:00Z -> 2026-09-21 07:00Z.
--
-- DECISION (CLAUDE.md 10.9, delegated by Dan): the basis is the rule the code
-- already defines, the rate rule of fn_calculate_cash_rakeback_periods (the
-- member's deal, else the direct agent's offer, else the weekly-volume tier;
-- capped at the direct agent's rate - 0.10) applied to the terms observed at
-- earning time. 20260921082544 applied exactly that rule, reproduced the
-- calculator to 0.00 on every earning-time contract row, and recorded the
-- result on the two accounting_deferred_obligations rows: 138,303.43 owed
-- (Deep Stack Society 44,931.08, Midway Union 93,372.35; strictly observed
-- 134,439.33, the 5h06m head before agreement history began priced at its
-- earliest observed terms). pending_amount carries that figure and is not
-- changed here. The week remains OWED, exactly as Dan recorded when he moved
-- the settlement floor on 2026-09-20 ("The two skipped weeks are NOT written
-- off ... stays owed, for a separate one-off payment").
--
-- WHAT THIS SUPERSEDES. 20260926093159 appended "CLOSED WITHOUT PAYMENT" to
-- both rows and resolved the alert that way, because every recipient is a
-- horse. CLAUDE.md 10.5 forbids exactly that ("rakeback basis ... IS PAID
-- everything a human is paid ... never skip the horses on a repayment"), and
-- it contradicts the floor record. That write-off is void. Its measurement
-- stands as a fact: 97,577.72 of the owed amount (441,623.03 of basis) is
-- still derivable per player from the immutable earning contracts today,
-- because the hand-history pruner deleted the week's pre-cutover
-- rake_attributions before its 2026-09-25 fix (103,614.58 of rake no longer
-- has a per-player record).
--
-- WHY NO CHIP MOVES HERE. The code's own calculator refuses the week
-- (historical_week_before_observed_source_cutover, cutover 2026-09-17
-- 18:24:04Z), so no certified per-player payable exists for it, and the
-- per-player records for 103,614.58 of its rake are gone. Paying it needs a
-- one-off payer outside the certified path for 600+ accounts; inventing the
-- missing per-player shares is not allowed (10.9 rule 1). The obligation rows
-- are the durable record of what is owed and on what basis.
--
-- PART 2. THE FLOORED WEEK'S ACCOUNTING RETRIES (re-verified noise).
--
-- 276 weekly_club_accounting and 82 union_accounting_scheduler alerts, plus
-- their two drift_incident meta-alerts, are every open alert of those
-- sources. All 360 name the SAME week, 2026-09-07 07:00Z -> 2026-09-14 07:00Z,
-- and are the scheduler's repeated refusals of it (union_pnl_basis_uncertified
-- / week_precedes_complete_original_capture, union_rakeback_wrong_club,
-- standalone_weekly_payout_incomplete) between 09-14 and 09-18. Dan's
-- 2026-09-20 floor (union_settlement_floor.earliest_period_start 2026-09-21)
-- removed that week from the weekly close for good, and its owed rakeback is
-- carried by its own accounting_deferred_obligations rows. No alert of either
-- source has been raised since 2026-09-18. They are closed with that reason.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $mig$
DECLARE
  c_mig    CONSTANT text := '20260926131554_the_week_of_2026_09_14_rakeback_stays_owed_on_the_calculator';
  c_void   CONSTANT text := '20260926093159_the_week_of_2026_09_14_horse_rakeback_is_closed_by_dispositi';
  c_actor  CONSTANT uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
  c_dss    CONSTANT uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
  c_union  CONSTANT uuid := 'fade0000-0000-0000-0000-000000000001';
  v_note text; v_n int;
BEGIN
  ---------------------------------------------------------------------------
  -- PART 1. PRE-IMAGE.
  ---------------------------------------------------------------------------
  IF (SELECT count(*) FROM public.accounting_deferred_obligations
       WHERE period_start = '2026-09-14 07:00:00+00' AND period_end = '2026-09-21 07:00:00+00'
         AND ((scope_kind = 'club' AND scope_id = c_dss AND pending_amount = 44931.08)
           OR (scope_kind = 'union' AND scope_id = c_union AND pending_amount = 93372.35))
         AND position('DISPOSITION 2026-09-26 (migration ' || c_void IN reason) > 0
         AND position('SUPERSEDED 2026-09-26' IN reason) = 0) <> 2 THEN
    RAISE EXCEPTION 'rakeback basis pre-image: the two obligation rows no longer read 44,931.08 / 93,372.35 with the voided disposition and no supersession';
  END IF;
  IF (SELECT count(*) FROM public.financial_alerts
       WHERE source = 'deferred_rakeback_basis_2026_09_14'
         AND context->'disposition'->>'decision' = 'closed_without_payment'
         AND context->'disposition'->>'migration' = c_void
         AND (context->'disposition'->>'derivable_rakeback')::numeric = 97577.72
         AND NOT context ? 'basis_decision') <> 1 THEN
    RAISE EXCEPTION 'rakeback basis pre-image: the alert no longer carries the voided disposition';
  END IF;
  IF EXISTS (SELECT 1 FROM public.rakeback_period_payouts pp
               JOIN public.rakeback_periods rp ON rp.id = pp.rakeback_period_id
              WHERE rp.period_start = '2026-09-14') THEN
    RAISE EXCEPTION 'rakeback basis pre-image: the week has payouts after all';
  END IF;

  v_note := format(
    E'\n\nSUPERSEDED 2026-09-26 (migration %s): the "CLOSED WITHOUT PAYMENT" disposition of %s is VOID. It rested on every recipient being a horse, which CLAUDE.md 10.5 forbids, and it contradicted the 2026-09-20 floor record (the skipped weeks are not written off). '
    || 'DECIDED BASIS: the rate rule of fn_calculate_cash_rakeback_periods on terms observed at earning time, as applied by 20260921082544 (validated to 0.00 against the earning-time contracts). OWED: pending_amount (Deep Stack Society 44,931.08; Midway Union 93,372.35; 138,303.43 in all, strictly observed 134,439.33). '
    || 'Still derivable per player today from immutable earning contracts: 97,577.72 on 441,623.03 of basis; 103,614.58 of the week''s rake lost its per-player record to the pre-fix pruner. The certified calculator refuses the week (historical_week_before_observed_source_cutover), so it is paid only by a one-off payer; no chip moved.',
    c_mig, c_void);

  UPDATE public.accounting_deferred_obligations
     SET reason = reason || v_note
   WHERE period_start = '2026-09-14 07:00:00+00' AND period_end = '2026-09-21 07:00:00+00'
     AND ((scope_kind = 'club' AND scope_id = c_dss) OR (scope_kind = 'union' AND scope_id = c_union))
     AND position('SUPERSEDED 2026-09-26' IN reason) = 0;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 2 THEN RAISE EXCEPTION 'rakeback basis: expected the two obligation rows, updated %', v_n; END IF;

  UPDATE public.financial_alerts
     SET context = context || jsonb_build_object('basis_decision', jsonb_build_object(
           'migration', c_mig, 'decided_under', 'CLAUDE.md 10.9, delegated by Dan; 10.5',
           'voids', c_void, 'status', 'owed_not_written_off',
           'basis', 'fn_calculate_cash_rakeback_periods rate rule on earning-time terms (20260921082544)',
           'owed_total', 138303.43, 'owed_strictly_observed', 134439.33,
           'owed_by_scope', jsonb_build_object('club:' || c_dss::text, 44931.08, 'union:' || c_union::text, 93372.35),
           'derivable_per_player_today', 97577.72, 'rake_without_per_player_record', 103614.58,
           'chips_moved', 0)),
         resolution = 'Basis decided; the week stays OWED. ' || btrim(v_note),
         resolved = true, resolved_at = now(), resolved_by = c_actor
   WHERE source = 'deferred_rakeback_basis_2026_09_14' AND NOT context ? 'basis_decision';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'rakeback basis: expected one alert, updated %', v_n; END IF;

  ---------------------------------------------------------------------------
  -- PART 2. PRE-IMAGE: every open alert of the two sources names the floored week.
  ---------------------------------------------------------------------------
  IF (SELECT earliest_period_start FROM public.union_settlement_floor WHERE union_id = c_union)
       IS DISTINCT FROM '2026-09-21 07:00:00+00'::timestamptz THEN
    RAISE EXCEPTION 'accounting retries pre-image: the settlement floor is no longer 2026-09-21';
  END IF;
  IF (SELECT count(*) FROM public.accounting_deferred_obligations
       WHERE period_start = '2026-09-07 07:00:00+00' AND period_end = '2026-09-14 07:00:00+00') <> 2 THEN
    RAISE EXCEPTION 'accounting retries pre-image: the floored week no longer has its two deferred obligation rows';
  END IF;
  IF (SELECT count(*) FROM public.financial_alerts
       WHERE resolved = false AND source IN ('weekly_club_accounting', 'union_accounting_scheduler',
             'drift_incident:financial_alerts:weekly_club_accounting', 'drift_incident:financial_alerts:union_accounting_scheduler')) <> 360
     OR EXISTS (SELECT 1 FROM public.financial_alerts
       WHERE resolved = false AND source IN ('weekly_club_accounting', 'union_accounting_scheduler',
             'drift_incident:financial_alerts:weekly_club_accounting', 'drift_incident:financial_alerts:union_accounting_scheduler')
         AND (context->>'period_start' IS DISTINCT FROM '2026-09-07T07:00:00+00:00'
           OR context->>'period_end' IS DISTINCT FROM '2026-09-14T07:00:00+00:00'
           OR created_at >= '2026-09-19')) THEN
    RAISE EXCEPTION 'accounting retries pre-image: the open alerts are no longer exactly 360 refusals of the floored week 2026-09-07';
  END IF;

  UPDATE public.financial_alerts
     SET resolved = true, resolved_at = now(), resolved_by = c_actor,
         resolution = 'Closed as a superseded retry (re-verified 2026-09-26): a weekly-close refusal of the week 2026-09-07 07:00Z -> 2026-09-14 07:00Z, which Dan''s 2026-09-20 settlement floor (union_settlement_floor.earliest_period_start 2026-09-21) removed from the weekly close for good. The week''s owed rakeback is carried by its accounting_deferred_obligations rows, not by this alert. No alert of this source has been raised since 2026-09-18. Migration ' || c_mig || '.'
   WHERE resolved = false AND source IN ('weekly_club_accounting', 'union_accounting_scheduler',
         'drift_incident:financial_alerts:weekly_club_accounting', 'drift_incident:financial_alerts:union_accounting_scheduler')
     AND context->>'period_start' = '2026-09-07T07:00:00+00:00'
     AND context->>'period_end' = '2026-09-14T07:00:00+00:00';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 360 THEN RAISE EXCEPTION 'accounting retries: expected 360, closed %', v_n; END IF;

  RAISE NOTICE 'rakeback 09-14 basis recorded (owed 138,303.43); 360 floored-week retries closed';
  IF COALESCE(current_setting('ca.money_d_probe', true), '') = 'on' THEN
    RAISE EXCEPTION 'PROBE OK (rolled back): basis recorded on 2 rows + 1 alert; 360 retries closed';
  END IF;
END
$mig$;

COMMIT;
