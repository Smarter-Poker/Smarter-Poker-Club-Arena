CREATE OR REPLACE FUNCTION public.fn_ca_hand_commit_refusals(p_hours integer DEFAULT 24)
 RETURNS TABLE(reason text, refusals bigint, tables_affected bigint, detail text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH win AS (
    SELECT CASE
             WHEN a.context->>'error' LIKE '%seat missing or left%' THEN 'seat missing or left'
             WHEN a.context->>'error' LIKE '%lease_proof_expired%'  THEN 'lease proof expired'
             WHEN a.context->>'error' LIKE '%hand_lease_stale%'     THEN 'hand lease stale'
             WHEN a.context->>'error' LIKE '%duplic%'               THEN 'duplicate commit'
             WHEN a.context->>'error' LIKE '%deadlock%'             THEN 'deadlock'
             /* A SEAT STACK, NOT ANY STACK (2026-09-11). This read '%stack%'
                and so counted "pldbgapi2 statement call stack is broken" as a
                seat stack mismatch, which held incident 07ebac1d open on an
                event that had nothing to do with money. Both engine wordings
                are matched: the current "did not durably sync every final seat
                stack" and the superseded "produced fractional stack". */
             WHEN a.context->>'error' LIKE '%seat stack%'
               OR a.context->>'error' LIKE '%fractional stack%'     THEN 'stack mismatch'
             ELSE 'other'
           END AS reason,
           a.context->>'table_id' AS table_id
      FROM public.financial_alerts a
     WHERE a.source = 'ServerTableEngine.authoritative_hand_semantic_refusal'
       /* A DETECTOR DOES NOT REPORT WHAT IT ALREADY ANSWERED FOR (2026-09-10).
          The window starts at the LATER of the rolling p_hours and the moment
          the most recent incident for this source was resolved with a
          correction_ref - a written assertion that the cause was fixed then.
          Anything after that instant still counts and still raises; only
          history stops being re-reported as news. A resolution with no
          correction_ref (verified:, no-change-needed:) does not move it. */
       AND a.created_at > GREATEST(
             now() - make_interval(hours => GREATEST(COALESCE(p_hours, 24), 1)),
             COALESCE((SELECT max(i.resolved_at) FROM public.ca_drift_incidents i
                        WHERE i.source = 'fn_ca_conservation_sweep:fn_ca_hand_commit_refusals'
                          AND i.status = 'resolved'
                          AND COALESCE(btrim(i.correction_ref), '') <> ''),
                      '-infinity'::timestamptz))
  )
  SELECT w.reason, count(*), count(DISTINCT w.table_id),
         count(*) || ' hand commit(s) refused for "' || w.reason || '" across '
           || count(DISTINCT w.table_id) || ' table(s). A refusal rolls the hand back whole '
           || 'before any money step, so no chips move; what is lost is the hand. This is '
           || 'ServerTableEngine on the poker host, not a function in this database.' AS detail
    FROM win w
   GROUP BY w.reason
  HAVING count(*) >= 25
   ORDER BY 2 DESC
$function$
;

