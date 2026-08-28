-- ═══════════════════════════════════════════════════════════════════════════
-- HAND-REVIEWS PANEL: leak-tag trend feed (2026-08-28)
-- ═══════════════════════════════════════════════════════════════════════════
-- The /horses/hand-reviews page shows per-tag rates per 1,000 captured hands
-- across the last week. supabase-js cannot GROUP BY over unnest, so the
-- aggregation lives here. Daemon/admin-API only. Applied via MCP 2026-08-28.

create or replace function fn_horse_tag_trends(p_days int default 7)
returns table(day date, tag text, n bigint, hands bigint)
language sql
security definer
set search_path = public
as $$
  with days as (
    select played_at::date as day, count(*) as hands
    from horse_hand_reviews
    where played_at >= (now() at time zone 'utc')::date - p_days
    group by 1
  ),
  tags as (
    select played_at::date as day, t.tag, count(*) as n
    from horse_hand_reviews, lateral unnest(leak_tags) as t(tag)
    where played_at >= (now() at time zone 'utc')::date - p_days
    group by 1, 2
  )
  select t.day, t.tag, t.n, d.hands
  from tags t
  join days d using (day)
  order by t.day desc, t.n desc
$$;

revoke all on function fn_horse_tag_trends(int) from public, anon, authenticated;
grant execute on function fn_horse_tag_trends(int) to service_role;
