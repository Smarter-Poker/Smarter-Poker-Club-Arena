-- ═══════════════════════════════════════════════════════════════════════════
--  A MONEY ALERT THAT HEALED ITSELF SHOULD SAY SO, AND SOMEBODY SHOULD BE TOLD
--  ABOUT THE ONES THAT DID NOT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHY (measured 2026-09-04)
--
--     1,345 unresolved rows in financial_alerts
--       656 distinct conditions  (2.1 copies of each)
--       154 of them are alerts ABOUT alerts (drift_incident:financial_alerts:*)
--    oldest 2026-08-20 - fifteen days unlooked-at
--
-- Nobody has ever been told about any of it. The table works perfectly: every
-- reconciler, guard and sweep on the platform writes here, and the rows sit.
-- This is the same failure as the settlement outage found earlier today - the
-- database knowing something 139,153 times with no way to say it out loud -
-- one layer up.
--
-- AND THE LOUDEST ALERTS IN IT ARE NOT TRUE
--
-- `Tournament.winner_prize_credit_failed` says, in as many words, "N chips owed
-- to <user> were never paid". Every one of the five unresolved instances had
-- ALREADY BEEN PAID when this was written:
--
--     alert 11:29:04 -> paid 11:29:13      9 seconds
--     alert 11:29:02 -> paid 11:29:11      9 seconds
--     alert 19:20:24 -> paid 19:20:33      9 seconds
--     alert 19:20:21 -> paid 19:38:35     18 minutes
--     alert 20:21:52 -> paid 20:52:01     30 minutes
--
-- The engine's direct credit hits the service_role statement timeout, retries
-- three times, gives up and raises a CRITICAL alert asserting the player was
-- never paid. The reconciler then pays them, correctly and idempotently,
-- seconds later. Nothing goes back to close the alert.
--
-- Every payment-linked alert in the table tells the same story: 69 of 71 where
-- a payout row can be matched show the money landed. So the backlog is not a
-- pile of unpaid players. It is a pile of recoveries nobody recorded - and it
-- is deep enough to hide a real one, which is the actual danger.
--
-- WHAT THIS DOES
--
-- 1. `fn_resolve_settled_prize_alerts()` closes ONLY the class where the alert
--    asserts non-payment and the payment provably happened: a
--    tournament_payouts row for that exact tournament and user, with paid_at
--    set and an amount matching what the alert said was owed. It writes a
--    resolution naming the evidence. It resolves nothing else.
--
-- 2. `fn_financial_alert_health()` puts the remaining backlog on a gauge, aged.
--    Age is the load-bearing dimension: a critical raised a minute ago is the
--    system working, and the same alert still open a day later is nobody
--    listening.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
-- It does not bulk-resolve the other 1,300 rows. Most are probably stale in
-- the same way, and "probably" is not evidence; section 10.9 reserves
-- rewriting a settled record to make a number look tidy to Dan alone. They are
-- left open, visibly, with their age on a gauge, which is the honest state.
--
-- Specifically NOT auto-resolved, though they match on a payout row:
--   * `fn_settle_tournament_obligation` "Refused 0.09 ... pool already paid
--     1500.00 of 1500.00" - the guard behaved correctly, but a player is still
--     short a rounding residual the pool cannot fund. That is a real question.
--   * `Tournament.guarantee_not_met` - an advertised guarantee that was not
--     met is what a FUTURE event owes as much as a past one, and section 10.9
--     puts guarantees with Dan.
--
-- ROLLBACK
--   SELECT cron.unschedule('sp_resolve_settled_prize_alerts_15m');
--   DROP FUNCTION IF EXISTS public.fn_resolve_settled_prize_alerts();
--   DROP FUNCTION IF EXISTS public.fn_financial_alert_health(integer);
-- Resolved rows are not restored by that; `resolution` names this migration,
-- so they are identifiable:
--   UPDATE financial_alerts SET resolved=false, resolved_at=NULL, resolution=NULL
--    WHERE resolution LIKE 'auto-resolved 2026-09-04%';
-- ═══════════════════════════════════════════════════════════════════════════

-- CLAUDE.md 10.9 (both repos) says a settlement is finished when the
-- financial_alerts row is "resolved with a resolution note saying what was
-- accepted and why". THAT COLUMN HAS NEVER EXISTED. financial_alerts carries
-- resolved, resolved_at and resolved_by (a uuid) - nowhere to put prose. Every
-- agent instructed to write a resolution note has had nowhere to write it,
-- and a rule that cannot be followed stops being followed.
ALTER TABLE public.financial_alerts ADD COLUMN IF NOT EXISTS resolution text;

COMMENT ON COLUMN public.financial_alerts.resolution IS
  'Why this alert was closed, in prose. Required by CLAUDE.md 10.9 for any money settlement; the column was missing until 2026-09-04, so the documented workflow could not be followed. resolved_by is a uuid and cannot carry it.';

