-- 20260921080426_the_deferred_rakeback_obligation_states_its_measured_basis.sql
--
-- Version reserved by scripts/reserve-migration-version.sh against origin/main
-- and every remote branch, so it cannot collide with another agent's work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- 20260920232523 moved the weeks of 2026-09-07 and 2026-09-14 below the
-- settlement floor and recorded what they leave behind in
-- `accounting_deferred_obligations` as STILL OWED, awaiting a separate one-off
-- payment Dan authorises. That decision is correct and is not reopened here.
--
-- The DEFECT is what those rows COUNT. `pending_amount` was summed from the
-- pending `rakeback_periods` rows, and for the week of 2026-09-14 those rows
-- are understated: their writer is the legacy daily path, whose cache
-- (`rakeback_daily_user`) was last refreshed 2026-09-17 07:29 and then stopped,
-- so the stored figures cover roughly the first half of the week and nothing
-- after it. Measured on production while writing this file:
--
--   week 2026-09-14 07:00Z -> 2026-09-21 07:00Z, cash only, non-ghost-twin
--     rake_records cash rake                       615,843.40
--     of that, credited in rake_attributions       615,842.54  (3 records,
--     unattributed                                       0.86   are the rest)
--     stored in rakeback_periods (866 rows)        173,311.84  = 28.1%
--
--   by paying member club, from rake_attributions:
--     Deep Stack Society  238,816.96   (standalone scope)
--     SHARK CLUB          203,064.22 ) Midway Union scope,
--     Club JAQK           173,961.36 ) together 377,025.58
--
-- So a reader who takes `pending_amount` (26,542.66 for that week) as the debt
-- and pays it would discharge an obligation measured on 28% of the week. The
-- numbers stay as observed - they are a true observation of the legacy rows at
-- `observed_at`, and falsifying an observation is not a correction - but the
-- `reason` each row carries now states the measured basis, the coverage, and
-- the one thing that cannot be derived.
--
-- WHAT CANNOT BE DERIVED, AND WHY THIS IS NOT SETTLED HERE. A payable needs a
-- per-player RATE observed at the time it was earned.
-- `accounting_agreement_history` holds NO observation before 2026-09-14
-- 12:09:27Z and none at all for the week of 2026-09-07, so the contracts in
-- force across these weeks were never recorded. Applying today's membership
-- rates to historical earning would be an assumption presented as a decision,
-- which is the exact failure CLAUDE.md 10.5 and 10.9 were written about. Under
-- 10.9 the basis is READ and the payable is NOT, so the path is not clear and
-- the amount goes to Dan as options with costs, never as a question. No chips
-- move in this file and no `rakeback_periods` row is touched.
--
-- THE WEEK OF 2026-09-07 IS THE OPPOSITE CASE and its `reason` says so, to stop
-- the next reader re-deriving it the way this file derives 09-14:
-- `rake_attributions` covers only 43,754 of its 494,915 cash records (8.8%),
-- leaving 813,123.18 of 879,994.89 cash rake uncredited, because the
-- attribution ledger only became complete during the following week. For that
-- week the attribution total (66,871.71) is NOT the basis and the legacy
-- allocator figures already recorded are the better evidence.
--
-- NO REPAIR JOB, NO SWEEP, NO BACKFILL, NO CRON is created here, and under
-- CLAUDE.md 10.12 none may be. This file records a measurement and raises the
-- obligation where a person will see it.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload (~28s on this database). This file is pure
-- DML and fires none, but the single transaction still applies.
--
-- @live-proof: (SELECT count(*) FROM public.accounting_deferred_obligations WHERE reason LIKE '%MEASURED 2026-09-21%')=4 AND (SELECT count(*) FROM public.financial_alerts WHERE source='deferred_rakeback_basis_2026_09_14' AND resolved_at IS NULL)=1

BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='300s';

-- ---------------------------------------------------------------------------
-- The state this correction is built on. READ, and asserted, so that if the
-- board moved since these numbers were measured the whole file aborts and
-- changes nothing (CLAUDE.md 10.9 test 4).
-- ---------------------------------------------------------------------------
DO $preconditions$
DECLARE
  v_basis numeric; v_stored numeric; v_rows bigint; v_certs bigint;
  v_union_floor timestamptz; v_club_floor timestamptz; v_cutover timestamptz;
  v_from timestamptz := '2026-09-14'::timestamp AT TIME ZONE 'America/Los_Angeles';
  v_to   timestamptz := '2026-09-21'::timestamp AT TIME ZONE 'America/Los_Angeles';
