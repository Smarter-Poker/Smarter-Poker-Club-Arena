-- Four small corrections, each verified against production before writing.
-- No chips move. Every statement asserts its own scope and aborts the whole
-- transaction if the board moved underneath it (CLAUDE.md 10.9 rule 4).
--
-- 1. FOUR CLOSED MONEY DOORS ARE STILL EXECUTABLE. fn_ca_money_rpc_drift's
--    second loop reports a door recorded 'closed' in ca_money_rpc_registry
--    that any client role can still call. The 2026-09-17 close used CREATE OR
--    REPLACE FUNCTION, which PRESERVES the existing ACL, so the revoke the
--    registry note claims happened never did. The bodies are tombstones that
--    raise 'automatic_weekly_accounting_only', so nothing breaks - but a
--    tombstone reachable by `authenticated` is a door, not a wall.
--    GRANT/REVOKE is not in pgrst_ddl_watch, so this reloads nothing (s.2 r.5).
--
-- 2. A RETIRED CRON IS STILL DEMANDED BY THE GUARD BASELINE. Migration
--    20260920070402 unscheduled ca-bbj-repair-unbanked-15m at 07:04 UTC today
--    under law 10.12 (a repair sweep is not a fix), and measured its candidate
--    set as empty: 208,249 of 208,249 BBJ-contributing rake_records in 7 days
--    already carry a hand_atomic_commits row. It did not deactivate the
--    ca_guard_inventory row that demands it, so at 07:15 the integrity check
--    filed a CRITICAL for a guard whose absence is the intended outcome. The
--    baseline is the stale side. Row id=48 (fn_bbj_repair_unbanked, the
--    function) stays active on purpose: the incident-gated caller still uses it.
--
-- 3. AN ORPHAN SETTLEMENT PERIOD HOLDS THE ONE NULL-CLUB OPEN SLOT. Period
--    37/2026 has three rows; the two club-scoped ones closed normally at
--    2026-09-14 07:05:00.440704+00. This third row has club_id IS NULL, zero
--    totals and no invoices, and was created 2026-09-10 by the implicit-period
--    path in get_current_settlement_period that item 1 tombstones. Every period
--    predicate in fn_process_weekly_accounting_scope is club-scoped, so nothing
--    can ever close it, and settlement_periods_one_open_per_club_uidx keys NULL
--    club to the zero uuid - so it blocks any future union-scoped open period.
--
-- 4. TWELVE DIAMOND PRIZES CARRY NO CLUB, SO THE DRIFT METER MISREADS THEM.
--    fn_chip_integrity_report's drift_since_baseline reports one member adrift
--    by 75.08. Nobody is short and nobody is over: the member's wallet is
--    correct and the 75.08 is twelve posted union_wallet -> player_wallet prize
--    credits (wheel 5.70, plinko 48.73, crash 7.00, mines 13.65). They carry
--    club_id IS NULL because fn_ca_autoledger derives the club from the row it
--    journals, fn_diamond_game_pay_chips autoskips club_members so the
--    journaled leg is the union_wallets debit, and union_wallets has no
--    club_id column. fn_chip_drift_since_baseline's moves CTE filters
--    club_id IS NOT NULL, so it counts the balance but not the movement.
--    This backfills the attribution only. amount, from/to, category, hashes and
--    keys are untouched, so fn_ca_journal_append_only admits it; club_id is not
--    part of row_hash. The writer-side fix so it cannot recur is a separate
--    change to fn_diamond_game_pay_chips and is not attempted here.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- 1 -------------------------------------------------------------------------
DO $doors$
DECLARE v_open int;
BEGIN
  SELECT count(*) INTO v_open
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('fn_open_settlement_period','fn_set_settlement_period_status','get_current_settlement_period')
     AND p.prosrc ILIKE '%automatic_weekly_accounting_only%'
     AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
       OR has_function_privilege('service_role',  p.oid, 'EXECUTE'));
  IF v_open <> 4 THEN
    RAISE EXCEPTION 'CLOSED_DOOR_SET_CHANGED: expected 4 reachable tombstones, found %', v_open;
  END IF;
END $doors$;

REVOKE EXECUTE ON FUNCTION public.fn_open_settlement_period(uuid)             FROM authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.fn_set_settlement_period_status(uuid, text) FROM authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_current_settlement_period()             FROM authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.get_current_settlement_period(uuid)         FROM authenticated, service_role;

