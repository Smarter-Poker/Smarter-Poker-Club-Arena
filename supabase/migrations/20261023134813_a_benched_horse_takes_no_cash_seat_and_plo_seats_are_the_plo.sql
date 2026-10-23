-- 20261023134813_a_benched_horse_takes_no_cash_seat_and_plo_seats_are_the_plo.sql
-- Version reserved by scripts/new-migration.mjs.
--
-- Dan 2026-10-23: "KEEP IT UNDER 35-50 TOTAL HORSES AT ANY TIME FOR ALL GAME
-- TYPES" and "ONLY ALLOW THE HORSES THAT HAVE SHOWN TO BE PROFITABLE PLAYING
-- PLO PLAY THOSE GAMES."
--
-- Migration 20261023072007 benched every horse off the 45-horse roster
-- (horse_status 'disabled') and wrote ca_horse_plo_roster. The engine's own
-- seating paths honour both. Measured 13:34 UTC the same day: a benched horse
-- took a NEW Lightning pilot cash seat anyway, through a path that does not
-- read horse_status. The rule belongs at the one door every seat passes, so
-- it cannot depend on which caller seats the horse.
--
-- THE DOOR. A new live cash seat (INSERT, or a row revived / moved / given to
-- another account) held by a horse is refused when:
--   * the horse is benched (horse_status 'disabled'), or
--   * the table is a PLO variant and the horse is not on ca_horse_plo_roster.
-- Raised as insufficient_privilege, the code the restriction door already
-- uses, so callers treat it as a refusal and never as a crash.
--
-- WHAT IT DOES NOT TOUCH:
--   * Tournament seats: a horse registered before the bench finishes its
--     event, and a tournament table move is never refused mid-event.
--   * A horse that already holds a live seat in the SAME game (a cash
--     cluster moving it from a breaking table to another table of the game):
--     the move is the game's, not a new sit. It leaves at its next session
--     end, and the rotator walks it out at hand end (PR 7787).
--   * Humans, and every non-horse account.
-- The trigger is named to fire AFTER zzzz_stamp_active_seat_game_scope, so
-- the same-game check reads the stamped scope of the new row.
-- Any other failure inside the check lets the seat through (the restriction
-- door's fail-open rule): a database blip must never empty the floor.

BEGIN;
set local lock_timeout = '5s';

create or replace function public.fn_ca_horse_roster_seat_guard()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $fn$
declare
  v_is_horse boolean;
  v_status   text;
  v_tourney  uuid;
  v_variant  text;
begin
  if new.left_at is not null then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and old.left_at is null
     and old.user_id is not distinct from new.user_id
     and old.table_id is not distinct from new.table_id then
    return new;
  end if;

  select p.is_horse, p.horse_status into v_is_horse, v_status
    from public.profiles p where p.id = new.user_id;
  if v_is_horse is not true then
    return new;
  end if;

  select t.tournament_id, lower(coalesce(t.game_variant, '')) into v_tourney, v_variant
    from public.tables t where t.id = new.table_id;
  if v_tourney is not null then
    return new;
  end if;

  -- A move inside the same game is the game's, not a new sit.
  if new.active_game_scope is not null and exists (
       select 1 from public.table_seats s
        where s.user_id = new.user_id and s.left_at is null
          and s.active_game_scope = new.active_game_scope
          and s.table_id is distinct from new.table_id) then
    return new;
  end if;

  if v_status = 'disabled' then
    raise exception using errcode = '42501',
      message = 'horse_benched: this horse is off the active horse roster';
  end if;
  if v_variant like 'plo%'
     and not exists (select 1 from public.ca_horse_plo_roster r where r.horse_id = new.user_id) then
    raise exception using errcode = '42501',
      message = 'horse_not_on_plo_roster: only horses with a proven PLO profit play PLO';
  end if;
  return new;
exception
  when insufficient_privilege then raise;
  when others then return new;
end
$fn$;

revoke all on function public.fn_ca_horse_roster_seat_guard() from public, anon, authenticated;

drop trigger if exists zzzzzz_horse_roster_seat_guard on public.table_seats;
create trigger zzzzzz_horse_roster_seat_guard
  before insert or update of user_id, table_id, left_at on public.table_seats
  for each row
  when (new.left_at is null)
  execute function public.fn_ca_horse_roster_seat_guard();

INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
VALUES ('table_seats', 'zzzzzz_horse_roster_seat_guard', 'Refuses a NEW live cash seat for a benched horse, or a PLO cash seat for a horse off ca_horse_plo_roster (Dan 2026-10-23). Moves no chips and writes nothing: it only raises insufficient_privilege before the row exists. Tournament seats and same-game moves pass; any other failure fails open.')
ON CONFLICT DO NOTHING;

COMMIT;
