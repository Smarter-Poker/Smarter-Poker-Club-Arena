-- ═══════════════════════════════════════════════════════════════════════════
-- tournaments.blind_speed NAMES A STRUCTURE THAT DOES NOT EXIST
-- ═══════════════════════════════════════════════════════════════════════════
--
-- @unapplied: dead-config retirement. Stops the lie growing without deciding
-- whether the column should be dropped or backfilled - that is Dan's call and
-- it is stated in the pull request.
--
-- WHAT IT IS. public.tournaments.blind_speed is 'standard' on all 54,260 rows,
-- every one of them, with 'standard' as the column DEFAULT.
--
-- WHY THAT IS A LIE. 'standard' is not a key of BLIND_STRUCTURES in
-- src/config/blindStructures.ts. Those keys are:
--
--     hyperTurbo | turbo | regular | deepStack | sng
--
-- So the column names a blind structure that has never existed. Anyone
-- resolving a tournament's speed through it - a report, an export, a lobby
-- badge, a future scheduler - gets a string that indexes nothing and, in
-- JavaScript, an `undefined` that renders as a blank rather than an error.
--
-- WHY IT IS SAFE TO TOUCH. Nothing reads it. Verified 2026-09-01 in both
-- directions: no function in the public schema and no view mentions
-- blind_speed (pg_proc.prosrc / pg_get_viewdef), and the only `blindSpeed` in
-- this repository is a local useState in CreateTournamentModal.tsx that indexes
-- BLIND_STRUCTURES directly and is never persisted. The engine reads
-- `blind_structure`, not this.
--
-- WHAT THIS DOES, and what it deliberately does not.
--
--   DOES: drops the DEFAULT, so a tournament created from tomorrow does not
--   assert a structure name that does not exist. New rows get NULL, which is
--   an honest "not recorded" rather than a confident wrong answer.
--
--   DOES: comments the column, so the next reader learns this from the schema
--   rather than from 54,260 identical values.
--
--   DOES NOT: backfill. There is nothing to backfill FROM - every row says the
--   same thing, so the real speed of a 2026-03 turbo is not recoverable from
--   this column and guessing it would be inventing history.
--
--   DOES NOT: drop the column. A DROP is irreversible and this is not urgent.
--
-- FOR DAN, the decision this defers: drop blind_speed outright, or make it
-- real by writing the BLIND_STRUCTURES key at creation time and backfilling
-- what is recoverable from blind_structure? The second is worth doing only if
-- something is going to read it.
--
-- IDEMPOTENT: DROP DEFAULT is a no-op when there is no default.
--
-- ROLLBACK (Tier 1 -- reversible, no data is changed):
--   ALTER TABLE public.tournaments ALTER COLUMN blind_speed SET DEFAULT 'standard';
--   COMMENT ON COLUMN public.tournaments.blind_speed IS NULL;

BEGIN;

SET LOCAL lock_timeout = '4s';

ALTER TABLE public.tournaments ALTER COLUMN blind_speed DROP DEFAULT;

COMMENT ON COLUMN public.tournaments.blind_speed IS
  'DEAD as of 2026-09-01, and it was never true. Every one of the 54,260 existing rows says ''standard'', which is not a key of BLIND_STRUCTURES (hyperTurbo|turbo|regular|deepStack|sng) - so the column has always named a structure that does not exist. Nothing reads it: no public function, no view, and no code in club-arena. The DEFAULT is dropped so new rows record NULL rather than repeating the claim. Read blind_structure instead. Drop-or-backfill is an open decision for Dan.';

-- Post-apply assertions.
DO $$
DECLARE
  v_default text;
  v_rows bigint;
BEGIN
  SELECT column_default INTO v_default
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'tournaments' AND column_name = 'blind_speed';
  IF v_default IS NOT NULL THEN
    RAISE EXCEPTION 'tournaments.blind_speed still defaults to %', v_default;
  END IF;

  -- History must be untouched: this migration changes what happens next, not
  -- what already happened.
  SELECT count(*) INTO v_rows FROM public.tournaments WHERE blind_speed IS DISTINCT FROM 'standard';
  IF v_rows <> 0 THEN
    RAISE EXCEPTION '% existing tournament row(s) no longer read ''standard'' - history was rewritten', v_rows;
  END IF;

  IF col_description('public.tournaments'::regclass,
       (SELECT attnum FROM pg_attribute
         WHERE attrelid = 'public.tournaments'::regclass AND attname = 'blind_speed')) IS NULL THEN
    RAISE EXCEPTION 'blind_speed has no comment - a dead column that does not say so reads as authoritative';
  END IF;
END $$;

COMMIT;
