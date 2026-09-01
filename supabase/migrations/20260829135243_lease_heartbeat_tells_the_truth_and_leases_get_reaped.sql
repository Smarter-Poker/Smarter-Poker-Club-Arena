-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260829135243; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- The lease heartbeat could only say "kept", so it said "stolen" for
-- everything else — and nothing ever reaped a dead lease row.
-- See supabase/migrations/20260829120000_lease_heartbeat_tells_the_truth_and_leases_get_reaped.sql
-- in the club-arena repo (PR #1726) for the full incident write-up.
-- ADDITIVE ONLY. The v1 functions are untouched and still granted.

-- ── heartbeat, honest ────────────────────────────────────────────────────
create or replace function public.heartbeat_table_leases_v2(
  p_instance_id   text,
  p_table_ids     uuid[],
  p_stale_seconds integer default 30
) returns table (table_id uuid, state text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(p_instance_id, '') = '' then
    raise exception 'heartbeat_table_leases_v2 requires a non-empty instance_id';
  end if;

  return query
  with renewed as (
    update public.engine_table_leases l
       set heartbeat_at = now()
     where l.instance_id = p_instance_id
       and l.table_id = any(p_table_ids)
    returning l.table_id
  ),
  asked as (
    select unnest(coalesce(p_table_ids, '{}'::uuid[])) as id
  )
  select a.id,
         case
           when r.table_id is not null then 'kept'
           when l.table_id is null     then 'missing'
           when l.heartbeat_at < now() - make_interval(secs => p_stale_seconds)
                                       then 'stale'
           else 'taken'
         end
    from asked a
    left join renewed r on r.table_id = a.id
    left join public.engine_table_leases l on l.table_id = a.id;
end;
$$;

comment on function public.heartbeat_table_leases_v2(text, uuid[], integer) is
  'Renew this instance''s table leases and report the truth about every id asked for: kept (renewed), taken (a different instance holds a LIVE lease - stop dealing), stale (holder has gone quiet, reclaimable), missing (no lease row at all - reclaim, nobody took it). Replaces the v1 shape, which could only say "kept" and so reported absent rows as takeovers.';

create or replace function public.heartbeat_tournament_leases_v2(
  p_instance_id    text,
  p_tournament_ids uuid[],
  p_stale_seconds  integer default 30
) returns table (tournament_id uuid, state text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(p_instance_id, '') = '' then
    raise exception 'heartbeat_tournament_leases_v2 requires a non-empty instance_id';
  end if;

  return query
  with renewed as (
    update public.engine_tournament_leases l
       set heartbeat_at = now()
     where l.instance_id = p_instance_id
       and l.tournament_id = any(p_tournament_ids)
    returning l.tournament_id
  ),
  asked as (
    select unnest(coalesce(p_tournament_ids, '{}'::uuid[])) as id
  )
  select a.id,
         case
           when r.tournament_id is not null then 'kept'
           when l.tournament_id is null     then 'missing'
           when l.heartbeat_at < now() - make_interval(secs => p_stale_seconds)
                                            then 'stale'
           else 'taken'
         end
    from asked a
    left join renewed r on r.tournament_id = a.id
    left join public.engine_tournament_leases l on l.tournament_id = a.id;
end;
$$;

comment on function public.heartbeat_tournament_leases_v2(text, uuid[], integer) is
  'Renew this instance''s tournament leases and report the truth about every id asked for: kept / taken / stale / missing. Only "taken" is a real takeover; the v1 shape could not say so, and with ENGINE_TOURNAMENT_LEASE_ENFORCE on it stopped managers for takeovers that never happened.';

-- ── the reaper ───────────────────────────────────────────────────────────
create or replace function public.reap_dead_engine_leases(
  p_stale_seconds integer default 3600
) returns table (table_leases_deleted integer, tournament_leases_deleted integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cutoff timestamptz;
  v_tables integer;
  v_tourneys integer;
begin
  if coalesce(p_stale_seconds, 0) < 600 then
    raise exception 'reap_dead_engine_leases refuses a cutoff under 600s (asked for %)', p_stale_seconds;
  end if;

  v_cutoff := now() - make_interval(secs => p_stale_seconds);

  delete from public.engine_table_leases where heartbeat_at < v_cutoff;
  get diagnostics v_tables = row_count;

  delete from public.engine_tournament_leases where heartbeat_at < v_cutoff;
  get diagnostics v_tourneys = row_count;

  return query select v_tables, v_tourneys;
end;
$$;

comment on function public.reap_dead_engine_leases(integer) is
  'Delete lease rows nobody has renewed for p_stale_seconds (default 1h, floor 10m). release_*_leases only runs on a graceful shutdown, so every hard-killed container leaks a full set of rows; the boot-time 7-day prune could not keep up with the deploy rate. Cannot race a live engine: a lease unrenewed for an hour has already lost every claim to the 30-second staleness rule.';

revoke all on function public.heartbeat_table_leases_v2(text, uuid[], integer) from public, anon, authenticated;
revoke all on function public.heartbeat_tournament_leases_v2(text, uuid[], integer) from public, anon, authenticated;
revoke all on function public.reap_dead_engine_leases(integer) from public, anon, authenticated;
grant execute on function public.heartbeat_table_leases_v2(text, uuid[], integer) to service_role;
grant execute on function public.heartbeat_tournament_leases_v2(text, uuid[], integer) to service_role;
grant execute on function public.reap_dead_engine_leases(integer) to service_role;

-- ── assertions: the migration fails rather than half-applying ────────────
do $$
declare
  v_state text;
  v_missing uuid := '00000000-0000-0000-0000-0000000000ff';
begin
  select state into v_state
    from public.heartbeat_table_leases_v2('__migration_assert__', array[v_missing]);

  if v_state is distinct from 'missing' then
    raise exception 'heartbeat_table_leases_v2 reported % for an absent lease; expected missing', coalesce(v_state, '<no row>');
  end if;

  select state into v_state
    from public.heartbeat_tournament_leases_v2('__migration_assert__', array[v_missing]);

  if v_state is distinct from 'missing' then
    raise exception 'heartbeat_tournament_leases_v2 reported % for an absent lease; expected missing', coalesce(v_state, '<no row>');
  end if;

  begin
    perform public.reap_dead_engine_leases(5);
    raise exception 'reap_dead_engine_leases accepted a 5 second cutoff; the floor is not enforced';
  exception
    when others then
      if sqlerrm not like '%refuses a cutoff under 600s%' then raise; end if;
  end;
end;
$$;
