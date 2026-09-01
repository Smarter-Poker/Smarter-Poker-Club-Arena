-- ===========================================================================
-- THREE HANDLES A PLAYER COULD PULL (2026-08-31)
--
-- Closing the operator console found twenty-six more browser-reachable
-- SECURITY DEFINER routines with no caller check and no scoping argument. Most
-- are the application working as intended - a public leaderboard, a club name
-- availability check - and seven are trigger functions, which PostgREST cannot
-- usefully invoke at all.
--
-- Three are not. Each has ZERO callers in this repo, in server/src, or in the
-- World Hub, and each hands a logged-in account something it should never have
-- had:
--
--   sp_backfill_member_fee_rollup(p_seconds, p_batch)
--     A LOOP WITH COMMIT INSIDE IT, running until p_seconds elapses. Any
--     account could call it with a large p_seconds and pin a backend worker
--     for exactly that long, as often as it liked. A backfill tool left wired
--     to the front door.
--
--   training_leaderboard_refresh()
--     REFRESH MATERIALIZED VIEW CONCURRENTLY, on demand, unbounded, free.
--     Same shape: real work, triggered by anyone, as often as they want.
--
--   sum_anti_farming_ips(p_ip, p_start)
--     Sums public.anti_farming_ips FOR AN IP ADDRESS THE CALLER SUPPLIES. It
--     is an oracle against the anti-fraud system: a farmer can ask whether an
--     address is being tracked and how much has been attributed to it, then
--     tune around the answer. The one here that is worse than a nuisance.
--
-- NOTE ON THE FIRST ATTEMPT AT THIS FILE: it said `REVOKE ON FUNCTION` for all
-- three and Postgres refused - `sp_backfill_member_fee_rollup is not a
-- function`. It is a PROCEDURE, which is exactly why it can COMMIT in a loop.
-- The keyword is now chosen from pg_proc.prokind rather than assumed, so the
-- thing that makes it dangerous is the same thing that makes it addressable.
-- ===========================================================================

begin;

-- PRE-FLIGHT
do $$
declare v_open int;
begin
  select count(*) into v_open
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosecdef
     and p.proname in ('sp_backfill_member_fee_rollup', 'training_leaderboard_refresh', 'sum_anti_farming_ips')
     and has_function_privilege('authenticated', p.oid, 'EXECUTE');
  if v_open <> 3 then
    raise exception 'PRE-FLIGHT: expected 3 open handles, found % - re-read before trusting this', v_open;
  end if;
end $$;

-- THE CHANGE
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig,
           case p.prokind when 'p' then 'procedure' else 'function' end as kind
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef
       and p.proname in ('sp_backfill_member_fee_rollup', 'training_leaderboard_refresh', 'sum_anti_farming_ips')
  loop
    execute format('revoke all on %s %s from public, anon, authenticated', r.kind, r.sig);
    execute format('grant execute on %s %s to service_role', r.kind, r.sig);
  end loop;
end $$;

-- POST-APPLY: BOTH HALVES
do $$
declare
  v_open text;
  v_svc  int;
  v_ip   bigint;
begin
  -- HALF ONE: no browser role reaches them.
  select string_agg(p.proname, ', ') into v_open
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('sp_backfill_member_fee_rollup', 'training_leaderboard_refresh', 'sum_anti_farming_ips')
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
       or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  if v_open is not null then
    raise exception 'POST-APPLY: still reachable: %', v_open;
  end if;

  -- HALF TWO: operations keep all three, and the fraud oracle still ANSWERS
  -- for the people entitled to ask - anti-farming enforcement runs as
  -- service_role and would be broken by a revoke that went too far.
  select count(*) into v_svc
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('sp_backfill_member_fee_rollup', 'training_leaderboard_refresh', 'sum_anti_farming_ips')
     and has_function_privilege('service_role', p.oid, 'EXECUTE');
  if v_svc <> 3 then
    raise exception 'POST-APPLY: service_role holds only % of 3', v_svc;
  end if;

  select public.sum_anti_farming_ips('203.0.113.1', now() - interval '1 day') into v_ip;
  if v_ip is null then
    raise exception 'POST-APPLY: sum_anti_farming_ips no longer answers for service_role';
  end if;

  -- ...and the rollup the browser IS allowed to nudge is untouched, because
  -- ClubRosterService calls it on every roster load.
  if not has_function_privilege('authenticated', 'public.ca_touch_member_fee_rollup()', 'EXECUTE') then
    raise exception 'POST-APPLY: ca_touch_member_fee_rollup was closed - the club roster page calls it';
  end if;

  raise notice 'POST-APPLY: 3 handles closed, ops intact, roster nudge still open';
end $$;

commit;

-- ===========================================================================
-- ROLLBACK - hands them back to every logged-in account:
--   GRANT EXECUTE ON PROCEDURE public.sp_backfill_member_fee_rollup(integer, integer) TO authenticated;
--   GRANT EXECUTE ON FUNCTION  public.training_leaderboard_refresh() TO authenticated;
--   GRANT EXECUTE ON FUNCTION  public.sum_anti_farming_ips(text, timestamptz) TO authenticated;
-- ===========================================================================
