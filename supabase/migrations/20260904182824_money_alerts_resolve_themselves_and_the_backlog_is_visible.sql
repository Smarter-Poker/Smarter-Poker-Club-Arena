-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260904182824; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260904182824   (the stamp IS the apply time, UTC: 2026-09-04 18:28:24)
--   name        money_alerts_resolve_themselves_and_the_backlog_is_visible
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 6077 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260904182824 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_resolve_settled_prize_alerts, public.fn_financial_alert_health
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- CLAUDE.md 10.9 (both repos) says a settlement is finished when the
-- financial_alerts row is "resolved with a resolution note saying what was
-- accepted and why". That column has never existed. Every agent instructed to
-- write a resolution note has had nowhere to write it, which is part of why
-- 1,345 alerts sit unresolved: resolving one properly was impossible as
-- documented.
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
      AND tp.amount = (a.context->>'prize')::numeric
  )
  UPDATE public.financial_alerts a
     SET resolved    = true,
         resolved_at = now(),
         resolution  = format(
           'auto-resolved 2026-09-04: the reconciler paid this. tournament_payouts records %s chips paid at %s under idempotency key %s. The alert was raised by the engine when its direct credit hit the statement timeout, BEFORE the reconciler ran; the assertion that the player was never paid was false when it was written.',
           p.paid_amount, p.paid_at, p.idempotency_key)
    FROM provable p
   WHERE a.id = p.id;

  GET DIAGNOSTICS v_closed = ROW_COUNT;
  RETURN v_closed;
END;
$function$;

COMMENT ON FUNCTION public.fn_resolve_settled_prize_alerts() IS
  'Closes Tournament.winner_prize_credit_failed alerts whose money provably landed - a tournament_payouts row for the same tournament and user, paid_at set, amount equal to the prize the alert named. Nothing else is auto-resolved. Measured 2026-09-04, the reconciler had already paid all five open instances, three of them within 9 seconds.';

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
  'The money-alert backlog, for the engine Prometheus gauges. AGE is the load-bearing dimension: a critical raised a minute ago is the system working; the same alert still open a day later is nobody listening. On 2026-09-04 the oldest unresolved row was fifteen days old and nothing had ever reported the backlog existed.';

REVOKE ALL ON FUNCTION public.fn_financial_alert_health(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_financial_alert_health(integer) FROM anon;
REVOKE ALL ON FUNCTION public.fn_financial_alert_health(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_financial_alert_health(integer) TO service_role;

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

  RAISE NOTICE 'auto-resolved % provably-paid prize alerts. Backlog now: % unresolved (% critical, % stale), % conditions, oldest %h, % meta.',
    v_closed, r.unresolved_total, r.unresolved_critical, r.stale_critical,
    r.distinct_conditions, r.oldest_unresolved_age, r.meta_alerts;

  IF v_closed > 50 THEN
    RAISE EXCEPTION
      'post-condition failed: the resolver closed % alerts. It is scoped to one narrow provable class and should close single digits.',
      v_closed;
  END IF;
END $$;
