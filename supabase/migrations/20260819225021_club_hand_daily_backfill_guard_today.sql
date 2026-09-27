-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819225021 "club_hand_daily_backfill_guard_today"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 2aab12eec035854a8f4f1fc5c79d4412 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ca_backfill_club_hand_daily writes an ABSOLUTE count taken from a snapshot,
-- which means any hand dealt while it runs is discarded along with the trigger
-- increment that already recorded it. Observed on Midway Union: a run left the
-- day exactly 20 hands short, and a second run (during a quieter moment) came
-- back exact at 29,905 = 29,905.
--
-- Past days are immutable, so overwriting them is always safe. TODAY is not:
-- the trigger owns it and is exact from the first hand of the day, so a
-- careless re-run would replace a correct running total with a snapshot that
-- is missing whatever was dealt during the scan.
--
-- The current day is therefore guarded behind p_force. Normal operation is to
-- backfill history only and let the trigger own today; from the next UTC
-- midnight the trigger owns every day end to end and no backfill is needed.
CREATE OR REPLACE FUNCTION public.ca_backfill_club_hand_daily(
  p_club_id uuid,
  p_date    date,
  p_force   boolean DEFAULT false
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '170s'
AS $fn$
DECLARE
  v_hands bigint;
BEGIN
  IF p_date >= (now() AT TIME ZONE 'UTC')::date AND NOT coalesce(p_force, false) THEN
    RAISE EXCEPTION
      'refusing to overwrite the current day (%) — the trigger maintains it exactly; pass p_force => true only if you know it has drifted',
      p_date
      USING ERRCODE = '55000';
  END IF;

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

DROP FUNCTION IF EXISTS public.ca_backfill_club_hand_daily(uuid, date);

REVOKE ALL ON FUNCTION public.ca_backfill_club_hand_daily(uuid, date, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ca_backfill_club_hand_daily(uuid, date, boolean) TO service_role;
