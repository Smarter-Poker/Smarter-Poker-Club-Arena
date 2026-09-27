-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820121254 "union_rake_rollup_hardening"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 254902578eac2121d9b7f57bda9b47a9 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- 2026-08-20 REVIEW ROUND: hardening the P0-1 rollup after a line-by-line pass.
--
-- Three real defects found in my own 20260820_union_rake_daily_rollup work:
--
-- (1) THE FALLBACK WAS THE OUTAGE. If any whole day failed to finalize, the
--     function fell back to fn_union_rake_paid_live over the ENTIRE window —
--     i.e. exactly the ~50s double-jsonb-expansion query that P0-1 existed to
--     eliminate. The safety net was the hazard. Now a day that cannot be
--     finalized is computed live FOR THAT DAY ONLY (bounded ~3s), so no code
--     path can ever scan more than one day plus the ragged edges.
--
-- (2) MONDAY WOULD FINALIZE DAYS INSIDE THE MONEY TRANSACTION. The rollup is
--     lazily filled by its first caller — which on Monday 10:00 is
--     fn_union_settle_player_pnl, holding FOR UPDATE locks on union_wallets
--     and clubs.chip_treasury. Measured today: 4 unrolled days (08-20..08-23)
--     = ~12s of extra work inside the settlement while live horse funding
--     contends on those same rows. Now fn_union_rake_rollup_catchup_all()
--     warms the rollup outside any money transaction; the engine settler
--     calls it every 30 minutes.
--
-- (3) REPORTS WROTE TO THE DATABASE. fn_union_rake_paid_by_club is VOLATILE
--     and writes; anything read-only that wanted rake had to either call it
--     or re-implement the slow scan. Added fn_union_rake_paid_readonly
--     (STABLE, never writes) and rebuilt fn_union_rake_basis_by_club — the
--     weekly STATEMENT's rake basis — on top of it. Before this, the
--     statement path still had the original unbounded shape: a 7-day
--     fn_union_weekly_statement (the report a human would actually run) was
--     still outage-class even after P0-1 fixed the settle path.

-- ─── 1. Read-only, always-bounded rake reader ────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_union_rake_paid_readonly(
  p_union_id uuid, p_start timestamptz, p_end timestamptz,
  p_include_horses boolean DEFAULT true)
