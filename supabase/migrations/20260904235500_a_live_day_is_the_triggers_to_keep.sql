-- ═══════════════════════════════════════════════════════════════════════════
--  A LIVE DAY IS THE TRIGGERS' TO KEEP
--  Club Operations upgrade, phase 6 of 8. Second correction to 20260904220000.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The first correction (20260904234500) gave the rebuild three passes so it
-- could close a gap it had opened by racing live inserts. Measured
-- immediately afterwards, on the reference club, that did not work and could
-- not have:
--
--   20:40:45   ledger 194,648.19   rollup 194,627.07   diff 21.1200
--   20:41:17   ledger 194,717.42   rollup 194,696.30   diff 21.1200
--
-- The ledger moved by 69 chips in 32 seconds and the difference did not move
-- at all. That is the whole answer:
--
--   * The statement-level trigger is EXACT under live load. Every insert it
--     sees lands, to the cent, in real time.
--   * DELETE-then-recount cannot converge on a day that is still being
--     written. Each pass takes ~14 seconds under this traffic; whatever
--     commits inside that window had its trigger row deleted and is not in
--     the snapshot, so every pass loses a fresh slice. More passes cost more
--     scans and lose again.
--
-- So a live day is not the rebuild's to touch. The rebuild recounts COMPLETE
-- days, where nothing writes and a recount is exact; today belongs to the
-- triggers, which is the only mechanism that can be right about it.
--
-- The one legitimate exception is the first build of a day whose triggers
-- were installed after it began (that is exactly how today came to hold
-- 21.12 less than the ledger: the triggers arrived at 19:55 and the hours
-- before that had to be counted by hand). That is an operator action, it is
-- lossy by construction while play continues, and it now has to be asked for
-- by name - p_include_today - rather than happening because someone passed a
-- date range that ended today.
--
-- Today's 21.12 is left where it is. It self-heals at 00:00 UTC, when the
-- day closes and the reconcile recounts it exactly, and correcting it now by
-- hand would mean writing a difference into a ledger rollup while the ledger
-- is moving - which is the same mistake in the other direction.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

SET LOCAL lock_timeout = '20s';
SET LOCAL statement_timeout = '0';

