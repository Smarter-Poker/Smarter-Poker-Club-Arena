-- 20261015132358_player_management_fees_accumulate_from_the_week_of_october_t.sql
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, 2026-10-15, correcting 20261015121331: "I DON'T WANT THE STATS RESET
-- EVERY WEEK ... THEY SHOULD ACCUMULATE FOR EVER FROM THIS POINT ONWARD ...
-- STARTING AT THE BEGINNING OF THIS WEEK, ANY AND ALL STATS FROM THIS WEEK
-- SHOULD STAY."
--
-- 20261015121331 made ca_club_member_fee_totals count from the CURRENT weekly
-- reset, so every Monday each player and horse would fall back to zero. This
-- pins the start to one fixed day instead: Monday 2026-10-12, the first day of
-- this week (America/Los_Angeles, the same Monday fn_ca_fee_week_start returns
-- today). Fees before it stay excluded; this week's fees stay; everything from
-- then on accumulates with no further reset.
--
-- Only the from-day changes. The fee ledgers are not deleted or rewritten
-- (CLAUDE.md 10.9), horses and humans are treated identically (10.5), and the
-- function's signature, owner, ACL and every reader are unchanged.
-- fn_ca_fee_week_start stays installed and unused by this function.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
BEGIN
  IF md5(pg_get_functiondef('public.ca_club_member_fee_totals(uuid,date,date,uuid)'::regprocedure))
       IS DISTINCT FROM '01a96cab63fcf171047f9de665d90ce2' THEN
    RAISE EXCEPTION 'FEE_TOTALS_PREIMAGE_CHANGED';
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.fn_ca_fee_counting_start()
RETURNS date
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT DATE '2026-10-12';
$function$;
COMMENT ON FUNCTION public.fn_ca_fee_counting_start() IS
  'Fixed first day (Monday 2026-10-12, America/Los_Angeles) that Player Management fees count from. Fees accumulate from this day onward with no weekly reset.';
REVOKE ALL ON FUNCTION public.fn_ca_fee_counting_start() FROM PUBLIC, anon, authenticated;

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
    SELECT greatest(coalesce(p_from, public.fn_ca_fee_counting_start()),
                    public.fn_ca_fee_counting_start()) AS from_day
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
  'Fees generated per club member from the fixed start fn_ca_fee_counting_start() (2026-10-12) onward, with no weekly reset: attributed cash rake (ca_club_rake_daily_user) plus tournament fee receipts (ca_club_member_tournament_fee_daily). Ledgers are never modified. Internal; called by the roster, downline and member detail readers.';
REVOKE ALL ON FUNCTION public.ca_club_member_fee_totals(uuid, date, date, uuid) FROM PUBLIC, anon, authenticated;

DO $post$
BEGIN
  IF position('fn_ca_fee_counting_start()' IN pg_get_functiondef('public.ca_club_member_fee_totals(uuid,date,date,uuid)'::regprocedure)) = 0
  OR position('fn_ca_fee_week_start' IN pg_get_functiondef('public.ca_club_member_fee_totals(uuid,date,date,uuid)'::regprocedure)) > 0
  OR (SELECT proacl::text FROM pg_proc WHERE oid = 'public.ca_club_member_fee_totals(uuid,date,date,uuid)'::regprocedure)
       IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}'
  THEN RAISE EXCEPTION 'FEE_TOTALS_POSTIMAGE_WRONG'; END IF;
END $post$;

COMMIT;
