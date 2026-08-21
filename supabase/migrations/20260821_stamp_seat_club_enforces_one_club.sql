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
