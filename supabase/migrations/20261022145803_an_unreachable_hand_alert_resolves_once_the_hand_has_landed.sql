-- 20261022145803_an_unreachable_hand_alert_resolves_once_the_hand_has_landed.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- ServerTableEngine.authoritative_hand_unreachable is raised when an engine
-- generation gives up on committing a hand (13 identical attempts timed out)
-- and stops with that hand behind its causal barrier. The successor generation
-- replays and commits the same hand. Nothing ever resolved these alerts: on
-- 2026-10-22 all 24 from the 02:34-02:49 UTC lock storm (root cause and fix in
-- PR #7662) stayed open although every hand had landed, and their two mirrored
-- drift incidents went past deadline and onto the Daily Digest.
--
-- fn_ca_resolve_landed_unreachable_hand_alerts() closes an alert only when the
-- exact (table_id, hand_number) is re-measured as landed: a hand_atomic_commits
-- row exists, its post-commit envelope is complete (or none was owed), and the
-- hand_history row is present. The mirrored incident is stamped with cause,
-- 'verified:' evidence and closure_basis 'verified_remeasured' first, then the
-- alert resolve propagates through zz_ca_alert_resolution_reaches_the_incident.
-- A hand that never landed keeps its alert open. No chips move.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.fn_ca_resolve_landed_unreachable_hand_alerts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r record;
  n integer := 0;
BEGIN
  FOR r IN
    SELECT a.id, c.table_id, c.hand_number, c.committed_at, c.post_commit_completed_at
      FROM public.financial_alerts a
      JOIN public.hand_atomic_commits c
        ON c.table_id    = (a.context->>'table_id')::uuid
       AND c.hand_number = (a.context->>'hand_number')::bigint
     WHERE a.source = 'ServerTableEngine.authoritative_hand_unreachable'
       AND NOT COALESCE(a.resolved, false)
       AND a.context->>'table_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       AND a.context->>'hand_number' ~ '^[0-9]{1,18}$'
       AND (c.post_commit_payload IS NULL OR c.post_commit_completed_at IS NOT NULL)
       AND EXISTS (SELECT 1 FROM public.hand_history h
                    WHERE h.table_id = c.table_id AND h.hand_number = c.hand_number)
     ORDER BY a.created_at
     LIMIT 200
     FOR UPDATE OF a SKIP LOCKED
  LOOP
    UPDATE public.ca_drift_incidents i
       SET root_cause = COALESCE(NULLIF(i.root_cause, ''), format(
             'Hand #%s on table %s could not be committed inside the engine''s 13 attempt budget because the database did not answer in time; that engine generation stopped with the hand behind its causal barrier and its successor committed the same hand.',
             r.hand_number, r.table_id)),
           correction_ref = COALESCE(NULLIF(i.correction_ref, ''), format(
             'verified: hand_atomic_commits row committed %s, post-commit complete, hand_history row present',
             r.committed_at)),
           closure_basis = COALESCE(i.closure_basis, 'verified_remeasured')
     WHERE i.status <> 'resolved'
       AND i.metadata->>'alert_id' = r.id::text;

    UPDATE public.financial_alerts
       SET resolved = true,
           resolved_at = now(),
           resolution = format(
             'verified: the successor engine committed hand #%s on table %s at %s; post-commit obligations complete%s; hand_history row present. No chips moved for closure.',
             r.hand_number, r.table_id, r.committed_at,
             COALESCE(' at ' || r.post_commit_completed_at::text, ' (none owed)'))
     WHERE id = r.id;
    n := n + 1;
  END LOOP;
  RETURN n;
END
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_resolve_landed_unreachable_hand_alerts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_resolve_landed_unreachable_hand_alerts() TO service_role;

-- periodic-work: no new job. The existing ca-resolve-settled-alerts run (4,24,44 past
-- the hour), which already closes the hand_history_failed alert for the same hand,
-- now closes the unreachable alert in the same pass.
DO $do$
DECLARE v_job bigint;
BEGIN
  SELECT jobid INTO v_job FROM cron.job
   WHERE command LIKE '%ca-resolve-settled-alerts%'
     AND command LIKE '%fn_resolve_settled_financial_alerts(true, 5000)%'
   ORDER BY jobid LIMIT 1;
  IF v_job IS NULL THEN
    RAISE EXCEPTION 'ca-resolve-settled-alerts job not found; refusing to schedule new periodic work';
  END IF;
  PERFORM cron.alter_job(v_job, command := $cmd$SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-resolve-settled-alerts'))
                THEN (SELECT public.fn_resolve_settled_financial_alerts(true, 5000))::text
                     || ' unreachable_landed=' || public.fn_ca_resolve_landed_unreachable_hand_alerts()::text
                ELSE 'busy' END$cmd$);
END
$do$;

SELECT public.fn_ca_resolve_landed_unreachable_hand_alerts();

COMMIT;
