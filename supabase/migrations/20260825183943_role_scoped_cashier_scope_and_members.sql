-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825183943; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

create or replace function public.fn_club_cashier_scope(
  p_club_id uuid,
  p_user_id uuid default null
) returns text
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select case public.fn_club_bank_role(p_club_id, coalesce(p_user_id, auth.uid()))
    when 'owner'       then 'all'
    when 'co_owner'    then 'all'
    when 'admin'       then 'all'
    when 'super_agent' then 'downline'
    when 'agent'       then 'downline'
    when 'sub_agent'   then 'downline'
    else 'none'
  end;
$$;

comment on function public.fn_club_cashier_scope(uuid, uuid) is
  'Cashier visibility scope for a member of a club: all, downline or none.';

create or replace function public.fn_club_cashier_can_transact(
  p_club_id uuid,
  p_actor uuid,
  p_target uuid
) returns boolean
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare v_scope text;
begin
  if p_club_id is null or p_actor is null or p_target is null then
    return false;
  end if;
  v_scope := public.fn_club_cashier_scope(p_club_id, p_actor);
  if v_scope = 'all' then
    return true;
  end if;
  if v_scope = 'downline' then
    return public.fn_club_is_in_downline(p_club_id, p_actor, p_target);
  end if;
  return false;
end
$$;

comment on function public.fn_club_cashier_can_transact(uuid, uuid, uuid) is
  'True when the actor may send to, or claim from, the target in this club.';

create or replace function public.fn_club_cashier_members(p_club_id uuid)
returns table (
  user_id uuid,
  role text,
  role_rank int,
  depth int,
  chip_balance numeric,
  name text,
  username text,
  player_number text,
  avatar_url text
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_actor uuid := auth.uid();
  v_scope text;
begin
  if v_actor is null or p_club_id is null then
    return;
  end if;

  v_scope := public.fn_club_cashier_scope(p_club_id, v_actor);
  if v_scope = 'none' then
    return;
  end if;

  return query
  with recursive
  edges as (
    select cm.user_id as child, cm.agent_id as parent
      from club_members cm
     where cm.club_id = p_club_id
       and coalesce(cm.status, 'active') in ('active', 'approved')
       and cm.agent_id is not null
       and cm.agent_id <> cm.user_id
  ),
  tree as (
    select e.child, array[e.child] as path, 1 as depth
      from edges e
     where e.parent = v_actor
    union all
    select e.child, t.path || e.child, t.depth + 1
      from tree t
      join edges e on e.parent = t.child
     where not (e.child = any (t.path))
       and t.depth < 20
  ),
  flat as (
    select t.child as uid, min(t.depth)::int as d
      from tree t
     group by t.child
  ),
  scoped as (
    select cm.user_id as uid,
           coalesce(cm.role, 'player') as r,
           coalesce(cm.chip_balance, 0)::numeric as bal,
           coalesce(f.d, 0) as d
      from club_members cm
      left join flat f on f.uid = cm.user_id
     where cm.club_id = p_club_id
       and coalesce(cm.status, 'active') in ('active', 'approved')
       and (v_scope = 'all' or f.uid is not null)
  )
  select s.uid,
         s.r,
         (case s.r
            when 'owner' then 100 when 'co_owner' then 90 when 'admin' then 80
            when 'super_agent' then 60 when 'agent' then 40 when 'sub_agent' then 20
            else 0 end)::int,
         s.d,
         s.bal,
         coalesce(
           nullif(btrim(pr.display_name), ''),
           nullif(btrim(pr.alias), ''),
           nullif(btrim(pr.username), ''),
           'Member'
         )::text,
         coalesce(pr.username, '')::text,
         coalesce(pr.player_number, '')::text,
         coalesce(nullif(btrim(pr.avatar_url), ''), nullif(btrim(pr.arena_avatar_url), ''), '')::text
    from scoped s
    left join profiles pr on pr.id = s.uid
   order by s.d asc,
            (case s.r
               when 'owner' then 100 when 'co_owner' then 90 when 'admin' then 80
               when 'super_agent' then 60 when 'agent' then 40 when 'sub_agent' then 20
               else 0 end) desc,
            lower(coalesce(pr.display_name, pr.username, ''));
end
$$;

comment on function public.fn_club_cashier_members(uuid) is
  'Members the caller may transact with in this club: everyone for staff, the recursive downline for an agent, nobody for a player.';

create unique index if not exists chip_transactions_agent_wallet_op_id_uidx
  on public.chip_transactions (club_id, ((metadata ->> 'op_id')))
  where transaction_type in (
          'agent_wallet_send',
          'agent_wallet_claim_back',
          'cashout_request_escrow',
          'cashout_approved',
          'cashout_denied',
          'cashout_cancelled'
        )
    and metadata ? 'op_id';

create index if not exists chip_transactions_agent_wallet_reversible_idx
  on public.chip_transactions (from_user_id, reversible_until)
  where transaction_type = 'agent_wallet_send';

revoke all on function public.fn_club_cashier_scope(uuid, uuid) from public, anon;
revoke all on function public.fn_club_cashier_can_transact(uuid, uuid, uuid) from public, anon;
revoke all on function public.fn_club_cashier_members(uuid) from public, anon;
grant execute on function public.fn_club_cashier_scope(uuid, uuid) to authenticated, service_role;
grant execute on function public.fn_club_cashier_can_transact(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function public.fn_club_cashier_members(uuid) to authenticated, service_role;
