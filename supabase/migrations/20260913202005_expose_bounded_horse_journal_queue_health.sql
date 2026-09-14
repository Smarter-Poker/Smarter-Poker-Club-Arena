-- Reserved 2026-09-13 20:20:05 UTC. Worker cycle counts could not show a
-- globally full queue, expired lease or quarantine. Expose only bounded
-- unfinished-work aggregates from the existing partial index. No data writes,
-- new index, payload/actor identity, retention or policy activation.
BEGIN;
SET LOCAL lock_timeout = '2s';
CREATE FUNCTION public.fn_horse_adaptive_journal_work_health()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp
AS $function$
  WITH bounded AS MATERIALIZED (
    SELECT state,payload,created_at,available_at,lease_until,attempts
    FROM public.horse_adaptive_journal_work WHERE state<>'completed' LIMIT 257
  ), measured AS (
    SELECT count(*) n,
      count(*) FILTER(WHERE state='queued') queued,
      count(*) FILTER(WHERE state='leased') leased,
      count(*) FILTER(WHERE state='quarantined') quarantined,
      count(*) FILTER(WHERE (state='queued' AND available_at<=statement_timestamp())
        OR (state='leased' AND lease_until<=statement_timestamp())) ready,
      count(*) FILTER(WHERE state='leased' AND lease_until<=statement_timestamp()) expired,
      coalesce(sum(octet_length(payload)),0) bytes,
      greatest(0,coalesce(floor(extract(epoch FROM statement_timestamp()-min(created_at))*1000),0))::bigint oldest,
      coalesce(max(attempts),0) attempts FROM bounded
  ) SELECT CASE WHEN n>256 OR bytes>67108864 THEN
    jsonb_build_object('version',1,'status','unavailable','reason','queue_budget_exceeded')
  ELSE jsonb_build_object('version',1,'status','snapshot',
    'sampledAtMs',floor(extract(epoch FROM statement_timestamp())*1000)::bigint,
    'unfinished',n,'queued',queued,'leased',leased,'quarantined',quarantined,
    'ready',ready,'expiredLeases',expired,'bufferedBytes',bytes,
    'oldestWorkAgeMs',oldest,'maxAttempts',attempts) END FROM measured;
$function$;
REVOKE ALL ON FUNCTION public.fn_horse_adaptive_journal_work_health() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_horse_adaptive_journal_work_health() TO service_role;
COMMENT ON FUNCTION public.fn_horse_adaptive_journal_work_health() IS
  'Service-only STABLE aggregate of at most257 unfinished work rows. Budget violations are unavailable, never an empty queue. No identities, payloads, completed-history scan or completeness claim.';
COMMIT;
