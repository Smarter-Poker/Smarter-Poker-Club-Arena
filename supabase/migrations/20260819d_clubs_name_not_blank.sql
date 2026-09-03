-- ═══════════════════════════════════════════════════════════════════════════
-- Migration: 20260819d_clubs_name_not_blank.sql   (applied to prod)
--
-- clubs.name is NOT NULL but had no guard against the empty string, so a club
-- could be saved nameless. The Club Settings page validates this client side
-- (pass 5), but the client is not an authority: any holder of an owner-scoped
-- token can PATCH the row directly through PostgREST.
--
-- A nameless club is not cosmetic — the delete confirmation compares typed
-- text against the saved name, so a blank name armed the Delete Club button
-- with an empty input box.
--
-- Verified before applying: 0 of 789 rows violate this.
-- Length is deliberately NOT constrained — the UI caps at 50, but other
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
