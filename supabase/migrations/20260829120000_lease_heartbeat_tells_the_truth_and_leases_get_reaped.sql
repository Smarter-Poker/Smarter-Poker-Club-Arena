-- ════════════════════════════════════════════════════════════════════════
-- The lease heartbeat could only say "kept", so it said "stolen" for
-- everything else — and nothing ever reaped a dead lease row
-- ════════════════════════════════════════════════════════════════════════
--
-- TWO DEFECTS, BOTH MEASURED IN PRODUCTION ON 2026-08-29.
--
-- ── 1. THE HEARTBEAT CANNOT TELL "TAKEN" FROM "ABSENT", SO IT GUESSES ────
--
-- heartbeat_table_leases is:
--
--     update engine_table_leases set heartbeat_at = now()
--      where instance_id = p_instance_id and table_id = any(p_table_ids)
--     returning table_id;
--
-- It returns the rows it updated. The caller (tableLease.heartbeatTables)
-- subtracts that from what it asked about and treats the remainder as
--
--     "Lost the deal-lease on table X to another engine instance"
--
-- That conclusion does not follow. An id goes missing from the result in
-- THREE different situations and only one of them is a takeover:
--
--   a. another instance holds the row      <- the real thing, must stop dealing
--   b. there is NO row for that table      <- nobody took anything
--   c. the row is ours but the UPDATE did not see it
--
-- (b) is not hypothetical. claim_table_lease is deliberately fail-open —
-- tableLease.claimTable returns true and starts dealing when the claim errors
-- or times out, and writes no row. The engine logged 596 supabase_timeouts in
-- one hour on 2026-08-29, so claims DO fail here. Every table that started
-- without a row is then reported, once per discovery sweep, as stolen by a
-- phantom.
--
-- Measured: eight tables the engine reported as lost "to another engine
-- instance" at 12:41 UTC were, in this database at that moment, held by that
-- very instance with a heartbeat 2.8 seconds old. The message asserted a
-- cause it had not established.
--
-- WHY IT IS NOT MERELY NOISE. ENGINE_TOURNAMENT_LEASE_ENFORCE is ON in
-- production. On the tournament side the same subtraction is not logged and
-- ignored — it STOPS THE TOURNAMENT MANAGER. A tournament whose claim timed
-- out is torn down on its next heartbeat for a takeover that never happened,
-- and the table side does the same the day ENGINE_LEASE_ENFORCE is switched
-- on. A fail-safe that cannot distinguish "I could not find my lease" from
-- "someone else has my lease" is not a fail-safe.
--
-- THE FIX: return one row per REQUESTED id with what is actually true of it.
-- 'kept' renewed, 'taken' held by a different live instance, 'missing' no row
-- at all. Only 'taken' is a takeover. 'missing' is a re-claim, not a teardown.
-- 'stale' is a row nobody has renewed for longer than the staleness window —
-- ours to take back, since claim_table_lease would grant it to us anyway.
--
-- ── 2. THE LEASE TABLES ARE A GRAVEYARD ──────────────────────────────────
--
-- release_*_leases only runs on a graceful shutdown, so every hard-killed
-- container leaves its rows behind forever. GameServer prunes rows older than
-- SEVEN DAYS, but only at boot. Deploys land many times a day and each one
-- abandons a full set of rows, so the table grows faster than a weekly
-- cutoff sheds it.
--
-- Live counts when this was written:
--
--     engine_table_leases       263 live  /  1,987 dead   (88% garbage)
--     engine_tournament_leases   39 live  /  3,015 dead   (99% garbage)
--
-- Read on every discovery sweep. Seven days is also absurdly generous next to
-- a 30-SECOND staleness window: a lease unrenewed for an hour is dead beyond
-- any argument, which is the cutoff reap_dead_engine_leases defaults to. It
-- cannot race a running engine, because an engine that has not heartbeat in an
-- hour has already lost every one of its leases to the staleness rule.
--
-- ADDITIVE ONLY. The v1 functions are untouched and still granted: the engine
-- running right now calls them, and it must keep working until it redeploys.
-- ════════════════════════════════════════════════════════════════════════

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

  -- Renew ours first, in one statement, exactly as v1 did. `renewed` is the
  -- authoritative set of ids we still hold: taking it from the UPDATE's own
  -- RETURNING rather than from a later SELECT is what makes this safe against
  -- a concurrent claim by another instance.
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
  -- A floor of ten minutes, twenty times the 30-second staleness window. The
  -- parameter exists so the sweep interval can be tuned; it does not exist so
  -- that someone can pass 5 and delete the leases of a briefly-stalled engine
  -- out from under it.
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
  -- The whole point of the change: an id with no row must read 'missing',
  -- never be silently absent from the result the way v1 left it.
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

  -- The reaper must refuse a cutoff that could delete a live engine's leases.
  begin
    perform public.reap_dead_engine_leases(5);
    raise exception 'reap_dead_engine_leases accepted a 5 second cutoff; the floor is not enforced';
  exception
    when others then
      if sqlerrm not like '%refuses a cutoff under 600s%' then raise; end if;
  end;
end;
$$;
