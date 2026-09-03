-- FREEROLL FILL (Dan 2026-08-27): "all horses, if they are playing, should
-- play the freeroll - all real players would."  Applied to production; see
-- the function bodies for the reasoning and the measurements that prompted it.
create or replace function public.fn_freeroll_fill_targets(p_union uuid default null)
returns table (
  tournament_id uuid, name text, status text,
  current_players int, max_players int, minutes_to_start numeric
)
language sql security definer set search_path = public stable as $$
  select t.id, t.name, t.status,
         coalesce(t.current_players, 0), coalesce(t.max_players, 0),
         round(extract(epoch from (t.start_time - now())) / 60.0, 1)
  from tournaments t
  left join clubs c on c.id = t.club_id
  where coalesce(t.buy_in_amount, 0) = 0
    and upper(t.status) in ('SCHEDULED', 'REGISTERING', 'ANNOUNCED', 'RUNNING')
    and t.start_time > now() - interval '20 minutes'
    and t.start_time < now() + interval '90 minutes'
    and coalesce(t.max_players, 0) > coalesce(t.current_players, 0)
    and (p_union is null or c.union_id = p_union or c.id = p_union)
  order by t.start_time asc;
$$;
revoke all on function public.fn_freeroll_fill_targets(uuid) from public;
grant execute on function public.fn_freeroll_fill_targets(uuid) to authenticated, service_role;

create or replace function public.fn_audit_empty_freerolls(p_day date)
returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare v jsonb := '[]'::jsonb; r record;
begin
  for r in
    select t.name, coalesce(t.current_players,0) cur, coalesce(t.max_players,0) maxp
    from tournaments t
    where coalesce(t.buy_in_amount,0) = 0
      and t.started_at >= p_day and t.started_at < p_day + 1
      and coalesce(t.max_players,0) > 0
      and coalesce(t.current_players,0) < greatest(6, coalesce(t.max_players,0) * 0.15)
    order by coalesce(t.current_players,0) asc limit 8
  loop
    v := v || jsonb_build_object(
      'severity','warn','category','logic','code','freeroll_started_empty',
      'title', r.name || ' started with ' || r.cur || ' of ' || r.maxp || ' players',
      'evidence', jsonb_build_object('entries', r.cur, 'capacity', r.maxp),
      'recommendation','Every playing horse should register for a freeroll. Check HorseOverlayGuard freeroll lines for that window.'
    );
  end loop;
  return v;
end $$;
revoke all on function public.fn_audit_empty_freerolls(date) from public;
grant execute on function public.fn_audit_empty_freerolls(date) to service_role;

create or replace function public.fn_audit_layer_silence_and_coverage(p_day date)
returns jsonb
language sql security definer set search_path = public stable as $$
  select fn_audit_layer_silence(p_day)
       || fn_audit_league_coverage(p_day)
       || fn_audit_league_pooled_findings(p_day)
       || fn_audit_analysis_watchdog(p_day)
       || fn_audit_overlays(p_day)
       || fn_audit_empty_freerolls(p_day);
$$;
revoke all on function public.fn_audit_layer_silence_and_coverage(date) from public;
grant execute on function public.fn_audit_layer_silence_and_coverage(date) to service_role;
