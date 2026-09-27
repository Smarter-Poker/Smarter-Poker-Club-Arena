-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821191431 "stamp_seat_club_trigger_drop_when_clause"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b7bbaaf8f10ac105756fd10b2cb976f2 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Dan 2026-08-21, item 7 — the LAST layer of the same opt-out.
--
-- I removed the `IF NEW.club_id IS NULL` guard from fn_stamp_seat_club and a
-- horse promptly formed a fresh split anyway (`quantum`, cash seat since 02:31
-- on JAQK, tournament seat 19:13 on Shark) — while the function, called
-- directly, correctly answered "Club JAQK".
--
-- Because the guard was in TWO places and I had only found one. The trigger
-- itself carries it:
--
--     CREATE TRIGGER trg_table_seats_stamp_club
--       BEFORE INSERT OR UPDATE ON table_seats
--       FOR EACH ROW WHEN ((new.club_id IS NULL))    <-- here
--
-- So a caller that supplies club_id — which the tournament seating path does —
-- never reached the function at all, however the function was written.
--
-- The WHEN clause is gone. The function is idempotent and cheap (one indexed
-- lookup on the player's live seats), it returns the supplied club unchanged
-- for a player who is not already seated, and it returns the table's own club
-- on non-union tables, so firing it on every row is safe on every path.
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