BEGIN
  IF to_regclass('public.accounting_deferred_obligations') IS NULL THEN
    RAISE EXCEPTION 'deferred_obligation_table_absent' USING ERRCODE='55000';
  END IF;

  -- The floors that put these weeks out of scope must still be where
  -- 20260920232523 put them. If they moved, this file's premise is gone.
  SELECT earliest_period_start INTO v_union_floor FROM public.union_settlement_floor
   WHERE union_id='fade0000-0000-0000-0000-000000000001'::uuid;
  SELECT earliest_period_start INTO v_club_floor FROM public.club_settlement_floor
   WHERE club_id='2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid;
  IF v_union_floor IS DISTINCT FROM timestamptz '2026-09-21T07:00:00Z'
     OR v_club_floor IS DISTINCT FROM timestamptz '2026-09-21T07:00:00Z' THEN
    RAISE EXCEPTION 'settlement_floor_moved' USING ERRCODE='55000';
  END IF;

  SELECT starts_at INTO v_cutover FROM public.accounting_cash_accrual_cutover;
  IF v_cutover IS DISTINCT FROM timestamptz '2026-09-17T18:24:04.643251Z' THEN
    RAISE EXCEPTION 'accrual_cutover_moved' USING ERRCODE='55000';
  END IF;

  -- Nothing has certified this week since it was measured.
  SELECT count(*) INTO v_certs FROM public.accounting_rakeback_period_calculations
   WHERE period_start IN (DATE '2026-09-07', DATE '2026-09-14');
  IF v_certs <> 0 THEN
    RAISE EXCEPTION 'week_has_been_certified_since_measurement' USING ERRCODE='55000';
  END IF;

  -- The four obligation rows, exactly as 20260920232523 recorded them.
  IF (SELECT count(*) FROM public.accounting_deferred_obligations) <> 4 THEN
    RAISE EXCEPTION 'unexpected_deferred_obligation_population' USING ERRCODE='55000';
  END IF;

  -- The measured basis. If live data has moved, abort rather than write a
  -- number this file no longer stands behind.
  SELECT round(COALESCE(sum(a.weighted_rake_credit),0),2) INTO v_basis
    FROM public.rake_attributions a
    JOIN public.rake_records r ON r.id=a.rake_record_id AND r.hand_id=a.hand_id
   WHERE r.created_at>=v_from AND r.created_at<v_to AND r.rake_amount>0
     AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL
     AND NOT public.fn_rake_record_is_ghost_twin(r.hand_id,r.table_id,r.metadata);
  IF v_basis IS DISTINCT FROM 615842.54 THEN
    RAISE EXCEPTION 'measured_basis_moved: got %, expected 615842.54', v_basis USING ERRCODE='55000';
  END IF;

  SELECT count(*), round(COALESCE(sum(rake_generated),0),2)
    INTO v_rows, v_stored
    FROM public.rakeback_periods WHERE period_start=DATE '2026-09-14';
  IF v_rows <> 866 OR v_stored IS DISTINCT FROM 173311.84 THEN
    RAISE EXCEPTION 'stored_period_figures_moved: % rows, basis %', v_rows, v_stored USING ERRCODE='55000';
  END IF;
END $preconditions$;

-- ---------------------------------------------------------------------------
-- The week of 2026-09-14: the recorded amount is a FLOOR on 28.1% of the week.
-- `pending_amount`, `pending_periods` and `observed_at` are left exactly as
-- observed. Only the explanation changes.
-- ---------------------------------------------------------------------------
UPDATE public.accounting_deferred_obligations o
   SET reason = o.reason || E'\n\n'
     || 'MEASURED 2026-09-21: THE AMOUNT ABOVE IS A FLOOR, NOT THE DEBT. '
     || 'pending_amount was summed from pending rakeback_periods rows written by '
     || 'the legacy daily path, whose cache (rakeback_daily_user) last refreshed '
     || '2026-09-17 07:29Z and then stopped, so those rows cover only the first '
     || 'part of the week. Measured from rake_attributions, the complete source '
     || 'for this week (615,842.54 of 615,843.40 cash rake credited; 3 records / '
     || '0.86 uncredited), the week basis is 615,842.54 against 173,311.84 stored '
     || '= 28.1% coverage. By paying member club: Deep Stack Society 238,816.96; '
     || 'SHARK CLUB 203,064.22 and Club JAQK 173,961.36 (together 377,025.58 under '
     || 'Midway Union). Horses are counted throughout (CLAUDE.md 10.5); every one '
     || 'of the 674 players in this basis is a horse and none is filtered. '
     || 'THE PAYABLE IS NOT DERIVABLE: accounting_agreement_history holds no '
     || 'observation before 2026-09-14 12:09:27Z, so no per-player rate observed '
     || 'at earning time exists for this week. Applying current rates would be an '
     || 'assumption, not a reading. The amount owed is Dan''s decision; this row '
     || 'must not be discharged by paying pending_amount.'
 WHERE o.period_start = timestamptz '2026-09-14T07:00:00Z'
   AND o.period_end   = timestamptz '2026-09-21T07:00:00Z'
   AND o.reason NOT LIKE '%MEASURED 2026-09-21%';

