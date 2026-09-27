-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819223300 "club_dashboard_hand_daily_rollup"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 4d6e9cb9f5d3cdee792ccf002c6ee3d2 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- "Hands Today" and "Rake Today" were reading club_daily_stats, which lags
-- badly. Measured on Midway Union: the card showed 10,195 hands for today
-- while hand_history actually held 28,195 for that club — a 64% under-report
-- on the dashboard's most prominent metric.
--
-- Counting hand_history live is not an option: the same count costs 2.75s
-- (30k buffers) because it fans out across every table of the club, and this
-- runs on page load.
--
-- So the rollup is maintained where the data arrives — the same AFTER INSERT
-- trigger that already resolves the club for every hand. One extra upsert
-- into a tiny table per hand, exact by construction.
--
-- club_daily_stats is left untouched (other surfaces read it) and is still
-- used as the fallback for dates that predate this rollup.

CREATE TABLE IF NOT EXISTS public.club_hand_daily (
  club_id      uuid NOT NULL,
  stat_date    date NOT NULL,
  hands        bigint  NOT NULL DEFAULT 0,
  rake         numeric NOT NULL DEFAULT 0,
  bbj          numeric NOT NULL DEFAULT 0,
  pot_total    numeric NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, stat_date)
);

ALTER TABLE public.club_hand_daily ENABLE ROW LEVEL SECURITY;

-- Backfill one (club, day) from hand_history. Chunked deliberately: the whole
-- range in one statement exceeds any workable timeout on the large clubs.
CREATE OR REPLACE FUNCTION public.ca_backfill_club_hand_daily(p_club_id uuid, p_date date)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '170s'
AS $fn$
DECLARE
  v_hands bigint;
BEGIN
  INSERT INTO club_hand_daily AS d (club_id, stat_date, hands, rake, bbj, pot_total)
  SELECT p_club_id, p_date,
         count(*),
         coalesce(sum(hh.rake_amount), 0),
         coalesce(sum(hh.bbj_amount), 0),
         coalesce(sum(hh.pot_size), 0)
  FROM hand_history hh
  JOIN tables t ON t.id = hh.table_id
  WHERE t.club_id = p_club_id
    AND hh.created_at >= p_date::timestamp AT TIME ZONE 'UTC'
    AND hh.created_at <  (p_date + 1)::timestamp AT TIME ZONE 'UTC'
  HAVING count(*) > 0
  ON CONFLICT (club_id, stat_date) DO UPDATE SET
    hands = EXCLUDED.hands, rake = EXCLUDED.rake, bbj = EXCLUDED.bbj,
    pot_total = EXCLUDED.pot_total, updated_at = now();

  SELECT hands INTO v_hands FROM club_hand_daily
   WHERE club_id = p_club_id AND stat_date = p_date;
  RETURN coalesce(v_hands, 0);
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_backfill_club_hand_daily(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_backfill_club_hand_daily(uuid, date) TO service_role;