DO $doors_after$
DECLARE v_open int;
BEGIN
  SELECT count(*) INTO v_open
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('fn_open_settlement_period','fn_set_settlement_period_status','get_current_settlement_period')
     AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
       OR has_function_privilege('service_role',  p.oid, 'EXECUTE'));
  IF v_open <> 0 THEN
    RAISE EXCEPTION 'CLOSED_DOOR_STILL_REACHABLE: %', v_open;
  END IF;
END $doors_after$;

-- 2 -------------------------------------------------------------------------
DO $guard$
DECLARE v_rows int;
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-bbj-repair-unbanked-15m') THEN
    RAISE EXCEPTION 'BBJ_CRON_IS_BACK: the guard baseline is not the stale side after all';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20260920070402') THEN
    RAISE EXCEPTION 'RETIREMENT_MIGRATION_ABSENT: refusing to deactivate a guard whose retirement is unproven';
  END IF;
  UPDATE public.ca_guard_inventory
     SET active = false,
         note = 'BBJ self-heal - RETIRED 2026-09-20 by migration 20260920070402 under law 10.12 '
             || '(a repair sweep is not a fix; its candidate set measured empty, 208249/208249 '
             || 'BBJ rake_records in 7 days already carry a hand_atomic_commits row). The function '
             || 'fn_bbj_repair_unbanked (inventory id 48) stays active for its incident-gated caller.'
   WHERE id = 30 AND kind = 'cron' AND object_a = 'ca-bbj-repair-unbanked-15m' AND active;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'GUARD_ROW_NOT_FOUND: updated % rows, expected 1', v_rows; END IF;
END $guard$;

-- 3 -------------------------------------------------------------------------
DO $period$
DECLARE v_rows int;
BEGIN
  IF (SELECT count(*) FROM public.settlement_invoices WHERE period_id = '65d6e3ad-cf2f-41ce-97ff-4c465e8a015f') <> 0 THEN
    RAISE EXCEPTION 'ORPHAN_PERIOD_HAS_INVOICES: it is not an orphan, leave it alone';
  END IF;
  UPDATE public.settlement_periods
     SET status = 'closed',
         notes = 'Closed 2026-09-20: orphan union-scoped period (club_id IS NULL) created 2026-09-10 by the '
              || 'now-tombstoned implicit-creation path in get_current_settlement_period. Zero totals, no '
              || 'invoices, and unreachable by fn_process_weekly_accounting_scope because every period '
              || 'predicate there is club-scoped. It held the single NULL-club slot of '
              || 'settlement_periods_one_open_per_club_uidx. The two club-scoped period-37 rows (a6d604e1, '
              || 'b029311a) settled normally at 2026-09-14 07:05:00.440704+00. No money was held up.'
   WHERE id = '65d6e3ad-cf2f-41ce-97ff-4c465e8a015f' AND status = 'open';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'ORPHAN_PERIOD_NOT_OPEN: updated % rows, expected 1', v_rows; END IF;
END $period$;

-- 4 -------------------------------------------------------------------------
DO $prizes$
DECLARE v_rows int; v_sum numeric;
BEGIN
  SELECT count(*), COALESCE(sum(amount),0) INTO v_rows, v_sum
    FROM public.chip_ledger
   WHERE club_id IS NULL AND from_type = 'union_wallet' AND to_type = 'player_wallet'
     AND to_entity_id = '47965354-0e56-43ef-931c-ddaab82af765'
     AND category IN ('crash_prize','mines_prize','plinko_prize','wheel_prize');
  IF v_rows <> 12 OR v_sum <> 75.08 THEN
    RAISE EXCEPTION 'PRIZE_SET_CHANGED: % rows totalling %, expected 12 totalling 75.08', v_rows, v_sum;
  END IF;

  UPDATE public.chip_ledger
     SET club_id = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'
   WHERE club_id IS NULL AND from_type = 'union_wallet' AND to_type = 'player_wallet'
     AND to_entity_id = '47965354-0e56-43ef-931c-ddaab82af765'
     AND category IN ('crash_prize','mines_prize','plinko_prize','wheel_prize');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 12 THEN RAISE EXCEPTION 'PRIZE_BACKFILL_SCOPE: updated % rows, expected 12', v_rows; END IF;

  IF EXISTS (
    SELECT 1 FROM public.chip_ledger
     WHERE club_id IS NULL AND from_type = 'union_wallet' AND to_type = 'player_wallet'
       AND to_entity_id = '47965354-0e56-43ef-931c-ddaab82af765'
       AND category IN ('crash_prize','mines_prize','plinko_prize','wheel_prize')
  ) THEN
    RAISE EXCEPTION 'PRIZE_BACKFILL_INCOMPLETE';
  END IF;
END $prizes$;

COMMIT;

