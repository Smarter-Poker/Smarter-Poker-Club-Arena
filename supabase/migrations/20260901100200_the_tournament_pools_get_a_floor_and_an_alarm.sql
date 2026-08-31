-- ═══════════════════════════════════════════════════════════════════════════
--  THE TOURNAMENT POOLS GET A FLOOR AND AN ALARM (2026-09-01)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `tournaments.prize_pool` and `tournaments.total_rake` are written by
-- fourteen SQL writers plus the engine, and NOTHING guards either column. The
-- only money CHECKs on that table are the four NOT VALID fee ceilings, and
-- every one of them is about `buy_in_fee`.
--
-- ── WHAT THIS SHIPS, AND WHAT IT DELIBERATELY DOES NOT ─────────────────────
--
-- This ships a BLOCKING floor and a READ-ONLY alarm. It does NOT ship a
-- blocking equality guard, and the rest of this header is why -- because
-- "why not" is the load-bearing part of this migration.
--
-- 1. THE FLOOR IS BLOCKING. prize_pool, total_rake, bounty_pool and
--    bounty_pool_paid may not be negative. Measured over all 54,275 live rows
--    on 2026-08-31: zero negatives, zero NULLs on prize_pool and total_rake.
--    So this is added NOT VALID and then VALIDATEd, and it refuses nothing
--    that exists.
--
-- 2. THE EQUALITY IS AN ALARM, NOT A REFUSAL. Three reasons, in order of
--    weight:
--
--    (a) A CHECK CONSTRAINT CANNOT EXPRESS IT. The expected pool is
--        buy_in_amount x the number of entries, and the entries live in
--        `tournament_players`. A CHECK may only see its own row. So the only
--        blocking form available is a TRIGGER.
--
--    (b) IT WOULD HAVE TO BE A TRIGGER ON UPDATE, AND THAT IS THE ONE THING
--        THE SHIPPED TOURNAMENT GUARD REFUSES TO DO. prize_pool and total_rake
--        both default to 0 and are filled in by UPDATE as players register and
--        as the event settles -- there is nothing to check at INSERT.
--        20260831180000 (`a tournament guard binds every writer, not just the
--        rpc`) is BEFORE INSERT only, and says exactly why: "a guard that can
--        refuse an update is a guard that can strand a running tournament".
--        An equality trigger on UPDATE would fire in the middle of settlement,
--        between the write that adds a player and the write that adds their
--        buy-in, and refuse the transaction. That is an outage, not a guard.
--
--    (c) THE IDENTITY IS ONLY UNAMBIGUOUS IN A SUBSET, AND ONLY RECENTLY.
--        Rebuys, add-ons, guarantees, overlays, satellite seat awards and
--        cancellation refunds ALL legitimately move these columns, and the
--        columns do not record which of them happened. Measured 2026-08-31
--        over August, restricted to COMPLETED events with no rebuy, no add-on,
--        no guarantee, not a Spin and not a satellite:
--
--           14,165 in scope    prize_pool identity holds on 13,893  (98.1%)
--                              total_rake identity holds on 14,060  (99.3%)
--
--        98% is a false-positive machine. But the failures are HISTORICAL, and
--        they stop dead:
--
--           2026-08-23   1,008 in scope    994 pp ok   1,007 tr ok
--           2026-08-24   1,057             1,047       1,057
--           2026-08-25   3,983             3,982       3,983
--           2026-08-26   3,960             3,960       3,960
--           2026-08-27     269               269         269
--           2026-08-28     593               593         593
--           2026-08-29   1,202             1,202       1,202
--           2026-08-30     482               482         482
--           2026-08-31     917               917         917
--
--        7,423 consecutive tournaments since 2026-08-26 with ZERO exceptions on
--        both columns. The rule is being obeyed; nothing was asserting it.
--
--        And the scope restrictions are not squeamishness. CANCELLED events
--        fail the rake identity 1,376 times out of 1,392 in August, because a
--        cancellation legitimately reverses the rake it collected. Any guard
--        that did not carve them out would have screamed at correct behaviour
--        1,376 times in one month.
--
-- So: the alarm watches, date-gated to tournaments created on or after
-- 2026-09-01, in the scope where the identity is unambiguous. If it stays
-- silent for a fortnight the case for promoting it to a trigger is made with
-- evidence rather than with hope. A false-positive guard on a money path is
-- worse than no guard.
--
-- RECONCILIATION COVERAGE. This closes two of the ten uncovered money columns
-- the sweep listed: `tournaments.prize_pool` and `tournaments.total_rake`.
-- The other eight are untouched here and stay uncovered.
--
-- ROLLBACK:
--   ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS tournaments_pools_are_not_negative;
--   SELECT cron.unschedule('tournament-pool-law-hourly');
--   DROP FUNCTION IF EXISTS public.fn_tournament_pool_law_check(interval);
--   DROP FUNCTION IF EXISTS public.fn_tournament_pool_law_violations(interval);