RETURNS TABLE(club_id uuid, rake_paid numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_first_day date;
  v_end_day   date;
  v_today     date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  v_first_day := (p_start AT TIME ZONE 'UTC')::date;
  IF (v_first_day::timestamp AT TIME ZONE 'UTC') < p_start THEN
    v_first_day := v_first_day + 1;
  END IF;
  v_end_day := (p_end AT TIME ZONE 'UTC')::date;
  IF v_end_day > v_today THEN
    v_end_day := v_today;
  END IF;

  -- Sub-day window: one bounded live call.
  IF v_first_day >= v_end_day THEN
    RETURN QUERY
      SELECT l.club_id, round(l.rake_paid, 2)
        FROM fn_union_rake_paid_live(p_union_id, p_start, p_end, p_include_horses) l;
    RETURN;
  END IF;

  RETURN QUERY
  WITH days AS (
    SELECT gs::date AS d
      FROM generate_series(v_first_day, v_end_day - 1, interval '1 day') gs
  ),
  rolled AS (
    SELECT u.club_id AS cid,
           CASE WHEN p_include_horses THEN u.rake_paid_all ELSE u.rake_paid_humans END AS s
      FROM union_rake_paid_daily u
     WHERE u.union_id = p_union_id
       AND u.day >= v_first_day AND u.day < v_end_day
  ),
  -- Any day not finalized is computed live for THAT DAY ONLY (bounded),
  -- never by widening the scan to the whole window.
  missing AS (
    SELECT days.d
      FROM days
     WHERE NOT EXISTS (
       SELECT 1 FROM union_rake_rollup_days rd
        WHERE rd.union_id = p_union_id AND rd.day = days.d)
  ),
  live_days AS (
    SELECT l.club_id AS cid, l.rake_paid AS s
      FROM missing m
      CROSS JOIN LATERAL fn_union_rake_paid_live(
        p_union_id,
        (m.d::timestamp AT TIME ZONE 'UTC'),
        ((m.d + 1)::timestamp AT TIME ZONE 'UTC'),
        p_include_horses) l
  ),
  edges AS (
    SELECT l.club_id AS cid, l.rake_paid AS s
      FROM fn_union_rake_paid_live(
        p_union_id, p_start, (v_first_day::timestamp AT TIME ZONE 'UTC'), p_include_horses) l
    UNION ALL
    SELECT l.club_id, l.rake_paid
      FROM fn_union_rake_paid_live(
        p_union_id, (v_end_day::timestamp AT TIME ZONE 'UTC'), p_end, p_include_horses) l
  ),
  combined AS (
    SELECT x.cid, SUM(x.s) AS s
      FROM (SELECT * FROM rolled
            UNION ALL SELECT * FROM live_days
            UNION ALL SELECT * FROM edges) x
     GROUP BY x.cid
  )
  SELECT c.cid, round(c.s, 2) FROM combined c WHERE c.s IS NOT NULL;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_union_rake_paid_readonly(uuid, timestamptz, timestamptz, boolean) FROM PUBLIC, anon, authenticated;

-- ─── 2. Settle-path reader: finalize what it can, then delegate ──────────────
CREATE OR REPLACE FUNCTION public.fn_union_rake_paid_by_club(
  p_union_id uuid, p_start timestamptz, p_end timestamptz,
  p_include_horses boolean DEFAULT true)
RETURNS TABLE(club_id uuid, rake_paid numeric)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_first_day date;
  v_end_day   date;
  v_today     date := (now() AT TIME ZONE 'UTC')::date;
  d           date;
BEGIN
  v_first_day := (p_start AT TIME ZONE 'UTC')::date;
  IF (v_first_day::timestamp AT TIME ZONE 'UTC') < p_start THEN
    v_first_day := v_first_day + 1;
  END IF;
  v_end_day := (p_end AT TIME ZONE 'UTC')::date;
  IF v_end_day > v_today THEN
    v_end_day := v_today;
  END IF;

  IF v_first_day < v_end_day THEN
    FOR d IN
      SELECT gs::date
        FROM generate_series(v_first_day, v_end_day - 1, interval '1 day') gs
       WHERE NOT EXISTS (SELECT 1 FROM union_rake_rollup_days u
                          WHERE u.union_id = p_union_id AND u.day = gs::date)
    LOOP
      BEGIN
        PERFORM fn_union_rake_rollup_refresh_day(p_union_id, d);
      EXCEPTION WHEN OTHERS THEN
        -- Deliberately swallowed: the readonly reader below computes this
        -- single day live. Bounded either way; never widens the scan.
        NULL;
      END;
    END LOOP;
  END IF;

  RETURN QUERY
    SELECT r.club_id, r.rake_paid
      FROM fn_union_rake_paid_readonly(p_union_id, p_start, p_end, p_include_horses) r;
END;
$function$;

-- ─── 3. Warm the rollup OUTSIDE any money transaction ────────────────────────
CREATE OR REPLACE FUNCTION public.fn_union_rake_rollup_catchup(
  p_union_id uuid, p_max_days integer DEFAULT 3, p_lookback_days integer DEFAULT 10)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  d date;
  v_done text[] := '{}';
  v_failed text[] := '{}';
  v_remaining integer;
BEGIN
  FOR d IN
    SELECT gs::date
      FROM generate_series(v_today - p_lookback_days, v_today - 1, interval '1 day') gs
     WHERE NOT EXISTS (SELECT 1 FROM union_rake_rollup_days u
                        WHERE u.union_id = p_union_id AND u.day = gs::date)
     ORDER BY gs
     LIMIT p_max_days
  LOOP
    BEGIN
      PERFORM fn_union_rake_rollup_refresh_day(p_union_id, d);
      v_done := v_done || d::text;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed || (d::text || ':' || SQLERRM);
    END;
  END LOOP;

  SELECT count(*) INTO v_remaining
    FROM generate_series(v_today - p_lookback_days, v_today - 1, interval '1 day') gs
   WHERE NOT EXISTS (SELECT 1 FROM union_rake_rollup_days u
                      WHERE u.union_id = p_union_id AND u.day = gs::date);

  RETURN jsonb_build_object('union_id', p_union_id, 'rolled', to_jsonb(v_done),
                            'failed', to_jsonb(v_failed), 'remaining', v_remaining);
END;
$function$;

-- One call per settler cycle keeps every union's rollup warm, so the Monday
-- settlement never finalizes a day while holding treasury locks.
CREATE OR REPLACE FUNCTION public.fn_union_rake_rollup_catchup_all(
  p_max_days integer DEFAULT 3)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  u record;
  v_out jsonb := '[]'::jsonb;
BEGIN
  FOR u IN
    SELECT DISTINCT un.id
      FROM unions un
     WHERE EXISTS (SELECT 1 FROM tables t WHERE t.union_id = un.id)
        OR EXISTS (SELECT 1 FROM union_clubs uc WHERE uc.union_id = un.id)
  LOOP
    v_out := v_out || jsonb_build_array(fn_union_rake_rollup_catchup(u.id, p_max_days));
  END LOOP;
  RETURN jsonb_build_object('unions', v_out);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_union_rake_rollup_catchup(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_rake_rollup_catchup_all(integer) FROM PUBLIC, anon, authenticated;

-- ─── 4. The weekly STATEMENT's rake basis, now bounded ───────────────────────
-- Dan's spec: the union fee is 10% of all cash game rake AND 10% of all
-- tournament fees. Both legs are kept; the cash leg now comes from the rollup
-- (bounded) instead of re-expanding every rake_records row in the window.
-- Tournament fees stay live: measured 0.34s over 7 days.
CREATE OR REPLACE FUNCTION public.fn_union_rake_basis_by_club(
  p_union_id uuid, p_start timestamptz, p_end timestamptz)
RETURNS TABLE(club_id uuid, rake_share numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH attributed AS (
    SELECT DISTINCT ON (cm.user_id) cm.user_id, cm.club_id
      FROM club_members cm
      JOIN union_clubs uc ON uc.club_id = cm.club_id AND uc.union_id = p_union_id
     ORDER BY cm.user_id, cm.joined_at ASC NULLS LAST, cm.club_id
  ),
  -- Cash rake, contribution-weighted, served from the daily rollup.
  cash AS (
    SELECT r.club_id, r.rake_paid AS rake
      FROM fn_union_rake_paid_readonly(p_union_id, p_start, p_end, true) r
  ),
  -- Tournament rake is the entry fee, charged once per registration.
  tourney AS (
    SELECT a.club_id, SUM(COALESCE(t.buy_in_fee, 0)) AS rake
      FROM tournament_players tp
      JOIN tournaments t ON t.id = tp.tournament_id AND t.union_id = p_union_id
      JOIN attributed a ON a.user_id = tp.user_id
     WHERE tp.registered_at >= p_start AND tp.registered_at < p_end
     GROUP BY a.club_id
  )
  SELECT x.club_id, round(SUM(x.rake), 2) AS rake_share
    FROM (SELECT club_id, rake FROM cash
          UNION ALL
          SELECT club_id, rake FROM tourney) x
   GROUP BY x.club_id;
$function$;
