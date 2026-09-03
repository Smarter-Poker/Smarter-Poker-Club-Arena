-- fn_batch_active_player_counts v2 (Dan 2026-08-21): a club's ACTIVE = its
-- MEMBERS currently seated anywhere. Union-member clubs own no tables (games
-- are union-hosted), so the old tables-owned join read 0 forever.
-- Applied to production via Supabase MCP apply_migration on 2026-08-21.
-- ROLLBACK: restore previous tables-owned body from migration history.

create or replace function public.fn_batch_active_player_counts(p_club_ids uuid[])
returns table(club_id uuid, active_count bigint)
language sql
stable
set search_path to 'public'
as $$
  select cm.club_id, count(distinct ts.user_id) as active_count
  from club_members cm
  join table_seats ts
    on ts.user_id = cm.user_id
   and ts.left_at is null
   and coalesce(ts.is_away, false) = false
  join tables t
    on t.id = ts.table_id
   and lower(coalesce(t.status, '')) not in ('closed','completed','cancelled','finished')
  where cm.club_id = any(p_club_ids)
    and cm.status = 'active'
  group by cm.club_id;
$$;
