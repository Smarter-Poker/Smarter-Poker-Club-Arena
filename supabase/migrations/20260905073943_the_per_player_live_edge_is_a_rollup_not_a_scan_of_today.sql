-- ═══════════════════════════════════════════════════════════════════════════
--  THE PER-PLAYER LIVE EDGE IS A ROLLUP, NOT A SCAN OF TODAY
--  Club Operations upgrade, phase 7 of 8. Found by phase 7's own gate.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `fn_ca_rake_by_agent` was 29.7 seconds. `20260905042100` stopped it
-- re-deriving a share per raked hand, `20260905052500` bounded its live scan to
-- the days the rollup has not sealed, and `20260905042500` gave that scan an
-- index. Measured at 03:55 UTC: **490-983ms**, and `ca_rake_snapshot` answered
-- the browser in 591-1,157ms on every range.
--
-- Measured again at 07:37 UTC THE SAME MORNING, on the same club, with nothing
-- changed: **3,402ms**, and `ca_rake_snapshot` back to **500 after 8,155ms**.
--
-- Nothing regressed. THE LIVE EDGE GROWS ALL DAY, and I had measured it at
-- four in the morning:
--
--     2026-09-01     9,288 attribution rows     175 players
--     2026-09-02    77,619                      267
--     2026-09-03   328,535                      257
--     2026-09-04   185,928                      237
--     2026-09-05    38,598  (07:37, still open) 174
--
-- Bounding the scan to one day is only a fix while that day is small. A busy
-- day is a third of a million rows, so the same read that took 490ms before
-- breakfast would take a minute by midnight, and the panel would go back to
-- dashes every evening and heal itself every morning - which is worse than
-- failing outright, because it looks like something else's fault.
--
-- THE ANSWER IS THE ONE PHASE 6 ALREADY ESTABLISHED for the club-level figure.
-- `ca_club_rake_daily` is kept exact by three statement-level triggers on
-- `rake_records`, so the club total for today is READ rather than derived. The
-- per-player figure had no such table: `club_rake_daily_user` exists but is
-- written once a day by `fn_club_rake_rollup_day`, which is why today had to
-- be scanned at all.
--
-- `ca_club_rake_daily_user` is that missing table, and it is the same shape,
-- with the same three triggers, on `rake_attributions` - the table
-- `club_rake_daily_user` is itself built from, so the live edge and the sealed
-- days remain one number by construction.
--
-- CENTS, NOT NUMERIC. The read this replaces is
-- `SUM(round(ra.rake_amount * 100)::bigint)::numeric / 100` - each row rounded
-- to a cent, then summed. Accumulating that incrementally in `numeric` would
-- be a different number from summing it in one pass. Storing the integer
-- cents and dividing once at read time is the same arithmetic in a different
-- order, and integers do not drift.
--
-- THE TRIGGER CAN NEVER FAIL A RAKED HAND. Every one of them mirrors
-- `trg_ca_club_rake_daily_insert`: collect ids from the transition table, hand
-- them to an apply function, and swallow any error as a WARNING. A rollup that
-- can refuse an INSERT into `rake_attributions` is a rollup that can stop the
-- engine paying rake, and no reporting figure is worth that. If the apply ever
-- does fail, the day self-heals: `fn_ca_club_rake_daily_user_rebuild_day`
-- recomputes a key exactly, and the sealed-day path never reads this table.
--
-- SPLIT IN TWO, AND THIS HALF TAKES NO LOCK. `CREATE TRIGGER` holds a
-- SHARE ROW EXCLUSIVE lock on `rake_attributions`, which blocks the engine
-- from writing rake for as long as it is held - so the three triggers and the
-- read that depends on them ship in 20260905074228, inside the `:55`
-- maintenance freeze, when nothing is writing. This half creates the table,
-- the two writers and the backfill, and changes no behaviour at all: nothing
-- reads `ca_club_rake_daily_user` until that second migration lands.
--
-- The order matters and is not arbitrary. If the READ switched to the rollup
-- before the TRIGGERS existed, every hand raked in between would be missing
-- from the panel and nothing would say so. So the read and the triggers land
-- together, and this half only prepares the ground.
--
-- NO TOURNAMENT FILTER, deliberately, and this differs from phase 6's
-- club-level trigger which excludes `is_tournament`. `fn_ca_rake_by_agent`
-- takes every attribution row the club produced, cash and tournament alike,
-- and a rollup that filtered differently from the read it replaces would be a
-- silent change to what an agent is credited with. `rake_attributions` has no
-- such column anyway.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

SET LOCAL lock_timeout = '20s';
SET LOCAL statement_timeout = '0';

-- ───────────────────────────────────────────────────────────────────────────
--  1. The table
-- ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ca_club_rake_daily_user (
  club_id     uuid        NOT NULL,
  day         date        NOT NULL,
  user_id     uuid        NOT NULL,
  -- Integer cents. See the header: this is the same arithmetic the read it
  -- replaces performs, in an order that survives being done incrementally.
  rake_cents  bigint      NOT NULL DEFAULT 0,
  hands       bigint      NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, day, user_id)
);

ALTER TABLE public.ca_club_rake_daily_user ENABLE ROW LEVEL SECURITY;

-- No policies: RLS on with none denies everything, and the only reader is a
-- SECURITY DEFINER function that is gated a level up in ca_rake_snapshot.
REVOKE ALL ON TABLE public.ca_club_rake_daily_user FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ca_club_rake_daily_user TO service_role;

