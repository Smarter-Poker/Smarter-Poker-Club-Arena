-- Record the partial index (built CONCURRENTLY beforehand) and make v2 use it:
-- only IP-bearing rows are scanned instead of the whole 600k-row audit table.
create index if not exists idx_audit_logs_ip_time on public.action_audit_logs (created_at) include (user_id, ip_address) where ip_address is not null;

create or replace function public.detect_multi_account_v2(p_since timestamptz, p_until timestamptz default now())
returns table(user_a uuid, user_b uuid, shared_ips integer, same_table boolean, severity text, ips text[])
language sql stable security definer set search_path = public
set statement_timeout = '60s'
as $$
  with raw as (
    select a.user_id, a.ip_address as ip, a.details->>'table_id' as table_id,
           floor(extract(epoch from a.created_at) / 10800)::bigint as bucket
    from public.action_audit_logs a
    where a.created_at >= p_since and a.created_at < p_until
      and a.ip_address is not null
      and a.user_id is not null
      and a.ip_address ~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
    group by 1, 2, 3, 4
  ), ips_ok as (
    select d.ip from (select distinct ip from raw) d
    where not exists (select 1 from public.anti_cheat_shared_ip_ranges r where d.ip::inet <<= r.cidr)
  ), eligible as (
    select u.user_id from (select distinct user_id from raw) u
    where not public.fn_anti_cheat_never_flag(u.user_id)
      and not exists (select 1 from public.anti_cheat_exemptions x
                      where x.player_id = u.user_id and x.flag_type = 'multi_account')
  ), ev as (
    select r.* from raw r join ips_ok using (ip) join eligible using (user_id)
  ), ipn as (
    select ip from ev group by ip having count(distinct user_id) between 2 and 5
  ), ui as (
    select distinct e.user_id, e.ip from ev e join ipn using (ip)
  ), ip_pairs as (
    select a.user_id as ua, b.user_id as ub, count(*)::int as n_ips, array_agg(a.ip) as ip_list
    from ui a join ui b on a.ip = b.ip and a.user_id < b.user_id
    group by 1, 2
  ), tab as (
    select distinct e.user_id, e.ip, e.table_id, e.bucket
    from ev e join ipn using (ip) where e.table_id is not null
  ), table_pairs as (
    select distinct a.user_id as ua, b.user_id as ub
    from tab a join tab b
      on a.ip = b.ip and a.table_id = b.table_id and a.user_id < b.user_id
     and b.bucket between a.bucket - 1 and a.bucket + 1
  )
  select p.ua, p.ub, p.n_ips, (t.ua is not null),
         case when t.ua is not null then 'high' else 'medium' end, p.ip_list
  from ip_pairs p left join table_pairs t on t.ua = p.ua and t.ub = p.ub
  where t.ua is not null or p.n_ips >= 2;
$$;
revoke all on function public.detect_multi_account_v2(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.detect_multi_account_v2(timestamptz, timestamptz) to service_role;
