-- Owner requested weekly leaderboard payment Monday 02:00 America/Chicago;
-- monthly payment is the first Monday after the month closes, also 02:00.
-- Existing job190 ran daily00:20UTC. This changes its timing, not prizes,
-- ranking windows, funding, immutable receipts or duplicate-payment keys.
-- Twin UTC ticks handle DST; only the Chicago02:00 tick invokes settlement.
-- Each round must also reach its own due time, including manual worker calls.
-- No money is moved during installation. Existing settled rounds stay settled.
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '10s';

CREATE FUNCTION public.fn_leaderboard_payout_due_at(p_period text, p_period_end date)
RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_period NOT IN ('weekly', 'monthly') THEN
    RAISE EXCEPTION 'Unsupported Leaderboard Payout Period' USING ERRCODE = '22023';
  END IF;
  RETURN ((p_period_end + ((8 - extract(isodow FROM p_period_end)::integer) % 7))
          + time '02:00') AT TIME ZONE 'America/Chicago';
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_leaderboard_payout_due_at(text,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_leaderboard_payout_due_at(text,date) TO service_role;

DO $patch$
DECLARE
  v_def text := pg_get_functiondef('public.fn_settle_due_leaderboards()'::regprocedure);
  v_old constant text := $old$    WHERE NOT EXISTS ($old$;
  v_new constant text := $new$    WHERE public.fn_leaderboard_payout_due_at(due.period,
      CASE due.period WHEN 'weekly' THEN due.period_start + 7
      ELSE (due.period_start + interval '1 month')::date END) <= now()
    AND NOT EXISTS ($new$;
BEGIN
  IF md5(v_def) IS DISTINCT FROM 'd0d452a2d2c96400743972370d0f6ece'
     OR (length(v_def)-length(replace(v_def,v_old,'')))/length(v_old) <> 1 THEN
    RAISE EXCEPTION 'leaderboard_monday_worker_preimage_changed';
  END IF;
  EXECUTE replace(v_def,v_old,v_new);
END;
$patch$;

DO $schedule$
DECLARE v_job bigint;
BEGIN
  SELECT jobid INTO STRICT v_job FROM cron.job
  WHERE jobname='leaderboard-payout-waterfall-daily'
    AND command='SELECT public.fn_settle_due_leaderboards();' AND active;
  PERFORM cron.alter_job(v_job,
    schedule := '0 7,8 * * 1',
    command := $command$DO $tick$
BEGIN
  IF extract(isodow FROM now() AT TIME ZONE 'America/Chicago') = 1
     AND extract(hour FROM now() AT TIME ZONE 'America/Chicago') = 2 THEN
    PERFORM public.fn_settle_due_leaderboards();
  END IF;
END;
$tick$;$command$);
END;
$schedule$;
COMMIT;
