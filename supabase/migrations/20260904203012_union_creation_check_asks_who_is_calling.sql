-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260904203012; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260904203012   (the stamp IS the apply time, UTC: 2026-09-04 20:30:12)
--   name        union_creation_check_asks_who_is_calling
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 2138 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260904203012 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_can_i_create_a_union
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

-- ═══════════════════════════════════════════════════════════════════════════
--  THE UNION-CREATION CHECK ASKS WHO IS CALLING (2026-09-04, same day)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- check-definer-authorization blocked the first cut and was right to. As
-- shipped, fn_can_create_union(uuid) was SECURITY DEFINER, executable by anon,
-- and took the account to test AS AN ARGUMENT - so anybody, signed in or not,
-- could ask it about any user id they could guess and learn who holds the
-- permission. Read-only is not the same as harmless: that is an enumeration
-- surface over a privilege.
--
-- Split in two, along the line of who is asking:
--
--   fn_can_create_union(uuid) - INTERNAL. The trigger on public.unions calls
--     it (as its own definer, so grants here do not affect it) and the union
--     API calls it as the service role. Revoked from every browser-reachable
--     role, including PUBLIC, because anon inherits whatever PUBLIC holds.
--
--   fn_can_i_create_a_union() - the client's question, about the caller and
--     nobody else. It takes no argument and reads auth.uid(), so there is
--     nothing to enumerate with.

BEGIN;

SET LOCAL lock_timeout = '8s';

REVOKE ALL ON FUNCTION public.fn_can_create_union(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_can_create_union(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_can_i_create_a_union()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT auth.uid() IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.union_creators c WHERE c.user_id = auth.uid());
$$;

COMMENT ON FUNCTION public.fn_can_i_create_a_union() IS
  'May the CALLER create a union? Takes no argument on purpose: the answer is about auth.uid() and nobody else, so there is nothing to enumerate. The refusal that counts is trg_union_creation_is_allowlisted on public.unions.';

REVOKE ALL ON FUNCTION public.fn_can_i_create_a_union() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_can_i_create_a_union() TO authenticated, service_role;

COMMIT;
