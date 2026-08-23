-- One tournament, one manager — the gate on running a second engine.
--
-- Cash tables are already leased: discoverCashTables() calls claim_table_lease
-- per table and enforcement is live (production reports enforced:true,
-- conflictCount:0). Two engine instances can safely share the cash fleet today.
--
-- TOURNAMENTS ARE NOT. discoverTournaments() selects every RUNNING tournament
-- and constructs a TournamentManager for any not already in ITS OWN in-memory
-- map. With a second instance, both would resume the same tournament: two
-- managers driving blind levels, synchronized breaks, hand-for-hand and
-- eliminations for one event. That is the same class of failure the table lease
-- exists to prevent -- "two decks, two dealers and two settlements against the
-- same seats" -- and it is why the engine is still a single point of failure.
--
-- Deliberately a mirror of engine_table_leases rather than a new idea: same
-- columns, same claim/heartbeat/release shape, same 30s staleness. One pattern
-- to understand, and the table version has been proven in production.
--
-- APPLIED TO PRODUCTION 2026-08-23 via Supabase MCP apply_migration before this
-- branch was pushed, per CHECK 17. Verified on apply against a real tournament
-- id: instance-A claims (granted), instance-B refused, A renews, and B takes
-- over once A's heartbeat is aged past the stale window. Test rows removed.
CREATE TABLE IF NOT EXISTS public.engine_tournament_leases (
  tournament_id  uuid PRIMARY KEY REFERENCES public.tournaments(id) ON DELETE CASCADE,
  instance_id    text        NOT NULL,
  engine_version text,
  acquired_at    timestamptz NOT NULL DEFAULT now(),
  heartbeat_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_engine_tournament_leases_heartbeat
  ON public.engine_tournament_leases (heartbeat_at);

ALTER TABLE public.engine_tournament_leases ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.claim_tournament_lease(
  p_tournament_id uuid,
  p_instance_id text,
  p_version text DEFAULT NULL::text,
  p_stale_seconds integer DEFAULT 30)
 RETURNS TABLE(granted boolean, holder text, holder_age_seconds numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_holder    text;
  v_heartbeat timestamptz;
begin
  if p_tournament_id is null or coalesce(p_instance_id, '') = '' then
    raise exception 'claim_tournament_lease requires a tournament_id and a non-empty instance_id';
  end if;

  insert into public.engine_tournament_leases as l
    (tournament_id, instance_id, engine_version, acquired_at, heartbeat_at)
  values
    (p_tournament_id, p_instance_id, p_version, now(), now())
  on conflict (tournament_id) do update
     set instance_id    = excluded.instance_id,
         engine_version = excluded.engine_version,
         acquired_at    = case
                            when l.instance_id = excluded.instance_id then l.acquired_at
                            else now()
                          end,
         heartbeat_at   = now()
   where l.instance_id = excluded.instance_id
      or l.heartbeat_at < now() - make_interval(secs => p_stale_seconds)
  returning l.instance_id, l.heartbeat_at into v_holder, v_heartbeat;

  if v_holder is not null then
    return query select true, v_holder, 0::numeric;
    return;
  end if;

  select l.instance_id, l.heartbeat_at
    into v_holder, v_heartbeat
    from public.engine_tournament_leases l
   where l.tournament_id = p_tournament_id;

  return query
    select false, v_holder,
           round(extract(epoch from (now() - v_heartbeat))::numeric, 1);
end;
$function$;

CREATE OR REPLACE FUNCTION public.heartbeat_tournament_leases(
  p_instance_id text,
  p_tournament_ids uuid[])
 RETURNS TABLE(tournament_id uuid)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  update public.engine_tournament_leases l
     set heartbeat_at = now()
   where l.instance_id = p_instance_id
     and l.tournament_id = any(p_tournament_ids)
  returning l.tournament_id;
$function$;

CREATE OR REPLACE FUNCTION public.release_tournament_leases(
  p_instance_id text,
  p_tournament_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_deleted integer;
begin
  delete from public.engine_tournament_leases l
   where l.instance_id = p_instance_id
     and (p_tournament_ids is null or l.tournament_id = any(p_tournament_ids));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$function$;

REVOKE ALL ON FUNCTION public.claim_tournament_lease(uuid, text, text, integer) FROM public;
REVOKE ALL ON FUNCTION public.heartbeat_tournament_leases(text, uuid[]) FROM public;
REVOKE ALL ON FUNCTION public.release_tournament_leases(text, uuid[]) FROM public;
GRANT EXECUTE ON FUNCTION public.claim_tournament_lease(uuid, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.heartbeat_tournament_leases(text, uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_tournament_leases(text, uuid[]) TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='engine_tournament_leases') THEN
    RAISE EXCEPTION 'engine_tournament_leases was not created';
  END IF;
  IF (SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public'
         AND p.proname IN ('claim_tournament_lease','heartbeat_tournament_leases',
                           'release_tournament_leases')) <> 3 THEN
    RAISE EXCEPTION 'tournament lease functions missing';
  END IF;
END $$;

-- ROLLBACK
--   DROP FUNCTION IF EXISTS public.claim_tournament_lease(uuid, text, text, integer);
--   DROP FUNCTION IF EXISTS public.heartbeat_tournament_leases(text, uuid[]);
--   DROP FUNCTION IF EXISTS public.release_tournament_leases(text, uuid[]);
--   DROP TABLE IF EXISTS public.engine_tournament_leases;