COMMENT ON TABLE public.ca_club_rake_daily_user IS
  'Per club, day and player rake in integer cents, kept exact by statement-level triggers on rake_attributions. The live edge of fn_ca_rake_by_agent reads this instead of scanning a day that reaches a third of a million rows by midnight.';

-- ───────────────────────────────────────────────────────────────────────────
--  2. Applying a set of new attribution rows as a delta
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_club_rake_daily_user_apply(p_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.ca_club_rake_daily_user (club_id, day, user_id, rake_cents, hands, updated_at)
  SELECT ra.club_id,
         (ra.created_at AT TIME ZONE 'UTC')::date,
         ra.player_id,
         SUM(round(ra.rake_amount * 100))::bigint,
         count(*)::bigint,
         now()
    FROM public.rake_attributions ra
   WHERE ra.id = ANY (p_ids)
     AND ra.club_id IS NOT NULL
     AND ra.player_id IS NOT NULL
     AND ra.rake_amount > 0
   GROUP BY 1, 2, 3
  ON CONFLICT (club_id, day, user_id) DO UPDATE
     SET rake_cents = public.ca_club_rake_daily_user.rake_cents + EXCLUDED.rake_cents,
         hands      = public.ca_club_rake_daily_user.hands + EXCLUDED.hands,
         updated_at = now();
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_club_rake_daily_user_apply(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_rake_daily_user_apply(uuid[]) TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
--  3. Recomputing one key exactly, for repair and for update/delete
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_club_rake_daily_user_rebuild_day(
  p_club_id uuid, p_day date, p_user_id uuid DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_rows bigint := 0;
BEGIN
  IF p_club_id IS NULL OR p_day IS NULL THEN
    RETURN 0;
  END IF;

  DELETE FROM public.ca_club_rake_daily_user d
   WHERE d.club_id = p_club_id AND d.day = p_day
     AND (p_user_id IS NULL OR d.user_id = p_user_id);

  INSERT INTO public.ca_club_rake_daily_user (club_id, day, user_id, rake_cents, hands, updated_at)
  SELECT ra.club_id,
         p_day,
         ra.player_id,
         SUM(round(ra.rake_amount * 100))::bigint,
         count(*)::bigint,
         now()
    FROM public.rake_attributions ra
   WHERE ra.club_id = p_club_id
     AND ra.created_at >= p_day::timestamptz
     AND ra.created_at <  (p_day + 1)::timestamptz
     AND ra.player_id IS NOT NULL
     AND ra.rake_amount > 0
     AND (p_user_id IS NULL OR ra.player_id = p_user_id)
   GROUP BY 1, 3;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_club_rake_daily_user_rebuild_day(uuid, date, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_club_rake_daily_user_rebuild_day(uuid, date, uuid) TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
--  6. Backfill every day the sealed rollup has not claimed
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  r      record;
  v_keys bigint := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT ra.club_id, (ra.created_at AT TIME ZONE 'UTC')::date AS day
      FROM public.rake_attributions ra
     WHERE ra.club_id IS NOT NULL
  LOOP
    v_keys := v_keys + public.fn_ca_club_rake_daily_user_rebuild_day(r.club_id, r.day, NULL);
  END LOOP;
  RAISE NOTICE 'backfilled % (club, day, player) rows', v_keys;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
--  6. Assertions
-- ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_club uuid; v_day date; v_a numeric; v_b numeric; v_days int;
BEGIN
  SELECT count(DISTINCT (club_id, day)) INTO v_days FROM public.ca_club_rake_daily_user;
  IF v_days = 0 THEN
    RAISE EXCEPTION 'the backfill wrote nothing, so the rollup would read as a club that earned no rake';
  END IF;

  -- Every (club, day) the attributions know about must be in the rollup, or a
  -- day the sealed path never claimed would silently read as zero.
  IF EXISTS (
    SELECT 1 FROM (
      SELECT DISTINCT ra.club_id, (ra.created_at AT TIME ZONE 'UTC')::date AS day
        FROM public.rake_attributions ra
       WHERE ra.club_id IS NOT NULL AND ra.player_id IS NOT NULL AND ra.rake_amount > 0
    ) k
    WHERE NOT EXISTS (SELECT 1 FROM public.ca_club_rake_daily_user du
                       WHERE du.club_id = k.club_id AND du.day = k.day)
  ) THEN
    RAISE EXCEPTION 'a club-day the attributions carry is missing from the rollup';
  END IF;

  SELECT du.club_id, du.day INTO v_club, v_day
    FROM public.ca_club_rake_daily_user du
   GROUP BY du.club_id, du.day ORDER BY sum(du.hands) DESC LIMIT 1;

  SELECT SUM(du.rake_cents)::numeric / 100 INTO v_a
    FROM public.ca_club_rake_daily_user du
   WHERE du.club_id = v_club AND du.day = v_day;

  SELECT COALESCE(SUM(round(ra.rake_amount * 100)), 0)::numeric / 100 INTO v_b
    FROM public.rake_attributions ra
   WHERE ra.club_id = v_club AND ra.player_id IS NOT NULL AND ra.rake_amount > 0
     AND ra.created_at >= v_day::timestamptz
     AND ra.created_at <  (v_day + 1)::timestamptz;

  IF COALESCE(v_a,0) <> COALESCE(v_b,0) THEN
    RAISE EXCEPTION 'the rollup for % on % totals % where the attributions total %',
      v_club, v_day, v_a, v_b;
  END IF;
  RAISE NOTICE 'rollup agrees with the attributions for % on %: % chips (% club-days backfilled)',
    v_club, v_day, v_a, v_days;
END $$;

COMMIT;
