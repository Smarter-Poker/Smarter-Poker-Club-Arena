-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424020742 "20260421190000_hg_seat_reservation_member_fk_cascade_on_delete"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 f35ffb3f3d78f9b54c51ae9f31565293 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Bug hunt: commander_home_seat_reservations.member_id → commander_home_members.id
-- was ON DELETE NO ACTION. If a host removes a member via manage_home_group_member,
-- the DELETE would fail with FK violation if that member had any upcoming
-- seat reservations. Zero rows today but blocks production.
--
-- Fix: CASCADE. Member removal logically implies their future seat reservations
-- are cancelled. This matches commander_home_rsvps.user_id CASCADE semantics.

ALTER TABLE public.commander_home_seat_reservations
  DROP CONSTRAINT IF EXISTS commander_home_seat_reservations_member_id_fkey;

ALTER TABLE public.commander_home_seat_reservations
  ADD CONSTRAINT commander_home_seat_reservations_member_id_fkey
  FOREIGN KEY (member_id)
  REFERENCES public.commander_home_members(id)
  ON DELETE CASCADE;
