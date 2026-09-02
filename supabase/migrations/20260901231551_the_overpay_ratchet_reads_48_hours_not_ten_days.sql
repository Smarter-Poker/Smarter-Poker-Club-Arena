-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260901231551; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- fn_ca_ratchet_watch took 31 seconds with the overpay count reading ten days:
-- a correlated credit-sum over 44,464 completed tournaments, every hour. That
-- is the same mistake the rake ratchet made earlier today, and it has the same
-- answer - the ratchet exists to say the floor MOVED, not to re-audit history.
--
-- 48 hours: 4 events, and the ten-day view stays available for a person
-- investigating (fn_ca_prize_overpay_unexplained takes an interval).
--
-- The baseline is rebased to the 48-hour count in the same statement, because
-- a baseline measured over a different window than the check is meaningless.

CREATE OR REPLACE FUNCTION public.fn_ca_prize_overpay_count()
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT count(*)::int FROM public.fn_ca_prize_overpay_unexplained('48 hours'::interval);
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_prize_overpay_count() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_prize_overpay_count() TO service_role;

UPDATE public.ca_ratchet_baselines
   SET baseline = public.fn_ca_prize_overpay_count(),
       tightened_at = now(),
       note = 'Completed tournaments paying beyond both pool and guarantee, excluding satellites and Spins, in a rolling 48 HOURS (a ten-day scan cost 31s of the hourly watch). 4 events / 18,394.61 chips on 2026-09-01, 97% of it one MTT: Sunday $200 Deep Stack, 115 entrants, 133 rebuys, pool 44,640, guarantee 20,000, paid 63,021.60. Rolling, so it falls as events age out; a RISE means settlement is creating chips again. Use fn_ca_prize_overpay_unexplained(''10 days'') for the wider view.'
 WHERE ratchet = 'prize_overpay_unexplained_10d';

