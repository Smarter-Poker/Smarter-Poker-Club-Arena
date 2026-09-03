-- Leader/standby, so a crash cannot take the platform down.
--
-- WHY NOT ACTIVE/ACTIVE. Two instances CAN safely split the fleet -- the table
-- and tournament leases guarantee one owner each. What they cannot do is serve
-- each other's traffic: every client connects to one hostname, Caddy sends it
-- to one container, and a request for a table owned by the other answers
-- `404 Table engine not found` (POST /action) or close 4404 (the websocket).
-- Verified live on 2026-08-23: container 2 held 14 of 44 tables that no player
-- could reach, invisible only because horses are server-side and kept dealing.
--
-- Making that work needs owner-aware routing, which means proxying player
-- websocket frames through a second hop in the hottest path in the product.
-- That buys throughput headroom, which was never the problem.
--
-- The problem is that ONE container dying stops everything until it comes back.
-- Leader/standby fixes exactly that: the standby holds no tables and serves no
-- traffic until the leader's lease goes stale, then takes the whole fleet. No
-- routing, no proxy, no client change.
--
-- Same mechanism as claim_table_lease, proven in production: a single row,
-- stale-takeover only, holder keeps acquired_at across renewals.
--
-- APPLIED TO PRODUCTION 2026-08-23 via Supabase MCP apply_migration before this
-- branch was pushed, per CHECK 17. Verified on apply: inst-A granted, inst-B
-- refused, inst-A renews, and inst-B takes over once A's heartbeat is aged past
-- the window. Test rows removed.
CREATE TABLE IF NOT EXISTS public.engine_leader (
  id             boolean     PRIMARY KEY DEFAULT true CHECK (id),
  instance_id    text        NOT NULL,
  engine_version text,
  acquired_at    timestamptz NOT NULL DEFAULT now(),
  heartbeat_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.engine_leader ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.claim_engine_leadership(
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
  if coalesce(p_instance_id, '') = '' then
    raise exception 'claim_engine_leadership requires a non-empty instance_id';
  end if;

  insert into public.engine_leader as l
    (id, instance_id, engine_version, acquired_at, heartbeat_at)
  values
    (true, p_instance_id, p_version, now(), now())
  on conflict (id) do update
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

  select l.instance_id, l.heartbeat_at into v_holder, v_heartbeat
    from public.engine_leader l where l.id = true;

  return query
    select false, v_holder,
           round(extract(epoch from (now() - v_heartbeat))::numeric, 1);
end;
$function$;

CREATE OR REPLACE FUNCTION public.release_engine_leadership(p_instance_id text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_deleted integer;
begin
  delete from public.engine_leader l where l.instance_id = p_instance_id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$function$;

REVOKE ALL ON FUNCTION public.claim_engine_leadership(text, text, integer) FROM public;
REVOKE ALL ON FUNCTION public.release_engine_leadership(text) FROM public;
GRANT EXECUTE ON FUNCTION public.claim_engine_leadership(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_engine_leadership(text) TO service_role;

-- ROLLBACK
--   DROP FUNCTION IF EXISTS public.claim_engine_leadership(text, text, integer);
--   DROP FUNCTION IF EXISTS public.release_engine_leadership(text);
--   DROP TABLE IF EXISTS public.engine_leader;
