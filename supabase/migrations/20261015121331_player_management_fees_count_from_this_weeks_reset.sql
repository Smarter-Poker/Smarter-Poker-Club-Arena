-- 20261015121331_player_management_fees_count_from_this_weeks_reset.sql
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, 2026-10-15: "I WANT FEES TO ONLY GO BACK AND START FROM THIS WEEKS
-- RESET, I WANT ANY AND ALL OLD FEES REMOVED AND ONLY THIS WEEKS FEES START
-- ... FROM ALL HORSE AND PLAYER ACCOUNTS."
--
-- Every fee figure in Player Management (roster rows, filters, sorts, export,
-- the downline list, and the player detail Total Fee / MTT Fee) reads one
-- function, ca_club_member_fee_totals. It now counts only from the current
-- weekly reset: Monday 00:00 America/Los_Angeles (fn_union_week_start), the
-- same Monday-to-Sunday week the rakeback periods use. Each Monday every
-- player and horse starts again at zero.
--
-- The fee ledgers themselves are NOT deleted or rewritten. They are the
-- immutable records agent commissions, rakeback and statements are paid from
-- (CLAUDE.md 10.9: never rewrite or delete a settled record). Old weeks simply
-- stop being counted on these surfaces. Horses and humans are treated
-- identically (CLAUDE.md 10.5).
--
-- The day keys of both ledgers are dates, so the week is the dates from this
-- Monday onward, matching rakeback_periods.period_start.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.fn_ca_fee_week_start(p_at timestamptz DEFAULT now())
RETURNS date
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT (public.fn_union_week_start(p_at) AT TIME ZONE 'America/Los_Angeles')::date;
$function$;
COMMENT ON FUNCTION public.fn_ca_fee_week_start(timestamptz) IS
  'First day (Monday, America/Los_Angeles) of the weekly reset that Player Management fees count from.';
REVOKE ALL ON FUNCTION public.fn_ca_fee_week_start(timestamptz) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.ca_club_member_fee_totals(
  p_club_id uuid,
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_user_id uuid DEFAULT NULL
)
RETURNS TABLE(user_id uuid, cash_fees numeric, tournament_fees numeric, total_fees numeric)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH bounds AS (
    SELECT greatest(coalesce(p_from, public.fn_ca_fee_week_start()),
                    public.fn_ca_fee_week_start()) AS from_day
  ), cash AS (
    SELECT d.user_id AS uid, sum(d.rake_cents)::numeric / 100 AS fees
      FROM public.ca_club_rake_daily_user d, bounds b
     WHERE d.club_id = p_club_id
       AND (p_user_id IS NULL OR d.user_id = p_user_id)
       AND d.day >= b.from_day
       AND (p_to IS NULL OR d.day <= p_to)
     GROUP BY d.user_id
  ), mtt AS (
    SELECT t.user_id AS uid, sum(t.fees) AS fees
      FROM public.ca_club_member_tournament_fee_daily t, bounds b
     WHERE t.club_id = p_club_id
       AND (p_user_id IS NULL OR t.user_id = p_user_id)
       AND t.day >= b.from_day
       AND (p_to IS NULL OR t.day <= p_to)
     GROUP BY t.user_id
  )
  SELECT coalesce(c.uid, m.uid),
         round(coalesce(c.fees, 0), 2),
         round(coalesce(m.fees, 0), 2),
         round(coalesce(c.fees, 0) + coalesce(m.fees, 0), 2)
    FROM cash c
    FULL JOIN mtt m ON m.uid = c.uid;
$function$;
COMMENT ON FUNCTION public.ca_club_member_fee_totals(uuid, date, date, uuid) IS
  'Fees generated per club member since the current weekly reset (fn_ca_fee_week_start): attributed cash rake (ca_club_rake_daily_user) plus tournament fee receipts (ca_club_member_tournament_fee_daily). Ledgers are never modified; older weeks are not counted. Internal; called by the roster, downline and member detail readers.';
REVOKE ALL ON FUNCTION public.ca_club_member_fee_totals(uuid, date, date, uuid) FROM PUBLIC, anon, authenticated;

COMMIT;
