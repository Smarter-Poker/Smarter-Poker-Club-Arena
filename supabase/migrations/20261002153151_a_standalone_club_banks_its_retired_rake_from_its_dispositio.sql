-- 20261002153151_a_standalone_club_banks_its_retired_rake_from_its_dispositio.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- SUPERSEDES 20261002145829 (merged, never installed). Its first install
-- attempt at 15:26 UTC summed the retired legs from chip_ledger, a cold-cache
-- scan of millions of rows that ran past the 120 s apply budget while the first
-- week's treasury credit already held Deep Stack Society's clubs row, and about
-- 330 engine statements timed out before it rolled back. Nothing committed.
-- This version reads the same amounts from the two immutable DISPOSITION
-- RECEIPTS the hand paths write with each retirement leg, which are indexed by
-- week (0.6 s for a full week, measured), and takes lock_timeout 15 s:
--   cash: accounting_cash_bank_receipts (union_id IS NULL, club, banked_at);
--         the receipt's amount equals its retirement leg by construction.
--   fees: tournament_rake_settlements (destination chip_retirement:<club>,
--         settled_at); one row per tournament, written with its fee legs.
-- Both equal the chip_ledger retirement legs to the cent for every closed week
-- (09-14: 185,562.68 / 52,545.90; 09-21: 279,799.97 / 89,356.54).
--
-- WHAT THIS CHANGES, AND WHY:
--
-- A standalone (or private) game's rake has been RETIRED at the hand since
-- 20260917181100: atomic_distribute_rake writes table_stack -> chip_retirement
-- ('Standalone cash rake retired') with an accounting_cash_bank_receipts row,
-- and fn_settle_tournament_rake writes prize_liability -> chip_retirement
-- ('Standalone tournament fee retired'). Meanwhile the standalone weekly close
-- (fn_process_weekly_accounting_scope, club branch) still pays round 2
-- commission and round 3 rakeback out of clubs.chip_treasury. So the treasury
-- paid every week's commission and never received the rake it was earned on:
-- Deep Stack Society retired 989,904.00 of rake from 2026-09-17 to 2026-10-02
-- 15:00 UTC while paying 522,102.61 of commission (316,931.84 on 2026-09-29,
-- 205,170.77 on 2026-10-02) from a treasury with no inflow, and it reached zero.
-- .agent/architecture/CLUB-MONEY-LEDGERS-CANONICAL.md: a standalone club's rake
-- settles to chip_treasury, the operational bank that pays its commission.
--
-- Crediting the treasury per hand is the clubs-row lock 20260929040413 removed
-- after measured HandProjection timeouts, so the rake is banked ONCE A WEEK
-- instead, the way a union club's share arrives in the union close:
--
--   fn_bank_standalone_week_rake(club, week) sums the disposition receipts of
--   the rake the hand paths retired for that club in that week (cash bank
--   receipts, standalone tournament fee settlements) and credits
--   that sum to the club treasury through the sanctioned issuance door
--   fn_ca_fund_club (system_mint -> club_treasury leg, ca_mint_ledger register
--   row with the reason, idempotency key standalone-rake-bank:<club>:<week>).
--   Supply is conserved over the week: what the hands retired, the close
--   re-issues to the bank that owns it. A replay is a no-op by key.
--
--   fn_process_weekly_accounting_scope calls it in the standalone branch,
--   inside the same money block, AFTER preparation and the commission-period
--   assertion and BEFORE round 2 pays commission. If any later stage refuses,
--   the whole block rolls back, bank included, and the next visit banks again
--   under the same key. Nothing else in the coordinator changes: the
--   head-of-line EXIT rule, the attempt budget, the minute-45 guard and the
--   union branch are byte-for-byte as they were (asserted below).
--
-- BACKLOG. The closed weeks whose commission was already paid from the
-- treasury are banked here once, from the same ledger proof:
--   week 2026-09-14 (legs from 2026-09-17 18:11): cash 185,562.68 + fees
--     52,545.90 = 238,108.58
--   week 2026-09-21: cash 279,799.97 + fees 89,356.54 = 369,156.51
--   total 607,265.09 to Deep Stack Society, the only club with retired
--   standalone rake. Week 2026-09-28 is banked by its own close on 2026-10-05
--   (382,640.81 retired by 15:00 UTC 2026-10-02). Nothing is credited for rake
--   before 20260917181100: until then it was credited to the treasury per hand.
--   The two direct top-ups of 2026-10-02 (49,255.53, system_mint) stay recorded
--   as they are.

BEGIN;

SET LOCAL lock_timeout = '15s';