SET lock_timeout = '4s';

-- ── 1. THE FLOOR ───────────────────────────────────────────────────────────
DO $floor$
DECLARE v_bad bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.tournaments'::regclass
                AND conname  = 'tournaments_pools_are_not_negative') THEN
    RAISE NOTICE 'tournaments_pools_are_not_negative already present';
    RETURN;
  END IF;

  SELECT count(*) INTO v_bad FROM public.tournaments
   WHERE COALESCE(prize_pool,0) < 0 OR COALESCE(total_rake,0) < 0
      OR COALESCE(bounty_pool,0) < 0 OR COALESCE(bounty_pool_paid,0) < 0;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'the pool floor would have refused % existing row(s) - decide what to do with those chips first', v_bad;
  END IF;

  ALTER TABLE public.tournaments
    ADD CONSTRAINT tournaments_pools_are_not_negative
    CHECK (COALESCE(prize_pool,0)      >= 0
       AND COALESCE(total_rake,0)      >= 0
       AND COALESCE(bounty_pool,0)     >= 0
       AND COALESCE(bounty_pool_paid,0) >= 0) NOT VALID;

  ALTER TABLE public.tournaments VALIDATE CONSTRAINT tournaments_pools_are_not_negative;
END
$floor$;

-- ── 2. THE RECONCILE LOG LEARNS TWO NEW FINDINGS ───────────────────────────
-- `ledger_reconcile_log.entity_type` is a closed vocabulary. An alarm that
-- files an unlisted entity_type raises 23514 instead of filing -- exactly the
-- defect that stopped fn_rake_law_check's board_not_recorded branch. Widen the
-- vocabulary in the same migration that needs it, never after.
DO $vocab$
DECLARE v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.ledger_reconcile_log'::regclass
     AND conname  = 'ledger_reconcile_log_entity_type_check';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'ledger_reconcile_log_entity_type_check is missing - do not guess its vocabulary';
  END IF;

  IF v_def LIKE '%tournament_pool_law%' AND v_def LIKE '%bounty_pool_law%' THEN
    RAISE NOTICE 'the reconcile log already admits both new findings';
    RETURN;
  END IF;

  ALTER TABLE public.ledger_reconcile_log
    DROP CONSTRAINT ledger_reconcile_log_entity_type_check;

  ALTER TABLE public.ledger_reconcile_log
    ADD CONSTRAINT ledger_reconcile_log_entity_type_check
    CHECK (entity_type = ANY (ARRAY[
      'player_wallet','club_treasury','agent_wallet','frozen_wallets_pool',
      'chip_circulation','seat_stack_exit','cashout_escrow_stuck',
      'negative_balance','over_claimed_send','insurance_bank',
      'insurance_offer_unresolved','bomb_award_ledger_gap','rake_law',
      'tournament_pool_law','bounty_pool_law']));
END
$vocab$;

-- ── 3. WHAT COUNTS AS A VIOLATION ──────────────────────────────────────────
--
-- p_window bounds the read by ended_at so the hourly run stays cheap.
-- The date gate is FORWARD-ONLY and hard-coded: this law starts on
-- 2026-09-01 and says nothing at all about the events before it.
CREATE OR REPLACE FUNCTION public.fn_tournament_pool_law_violations(
  p_window interval DEFAULT '2 hours'::interval)
RETURNS TABLE(
  kind          text,
  tournament_id uuid,
  club_id       uuid,
  ended_at      timestamptz,
  expected      numeric,
  stored        numeric,
  entries       bigint)
LANGUAGE sql
STABLE
AS $$
  WITH scoped AS (
    SELECT t.id, t.club_id, t.ended_at,
           COALESCE(t.prize_pool,0)     AS prize_pool,
           COALESCE(t.total_rake,0)     AS total_rake,
           COALESCE(t.buy_in_amount,0)  AS buy_in_amount,
           COALESCE(t.buy_in_fee,0)     AS buy_in_fee,
           p.entries
      FROM public.tournaments t
      JOIN LATERAL (
        SELECT count(*)::bigint AS entries
          FROM public.tournament_players tp
         WHERE tp.tournament_id = t.id
      ) p ON true
     WHERE t.status = 'COMPLETED'
       -- FORWARD ONLY. The drift this alarm exists to catch is historical and
       -- is Dan's to decide about; the law starts here.
       AND t.created_at >= TIMESTAMPTZ '2026-09-01 00:00:00+00'
       AND t.ended_at   >= now() - p_window
       AND p.entries > 0
       -- Every carve-out below is a case where the identity is genuinely
       -- ambiguous, not a case that is merely inconvenient. See the header.
       AND COALESCE(t.is_rebuy, false)          = false   -- rebuys add chips
       AND COALESCE(t.add_on_available, false)  = false   -- add-ons add chips
       AND COALESCE(t.guaranteed_prize, 0)      = 0       -- an overlay tops up
       AND lower(COALESCE(t.variant,''))       <> 'spin'  -- multiplier priced
       AND upper(COALESCE(t.tournament_type,'')) <> 'SPIN'
       AND t.satellite_target    IS NULL                  -- pays seats
       AND t.satellite_target_id IS NULL
  )
  SELECT 'prize_pool_off_the_entries', s.id, s.club_id, s.ended_at,
         s.buy_in_amount * s.entries, s.prize_pool, s.entries
    FROM scoped s
   WHERE s.prize_pool <> s.buy_in_amount * s.entries
  UNION ALL
  SELECT 'total_rake_off_the_entries', s.id, s.club_id, s.ended_at,
         s.buy_in_fee * s.entries, s.total_rake, s.entries
    FROM scoped s
   WHERE s.total_rake <> s.buy_in_fee * s.entries;
