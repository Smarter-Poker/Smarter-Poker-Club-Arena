-- ═══════════════════════════════════════════════════════════════════════════
--  THE BOMB POT REPORT REMEMBERS, AND STOPS READING THE HANDS
--  Club Operations upgrade, phase 7 of 8. The item phase 6's gate could not
--  explain, explained and then fixed.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE MYSTERY FIRST, BECAUSE THE RECORD WAS WRONG. The phase 6 gate measured
-- `fn_club_bomb_pot_report` at 684ms called as `postgres` and 9.7 and 17.3
-- SECONDS called as `authenticated`, ruled out the index, RLS, a second
-- overload and the safeupdate preload, and honestly wrote down that something
-- role-dependent was happening that it could not name.
--
-- Nothing role-dependent was happening. **The 684ms baseline was the function
-- REFUSING.** Its first statement is
--
--     v_uid uuid := auth.uid();
--     IF v_uid IS NULL THEN RAISE EXCEPTION 'not_authenticated' ...
--
-- and a psql session as `postgres` carries no `request.jwt.claims`, so
-- `auth.uid()` is NULL and the call raised 28000 in 88ms without touching a
-- single hand. Every "fast as postgres" reading in that report was the timing
-- of an error. Proved by holding the ROLE constant and changing only the
-- claims:
--
--     postgres, no claims                    ERROR not_authenticated    88ms
--     postgres, the owner's claims set         50 rows            31,715ms
--     postgres, same claims, called again      50 rows                384ms
--
-- Same role, same session, same data: 31.7 seconds and then 384ms. It is a
-- COLD CACHE, not a role. Across sessions the same call has measured 0.4s,
-- 1.8s, 3.5s, 5.1s and 31.7s depending only on what happened to be resident.
--
-- WHY IT IS SO EXPENSIVE COLD. The report reads `hand_history` directly:
-- ~20,200 bomb pot hands in the window, each a wide row whose `players` jsonb
-- is TOASTed, and `jsonb_array_length(h.players)` is how it counts seats. That
-- is tens of thousands of heap and toast pages fetched at random for a report
-- an operator opens perhaps once a day - which is exactly the access pattern
-- that is never resident. Through PostgREST the `authenticated` role has an 8
-- second statement_timeout, so the cold call is killed, the page says "Could
-- Not Load The Bomb Pot Report", and the read that would have warmed the cache
-- never completes. It cannot bootstrap itself out of the cold state.
--
-- AND WHILE MEASURING IT, A SECOND DEFECT NOBODY HAD NOTICED. Ask this report
-- for 365 days and it answers with seven, because it reads `hand_history`, and
-- `sp_prune_hand_history` deletes horse-only hands after
-- `hand_history_retention_policy.horse_retention_days` (7 - Dan's ruling, the
-- one sanctioned asymmetry in CLAUDE.md 10.5, and a STORAGE decision). Today
-- the table holds bomb pot hands for 2026-08-29, 08-30, 09-01, 09-02, 09-03,
-- 09-04 and 09-05 and nothing else. **The report has been silently forgetting
-- its own history**, and saying so with a number rather than a gap: a quarter
-- that contained bomb pots reads as a quarter that did not.
--
-- THE FIX IS THE SHAPE PHASE 6 ESTABLISHED. A daily rollup, per club, per
-- table, per (trigger reason, board count, variant) - which is exactly how the
-- report already groups - written once for a day that is finished and read for
-- ever after. The rollup is a few hundred rows where the hands are twenty
-- thousand wide ones, so it stays resident, and it OUTLIVES the pruning, so
-- the history stops disappearing.
--
-- NO NEW SCHEDULER AND NO TRIGGER ON `hand_history`. That table takes ~221,000
-- inserts a day on the engine's hottest path and nothing of mine is going on
-- it. There is no cron either: World Hub CLAUDE.md 10.9 and 11.3 send
-- scheduled application logic to Open Claw, which a Club Arena agent may not
-- deploy to. So the rollup catches itself up lazily, inside the report, the
-- way `fn_club_table_daily_catchup` already does in phase 6 - the first read
-- after midnight pays for one day (~700 hands) and every read after that is
-- the rollup plus today.
--
-- A DAY IS ONLY ROLLED UP FIFTEEN MINUTES AFTER IT ENDS. `bomb_pot_award_units`
-- is written as the pot is awarded, so a day sealed at 00:00:00 could miss a
-- unit still landing from 23:59:59, and a sealed day is never recomputed. The
-- fifteen minutes is the cheapest possible insurance against writing a wrong
-- number permanently.
--
-- WHAT THE REPORT RETURNS IS UNCHANGED - same fourteen columns, same names,
-- same grouping, same order. The client is not touched by this migration.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

