-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260912061735; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260912061735   (the stamp IS the apply time, UTC: 2026-09-12 06:17:35)
--   name        the_felt_register_is_read_only_and_the_incident_is_closed
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 7707 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260912061735 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     (no CREATE/DROP of a named object; see the body)
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- The felt register is read-only, and the incident is closed.
--
-- Follow-up to 20260912060147_the_felt_may_not_grow_past_what_was_bought_in,
-- which created public.tournament_felt_supply_acknowledgements and closed the
-- last finding of drift incident 8b8fe26c-f2f9-458f-a275-a19508b55b58. Two
-- things were left over. Neither is DDL on a relation's structure, so neither
-- fires pgrst_ddl_watch and neither costs a schema reload (production DDL
-- policy rule 5: GRANT/REVOKE are not in its list).
--
-- 1. THE REGISTER IS READ-ONLY TO EVERY RUNTIME ROLE. The first migration
--    revoked PUBLIC, anon and authenticated, and those took. But Supabase's
--    ALTER DEFAULT PRIVILEGES had already handed service_role the full
--    DELETE/INSERT/UPDATE/TRUNCATE set on the new table, so the GRANT SELECT
--    was additive and bought nothing. An acknowledgement is a statement about
--    what the platform created by defect; it is written by a migration, under
--    review, or it is not written. Reading is unaffected either way:
--    fn_ca_tournament_chip_supply and the felt gate are both SECURITY DEFINER
--    owned by postgres, so the meter reads the register whoever calls it, and
--    the table carries RLS with no policy for the browser roles.
--
--    This deliberately does NOT match the sibling ops tables - ca_drift_incidents
--    and ca_tournament_conservation_samples both leave service_role fully
--    privileged - because those are written at runtime by the sweep and this
--    one never is.
--
-- 2. THE INCIDENT IS CLOSED. fn_ca_conservation_sweep raises and re-raises
--    findings but never resolves one: its source carries no 'resolved' and no
--    resolved_at, so 8b8fe26c would have sat at status 'open' with its
--    occurrence count climbing hourly forever, long after the invariant it
--    watches came back to true. fn_tournament_chip_conservation_check(0.01)
--    now returns zero rows.
--
-- WHAT WAS DECIDED, in one paragraph. Two RUNNING tournaments carried a felt
-- heavier than their recorded supply: $100 Freeroll 12:00 PM (7aa16fa7) by
-- 10,000 and Early Bird Freeroll NLH (a5aa6984) by 2,500. The chips were real
-- and were created on 2026-09-09 by the one-shot stranded-seat repair, which
-- restored seats from table_seats.stack on rows that had already been vacated -
-- a stale snapshot nothing zeroes - and so handed players chips that had
-- already been paid to whoever busted them. Both amounts are exact multiples
-- of the events' starting stacks, both appear in ca_tournament_conservation_
-- samples as a step with no hands dealt in the window, and all three witnesses
-- (table_seats, tournament_players.chips, hand_history) agree the felt is what
-- it says. Nothing was taken back from any player: the chips had been in play
-- for three days and the hands they were played in are final, which is
-- CLAUDE.md 10.9 rule 3. Instead the platform acknowledged what it created, in
-- a register denominated in play chips so the money conservation audit is not
-- touched, and the supply meter now counts it, which returns both events to a
-- drift of zero without moving a single stack. a5aa6984 was acknowledged at the
-- 2,500 standing on its felt and NOT at the 5,000 it would take to also re-seat
-- the stranded player river222, because inventing supply to solve a seating
-- problem is how a meter stops being worth reading; river222 is filed as a
-- seating finding instead. The door the repair came through is now shut in the
-- database rather than in the callers: no trigger on table_seats constrained
-- the value written to stack, and now one does.

BEGIN;

REVOKE ALL ON public.tournament_felt_supply_acknowledgements FROM service_role;
GRANT SELECT ON public.tournament_felt_supply_acknowledgements TO service_role;