CREATE OR REPLACE FUNCTION public.fn_resolve_settled_prize_alerts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_closed integer := 0;
BEGIN
  WITH provable AS (
    SELECT a.id,
           tp.amount   AS paid_amount,
           tp.paid_at,
           tp.idempotency_key
    FROM public.financial_alerts a
    JOIN public.tournament_payouts tp
      ON tp.tournament_id = (a.context->>'tournament_id')::uuid
     AND tp.user_id       = (a.context->>'user_id')::uuid
    WHERE NOT a.resolved
      AND a.source = 'Tournament.winner_prize_credit_failed'
      AND a.context ? 'tournament_id'
      AND a.context ? 'user_id'
      AND a.context ? 'prize'
      AND tp.paid_at IS NOT NULL
      -- The amount must match what the alert said was owed. A payout for a
      -- DIFFERENT amount is not evidence that THIS obligation was met.
      AND tp.amount = (a.context->>'prize')::numeric
  )
  UPDATE public.financial_alerts a
     SET resolved    = true,
         resolved_at = now(),
         resolution  = format(
           'auto-resolved 2026-09-04: the reconciler paid this. tournament_payouts records %s chips paid at %s under idempotency key %s. The alert was raised by the engine when its direct credit hit the statement timeout, BEFORE the reconciler ran; the assertion that the player "was never paid" was false when it was written.',
           p.paid_amount, p.paid_at, p.idempotency_key)
    FROM provable p
   WHERE a.id = p.id;

  GET DIAGNOSTICS v_closed = ROW_COUNT;
  RETURN v_closed;
END;
$function$;

COMMENT ON FUNCTION public.fn_resolve_settled_prize_alerts() IS
  'Closes Tournament.winner_prize_credit_failed alerts whose money provably landed - a tournament_payouts row for the same tournament and user, paid_at set, amount equal to the prize the alert named. Nothing else is auto-resolved. The alert is raised when the engine credit times out, before the reconciler runs; measured 2026-09-04, the reconciler had already paid all five open instances, three of them within 9 seconds.';

REVOKE ALL ON FUNCTION public.fn_resolve_settled_prize_alerts() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_resolve_settled_prize_alerts() FROM anon;
REVOKE ALL ON FUNCTION public.fn_resolve_settled_prize_alerts() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_resolve_settled_prize_alerts() TO service_role;


CREATE OR REPLACE FUNCTION public.fn_financial_alert_health(p_stale_hours integer DEFAULT 24)
RETURNS TABLE (
  unresolved_total      bigint,
  unresolved_critical   bigint,
  stale_critical        bigint,
  distinct_conditions   bigint,
  oldest_unresolved_age numeric,
  meta_alerts           bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    count(*),
    count(*) FILTER (WHERE severity = 'critical'),
    count(*) FILTER (WHERE severity = 'critical'
                       AND created_at < now() - make_interval(hours => greatest(p_stale_hours, 1))),
    count(DISTINCT (source || '|' || left(message, 200))),
    CASE WHEN count(*) = 0 THEN NULL
         ELSE round(extract(epoch FROM now() - min(created_at)) / 3600.0, 1)
    END,
    count(*) FILTER (WHERE source LIKE 'drift_incident:financial_alerts:%')
  FROM public.financial_alerts
  WHERE NOT resolved
$$;

COMMENT ON FUNCTION public.fn_financial_alert_health(integer) IS
  'The money-alert backlog, for the engine''s Prometheus gauges. AGE is the load-bearing dimension: a critical raised a minute ago is the system working; the same alert still open a day later is nobody listening. On 2026-09-04 the oldest unresolved row was fifteen days old and nothing had ever reported the backlog existed. distinct_conditions is separated from the row count because the table does not deduplicate - 1,345 rows carried 656 conditions. meta_alerts counts the drift_incident:financial_alerts:* loop, where a monitor raises an alert because an alert exists.';

REVOKE ALL ON FUNCTION public.fn_financial_alert_health(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_financial_alert_health(integer) FROM anon;
REVOKE ALL ON FUNCTION public.fn_financial_alert_health(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_financial_alert_health(integer) TO service_role;

-- Every fifteen minutes, avoiding the :55-:00 maintenance break.
SELECT cron.unschedule('sp_resolve_settled_prize_alerts_15m')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sp_resolve_settled_prize_alerts_15m');

SELECT cron.schedule(
  'sp_resolve_settled_prize_alerts_15m',
  '9,24,39 * * * *',
  $cron$
select case
         when pg_try_advisory_lock(hashtext('sp-resolve-settled-prize-alerts'))
           then (select set_config('statement_timeout','30s',true) is not null
                    and public.fn_resolve_settled_prize_alerts() >= 0)::text
         else 'skipped: previous run still in progress'
       end;
$cron$
);

DO $$
DECLARE
  v_closed  integer;
  v_job     integer;
  r         record;
BEGIN
  SELECT count(*) INTO v_job FROM cron.job WHERE jobname = 'sp_resolve_settled_prize_alerts_15m';
  IF v_job <> 1 THEN
    RAISE EXCEPTION 'post-condition failed: expected one sp_resolve_settled_prize_alerts_15m job, found %', v_job;
  END IF;

  SELECT public.fn_resolve_settled_prize_alerts() INTO v_closed;
  SELECT * INTO r FROM public.fn_financial_alert_health(24);

  RAISE NOTICE 'auto-resolved % provably-paid prize alerts. Backlog now: % unresolved (% critical, % of them stale), % distinct conditions, oldest %h, % meta-alerts.',
    v_closed, r.unresolved_total, r.unresolved_critical, r.stale_critical,
    r.distinct_conditions, r.oldest_unresolved_age, r.meta_alerts;

  -- Guard against the resolver being too greedy. It may only ever touch the
  -- one narrow class; if it ever closes a large fraction of the table,
  -- something in its predicate has gone wrong and that is worse than a
  -- backlog.
  IF v_closed > 50 THEN
    RAISE EXCEPTION
      'post-condition failed: the resolver closed % alerts. It is scoped to one narrow provable class and should close single digits. Re-read its predicate before trusting this.',
      v_closed;
  END IF;
END $$;
