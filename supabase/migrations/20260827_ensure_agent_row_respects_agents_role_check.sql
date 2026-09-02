-- agents_role_check permits only super_agent / agent / sub_agent, but the
-- wallet law (2026-08-23) says staff hold agent and promo floats too — so
-- minting a float row for an owner, co-owner or admin violated the CHECK
-- (probed 2026-08-27 inside a rolled-back transaction: fn_cashout_approve by
-- an owner without an agents row raised 23514, and fn_club_bank_send to an
-- admin without one would have too). The membership row stays the source of
-- truth for the real role; agents.role is float bookkeeping, so staff are
-- stored at the closest permitted tier rather than widening a constraint
-- every commission and rakeback query was written against.
create or replace function public.fn_ensure_agent_row(
  p_club_id uuid, p_user_id uuid, p_role text
) returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_id    uuid;
  v_union uuid;
  v_min   numeric;
  v_role  text;
begin
  select a.id into v_id
    from agents a
   where a.club_id = p_club_id and a.user_id = p_user_id
   for update;
  if v_id is not null then
    return v_id;
  end if;

  v_role := case when p_role in ('super_agent', 'agent', 'sub_agent') then p_role
                 else 'super_agent' end;

  select coalesce(uc.union_id, c.union_id) into v_union
    from clubs c
    left join union_clubs uc on uc.club_id = c.id
   where c.id = p_club_id
   limit 1;
  v_min := case when v_union is null then 0
                else public.fn_union_setting(v_union, 'min_agent_commission', 0) end;

  insert into agents (user_id, club_id, role, status,
                      agent_wallet_balance, promo_wallet_balance,
                      commission_rate, player_rakeback_rate)
  values (p_user_id, p_club_id, v_role, 'active', 0, 0, v_min, 0)
  on conflict (user_id, club_id) do nothing;

  select a.id into v_id
    from agents a
   where a.club_id = p_club_id and a.user_id = p_user_id
   for update;
  return v_id;
end
$$;

do $assert$
declare v_src text;
begin
  select prosrc into v_src from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='fn_ensure_agent_row';
  if v_src not like '%else ''super_agent''%' then
    raise exception 'ASSERT FAILED: fn_ensure_agent_row missing the role clamp';
  end if;
end $assert$;
