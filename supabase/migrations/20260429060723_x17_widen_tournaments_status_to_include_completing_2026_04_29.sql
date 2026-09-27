-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260429060723 "x17_widen_tournaments_status_to_include_completing_2026_04_29"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 7564a15f2836efb68c3f2c9a455b53d2 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Round 17 — tournaments.status_check rejects 'COMPLETING' but the engine
-- atomic finalize guard at server/src/GameServer.ts:2400 writes that value
-- as a transient state to claim the RUNNING → COMPLETING transition before
-- doing the heavy finalize work. Without 'COMPLETING' in the allow-list:
--   1. The .update fails the CHECK
--   2. Postgres returns an error, the JS catches it but the tournament stays
--      stuck in RUNNING
--   3. The stuck-COMPLETING recovery code (GameServer.ts:578 + 793) queries
--      for status='COMPLETING' to recover — but the value never landed, so
--      recovery finds nothing and the tournament accumulates as a stuck
--      RUNNING row indefinitely
--
-- Fix: add 'COMPLETING' to the allow-list. This matches the engine's
-- transient-lock semantics, so the finalizer can claim the transition
-- and the recovery path can clean up stuck transitions if a worker crashes
-- mid-finalize.

ALTER TABLE public.tournaments
  DROP CONSTRAINT IF EXISTS tournaments_status_check;
ALTER TABLE public.tournaments
  ADD CONSTRAINT tournaments_status_check
      CHECK (status = ANY (ARRAY[
        'ANNOUNCED'::text,
        'REGISTERING'::text,
        'LATE_REG'::text,
        'RUNNING'::text,
        'COMPLETING'::text,
        'COMPLETED'::text,
        'CANCELLED'::text
      ]));