UPDATE public.ca_drift_incidents
   SET status        = 'resolved',
       resolved_at   = now(),
       correction_ref= 'migration 20260912060147_the_felt_may_not_grow_past_what_was_bought_in',
       resolution    =
         'Acknowledged, not confiscated. The 10,000 (7aa16fa7) and 2,500 '
         '(a5aa6984) were really created on the felt on 2026-09-09 by the '
         'one-shot stranded-seat repair fn_ca_return_stranded_to_the_felt -> '
         'fn_ca_move_tournament_seat (migrations 20260909175754 / '
         '20260909175822), which re-seated players from table_seats.stack on '
         'ALREADY-VACATED rows - a stale snapshot nothing zeroes - so chips '
         'already paid to the players who busted them went back onto the felt. '
         'Both figures are whole multiples of the starting stack and both show '
         'in ca_tournament_conservation_samples as a step with zero hands '
         'dealt. Recorded in public.tournament_felt_supply_acknowledgements, a '
         'PLAY-CHIP register - deliberately not tournament_conservation_'
         'baseline, which is money-denominated and read by '
         'fn_tournament_conservation_delta against wallet_transactions - and '
         'added to fn_ca_tournament_chip_supply, so '
         'fn_tournament_chip_conservation_check(0.01) now returns zero rows '
         'with no player stack rewritten. No claw-back (CLAUDE.md 10.9 rule '
         '3): the chips were in play for three days. 7aa16fa7 COMPLETED '
         '2026-09-12 05:23:27Z carrying its last measured +10,000 and is '
         'acknowledged for the record. a5aa6984 is acknowledged at the 2,500 '
         'standing on its felt, NOT the 5,000 that would also re-seat the '
         'stranded river222 (dca6c345) - that is a seating problem and is not '
         'paid for with supply nobody bought; it is filed separately and is '
         'still open. HARDENED: zzzzzz_tournament_felt_may_not_exceed_supply, '
         'a DEFERRABLE INITIALLY DEFERRED constraint trigger on table_seats '
         '(AFTER INSERT OR UPDATE OF stack, left_at), refuses the write that '
         'carries a tournament felt above supply; existing overage tolerated, '
         'growth refused. None of the 38 triggers on table_seats constrained '
         'the value written to stack before this.'
 WHERE id = '8b8fe26c-f2f9-458f-a275-a19508b55b58';

DO $after$
DECLARE
  v_n integer;
  v_privs text;
BEGIN
  SELECT count(*) INTO v_n FROM public.ca_drift_incidents
   WHERE id = '8b8fe26c-f2f9-458f-a275-a19508b55b58'
     AND status = 'resolved' AND resolved_at IS NOT NULL
     AND resolution IS NOT NULL;
  IF v_n <> 1 THEN RAISE EXCEPTION 'incident 8b8fe26c did not close'; END IF;

  SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) INTO v_privs
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND table_name = 'tournament_felt_supply_acknowledgements'
     AND grantee = 'service_role';
  IF v_privs IS DISTINCT FROM 'SELECT' THEN
    RAISE EXCEPTION 'service_role holds % on the felt register, not SELECT', v_privs;
  END IF;

  SELECT count(*) INTO v_n
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND table_name = 'tournament_felt_supply_acknowledgements'
     AND grantee IN ('anon','authenticated','PUBLIC');
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'a browser role still holds a grant on the felt register';
  END IF;

  -- The register must still read, and the invariant must still hold.
  IF public.fn_ca_tournament_chip_supply('a5aa6984-6c1c-4b59-aeb7-9e7878853bdd')
     <> 320000 THEN
    RAISE EXCEPTION 'the meter stopped reading the register after the revoke';
  END IF;
  SELECT count(*) INTO v_n FROM public.fn_tournament_chip_conservation_check(0.01);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'the conservation check returns % row(s)', v_n;
  END IF;
END $after$;

COMMIT;
