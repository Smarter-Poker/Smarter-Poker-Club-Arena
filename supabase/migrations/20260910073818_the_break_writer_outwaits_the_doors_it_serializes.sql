-- THE BREAK WRITER OUTWAITS THE DOORS IT SERIALIZES AGAINST (2026-09-10).
--
-- WHAT BROKE. At 06:53:11 UTC the engine announced the :55 maintenance break
-- and the durable save of the last-hand row failed:
--
--   [MaintenanceBreak] announcement failed Error: canceling statement due to
--   lock timeout
--   [MaintenanceBreak] failed to clear the break row Error: canceling
--   statement due to lock timeout
--
-- One timeout cancelled the whole hour's break: no last-hand row, no :55
-- countdown, no readyForRestart certificate. The deploy waiting on that
-- certificate (Actions run 34445622542) polled the gate 57 times, saw
-- `active=False phase=idle` every time, and recorded `shipped=false`.
-- Production stayed 22 commits behind - including the fix for a dead hand
-- projection listener - with nobody told.
--
-- WHY IT TIMED OUT. fn_save_engine_maintenance_break is the serialization
-- point for admission: it takes pg_advisory_xact_lock(530090, 1) EXCLUSIVELY
-- so that no entry can commit on the wrong side of the announcement. Every
-- entry door - atomic_table_buyin, atomic_table_rebuy, atomic_table_addon,
-- process_tournament_rebuy, fn_spin_draw_and_settle_atomic,
-- fn_seat_horse_in_seat_first_game, fn_cash_seat_move_execute,
-- fn_create_seat_first_game_atomic, fn_register_horse_for_tournament and the
-- rest of the 530090 family - takes the same key SHARED for the whole life of
-- its transaction, and those transactions are allowed 30 seconds by their own
-- statement_timeout.
--
-- So the writer was given five seconds to outwait transactions that are
-- permitted thirty. Measured on production this morning: a 15-second sample
-- found the boundary held in 59% of samples, and pg_stat_statements since the
-- 02:34 reset shows atomic_table_buyin at 1.7 s mean / 27 s max,
-- process_tournament_rebuy at 11.9 s max, fn_seat_horse_in_seat_first_game at
-- 9.3 s max. A five-second budget against that is a coin flip, and it landed
-- tails at 06:53.
--
-- THE RULE THIS RESTORES. A serialization point must be able to outwait the
-- work it serializes. The four writers of the maintenance boundary now get
-- lock_timeout 32s / statement_timeout 35s - just past the 30 s ceiling their
-- own entry doors run under - so the wait ends when the last admitted entry
-- commits rather than at an arbitrary five seconds.
--
-- WHAT THIS COSTS. A queued exclusive advisory waiter blocks shared requests
-- behind it, so from the moment the announcement queues, new entries wait
-- instead of being admitted. That is precisely the intended meaning of the
-- announcement: the freeze starts at :53, and an entry arriving at :53:01 is
-- refused as PLATFORM_FROZEN either way. The wait is bounded by the entry
-- doors' own 30 s ceiling, and in the ordinary case (holds of ~2 s) nobody
-- notices. Hand settlement does NOT take this key, so tables keep dealing
-- throughout.
--
-- BELT AND BRACES. The engine half shipped separately in #4142:
-- MaintenanceBreak.announceLastHand now retries a lock or statement timeout
-- every 5 s for up to 90 s from announcedAt, without moving the announced :55
-- boundary. This migration makes the first attempt succeed; that retry covers
-- the pathological tail.
--
-- Bodies, grants and search_path are untouched: ALTER FUNCTION ... SET only
-- replaces the per-function GUC settings listed here.

BEGIN;

-- The announcement and countdown writer.
ALTER FUNCTION public.fn_save_engine_maintenance_break(
  text, timestamptz, timestamptz, timestamptz, text, text, uuid
) SET lock_timeout TO '32s';
ALTER FUNCTION public.fn_save_engine_maintenance_break(
  text, timestamptz, timestamptz, timestamptz, text, text, uuid
) SET statement_timeout TO '35s';

-- The compare-and-delete that ends a break, and the cleanup path that runs
-- when an announcement is cancelled. This one failed at 06:53 too: a break
-- that cannot be cleared leaves every browser on a break screen.
ALTER FUNCTION public.fn_clear_engine_maintenance_break(
  text, timestamptz, timestamptz, timestamptz, text, uuid
) SET lock_timeout TO '32s';
ALTER FUNCTION public.fn_clear_engine_maintenance_break(
  text, timestamptz, timestamptz, timestamptz, text, uuid
) SET statement_timeout TO '35s';

-- The token rotation a replacement engine uses to adopt a live break. If this
-- cannot take the boundary, a restarted engine cannot adopt the break it was
-- restarted inside.
ALTER FUNCTION public.fn_claim_engine_maintenance_break(uuid, uuid, text)
  SET lock_timeout TO '32s';
ALTER FUNCTION public.fn_claim_engine_maintenance_break(uuid, uuid, text)
  SET statement_timeout TO '35s';

-- The thaw at :00. When this times out the platform resumes with its clocks
-- still holding the frozen minutes ("THAW FAILED - resuming anyway; clocks
-- lost the frozen minutes"), which is the one wrong a break is supposed never
-- to do.
ALTER FUNCTION public.fn_thaw_platform(
  timestamptz, timestamptz, numeric, uuid, text
) SET lock_timeout TO '32s';
ALTER FUNCTION public.fn_thaw_platform(
  timestamptz, timestamptz, numeric, uuid, text
) SET statement_timeout TO '35s';

COMMIT;
