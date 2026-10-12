-- 20261007132903_the_elimination_stamp_fires_in_every_replication_role.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE LINE THAT WROTE THE NULL SEQUENCES
--
-- At 15:33:04 UTC on 2026-10-06 a psql session (user postgres) that had run
-- `SET session_replication_role = replica` executed the patterned-identity
-- force drain loop:
--
--     UPDATE public.tournament_players tp
--        SET status = 'eliminated', eliminated_at = clock_timestamp()
--       FROM smarter_private.patterned_identity_retirements r
--      WHERE r.old_id = tp.user_id AND r.cohort = 'horse'
--        AND lower(coalesce(tp.status::text, '')) IN ('registered', 'playing');
--
-- (postgres_logs, sessions 6ac51418 .. 6ac514ac; the same UPDATE run without
-- replica mode at 15:33:34 was correctly refused by the never-started guard.)
-- The elimination stamp, zz_stamp_tournament_elimination_sequence, is an
-- ordinary ENABLED trigger, and an ordinary trigger does not fire while
-- session_replication_role = replica. So the UPDATE marked live players
-- eliminated with elimination_sequence NULL: four running Spins and five
-- registering events. A NULL sequence makes the last bust unknowable, the
-- terminal authority refuses to name a winner (P0404), and on 62a15104 the
-- refusal pinned the PostgREST pool into hourly 504 storms for ten hours
-- (20261007071300).
--
-- The maintained producer (scripts/admin/retire-patterned-identities.sql,
-- #6315) now refuses to run outside replication role 'origin' and never
-- force-drains. That constrains the maintained script, not a foreign session
-- that sets replica mode. The sequence is database-owned (the trigger says so
-- and refuses any hand-written one); this makes it owned in every role.
--
-- THE FIX
--
-- ENABLE ALWAYS: the stamp now fires under session_replication_role = replica
-- as well. The function is unchanged (md5 asserted below), so ordinary
-- sessions behave exactly as before, and a session that bypasses every other
-- trigger still cannot put a player into 'eliminated' without the next
-- sequence number - the field stays orderable and the terminal authority can
-- always place every bust. It writes no row; it changes one catalogue flag.
--
-- One short transaction with a lock timeout (CLAUDE.md section 2 rule 7):
-- ALTER TABLE takes SHARE ROW EXCLUSIVE on tournament_players for an instant.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';

DO $preimage$
BEGIN
  IF (SELECT t.tgenabled FROM pg_trigger t
       WHERE t.tgrelid = 'public.tournament_players'::regclass
         AND t.tgname = 'zz_stamp_tournament_elimination_sequence') IS DISTINCT FROM 'O'
     OR md5(pg_get_functiondef('public.fn_stamp_tournament_elimination_sequence()'::regprocedure))
        IS DISTINCT FROM '1da72fa956566502be6d6c8d46ba6d2a' THEN
    RAISE EXCEPTION 'ELIMINATION_STAMP_PREIMAGE_CHANGED' USING ERRCODE = '55000';
  END IF;
END
$preimage$;

ALTER TABLE public.tournament_players
  ENABLE ALWAYS TRIGGER zz_stamp_tournament_elimination_sequence;

-- @live-proof: (SELECT t.tgenabled FROM pg_trigger t WHERE t.tgrelid = 'public.tournament_players'::regclass AND t.tgname = 'zz_stamp_tournament_elimination_sequence') = 'A'

COMMIT;
