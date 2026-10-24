-- Multi-account detector v2 (Dan 2026-10-22): never flag SmarterPokerOfficial
-- or any admin account; only flag real multiple accounts, not shared logins.

create table if not exists public.anti_cheat_shared_ip_ranges (
  cidr inet primary key,
  label text not null,
  added_at timestamptz not null default now()
);
alter table public.anti_cheat_shared_ip_ranges enable row level security;
revoke all on public.anti_cheat_shared_ip_ranges from anon, authenticated;

insert into public.anti_cheat_shared_ip_ranges (cidr, label) values
  ('10.0.0.0/8','private'),('172.16.0.0/12','private'),('192.168.0.0/16','private'),
  ('127.0.0.0/8','loopback'),('100.64.0.0/10','carrier-grade NAT'),
  ('140.248.0.0/16','iCloud Private Relay (Fastly)'),('146.75.0.0/16','iCloud Private Relay (Fastly)'),
  ('172.224.0.0/12','iCloud Private Relay (Akamai)'),('104.28.0.0/16','iCloud Private Relay / WARP (Cloudflare)'),
  ('20.0.0.0/8','Microsoft Azure / GitHub runners'),('4.144.0.0/12','Microsoft Azure'),
  ('52.96.0.0/11','Microsoft Azure'),('51.56.0.0/14','Microsoft Azure'),
  ('172.160.0.0/11','Microsoft Azure'),('64.236.0.0/16','Microsoft Azure'),
  ('104.208.0.0/13','Microsoft Azure'),('158.23.0.0/16','Microsoft Azure'),
  ('52.0.0.0/11','Amazon AWS'),('3.0.0.0/9','Amazon AWS'),('18.128.0.0/9','Amazon AWS'),
  ('34.64.0.0/10','Google Cloud'),('35.184.0.0/13','Google Cloud')
on conflict (cidr) do nothing;

create or replace function public.fn_anti_cheat_is_staff(p_player uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = p_player
      and (coalesce(p.is_admin,false)
           or lower(coalesce(p.role,'')) in ('admin','god','super_admin','superadmin','owner','staff'))
  );
$$;

create or replace function public.fn_anti_cheat_never_flag(p_player uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.fn_anti_cheat_is_staff(p_player)
      or exists (select 1 from public.profiles p where p.id = p_player and p.username ilike 'PostDeploy%');
$$;

revoke all on function public.fn_anti_cheat_is_staff(uuid) from public, anon, authenticated;
revoke all on function public.fn_anti_cheat_never_flag(uuid) from public, anon, authenticated;
grant execute on function public.fn_anti_cheat_is_staff(uuid) to service_role;
grant execute on function public.fn_anti_cheat_never_flag(uuid) to service_role;

-- Backstop on the table: no detector or tool can flag staff accounts at all,
-- and no multi-account / IP flag lands on a synthetic test account.
create or replace function public.fn_anti_cheat_flags_skip_exempt()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if exists (select 1 from public.anti_cheat_exemptions e
             where e.player_id = new.player_id and e.flag_type = new.flag_type) then
    return null;
  end if;
  if public.fn_anti_cheat_is_staff(new.player_id) then
    return null;
  end if;
  if new.flag_type in ('multi_account','ip_conflict') and public.fn_anti_cheat_never_flag(new.player_id) then
    return null;
  end if;
  return new;
end
$$;
revoke all on function public.fn_anti_cheat_flags_skip_exempt() from public, anon, authenticated;

create or replace function public.detect_multi_account_v2(p_since timestamptz, p_until timestamptz default now())
returns table(user_a uuid, user_b uuid, shared_ips integer, same_table boolean, severity text, ips text[])
language sql stable security definer set search_path = public
set statement_timeout = '60s'
as $$
  with ev as (
    select a.user_id, a.ip_address as ip, a.details->>'table_id' as table_id, a.created_at
    from public.action_audit_logs a
    where a.created_at >= p_since and a.created_at < p_until
      and a.user_id is not null
      and a.ip_address ~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
  ), eligible as (
    select u.user_id from (select distinct user_id from ev) u
    where not public.fn_anti_cheat_never_flag(u.user_id)
      and not exists (select 1 from public.anti_cheat_exemptions x
                      where x.player_id = u.user_id and x.flag_type = 'multi_account')
  ), ev2 as (
    select e.* from ev e join eligible g using (user_id)
    where not exists (select 1 from public.anti_cheat_shared_ip_ranges r where e.ip::inet <<= r.cidr)
  ), ipn as (
    select ip from ev2 group by ip having count(distinct user_id) between 2 and 5
  ), q as (
    select e.* from ev2 e join ipn using (ip)
  ), pairs as (
    select a.user_id as ua, b.user_id as ub,
           count(distinct a.ip)::int as n_ips,
           bool_or(a.table_id is not null and a.table_id = b.table_id
                   and abs(extract(epoch from a.created_at - b.created_at)) < 10800) as st,
           array_agg(distinct a.ip) as ip_list
    from q a join q b on a.ip = b.ip and a.user_id < b.user_id
    group by 1, 2
  )
  select ua, ub, n_ips, st, case when st then 'high' else 'medium' end, ip_list
  from pairs
  where st or n_ips >= 2;
$$;
revoke all on function public.detect_multi_account_v2(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.detect_multi_account_v2(timestamptz, timestamptz) to service_role;

-- Neutralise v1 for any worker build still calling it: it now returns no groups.
create or replace function public.detect_multi_account_ips(p_since timestamptz)
returns table(ip_address text, user_ids uuid[], hit_count bigint)
language sql stable security definer set search_path = public
as $$ select null::text, null::uuid[], null::bigint where false; $$;