$$;

COMMENT ON FUNCTION public.fn_tournament_pool_law_violations(interval) IS
  'Read-only. Tournaments completed in the window whose prize_pool or total_rake disagrees with buy-in x entries, in the scope where that identity is unambiguous. Forward-only from 2026-09-01.';

-- ── 4. THE ALARM ───────────────────────────────────────────────────────────
-- Files once per (tournament, kind). Never raises, never writes to a money
-- table, and returns how many NEW findings it filed.
CREATE OR REPLACE FUNCTION public.fn_tournament_pool_law_check(
  p_window interval DEFAULT '2 hours'::interval)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_new integer;
BEGIN
  WITH v AS (
    SELECT * FROM public.fn_tournament_pool_law_violations(p_window)
  ), ins AS (
    INSERT INTO public.ledger_reconcile_log
      (run_date, run_ts, entity_type, entity_id, ledger_balance, stored_balance,
       drift, severity, metadata, notes)
    SELECT CURRENT_DATE, now(), 'tournament_pool_law', v.tournament_id,
           v.expected, v.stored, v.stored - v.expected,
           'critical',
           jsonb_build_object(
             'kind', v.kind,
             'tournament_id', v.tournament_id,
             'club_id', v.club_id,
             'ended_at', v.ended_at,
             'entries', v.entries),
           v.kind || ': stored ' || v.stored::text || ' where ' ||
             v.expected::text || ' was owed across ' || v.entries::text || ' entries'
      FROM v
     WHERE NOT EXISTS (
       SELECT 1 FROM public.ledger_reconcile_log l
        WHERE l.entity_type = 'tournament_pool_law'
          AND l.metadata->>'tournament_id' = v.tournament_id::text
          AND l.metadata->>'kind' = v.kind)
    RETURNING 1
  )
  SELECT count(*) INTO v_new FROM ins;
  RETURN v_new;
END;
$$;

COMMENT ON FUNCTION public.fn_tournament_pool_law_check(interval) IS
  'Read-only alarm. Files tournament prize_pool / total_rake identity failures into ledger_reconcile_log, once per tournament per kind. Moves no chips.';

REVOKE ALL ON FUNCTION public.fn_tournament_pool_law_violations(interval) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_tournament_pool_law_check(interval)      FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_pool_law_violations(interval) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_tournament_pool_law_check(interval)      TO service_role;

-- ── 5. RUN IT HOURLY, alongside the rake law alarm ─────────────────────────
DO $sched$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('tournament-pool-law-hourly')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tournament-pool-law-hourly');
    PERFORM cron.schedule('tournament-pool-law-hourly', '45 * * * *',
      $job$SELECT public.fn_tournament_pool_law_check('2 hours'::interval);$job$);
  ELSE
    RAISE NOTICE 'pg_cron not installed - fn_tournament_pool_law_check is unscheduled';
  END IF;
END
$sched$;

-- ── 6. POST-APPLY ASSERTIONS ───────────────────────────────────────────────
DO $verify$
DECLARE v_n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.tournaments'::regclass
                    AND conname = 'tournaments_pools_are_not_negative'
                    AND convalidated) THEN
    RAISE EXCEPTION 'the pool floor is missing or unvalidated';
  END IF;

  IF pg_get_constraintdef((SELECT oid FROM pg_constraint
      WHERE conrelid = 'public.ledger_reconcile_log'::regclass
        AND conname = 'ledger_reconcile_log_entity_type_check'))
     NOT LIKE '%tournament_pool_law%' THEN
    RAISE EXCEPTION 'the reconcile log will not admit a tournament_pool_law finding';
  END IF;

  -- The alarm must run. A 90-day read proves it executes and shows what the
  -- law would have said about the events since it was measured.
  SELECT count(*) INTO v_n FROM public.fn_tournament_pool_law_violations('90 days'::interval);
  RAISE NOTICE 'tournament pool law: % violation(s) in the last 90 days within the date gate', v_n;
END
$verify$;
