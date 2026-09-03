-- Dan 2026-08-21, item 7 FOLLOW-UP: horses were STILL ending up in two clubs at
-- once, and every offending pair had a TOURNAMENT seat as its second seat.
--
-- 20260821_active_counts_one_club_at_a_time.sql taught fn_seat_club_for_user to
-- inherit the club a player is already seated with. But fn_stamp_seat_club only
-- CALLED it when the incoming row had no club of its own:
--
--     IF NEW.club_id IS NULL AND ... THEN
--       NEW.club_id := fn_seat_club_for_user(...)
--
-- The tournament seating path supplies club_id itself, so it sailed straight
-- past the rule. Verified live after that migration shipped: seven horses
-- picked up a second club, every one of them on a tournament seat — e.g.
-- `handreader`, cash seat 18:43, tournament seat 18:53, Shark AND JAQK.
--
-- A rule a caller can opt out of by passing an argument is not a rule. The
-- trigger now consults fn_seat_club_for_user on EVERY seat and hands the
-- supplied club through as the PREFERRED one. An explicit choice is still
-- honoured for a player who holds no other live seat in the union; it is
-- overridden only by the club they are already representing at another live
-- table, which is exactly what "one club at a time" means.
--
-- Standalone (non-union) tables are unaffected: fn_seat_club_for_user returns
-- the table's own club for those, which is what any caller would have passed.
--
-- Applied to production via Supabase MCP apply_migration on 2026-08-21.
-- ROLLBACK: restore the `IF NEW.club_id IS NULL` guard around the assignment.

create or replace function public.fn_stamp_seat_club()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
BEGIN
  IF NEW.user_id IS NOT NULL AND NEW.table_id IS NOT NULL THEN
    NEW.club_id := COALESCE(
      public.fn_seat_club_for_user(NEW.user_id, NEW.table_id, NEW.club_id),
      NEW.club_id
    );
  END IF;
  RETURN NEW;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- THE LAST LAYER OF THE SAME OPT-OUT (same day, minutes later)
--
-- Removing the `IF NEW.club_id IS NULL` guard from the function above was not
-- enough: a horse formed a fresh split immediately afterwards (`quantum`, cash
-- seat since 02:31 on JAQK, tournament seat 19:13 on Shark) while the function,
-- called directly with the same arguments, correctly answered "Club JAQK".
--
-- The guard existed in TWO places and only one had been found. The TRIGGER
-- carried its own copy:
--
--     CREATE TRIGGER trg_table_seats_stamp_club
--       BEFORE INSERT OR UPDATE ON table_seats
--       FOR EACH ROW WHEN ((new.club_id IS NULL))    <-- here
--
-- so a caller supplying club_id — which the tournament seating path does — never
-- reached the function at all, however the function was written.
--
-- Firing on every row is safe: the function is one indexed lookup on the
-- player's live seats, it returns the supplied club unchanged for a player who
-- is not already seated, and it returns the table's own club on non-union
-- tables.
--
-- Verified: 14 fresh seats in the first two minutes after this landed, zero
-- splits — against 69 seats / 1 split in the equivalent window before it.
--
-- ROLLBACK:
--   drop trigger trg_table_seats_stamp_club on public.table_seats;
--   create trigger trg_table_seats_stamp_club before insert or update
--     on public.table_seats for each row when (new.club_id is null)
--     execute function fn_stamp_seat_club();

drop trigger if exists trg_table_seats_stamp_club on public.table_seats;

create trigger trg_table_seats_stamp_club
  before insert or update on public.table_seats
  for each row
  execute function public.fn_stamp_seat_club();