SET LOCAL lock_timeout = '20s';
SET LOCAL statement_timeout = '0';

-- ───────────────────────────────────────────────────────────────────────────
--  1. The rollup, and the marker that says a day is finished
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ca_club_bomb_pot_daily (
  club_id        uuid        NOT NULL,
  day            date        NOT NULL,
  table_id       uuid        NOT NULL,
  trigger_reason text,
  board_count    integer,
  variant        text,
  hands          bigint      NOT NULL DEFAULT 0,
  -- Sums, never averages. An average of daily averages is not the average of
  -- the range, and this table is read across ranges.
  seats_sum      numeric     NOT NULL DEFAULT 0,
  pot_sum        numeric     NOT NULL DEFAULT 0,
  rake_sum       numeric     NOT NULL DEFAULT 0,
  ante_sum       numeric     NOT NULL DEFAULT 0,
  scoops         bigint      NOT NULL DEFAULT 0,
  splits         bigint      NOT NULL DEFAULT 0,
  unrecorded     bigint      NOT NULL DEFAULT 0,
  computed_at    timestamptz NOT NULL DEFAULT now()
);

-- NULLS NOT DISTINCT because all three grouping keys are genuinely nullable -
-- a hand whose bomb_pot carries no variant groups with the other hands that
-- carry no variant, and without this every one of them would be its own row.
CREATE UNIQUE INDEX IF NOT EXISTS ca_club_bomb_pot_daily_key
  ON public.ca_club_bomb_pot_daily (club_id, day, table_id, trigger_reason, board_count, variant)
  NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS ca_club_bomb_pot_daily_club_day
  ON public.ca_club_bomb_pot_daily (club_id, day);

CREATE TABLE IF NOT EXISTS public.ca_club_bomb_pot_complete (
  club_id      uuid        NOT NULL,
  day          date        NOT NULL,
  rows_written integer     NOT NULL DEFAULT 0,
  hands_read   bigint      NOT NULL DEFAULT 0,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, day)
);

ALTER TABLE public.ca_club_bomb_pot_daily    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ca_club_bomb_pot_complete ENABLE ROW LEVEL SECURITY;

-- No policies on purpose: RLS on with no policy denies everything, and the
-- only reader is a SECURITY DEFINER function that is gated itself. Nothing
-- reaches these tables from a browser.
REVOKE ALL ON TABLE public.ca_club_bomb_pot_daily    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.ca_club_bomb_pot_complete FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ca_club_bomb_pot_daily    TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ca_club_bomb_pot_complete TO service_role;

COMMENT ON TABLE public.ca_club_bomb_pot_daily IS
  'One row per club, day, table and bomb pot shape, summed. Written once a day is finished and kept after hand_history prunes it, which is why the bomb pot report can answer for a quarter that hand_history no longer holds.';
COMMENT ON TABLE public.ca_club_bomb_pot_complete IS
  'Which (club, day) pairs ca_club_bomb_pot_daily has finished. A day absent from here is read live, so a day that was never rolled up is never silently zero.';

