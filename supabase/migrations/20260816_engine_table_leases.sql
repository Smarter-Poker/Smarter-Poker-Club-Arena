-- ════════════════════════════════════════════════════════════════════════
-- engine_table_leases — one owner per table, enforced by the database
-- ════════════════════════════════════════════════════════════════════════
--
-- WHY THIS EXISTS (2026-08-16 incident, 00:38:45 -> 01:09:11 UTC)
--
-- Two engine containers were serving engine.smarter.poker at the same time: the
-- build from PR #72 and a rolled-back 13a90cf4 image that the host's recovery
-- paths kept resurrecting from `club-arena-engine:current`. Every table stopped
-- dealing for 30 minutes while the stale container held the port with zero
-- tables and a discovery loop that never completed a cycle.
--
-- Nothing in the system could tell the two apart, and nothing prevented both
-- from starting an engine for the SAME table. That second part is the dangerous
-- one: two engines dealing one table means two decks, two dealers and two
-- settlements against the same seats.
--
-- This table makes single ownership a property of the database rather than a
-- property of nobody. An engine must hold a lease to deal a table, the lease
-- expires if its owner stops heartbeating, and a lease can only be taken from a
-- dead owner — never from a live one.
--
-- FAIL-OPEN BY DESIGN: these functions are advisory. The engine ships with
-- enforcement OFF (ENGINE_LEASE_ENFORCE unset) and only logs conflicts, so a
-- bug here cannot freeze the platform. Enforcement is switched on once the logs
-- prove the claim path is behaving.

create table if not exists public.engine_table_leases (
  table_id      uuid        primary key,
  instance_id   text        not null,
  -- Human-readable so an operator reading the table can tell which build holds
  -- what without cross-referencing anything.
  engine_version text,
  acquired_at   timestamptz not null default now(),
  heartbeat_at  timestamptz not null default now()
);

comment on table public.engine_table_leases is
  'One row per table currently owned by an engine instance. A lease is live while heartbeat_at is recent; a stale lease may be taken over. Written only by the engine service role. Motivated by the 2026-08-16 dual-container incident.';
comment on column public.engine_table_leases.instance_id is
  'Per-process boot id of the owning engine (GameServer.instanceId). Changes on every restart, so a restarted engine never inherits its own dead lease by accident.';

-- Reaping stale leases and listing an instance's holdings are both hot paths on
-- the 5s discovery tick.
create index if not exists engine_table_leases_heartbeat_idx
  on public.engine_table_leases (heartbeat_at);
create index if not exists engine_table_leases_instance_idx
  on public.engine_table_leases (instance_id);

-- The engine connects with the service role, which bypasses RLS. RLS is still
-- enabled with no policies so that anon/authenticated (the browser clients)
-- cannot read or write it — a lease table is operational data, and knowing
-- which instance owns which table is of no use to a player.
alter table public.engine_table_leases enable row level security;

-- ── claim ──────────────────────────────────────────────────────────────────────────
-- Grants the lease when: nobody holds it, WE already hold it (renewal), or the
-- current holder has gone quiet for longer than p_stale_seconds.
--
-- The whole decision happens inside one INSERT ... ON CONFLICT so two engines
-- racing for the same table are serialised by the primary key rather than by
-- luck. The RETURNING tells us who ended up owning it, which is the only
-- trustworthy answer — a separate SELECT afterwards could observe a third
-- writer.
create or replace function public.claim_table_lease(
  p_table_id      uuid,
  p_instance_id   text,
  p_version       text default null,
  p_stale_seconds integer default 30
) returns table (
  granted            boolean,
  holder             text,
  holder_age_seconds numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_holder     text;
  v_heartbeat  timestamptz;
begin
  if p_table_id is null or coalesce(p_instance_id, '') = '' then
    raise exception 'claim_table_lease requires a table_id and a non-empty instance_id';
  end if;

  insert into public.engine_table_leases as l
    (table_id, instance_id, engine_version, acquired_at, heartbeat_at)
  values
    (p_table_id, p_instance_id, p_version, now(), now())
  on conflict (table_id) do update
     set instance_id    = excluded.instance_id,
         engine_version = excluded.engine_version,
         -- Only reset acquired_at on a genuine handover, so the column keeps
         -- meaning "owned continuously since".
         acquired_at    = case
                            when l.instance_id = excluded.instance_id then l.acquired_at
                            else now()
                          end,
         heartbeat_at   = now()
   where l.instance_id = excluded.instance_id
      or l.heartbeat_at < now() - make_interval(secs => p_stale_seconds)
  returning l.instance_id, l.heartbeat_at into v_holder, v_heartbeat;

  if v_holder is not null then
    -- The upsert took effect, so we are the owner.
    return query select true, v_holder, 0::numeric;
    return;
  end if;

  -- The WHERE clause rejected the update: a DIFFERENT instance holds a live
  -- lease. Report who, and how live, so the caller can log something useful
  -- instead of "claim failed".
  select l.instance_id, l.heartbeat_at
    into v_holder, v_heartbeat
    from public.engine_table_leases l
   where l.table_id = p_table_id;

  return query
    select false,
           v_holder,
           round(extract(epoch from (now() - v_heartbeat))::numeric, 1);
end;
$$;

comment on function public.claim_table_lease(uuid, text, text, integer) is
  'Acquire or renew the deal-lease on one table. Returns granted=false plus the live holder when another instance owns it.';

-- ── heartbeat ─────────────────────────────────────────────────────────────────────
-- Bulk-renews every lease this instance believes it holds and returns the ids
-- it ACTUALLY still holds. The difference between what the caller sent and what
-- comes back is precisely the set of tables it has lost and must stop dealing —
-- which is the signal a split-brain engine needs and never had.
create or replace function public.heartbeat_table_leases(
  p_instance_id text,
  p_table_ids   uuid[]
) returns table (table_id uuid)
language sql
security definer
set search_path = public
as $$
  update public.engine_table_leases l
     set heartbeat_at = now()
   where l.instance_id = p_instance_id
     and l.table_id = any(p_table_ids)
  returning l.table_id;
$$;

comment on function public.heartbeat_table_leases(text, uuid[]) is
  'Renew this instance''s leases. Returns only the table_ids still owned — anything missing from the result has been lost and must not be dealt.';

-- ── release ───────────────────────────────────────────────────────────────────────
-- Called on SIGTERM and whenever an engine is torn down. Releasing eagerly is
-- what keeps a rolling deploy fast: without it the incoming container waits out
-- the full stale window on every table.
create or replace function public.release_table_leases(
  p_instance_id text,
  p_table_ids   uuid[] default null
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  delete from public.engine_table_leases l
   where l.instance_id = p_instance_id
     and (p_table_ids is null or l.table_id = any(p_table_ids));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

comment on function public.release_table_leases(text, uuid[]) is
  'Drop this instance''s leases (all of them when p_table_ids is null). Called on shutdown so a redeploy does not have to wait out the stale window.';

revoke all on function public.claim_table_lease(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.heartbeat_table_leases(text, uuid[]) from public, anon, authenticated;
revoke all on function public.release_table_leases(text, uuid[]) from public, anon, authenticated;
grant execute on function public.claim_table_lease(uuid, text, text, integer) to service_role;
grant execute on function public.heartbeat_table_leases(text, uuid[]) to service_role;
grant execute on function public.release_table_leases(text, uuid[]) to service_role;
