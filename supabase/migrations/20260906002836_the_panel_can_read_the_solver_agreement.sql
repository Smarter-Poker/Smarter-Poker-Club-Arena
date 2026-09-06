-- The console card for the V47 absolute score. Same admin gate and the same
-- allowlist entry as every other ca_horse_* console function: the panel is
-- where these numbers are actually read, and a score nobody can see is a
-- score nobody acts on.
create or replace function public.ca_horse_solver_agreement(p_runs integer default 14)
returns table (run_date date, reference text, spots int, agreement numeric, pure_misses int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not fn_is_horse_admin() then
    raise exception 'admin only';
  end if;
  return query
    select a.run_date, a.reference, a.spots, a.agreement, a.pure_misses
      from horse_solver_agreement a
     order by a.run_date desc
     limit least(greatest(coalesce(p_runs, 14), 1), 90);
end $$;

revoke all on function public.ca_horse_solver_agreement(integer) from public, anon;
grant execute on function public.ca_horse_solver_agreement(integer) to authenticated, service_role;

insert into public.ca_browser_definer_allowlist (proname, reason)
values ('ca_horse_solver_agreement', 'Horse solver-agreement card, read from the horse pages. Gates itself on fn_is_horse_admin() like the other ca_horse_* console functions.')
on conflict (proname) do nothing;