-- ───────────────────────────────────────────────────────────────────────────
--  2. Rolling one day up
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_bomb_pot_rollup_day(p_club_id uuid, p_day date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rows  integer := 0;
  v_hands bigint  := 0;
BEGIN
  IF p_club_id IS NULL OR p_day IS NULL THEN
    RETURN 0;
  END IF;

  -- A day is finished fifteen minutes after it ends, never before. See the
  -- header: bomb_pot_award_units can land a moment late and a sealed day is
  -- not recomputed.
  IF (p_day + 1)::timestamptz > now() - interval '15 minutes' THEN
    RETURN 0;
  END IF;

  DELETE FROM public.ca_club_bomb_pot_daily d
   WHERE d.club_id = p_club_id AND d.day = p_day;

  WITH bomb_hands AS (
    SELECT h.id,
           h.table_id,
           h.bomb_pot ->> 'trigger_reason'                       AS trigger_reason,
           (h.bomb_pot ->> 'board_count')::int                   AS board_count,
           h.bomb_pot ->> 'variant'                              AS variant,
           COALESCE((h.bomb_pot ->> 'ante_amount')::numeric, 0)  AS ante_amount,
           COALESCE(h.pot_size, 0)                               AS pot_size,
           COALESCE(h.rake_amount, 0)                            AS rake_amount,
           COALESCE(jsonb_array_length(h.players), 0)            AS seats
      FROM public.hand_history h
      JOIN public.tables t ON t.id = h.table_id
     WHERE t.club_id = p_club_id
       AND h.bomb_pot IS NOT NULL
       AND h.created_at >= p_day::timestamptz
       AND h.created_at <  (p_day + 1)::timestamptz
  ), per_hand_units AS (
    SELECT a.hand_history_id,
           count(DISTINCT a.user_id) AS distinct_winners
      FROM public.bomb_pot_award_units a
      JOIN bomb_hands b ON b.id = a.hand_history_id
     GROUP BY a.hand_history_id
  ), grouped AS (
    SELECT b.table_id, b.trigger_reason, b.board_count, b.variant,
           count(*)::bigint                                              AS hands,
           SUM(b.seats)::numeric                                         AS seats_sum,
           SUM(b.pot_size)                                               AS pot_sum,
           SUM(b.rake_amount)                                            AS rake_sum,
           SUM(b.ante_amount * b.seats)                                  AS ante_sum,
           count(*) FILTER (WHERE u.distinct_winners = 1)::bigint        AS scoops,
           count(*) FILTER (WHERE u.distinct_winners > 1)::bigint        AS splits,
           count(*) FILTER (WHERE u.hand_history_id IS NULL)::bigint     AS unrecorded
      FROM bomb_hands b
      LEFT JOIN per_hand_units u ON u.hand_history_id = b.id
     GROUP BY b.table_id, b.trigger_reason, b.board_count, b.variant
  )
  INSERT INTO public.ca_club_bomb_pot_daily
    (club_id, day, table_id, trigger_reason, board_count, variant,
     hands, seats_sum, pot_sum, rake_sum, ante_sum, scoops, splits, unrecorded)
  SELECT p_club_id, p_day, g.table_id, g.trigger_reason, g.board_count, g.variant,
         g.hands, g.seats_sum, g.pot_sum, g.rake_sum, g.ante_sum,
         g.scoops, g.splits, g.unrecorded
    FROM grouped g;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  SELECT COALESCE(SUM(d.hands), 0) INTO v_hands
    FROM public.ca_club_bomb_pot_daily d
   WHERE d.club_id = p_club_id AND d.day = p_day;

  -- The marker is written even when the day held no bomb pots. A day with
  -- none is a FACT, and without the marker it would be re-scanned live for
  -- ever and read as "not yet known" rather than "none".
  INSERT INTO public.ca_club_bomb_pot_complete (club_id, day, rows_written, hands_read, computed_at)
  VALUES (p_club_id, p_day, v_rows, v_hands, now())
  ON CONFLICT (club_id, day) DO UPDATE
    SET rows_written = EXCLUDED.rows_written,
        hands_read   = EXCLUDED.hands_read,
        computed_at  = EXCLUDED.computed_at;

  RETURN v_rows;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_bomb_pot_rollup_day(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_bomb_pot_rollup_day(uuid, date) TO service_role;

COMMENT ON FUNCTION public.fn_ca_bomb_pot_rollup_day(uuid, date) IS
  'Seals one finished day of one club into ca_club_bomb_pot_daily. Refuses a day less than fifteen minutes old, because a sealed day is never recomputed and an award unit can land late.';

-- ───────────────────────────────────────────────────────────────────────────
--  3. Catching up whatever is missing, cheaply
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_bomb_pot_catchup(p_club_id uuid, p_days integer DEFAULT 30)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_day  date;
  v_done integer := 0;
BEGIN
  IF p_club_id IS NULL THEN
    RETURN 0;
  END IF;

  -- Only days the hands can still answer for. Reaching further back would
  -- write ZEROES over history that pruning removed, which is worse than the
  -- gap it would be papering over: the rollup exists to be believed.
  FOR v_day IN
    SELECT g::date
      FROM generate_series(
             GREATEST(
               (now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 30), 1), 365)))::date,
               (SELECT MIN(h.created_at)::date FROM public.hand_history h
                 WHERE h.bomb_pot IS NOT NULL)
             ),
             (now() - interval '15 minutes')::date - 1,
             interval '1 day') g
     WHERE NOT EXISTS (
       SELECT 1 FROM public.ca_club_bomb_pot_complete c
        WHERE c.club_id = p_club_id AND c.day = g::date)
     ORDER BY g DESC
     LIMIT 40
  LOOP
    PERFORM public.fn_ca_bomb_pot_rollup_day(p_club_id, v_day);
    v_done := v_done + 1;
  END LOOP;

  RETURN v_done;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_bomb_pot_catchup(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_bomb_pot_catchup(uuid, integer) TO service_role;

COMMENT ON FUNCTION public.fn_ca_bomb_pot_catchup(uuid, integer) IS
  'Seals any finished day in the window that has no marker yet, newest first, at most forty per call. Called by fn_club_bomb_pot_report so the rollup needs no scheduler.';

-- ───────────────────────────────────────────────────────────────────────────
--  4. The report: the rollup for finished days, the hands for today only
-- ───────────────────────────────────────────────────────────────────────────
-- The default stays: dropping it would need a DROP FUNCTION, and the client
-- calls this with p_days omitted.
CREATE OR REPLACE FUNCTION public.fn_club_bomb_pot_report(p_club_id uuid, p_days integer DEFAULT 30)
RETURNS TABLE(
  table_id uuid, table_name text, trigger_reason text, board_count integer,
  variant text, hands bigint, avg_players numeric, avg_pot numeric,
  total_pot numeric, total_rake numeric, total_antes numeric,
  scoops bigint, splits bigint, unrecorded_hands bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid        uuid    := auth.uid();
  v_authorized boolean := false;
  v_days       integer := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  v_from       date;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT
    EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = p_club_id AND c.owner_id = v_uid)
    OR EXISTS (
      SELECT 1 FROM public.club_members cm
      WHERE cm.club_id = p_club_id AND cm.user_id = v_uid
        AND lower(cm.role) IN ('owner', 'co_owner', 'admin')
    )
  INTO v_authorized;

  IF NOT v_authorized THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  -- Seal whatever is finished and unsealed. After midnight this is one day.
  PERFORM public.fn_ca_bomb_pot_catchup(p_club_id, v_days);

  v_from := (now() - make_interval(days => v_days))::date;

  RETURN QUERY
  WITH ok_days AS MATERIALIZED (
    SELECT c.day FROM public.ca_club_bomb_pot_complete c
     WHERE c.club_id = p_club_id AND c.day >= v_from
  ), from_rollup AS (
    SELECT d.table_id, d.trigger_reason, d.board_count, d.variant,
           d.hands, d.seats_sum, d.pot_sum, d.rake_sum, d.ante_sum,
           d.scoops, d.splits, d.unrecorded
      FROM public.ca_club_bomb_pot_daily d
      JOIN ok_days o ON o.day = d.day
     WHERE d.club_id = p_club_id
  ), from_live AS (
    -- Only the days no marker claims - today, and any day the rollup has not
    -- reached. This is the part that still touches hand_history, and it is
    -- one day of it rather than a year.
    SELECT b.table_id, b.trigger_reason, b.board_count, b.variant,
           count(*)::bigint                                          AS hands,
           SUM(b.seats)::numeric                                     AS seats_sum,
           SUM(b.pot_size)                                           AS pot_sum,
           SUM(b.rake_amount)                                        AS rake_sum,
           SUM(b.ante_amount * b.seats)                              AS ante_sum,
           count(*) FILTER (WHERE u.distinct_winners = 1)::bigint    AS scoops,
           count(*) FILTER (WHERE u.distinct_winners > 1)::bigint    AS splits,
           count(*) FILTER (WHERE u.hand_history_id IS NULL)::bigint AS unrecorded
      FROM (
        SELECT h.id, h.table_id,
               h.bomb_pot ->> 'trigger_reason'                      AS trigger_reason,
               (h.bomb_pot ->> 'board_count')::int                  AS board_count,
               h.bomb_pot ->> 'variant'                             AS variant,
               COALESCE((h.bomb_pot ->> 'ante_amount')::numeric, 0) AS ante_amount,
               COALESCE(h.pot_size, 0)                              AS pot_size,
               COALESCE(h.rake_amount, 0)                           AS rake_amount,
               COALESCE(jsonb_array_length(h.players), 0)           AS seats
          FROM public.hand_history h
          JOIN public.tables t ON t.id = h.table_id
         WHERE t.club_id = p_club_id
           AND h.bomb_pot IS NOT NULL
           AND h.created_at >= v_from::timestamptz
           AND NOT EXISTS (SELECT 1 FROM ok_days o2
                            WHERE o2.day = (h.created_at AT TIME ZONE 'UTC')::date)
      ) b
      LEFT JOIN (
        SELECT a.hand_history_id, count(DISTINCT a.user_id) AS distinct_winners
          FROM public.bomb_pot_award_units a
         WHERE a.created_at >= v_from::timestamptz
         GROUP BY a.hand_history_id
      ) u ON u.hand_history_id = b.id
     GROUP BY b.table_id, b.trigger_reason, b.board_count, b.variant
  ), merged AS (
    SELECT * FROM from_rollup
    UNION ALL
    SELECT * FROM from_live
  ), totalled AS (
    SELECT m.table_id, m.trigger_reason, m.board_count, m.variant,
           SUM(m.hands)::bigint      AS hands,
           SUM(m.seats_sum)          AS seats_sum,
           SUM(m.pot_sum)            AS pot_sum,
           SUM(m.rake_sum)           AS rake_sum,
           SUM(m.ante_sum)           AS ante_sum,
           SUM(m.scoops)::bigint     AS scoops,
           SUM(m.splits)::bigint     AS splits,
           SUM(m.unrecorded)::bigint AS unrecorded
      FROM merged m
     GROUP BY m.table_id, m.trigger_reason, m.board_count, m.variant
  )
  SELECT tt.table_id,
         t.name,
         tt.trigger_reason,
         tt.board_count,
         tt.variant,
         tt.hands,
         -- The averages are re-derived from the sums, so a range of days
         -- averages over the range rather than over the daily averages.
         round(tt.seats_sum / NULLIF(tt.hands, 0), 2),
         round(tt.pot_sum   / NULLIF(tt.hands, 0), 2),
         round(tt.pot_sum,  2),
         round(tt.rake_sum, 2),
         round(tt.ante_sum, 2),
         tt.scoops,
         tt.splits,
         tt.unrecorded
    FROM totalled tt
    LEFT JOIN public.tables t ON t.id = tt.table_id
   ORDER BY tt.hands DESC;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_club_bomb_pot_report(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_bomb_pot_report(uuid, integer) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_club_bomb_pot_report(uuid, integer) IS
  'Bomb pot summary for a club. Finished days come from ca_club_bomb_pot_daily, which outlives hand_history pruning; only the unsealed days are read from the hands. Same fourteen columns it has always returned.';

-- ───────────────────────────────────────────────────────────────────────────
--  5. Backfill every finished day the hands can still answer for
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  r        record;
  v_days   integer := 0;
  v_rows   integer := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT t.club_id, (h.created_at AT TIME ZONE 'UTC')::date AS day
      FROM public.hand_history h
      JOIN public.tables t ON t.id = h.table_id
     WHERE h.bomb_pot IS NOT NULL
       AND t.club_id IS NOT NULL
       AND h.created_at < (now() - interval '15 minutes')
     ORDER BY 1, 2
  LOOP
    IF (r.day + 1)::timestamptz <= now() - interval '15 minutes' THEN
      v_rows := v_rows + public.fn_ca_bomb_pot_rollup_day(r.club_id, r.day);
      v_days := v_days + 1;
    END IF;
  END LOOP;
  RAISE NOTICE 'backfilled % club-days, % rollup rows', v_days, v_rows;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
--  6. Assertions
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_src   text;
  v_a     numeric;
  v_b     numeric;
  v_club  uuid;
  v_day   date;
BEGIN
  -- Comment lines stripped: the body NAMES hand_history in the comment saying
  -- which single day it still reads from, and a check that cannot tell code
  -- from prose fails on its own explanation. That mistake cost 20260905042100
  -- its first apply today.
  SELECT string_agg(line, chr(10)) INTO v_src
    FROM (SELECT line FROM regexp_split_to_table(
            (SELECT prosrc FROM pg_proc WHERE proname = 'fn_club_bomb_pot_report'
              AND pronamespace = 'public'::regnamespace), chr(10)) AS line
           WHERE btrim(line) NOT LIKE '--%') q;

  IF v_src NOT LIKE '%ca_club_bomb_pot_daily d%' THEN
    RAISE EXCEPTION 'the report is not reading the rollup';
  END IF;
  IF v_src NOT LIKE '%NOT EXISTS (SELECT 1 FROM ok_days o2%' THEN
    RAISE EXCEPTION 'the live edge does not exclude the sealed days, so they are counted twice';
  END IF;

  -- The rollup must agree with the hands for a day both can answer for.
  SELECT c.club_id, c.day INTO v_club, v_day
    FROM public.ca_club_bomb_pot_complete c
    JOIN public.ca_club_bomb_pot_daily d ON d.club_id = c.club_id AND d.day = c.day
   ORDER BY c.day DESC LIMIT 1;

  IF v_club IS NOT NULL THEN
    SELECT SUM(d.pot_sum) INTO v_a
      FROM public.ca_club_bomb_pot_daily d
     WHERE d.club_id = v_club AND d.day = v_day;

    SELECT COALESCE(SUM(COALESCE(h.pot_size, 0)), 0) INTO v_b
      FROM public.hand_history h
      JOIN public.tables t ON t.id = h.table_id
     WHERE t.club_id = v_club
       AND h.bomb_pot IS NOT NULL
       AND h.created_at >= v_day::timestamptz
       AND h.created_at <  (v_day + 1)::timestamptz;

    IF COALESCE(v_a, 0) <> COALESCE(v_b, 0) THEN
      RAISE EXCEPTION 'the rollup for % on % totals % where the hands total %',
        v_club, v_day, v_a, v_b;
    END IF;
    RAISE NOTICE 'rollup agrees with the hands for % on %: % chips', v_club, v_day, v_a;
  END IF;
END $$;

COMMIT;
