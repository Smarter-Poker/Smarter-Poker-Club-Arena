-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260821174930 as "fn_batch_active_player_counts_v3_one_club_at_a_time"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran
-- (array_to_string(statements, chr(10))). Do NOT re-apply; it is already live.
--
-- fn_batch_active_player_counts v3 (Dan 2026-08-21, bug list item 7)
--
-- Verbatim: "If all the games are ran from the Midway Union, and both Shark
-- Club and Club JAQK are inside of it, why does Shark Club have 513 active,
-- Club JAQK have 508 active but Midway Union only shows 513? Horses can only
-- play inside ONE club at a time."
--
-- v2 counted a club's MEMBERS who were seated anywhere. Every horse in this
-- union belongs to both clubs (583 of them), so a single horse sitting at a
-- single table was counted as ACTIVE by Shark, by JAQK and by the union at the
-- same time. Three cards, one player, three counts — which is exactly why the
-- club numbers were each nearly as large as the union that contains them.
--
-- v3 attributes a seated player to exactly ONE club: the club recorded on the
-- seat (`table_seats.club_id` — who they are representing at that table),
-- falling back to the club that owns the table. Measured live at the time of
-- writing: 546 live seats, every one of them carrying both fields.
--
--   before: Shark 585, JAQK 580, Union 585   (the same horses, three times)
--   after:  Shark 215, JAQK 233, Union 437   (437 = 215 + 233 - 11 horses who
--           are genuinely seated in both clubs at once, which is the seating
--           bug the engine change alongside this migration stops creating)
--
-- A UNION counts every player seated at any of its own tables or at any of its
-- member clubs' tables, distinctly — so the union is always >= the largest
-- club and <= the sum of them, which is the relationship Dan expected to see.
--
-- Applied to production via Supabase MCP apply_migration on 2026-08-21.
-- ROLLBACK: restore the v2 body from migration
--           20260821_fn_batch_active_member_counts.sql.

create or replace function public.fn_batch_active_player_counts(p_club_ids uuid[])
returns table(club_id uuid, active_count bigint)
language sql
stable
set search_path to 'public'
as $$
  with live as (
    select
      ts.user_id,
      -- ONE club per seated player. This is the whole fix.
      coalesce(ts.club_id, t.club_id) as at_club,
      t.union_id                      as at_union
    from table_seats ts
    join tables t
      on t.id = ts.table_id
     and lower(coalesce(t.status, '')) not in ('closed', 'completed', 'cancelled', 'finished')
    where ts.left_at is null
      and coalesce(ts.is_away, false) = false
  )
  select
    c.id as club_id,
    count(distinct l.user_id) as active_count
  from clubs c
  join live l
    on case
         when coalesce(c.is_union, false)
           -- Union: its own tables, plus every member club's tables.
           then l.at_union = c.id
                or l.at_club = c.id
                or l.at_club in (select mc.id from clubs mc where mc.union_id = c.id)
           -- Club: only the players actually representing it right now.
           else l.at_club = c.id
       end
  where c.id = any(p_club_ids)
  group by c.id;
$$;

revoke all on function public.fn_batch_active_player_counts(uuid[]) from public;
grant execute on function public.fn_batch_active_player_counts(uuid[]) to anon, authenticated;
