-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260725145106 "commander_incidents_players_and_game_type_normalization"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 80cea09a36da359b06ada6eb3287beba of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Commander audit 2026-07-25:
-- (a) incidents report form collects players_involved but the table had no
--     column for it (API silently discarded it);
-- (b) game_type casing was inconsistent (waitlist stored UPPERCASE, games
--     stored lowercase) breaking waitlist<->game linking and live counts.
-- Tier 2/3: additive column + in-place data normalization (reversible by
-- re-uppercasing waitlist rows, though the app now writes lowercase).

alter table public.commander_incidents
  add column if not exists players_involved jsonb;

-- Normalize existing game_type values to lowercase across the three tables
-- that cross-match on it. App code (after this deploy) writes lowercase and
-- compares case-insensitively.
update public.commander_games    set game_type = lower(game_type) where game_type is not null and game_type <> lower(game_type);
update public.commander_waitlist set game_type = lower(game_type) where game_type is not null and game_type <> lower(game_type);
update public.commander_tables   set game_type = lower(game_type) where game_type is not null and game_type <> lower(game_type);

do $$
begin
  if exists (select 1 from public.commander_waitlist where game_type is not null and game_type <> lower(game_type)) then
    raise exception 'waitlist game_type normalization incomplete';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='commander_incidents' and column_name='players_involved') then
    raise exception 'players_involved column missing';
  end if;
end $$;