-- ---------------------------------------------------------------------------
-- The week of 2026-09-07: the opposite case. Say so, so the next reader does
-- not re-derive it from an attribution ledger that is 8.8% complete.
-- ---------------------------------------------------------------------------
UPDATE public.accounting_deferred_obligations o
   SET reason = o.reason || E'\n\n'
     || 'MEASURED 2026-09-21: DO NOT RE-DERIVE THIS WEEK FROM rake_attributions. '
     || 'That ledger covers only 43,754 of this week''s 494,915 cash records '
     || '(8.8%), leaving 813,123.18 of 879,994.89 cash rake uncredited, because '
     || 'attribution only became complete during the following week. Its total '
     || 'for this week (66,871.71) is therefore NOT the basis. The legacy '
     || 'allocator figures already summed into pending_amount are the better '
     || 'evidence here. As with the week of 2026-09-14, no per-player rate '
     || 'observed at earning time exists (accounting_agreement_history begins '
     || '2026-09-14 12:09:27Z), so the amount owed is Dan''s decision.'
 WHERE o.period_start = timestamptz '2026-09-07T07:00:00Z'
   AND o.period_end   = timestamptz '2026-09-14T07:00:00Z'
   AND o.reason NOT LIKE '%MEASURED 2026-09-21%';

-- ---------------------------------------------------------------------------
-- Give the obligation a reader. This is NOT offered as the fix (CLAUDE.md
-- 10.11): the fix is that the recorded reason can no longer mislead. This row
-- exists because a debt that only a person can authorise needs that person to
-- see it, and it stays OPEN until that payment is made.
-- ---------------------------------------------------------------------------
INSERT INTO public.financial_alerts(source, severity, message, context)
SELECT 'deferred_rakeback_basis_2026_09_14', 'warning',
  'Deferred rakeback for 2026-09-14 is recorded on 28.1% of the week; the amount owed needs a decision',
  jsonb_build_object(
    'period_start', timestamptz '2026-09-14T07:00:00Z',
    'period_end',   timestamptz '2026-09-21T07:00:00Z',
    'measured_cash_basis', 615843.40,
    'measured_attributed_basis', 615842.54,
    'stored_period_basis', 173311.84,
    'stored_period_amount', 26542.66,
    'coverage_pct', 28.1,
    'by_paying_club', jsonb_build_object(
      'Deep Stack Society', 238816.96,
      'SHARK CLUB', 203064.22,
      'Club JAQK', 173961.36),
    'payable_derivable', false,
    'why_not_derivable', 'accounting_agreement_history holds no observation before 2026-09-14 12:09:27Z, so no per-player rate observed at earning time exists for this week',
    'decision_owner', 'Dan',
    'no_chips_moved', true)
WHERE NOT EXISTS (
  SELECT 1 FROM public.financial_alerts
   WHERE source='deferred_rakeback_basis_2026_09_14' AND resolved_at IS NULL);

-- ---------------------------------------------------------------------------
-- Prove the file did what it says, in the same transaction that did it.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE v_marked bigint; v_alert bigint; v_periods_touched bigint;
BEGIN
  SELECT count(*) INTO v_marked FROM public.accounting_deferred_obligations
   WHERE reason LIKE '%MEASURED 2026-09-21%';
  IF v_marked <> 4 THEN
    RAISE EXCEPTION 'expected_four_annotated_obligations_got_%', v_marked USING ERRCODE='55000';
  END IF;

  SELECT count(*) INTO v_alert FROM public.financial_alerts
   WHERE source='deferred_rakeback_basis_2026_09_14' AND resolved_at IS NULL;
  IF v_alert <> 1 THEN
    RAISE EXCEPTION 'expected_one_open_alert_got_%', v_alert USING ERRCODE='55000';
  END IF;

  -- Nothing here may touch a period or a wallet.
  SELECT count(*) INTO v_periods_touched FROM public.rakeback_periods
   WHERE period_start=DATE '2026-09-14' AND status<>'pending';
  IF v_periods_touched <> 0 THEN
    RAISE EXCEPTION 'a_period_changed_status_and_must_not_have' USING ERRCODE='55000';
  END IF;
END $verify$;

COMMIT;
