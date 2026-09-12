-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260903011302; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260903011302   (the stamp IS the apply time, UTC: 2026-09-03 01:13:02)
--   name        horse_flag_rpcs_state_their_audience
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 3012 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260903011302 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     (no CREATE/DROP of a named object; see the body)
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
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

-- The estate's `check-definer-authorization` guard blocked the masking
-- migration, correctly. Its point was not that these functions are reachable
-- by `anon` in PRODUCTION today - probed, all three already answer
-- "permission denied for function" to a logged-out caller. Its point is that
-- the MIGRATION FILE never said so.
--
-- `CREATE OR REPLACE FUNCTION` does not reset privileges on an existing
-- function, so re-applying it here kept the good grants that were already in
-- place. Applied to a FRESH database, the same file would create three
-- SECURITY DEFINER functions carrying PostgreSQL's default `EXECUTE TO
-- PUBLIC` - and a club roster, with chip balances, would be readable by
-- anybody with no account. A migration that is only correct because of state
-- it did not create is a trap for whoever rebuilds this schema.
--
-- So the audience is now stated explicitly and idempotently. PUBLIC is named
-- as well as `anon`, because `anon` inherits whatever PUBLIC holds and
-- revoking `anon` alone reads as a fix while doing nothing.
--
-- These three are member-facing club surfaces: a logged-in player may call
-- them (the horse flag inside is masked to club leadership by
-- fn_can_see_horse_flag), and a logged-out visitor may not.

REVOKE ALL ON FUNCTION public.ca_club_members(uuid, text, timestamptz, integer, integer, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_members(uuid, text, timestamptz, integer, integer, text, text) TO authenticated;

REVOKE ALL ON FUNCTION public.ca_club_top_players(uuid, timestamptz, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_top_players(uuid, timestamptz, integer) TO authenticated;

REVOKE ALL ON FUNCTION public.fn_club_cashier_members_v2(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_cashier_members_v2(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.fn_can_see_horse_flag(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_can_see_horse_flag(uuid) TO authenticated;

DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public'
    AND p.proname IN ('ca_club_members','ca_club_top_players','fn_club_cashier_members_v2','fn_can_see_horse_flag')
    AND (has_function_privilege('anon', p.oid, 'EXECUTE')
         OR has_function_privilege('public', p.oid, 'EXECUTE'));

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POST-APPLY: still reachable without an account: %', v_bad;
  END IF;

  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public'
    AND p.proname IN ('ca_club_members','ca_club_top_players','fn_club_cashier_members_v2','fn_can_see_horse_flag')
    AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE');

  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'POST-APPLY: a signed-in player can no longer call: %', v_bad;
  END IF;
END $$;
