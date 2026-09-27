-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819234422 "clubs_name_not_blank_check"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 9cd3082baa617e223b7fd6ac43a79cb8 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- clubs.name is NOT NULL but had no guard against the empty string, so a club
-- could be saved nameless. The Club Settings page now validates this client
-- side (pass 5), but the client is not an authority: any holder of an
-- owner-scoped token can PATCH the row directly through PostgREST.
--
-- A nameless club is not cosmetic — the delete confirmation compares typed
-- text against the saved name, so a blank name armed the Delete Club button
-- with an empty input box.
--
-- Verified before applying: 0 of 789 rows violate this.
-- Length is deliberately NOT constrained here — the UI caps at 50, but other
-- creation paths have not been audited and a length CHECK could reject a
-- legitimate existing flow.
--
-- ROLLBACK: ALTER TABLE public.clubs DROP CONSTRAINT clubs_name_not_blank;
-- ═══════════════════════════════════════════════════════════════════════════
SET LOCAL lock_timeout = '4s';

DO $$
DECLARE
  v_bad int;
BEGIN
  SELECT count(*) INTO v_bad FROM public.clubs WHERE name IS NULL OR btrim(name) = '';
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'pre-flight: % club(s) already have a blank name — fix them first', v_bad;
  END IF;
END $$;

ALTER TABLE public.clubs
  ADD CONSTRAINT clubs_name_not_blank CHECK (btrim(name) <> '');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.clubs'::regclass AND conname = 'clubs_name_not_blank'
  ) THEN
    RAISE EXCEPTION 'post-apply: clubs_name_not_blank missing';
  END IF;
END $$;
