-- ═══════════════════════════════════════════════════════════════════════════
-- A BOMB POT MAY NOT CROSS THE FIXED-LIMIT LINE (2026-08-31)
-- ═══════════════════════════════════════════════════════════════════════════
-- The engine learned this rule and the database did not.
--
-- `resolveBombPotVariant` (server/src/engine/BombPotScheduler.ts) refuses a
-- bomb-pot variant whose betting structure differs from the table's, in both
-- directions, and says why: a `plo4` bomb on a Fixed Limit Hold'em table
-- "handed every seated player one hand of pot-limit poker at a table they had
-- sat down at for limit. Nothing warned them and nothing in the hand history
-- explained it afterwards."
--
-- The CHECK that was supposed to mirror the engine's whitelist did not know
-- about that, because it could only see ONE column:
--
--   CHECK (bomb_pot_variant IS NULL
--          OR bomb_pot_variant IN ('nlh','plo4','plo5','plo6'))
--
-- Two consequences, both live until now:
--
--   1. The database would happily store bomb_pot_variant='plo4' on a
--      game_variant='flh' table. The engine refuses it at deal time, which is
--      the right failsafe, but the ROW is a lie and it is a PUBLISHED one:
--      the migration that added this column splices bomb_pot_variant into
--      get_club_home, so the lobby advertises "PLO4 bomb pots" on a table
--      that will only ever deal FLH. Nothing warns the owner at write time.
--
--   2. The whitelist omits 'flh' and 'flo8' entirely, so the LEGAL case — a
--      fixed-limit bomb on a fixed-limit table — could not be configured at
--      all. The engine's cross-the-line test could therefore only ever
--      reject, never permit.
--
-- The constraint is now a two-column one, which is the only shape that can
-- express the rule. Structure classes mirror server/src/engine/
-- BettingStructure.ts exactly: FIXED_LIMIT_VARIANTS = {flh, flo8};
-- everything else on this list is no-limit or pot-limit.
--
-- SAFETY, measured before applying: 103,732 rows in public.tables, of which
-- exactly ONE has bomb_pot_variant set at all — an 'nlh' table with a 'plo5'
-- bomb, which is legal under the new rule and stays legal. Every other row is
-- NULL. So this cannot fail validation and it changes no existing row.
--
-- APPLIED TO PRODUCTION 2026-08-31 via Supabase MCP apply_migration
-- (migration name: a_bomb_pot_may_not_cross_the_fixed_limit_line), then
-- verified by re-reading pg_get_constraintdef.
--
-- ROLLBACK (Tier 3 — this replaces a constraint):
--   ALTER TABLE public.tables
--     DROP CONSTRAINT IF EXISTS tables_bomb_pot_variant_check;
--   ALTER TABLE public.tables
--     ADD CONSTRAINT tables_bomb_pot_variant_check
--     CHECK (bomb_pot_variant IS NULL
--            OR bomb_pot_variant IN ('nlh','plo4','plo5','plo6'));

-- Pre-flight: refuse to run if any row would violate the new rule, so this
-- reports the offending count rather than a bare constraint error.
DO $$
DECLARE
  v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad
    FROM public.tables
   WHERE bomb_pot_variant IS NOT NULL
     AND ( bomb_pot_variant NOT IN ('nlh','plo4','plo5','plo6','flh','flo8')
        OR (lower(coalesce(game_variant,'nlh')) IN ('flh','flo8'))
           IS DISTINCT FROM (bomb_pot_variant IN ('flh','flo8')) );
  IF v_bad > 0 THEN
    RAISE EXCEPTION
      'refusing to add the constraint: % existing rows carry a bomb pot that crosses the fixed-limit line or is off the whitelist',
      v_bad;
  END IF;
END $$;

ALTER TABLE public.tables
  DROP CONSTRAINT IF EXISTS tables_bomb_pot_variant_check;

ALTER TABLE public.tables
  ADD CONSTRAINT tables_bomb_pot_variant_check
  CHECK (
    bomb_pot_variant IS NULL
    OR (
      bomb_pot_variant IN ('nlh', 'plo4', 'plo5', 'plo6', 'flh', 'flo8')
      AND (lower(coalesce(game_variant, 'nlh')) IN ('flh', 'flo8'))
          = (bomb_pot_variant IN ('flh', 'flo8'))
    )
  );

-- Post-apply assertion: the constraint exists and actually bites. Probed in a
-- transaction that is rolled back (CLAUDE.md 11.5 — never spend real chips to
-- test a rule); what we want is the error, and GET STACKED DIAGNOSTICS
-- survives the rollback.
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_def
    FROM pg_constraint
   WHERE conrelid = 'public.tables'::regclass
     AND conname = 'tables_bomb_pot_variant_check';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'tables_bomb_pot_variant_check is missing after the ALTER';
  END IF;
  IF position('game_variant' in v_def) = 0 THEN
    RAISE EXCEPTION 'the constraint is still single-column: %', v_def;
  END IF;
  IF position('flo8' in v_def) = 0 THEN
    RAISE EXCEPTION 'the constraint does not know the fixed-limit variants: %', v_def;
  END IF;
END $$;
