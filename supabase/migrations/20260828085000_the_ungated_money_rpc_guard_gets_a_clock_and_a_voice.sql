-- THE UNGATED-MONEY-RPC GUARD GETS A CLOCK AND A VOICE.
--
-- fn_ungated_money_rpcs was built earlier today and then left with no caller:
-- nothing ran it, and it had no way to say anything if it found something. A
-- detector that only answers when an operator remembers to ask is the same
-- shape as the four repairs this session found sitting behind perfect
-- detection - and it is exactly what the playbook's wiring check ("is every new
-- function actually CALLED? Dead code is unacceptable") exists to catch. It
-- caught this one.
--
-- It now runs daily and files a critical if the count is ever non-zero. A
-- money-mutating SECURITY DEFINER function that `authenticated` can call with
-- no authorization gate is one missing line away from letting any registered
-- account mint chips, so the alert is worth waking someone for.
--
-- Deduped on the open alert, so a standing problem is one row rather than one
-- per day - the mistake that put 173 identical BBJ snapshots in the queue.

CREATE OR REPLACE FUNCTION public.fn_check_ungated_money_rpcs()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_n int; v_list text;
BEGIN
  SELECT count(*), string_agg(fn || '(' || args || ')', ', ')
    INTO v_n, v_list
    FROM public.fn_ungated_money_rpcs();

  IF v_n > 0 THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    SELECT 'critical', 'fn_check_ungated_money_rpcs',
           v_n || ' money-mutating SECURITY DEFINER function(s) are callable by '
             || 'authenticated with no authorization gate',
           jsonb_build_object('count', v_n, 'functions', v_list)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.financial_alerts
        WHERE source = 'fn_check_ungated_money_rpcs' AND resolved IS NOT TRUE);
  ELSE
    -- Self-resolving: a guard that can raise must be able to stand down.
    UPDATE public.financial_alerts
       SET resolved = true, resolved_at = now()
     WHERE source = 'fn_check_ungated_money_rpcs' AND resolved IS NOT TRUE;
  END IF;

  RETURN jsonb_build_object('ok', true, 'ungated', v_n, 'functions', v_list);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_check_ungated_money_rpcs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_check_ungated_money_rpcs() TO service_role;

DO $sched$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ungated-money-rpc-check') THEN
    PERFORM cron.unschedule('ungated-money-rpc-check');
  END IF;
END
$sched$;

SELECT cron.schedule(
  'ungated-money-rpc-check',
  '15 4 * * *',
  $job$
  select case
           when pg_try_advisory_lock(hashtext('ungated-money-rpc-check'))
             then (select set_config('statement_timeout','120s',true) is not null
                      and public.fn_check_ungated_money_rpcs() IS NOT NULL)::text
           else 'skipped: previous run still in progress'
         end;
  $job$
);

DO $post$
DECLARE v_res jsonb; v_job int;
BEGIN
  SELECT count(*) INTO v_job FROM cron.job
   WHERE jobname = 'ungated-money-rpc-check' AND active
     AND command LIKE '%fn_check_ungated_money_rpcs%';
  IF v_job <> 1 THEN
    RAISE EXCEPTION 'the guard has no active cron job; it is still dead code';
  END IF;

  -- Run it once now so the wiring is proven, not assumed.
  v_res := public.fn_check_ungated_money_rpcs();
  IF (v_res->>'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'the guard did not run: %', v_res;
  END IF;
  IF (v_res->>'ungated')::int <> 0 THEN
    RAISE EXCEPTION 'guard reports % ungated money RPC(s): %',
      v_res->>'ungated', v_res->>'functions';
  END IF;
END
$post$;
