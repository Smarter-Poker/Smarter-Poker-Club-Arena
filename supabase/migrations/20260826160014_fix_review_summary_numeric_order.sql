-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826160014; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- FIX (2026-08-26, line-by-line review): ca_horse_review_summary ordered its
-- horses by h->>'sum_net_bb' - a TEXT sort. Cast to numeric.
-- Repo file: supabase/migrations/20260826160001_fix_review_summary_numeric_order.sql

create or replace function public.ca_horse_review_summary(p_days int default 7)
returns jsonb
language plpgsql security definer set search_path = public stable as $$
declare out jsonb;
begin
  if not fn_is_horse_admin() then
    raise exception 'admin only';
  end if;
  select jsonb_build_object(
    'window_days', p_days,
    'horses', coalesce((
      select jsonb_agg(h order by (h->>'sum_net_bb')::numeric)
      from (
        select jsonb_build_object(
          'horse_user_id', horse_user_id,
          'alias', (select coalesce(p.alias, p.display_name, p.username) from profiles p where p.id = horse_user_id),
          'big_wins', sum(big_wins),
          'big_losses', sum(big_losses),
          'sum_net_bb', round(sum(sum_net_bb), 1),
          'leak_counts', (
            select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from (
              select k, sum((c.leak_counts->>k)::int) v
              from horse_review_rollup c, lateral jsonb_object_keys(c.leak_counts) k
              where c.horse_user_id = rr.horse_user_id and c.day > current_date - p_days
              group by k
            ) tags
          )
        ) h
        from horse_review_rollup rr
        where day > current_date - p_days
        group by horse_user_id
      ) horses
    ), '[]'::jsonb),
    'fleet_leaks', coalesce((
      select jsonb_object_agg(k, v) from (
        select k, sum((r.leak_counts->>k)::int) v
        from horse_review_rollup r, lateral jsonb_object_keys(r.leak_counts) k
        where day > current_date - p_days
        group by k
      ) f
    ), '{}'::jsonb)
  ) into out;
  return out;
end $$;
