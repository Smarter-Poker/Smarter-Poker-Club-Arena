-- ═══════════════════════════════════════════════════════════════════════════
-- HAND-REVIEWS PANEL, TWO MISSING FEEDS (2026-08-28)
-- ═══════════════════════════════════════════════════════════════════════════
-- The /horses/hand-reviews page (2026-08-26) reads everything through
-- fn_is_horse_admin-gated ca_* RPCs. It had no view of the nightly LEAGUE
-- CARD (the A/B measurements every strategy decision hangs on) and no
-- LEAK-TAG RATE trend (raw counts mislead when fleet volume moves - the
-- 2026-08-27 false-spike incident). Same gate, same shape as its siblings.
-- Applied via MCP 2026-08-28.

create or replace function public.ca_horse_league_card(p_runs integer default 3)
returns table(run_date date, matchup text, bb100 numeric, stderr numeric, hands bigint, illegal_actions bigint)
language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  if not fn_is_horse_admin() then
    raise exception 'admin only';
  end if;
  return query
    select r.run_date, r.matchup, r.bb100, r.stderr, r.hands::bigint, r.illegal_actions::bigint
    from horse_league_results r
    where r.run_date in (
      select distinct l.run_date from horse_league_results l
      order by l.run_date desc
      limit least(greatest(coalesce(p_runs, 3), 1), 10)
    )
    order by r.run_date desc, r.matchup;
end $function$;

create or replace function public.ca_horse_tag_trends(p_days integer default 7)
returns table(day date, tag text, n bigint, hands bigint)
language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  if not fn_is_horse_admin() then
    raise exception 'admin only';
  end if;
  return query
    with d as (
      select rv.played_at::date as dday, count(*) as dhands
      from horse_hand_reviews rv
      where rv.played_at >= (now() at time zone 'utc')::date - least(greatest(coalesce(p_days, 7), 1), 30)
      group by 1
    ),
    t as (
      select rv.played_at::date as dday, u.tag as dtag, count(*) as dn
      from horse_hand_reviews rv, lateral unnest(rv.leak_tags) as u(tag)
      where rv.played_at >= (now() at time zone 'utc')::date - least(greatest(coalesce(p_days, 7), 1), 30)
      group by 1, 2
    )
    select t.dday, t.dtag, t.dn, d.dhands
    from t join d using (dday)
    order by t.dday desc, t.dn desc;
end $function$;

revoke all on function public.ca_horse_league_card(integer) from public, anon;
grant execute on function public.ca_horse_league_card(integer) to authenticated, service_role;
revoke all on function public.ca_horse_tag_trends(integer) from public, anon;
grant execute on function public.ca_horse_tag_trends(integer) to authenticated, service_role;