CREATE FUNCTION public.fn_bank_standalone_week_rake(
  p_club_id uuid, p_period_start timestamptz, p_period_end timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_name text;
  v_cash numeric;
  v_fees numeric;
  v_total numeric;
  v_key text;
  v_res jsonb;
  v_cat text := COALESCE(current_setting('app.ledger_category', true), '');
  v_cp text := COALESCE(current_setting('app.ledger_counterparty', true), '');
  v_cpe text := COALESCE(current_setting('app.ledger_counterparty_entity', true), '');
  v_idem text := COALESCE(current_setting('app.ledger_idempotency_key', true), '');
BEGIN
  IF NOT public.fn_caller_is_engine() THEN
    RAISE EXCEPTION 'not_authorised' USING ERRCODE = '42501';
  END IF;
  IF p_club_id IS NULL OR p_period_start IS NULL OR p_period_end IS NULL
     OR p_period_start <> public.fn_union_week_start(p_period_start)
     OR p_period_end <> public.fn_union_week_start(p_period_start + interval '8 days')
     OR p_period_end > public.fn_union_week_start(clock_timestamp()) THEN
    RAISE EXCEPTION 'standalone_rake_bank_invalid_week' USING ERRCODE = '22023';
  END IF;
  SELECT c.name INTO v_name FROM public.clubs c
   WHERE c.id = p_club_id AND c.is_union IS NOT TRUE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'standalone_rake_bank_unknown_club' USING ERRCODE = '22023';
  END IF;

  -- Cash: the standalone bank receipt every retired cash rake leg carries.
  SELECT COALESCE(sum(b.amount), 0) INTO v_cash
    FROM public.accounting_cash_bank_receipts b
   WHERE b.union_id IS NULL AND b.club_id = p_club_id
     AND b.club_ledger_id IS NOT NULL
     AND b.banked_at >= p_period_start AND b.banked_at < p_period_end;
  -- Tournament fees: the settlement row of every standalone fee retirement.
  SELECT COALESCE(sum(s.amount), 0) INTO v_fees
    FROM public.tournament_rake_settlements s
   WHERE s.destination = 'chip_retirement:' || p_club_id::text
     AND s.settled_at >= p_period_start AND s.settled_at < p_period_end;
  v_total := v_cash + v_fees;
  IF v_total <= 0 THEN
    RETURN jsonb_build_object('ok', true, 'amount', 0, 'club_id', p_club_id,
      'period_start', p_period_start, 'period_end', p_period_end);
  END IF;

  v_key := 'standalone-rake-bank:' || p_club_id::text || ':'
    || to_char(p_period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '..'
    || to_char(p_period_end AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  v_res := public.fn_ca_fund_club(
    p_club_id, v_total,
    'Weekly bank of the standalone rake ' || COALESCE(v_name, p_club_id::text)
      || ' retired in the week ' || to_char(p_period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD')
      || '..' || to_char(p_period_end AT TIME ZONE 'UTC', 'YYYY-MM-DD')
      || ' (cash ' || v_cash::text || ', tournament fees ' || v_fees::text
      || '); standalone rake belongs to the club treasury (CLUB-MONEY-LEDGERS-CANONICAL)',
    v_key);
  PERFORM set_config('app.ledger_category', v_cat, true);
  PERFORM set_config('app.ledger_counterparty', v_cp, true);
  PERFORM set_config('app.ledger_counterparty_entity', v_cpe, true);
  PERFORM set_config('app.ledger_idempotency_key', v_idem, true);
  IF v_res->>'ok' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'standalone_rake_bank_refused' USING DETAIL = v_res::text;
  END IF;
  RETURN v_res || jsonb_build_object('cash_rake', v_cash, 'tournament_fees', v_fees,
    'period_start', p_period_start, 'period_end', p_period_end);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_bank_standalone_week_rake(uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated, service_role;

-- The coordinator: one statement inserted before round 2 of the standalone branch.
DO $sub$
DECLARE
  d text;
  o text := 'v_stage2:=public.fn_settle_accounting_commission_stage(''club'',v_club.id,v_from,v_end);';
  n text;
  c integer;
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p
       WHERE p.oid = 'public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure)
     IS DISTINCT FROM '3b8b3096051636ec4e67c8665fab8d28' THEN
    RAISE EXCEPTION 'WEEKLY_COORDINATOR_PREIMAGE_DRIFT';
  END IF;
  n := 'PERFORM public.fn_bank_standalone_week_rake(v_club.id,v_from,v_end);'
       || chr(10) || '          ' || o;
  d := pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure);
  c := (length(d) - length(replace(d, o, ''))) / length(o);
  IF c <> 1 THEN
    RAISE EXCEPTION 'WEEKLY_COORDINATOR_ANCHOR_COUNT %', c;
  END IF;
  EXECUTE replace(d, o, n);
END
$sub$;

DO $post$
DECLARE s text := (SELECT p.prosrc FROM pg_proc p
  WHERE p.oid = 'public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure);
BEGIN
  IF position('PERFORM public.fn_bank_standalone_week_rake(v_club.id,v_from,v_end);' IN s) = 0
     OR position('PERFORM public.fn_bank_standalone_week_rake(v_club.id,v_from,v_end);' IN s)
        > position('v_stage2:=public.fn_settle_accounting_commission_stage(''club''' IN s)
     OR position('IF v_result->>''success'' IS DISTINCT FROM ''true'' THEN EXIT;END IF;' IN s) = 0
     OR length(s) <> 37041 + length('PERFORM public.fn_bank_standalone_week_rake(v_club.id,v_from,v_end);') + 11 THEN
    RAISE EXCEPTION 'WEEKLY_COORDINATOR_POSTIMAGE';
  END IF;
END
$post$;

-- The backlog: closed weeks whose commission the treasury already paid.
DO $backlog$
DECLARE
  w timestamptz;
  r jsonb;
  v_total numeric := 0;
  c_dss constant uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3';
BEGIN
  FOREACH w IN ARRAY ARRAY['2026-09-14 07:00:00+00'::timestamptz, '2026-09-21 07:00:00+00'::timestamptz] LOOP
    r := public.fn_bank_standalone_week_rake(c_dss, w, public.fn_union_week_start(w + interval '8 days'));
    v_total := v_total + COALESCE((r->>'amount')::numeric, 0);
  END LOOP;
  IF v_total <> 607265.09 THEN
    RAISE EXCEPTION 'STANDALONE_RAKE_BACKLOG_MOVED: banked %, expected 607265.09', v_total;
  END IF;
END
$backlog$;

COMMIT;
