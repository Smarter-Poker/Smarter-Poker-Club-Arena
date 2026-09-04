-- ═══════════════════════════════════════════════════════════════════════════
--  A REBUILD THAT RACES THE LEDGER CHECKS ITSELF
--  Club Operations upgrade, phase 6 of 8. Correction to 20260904220000.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Measured an hour after that migration shipped, against production:
--
--   ledger (rake_records, cash, today)            194,029.4700
--   fn_ca_club_rake_daily_compute, run fresh      194,029.4700   exact
--   ca_club_rake_daily as STORED                  194,008.8400   20.63 short
--
-- So the attribution is right and the stored rows had drifted. The cause is
-- the rebuild itself, not the triggers. `fn_ca_club_rake_daily_rebuild_range`
-- DELETEs a day and re-INSERTs it from a snapshot taken at that moment. A
-- transaction that inserted rake_records BEFORE that snapshot but COMMITTED
-- after it is invisible to the SELECT, while the row its trigger had already
-- added to the rollup is removed by the DELETE. Its rake is lost from the
-- rollup until something recounts the day. This club deals ~1,200 raked hands
-- a minute, so any backfill over a live day loses a little.
--
-- The hourly reconcile in fn_club_table_daily_catchup already repairs it -
-- that is what it is for, and it compares against the ledger rather than
-- trusting the rollup. But a rebuild that is KNOWN to lose writes while it
-- runs should not hand back a number and say nothing, so it now checks its own
-- work: after writing a day it compares that day against the ledger and, while
-- they disagree by more than half a cent, does it again, up to three passes.
-- Each pass is far shorter than the last (only the lost rows are missing), so
-- the race closes rather than repeating.
--
-- The alternative - having the INSERT trigger take the same per-day advisory
-- lock the rebuild takes - would make the two serialise properly, and is
-- rejected: it puts a platform-wide lock in the path of every rake write on
-- the hottest table on the system, to protect a rollup that is repaired
-- anyway. Reporting must never slow the money path (11.5).
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

SET LOCAL lock_timeout = '20s';
SET LOCAL statement_timeout = '0';

