-- fn_ca_ratchet_watch took 31 seconds with the overpay count reading ten days:
-- a correlated credit-sum over 44,464 completed tournaments, every hour. Same
-- mistake the rake ratchet made earlier today, same answer - a ratchet exists
-- to say the floor MOVED, not to re-audit history.
--
-- Measured afterwards, per ratchet: undeclared_money_paths 8.2s (a catalog
-- sweep, the dominant cost), rake 2.1s, champion 0.41s, overpay 0.27s,
-- unledgered 0.05s. Every statement sits inside the 30s statement_timeout.
--
-- The baseline is rebased in the same statement, because a baseline measured
-- over a different window than the check is meaningless.

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
       tightened_at = now()
 WHERE ratchet = 'prize_overpay_unexplained_10d';