CREATE OR REPLACE FUNCTION public.fn_ca_club_rake_daily_rebuild_range(
  p_start date, p_end date, p_include_today boolean DEFAULT false
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_last date := CASE WHEN coalesce(p_include_today, false) THEN v_today ELSE v_today - 1 END;
  v_s date := LEAST(coalesce(p_start, v_today), coalesce(p_end, v_today));
  v_e date := LEAST(GREATEST(coalesce(p_start, v_today), coalesce(p_end, v_today)), v_last);
  d date;
  v_days integer := 0;
BEGIN
  IF v_s > v_e THEN RETURN 0; END IF;
  FOR d IN SELECT gs::date FROM generate_series(v_s, v_e, interval '1 day') gs LOOP
    -- One pass. A complete day has no writer to race, so the recount is
    -- exact; the caller checks the result against the ledger and says so.
    -- Retrying was measured on a live day and never closed the gap: see the
    -- header.
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
    v_days := v_days + 1;
  END LOOP;
  RETURN v_days;
END;
$function$;

-- The two-argument form the earlier migrations installed, kept so nothing that
-- already calls it breaks, and defined as "complete days only".
CREATE OR REPLACE FUNCTION public.fn_ca_club_rake_daily_rebuild_range(p_start date, p_end date)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT public.fn_ca_club_rake_daily_rebuild_range(p_start, p_end, false);
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_club_rake_daily_rebuild_range(date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_club_rake_daily_rebuild_range(date, date, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_rake_daily_rebuild_range(date, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_rake_daily_rebuild_range(date, date, boolean) TO service_role;

-- The operator wrapper carries the same flag, and reports what it built next
-- to what the ledger says, so a lossy today-build is visible rather than
-- reassuring.
CREATE OR REPLACE FUNCTION public.fn_ca_club_rake_daily_rebuild(
  p_start date, p_end date, p_include_today boolean DEFAULT false
)
RETURNS TABLE(stat_date date, clubs bigint, hands bigint, rake numeric,
              ledger_rake numeric, difference numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_n integer;
BEGIN
  IF NOT (session_user IN ('postgres', 'supabase_admin')
          OR coalesce(auth.role(), '') = 'service_role'
          OR coalesce(fn_is_platform_admin(), false)) THEN
    RAISE EXCEPTION 'rebuild is an operator action' USING ERRCODE = '42501';
  END IF;
  v_n := public.fn_ca_club_rake_daily_rebuild_range(p_start, p_end, p_include_today);
  RETURN QUERY
  SELECT r.stat_date, count(*)::bigint, coalesce(sum(r.hands), 0)::bigint,
         round(coalesce(sum(r.rake), 0), 4),
         round(public.fn_ca_club_rake_daily_ledger_total(r.stat_date), 4),
         round(public.fn_ca_club_rake_daily_ledger_total(r.stat_date)
               - coalesce(sum(r.rake), 0), 4)
    FROM public.ca_club_rake_daily r
   WHERE r.stat_date BETWEEN LEAST(p_start, p_end) AND GREATEST(p_start, p_end)
   GROUP BY r.stat_date ORDER BY r.stat_date;
END;
$function$;

DROP FUNCTION IF EXISTS public.fn_ca_club_rake_daily_rebuild(date, date);

REVOKE ALL ON FUNCTION public.fn_ca_club_rake_daily_rebuild(date, date, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_rake_daily_rebuild(date, date, boolean) TO service_role;

-- The reconcile: complete days only, for the same reason.
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
  v_today_drift numeric;
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

    -- Rake is conserved across attribution, so a COMPLETE day's rollup total
    -- must equal the ledger's cash rake for that day. Today is excluded on
    -- purpose: the triggers are exact on a live day and a recount is not.
    IF d < v_today THEN
      v_ledger := public.fn_ca_club_rake_daily_ledger_total(d);
      SELECT COALESCE(SUM(x.rake), 0) INTO v_rollup
        FROM ca_club_rake_daily x WHERE x.stat_date = d;
      IF abs(v_ledger - v_rollup) > 0.005 THEN
        PERFORM fn_ca_club_rake_daily_rebuild_range(d, d, false);
        v_reconciled := v_reconciled || jsonb_build_array(jsonb_build_object(
          'day', d, 'ledger', v_ledger, 'rollup_was', v_rollup));
      END IF;
    END IF;
  END LOOP;

  -- Today is reported, never rewritten. A drift that survives the day is a
  -- trigger that stopped landing, and it will be recounted at midnight.
  v_today_drift := round(public.fn_ca_club_rake_daily_ledger_total(v_today)
                         - COALESCE((SELECT SUM(x.rake) FROM ca_club_rake_daily x
                                      WHERE x.stat_date = v_today), 0), 4);

  RETURN jsonb_build_object('success', true, 'days', v_done,
                            'rake_daily_rebuilt', v_reconciled,
                            'today_drift', v_today_drift);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_club_table_daily_catchup(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_club_table_daily_catchup(integer) TO service_role;

DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'fn_ca_club_rake_daily_rebuild_range'
     AND pronamespace = 'public'::regnamespace
     AND pg_get_function_identity_arguments(oid) = 'p_start date, p_end date, p_include_today boolean';
  IF v_src IS NULL OR v_src NOT LIKE '%p_include_today, false) THEN v_today ELSE v_today - 1%' THEN
    RAISE EXCEPTION 'the rebuild will still recount a day that is still being written';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_club_table_daily_catchup'
     AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%IF d < v_today THEN%' THEN
    RAISE EXCEPTION 'the reconcile still rebuilds today';
  END IF;
  IF v_src NOT LIKE '%today_drift%' THEN
    RAISE EXCEPTION 'the reconcile no longer reports what today is short by';
  END IF;
END $$;

COMMIT;