-- The ledger's own total for one day, defined once: cash rake_records rows,
-- at a table that is not a tournament table, with a club. The same predicate
-- the reconcile uses, so "the rollup agrees with the ledger" means one thing
-- everywhere.
CREATE OR REPLACE FUNCTION public.fn_ca_club_rake_daily_ledger_total(p_day date)
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(SUM(r.rake_amount), 0)
    FROM rake_records r
   WHERE r.created_at >= (p_day::timestamp AT TIME ZONE 'UTC')
     AND r.created_at <  ((p_day + 1)::timestamp AT TIME ZONE 'UTC')
     AND r.club_id IS NOT NULL
     AND NOT COALESCE(r.is_tournament, false)
     AND EXISTS (SELECT 1 FROM tables t WHERE t.id = r.table_id AND t.tournament_id IS NULL);
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_club_rake_daily_ledger_total(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_rake_daily_ledger_total(date) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_club_rake_daily_rebuild_range(p_start date, p_end date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_s date := LEAST(coalesce(p_start, v_today), coalesce(p_end, v_today));
  v_e date := LEAST(GREATEST(coalesce(p_start, v_today), coalesce(p_end, v_today)), v_today);
  d date;
  v_days integer := 0;
  v_pass integer;
  v_ledger numeric;
  v_rollup numeric;
BEGIN
  IF v_s > v_e THEN RETURN 0; END IF;
  FOR d IN SELECT gs::date FROM generate_series(v_s, v_e, interval '1 day') gs LOOP
    -- Up to three passes. A pass that loses a concurrent write leaves the day
    -- short of the ledger; the next pass is nearly empty and closes it. A day
    -- that is already complete costs exactly one pass plus one comparison.
    FOR v_pass IN 1..3 LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended('ca_club_rake_daily:' || d::text, 42));
      DELETE FROM public.ca_club_rake_daily r WHERE r.stat_date = d;
      INSERT INTO public.ca_club_rake_daily AS x
             (club_id, stat_date, hands, rake, bbj, pot, source_rows, updated_at)
      SELECT c.club_id, c.stat_date, c.hands, c.rake, c.bbj, c.pot, c.source_rows, now()
        FROM public.fn_ca_club_rake_daily_compute(
               (d::timestamp AT TIME ZONE 'UTC'), ((d + 1)::timestamp AT TIME ZONE 'UTC'), NULL) c
      ON CONFLICT (club_id, stat_date) DO UPDATE
         SET hands = x.hands + EXCLUDED.hands,
             rake = x.rake + EXCLUDED.rake,
             bbj = x.bbj + EXCLUDED.bbj,
             pot = x.pot + EXCLUDED.pot,
             source_rows = x.source_rows + EXCLUDED.source_rows,
             updated_at = now();

      v_ledger := public.fn_ca_club_rake_daily_ledger_total(d);
      SELECT COALESCE(SUM(r.rake), 0) INTO v_rollup
        FROM public.ca_club_rake_daily r WHERE r.stat_date = d;
      EXIT WHEN abs(v_ledger - v_rollup) <= 0.005;
    END LOOP;
    v_days := v_days + 1;
  END LOOP;
  RETURN v_days;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_club_rake_daily_rebuild_range(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_rake_daily_rebuild_range(date, date) TO service_role;

-- The hourly reconcile asks the same question through the same function, so
-- the two can never drift apart in their definition of agreement.
CREATE OR REPLACE FUNCTION public.fn_club_table_daily_catchup(p_days integer DEFAULT 3)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_n int := GREATEST(LEAST(COALESCE(p_days, 3), 30), 1);
  d date;
  v_done jsonb := '[]'::jsonb;
  v_stored bigint;
  v_actual bigint;
  v_ledger numeric;
  v_rollup numeric;
  v_reconciled jsonb := '[]'::jsonb;
BEGIN
  FOR d IN SELECT gs::date FROM generate_series(v_today - (v_n - 1), v_today, interval '1 day') gs LOOP
    SELECT COALESCE(SUM(c.source_rows), 0) INTO v_stored
      FROM club_table_daily c WHERE c.stat_date = d;

    -- The same reading of contributions the refresh uses (uuid-keyed rows,
    -- plus one synthetic row per hand with no usable contribution), so a
    -- stored count matches an actual count exactly when nothing has changed.
    SELECT (
      SELECT COUNT(*)
        FROM rake_records r
        JOIN tables t ON t.id = r.table_id AND t.tournament_id IS NULL
        CROSS JOIN LATERAL jsonb_each_text(r.player_contributions) e(key, value)
       WHERE r.created_at >= (d::timestamp AT TIME ZONE 'UTC')
         AND r.created_at <  ((d + 1)::timestamp AT TIME ZONE 'UTC')
         AND r.player_contributions IS NOT NULL
         AND r.rake_amount > 0
         AND e.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         AND EXISTS (
           SELECT 1
             FROM jsonb_each_text(CASE WHEN jsonb_typeof(r.player_contributions) = 'object'
                                       THEN r.player_contributions ELSE '{}'::jsonb END) x
            WHERE x.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
              AND (CASE WHEN x.value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN x.value::numeric ELSE 0 END) > 0)
    ) + (
      SELECT COUNT(*)
        FROM rake_records r
        JOIN tables t ON t.id = r.table_id AND t.tournament_id IS NULL
       WHERE r.created_at >= (d::timestamp AT TIME ZONE 'UTC')
         AND r.created_at <  ((d + 1)::timestamp AT TIME ZONE 'UTC')
         AND r.rake_amount > 0
         AND NOT EXISTS (
           SELECT 1
             FROM jsonb_each_text(CASE WHEN jsonb_typeof(r.player_contributions) = 'object'
                                       THEN r.player_contributions ELSE '{}'::jsonb END) e
            WHERE e.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
              AND (CASE WHEN e.value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN e.value::numeric ELSE 0 END) > 0)
    ) INTO v_actual;

    IF d >= v_today - 1 OR v_stored IS DISTINCT FROM v_actual THEN
      PERFORM fn_club_table_daily_refresh_day(d);
      v_done := v_done || jsonb_build_array(jsonb_build_object('day', d, 'refreshed', true));
    END IF;

    -- Rake is conserved across attribution, so the rollup's day total must
    -- equal the ledger's cash rake for that day. A drift - a trigger that
    -- warned instead of writing, or a rebuild that raced a live insert -
    -- rebuilds the day, and the rebuild now checks itself.
    v_ledger := public.fn_ca_club_rake_daily_ledger_total(d);
    SELECT COALESCE(SUM(x.rake), 0) INTO v_rollup
      FROM ca_club_rake_daily x WHERE x.stat_date = d;
    IF abs(v_ledger - v_rollup) > 0.005 THEN
      PERFORM fn_ca_club_rake_daily_rebuild_range(d, d);
      v_reconciled := v_reconciled || jsonb_build_array(jsonb_build_object(
        'day', d, 'ledger', v_ledger, 'rollup_was', v_rollup));
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'days', v_done, 'rake_daily_rebuilt', v_reconciled);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_club_table_daily_catchup(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_club_table_daily_catchup(integer) TO service_role;

DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_ca_club_rake_daily_rebuild_range'
     AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%FOR v_pass IN 1..3 LOOP%' THEN
    RAISE EXCEPTION 'the rebuild still writes a day once and never looks at it again';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_club_table_daily_catchup'
     AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%fn_ca_club_rake_daily_ledger_total(d)%' THEN
    RAISE EXCEPTION 'the reconcile and the rebuild no longer share one definition of agreement';
  END IF;
END $$;

COMMIT;
