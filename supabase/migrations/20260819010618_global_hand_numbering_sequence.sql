-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819010618 "global_hand_numbering_sequence"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ef4afed1015786dc91f8f5ed1779e2f8 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- GLOBAL HAND NUMBERING (2026-08-18)
-- ═══════════════════════════════════════════════════════════════════════════
-- Dan: "each hand number needs to be 100% completely different and unique with
-- the hand numbers counting upwards forever ... we should be able to grab
-- literally any hand number and identify that hand, see all the action for the
-- hand ... across multiple tables, cash games, clubs, unions etc. Hand numbers
-- can never reset or be reused ever."
--
-- TODAY IT IS A PER-TABLE COUNTER. Measured: the most recent 20,000 hands carry
-- only 7,468 distinct hand numbers, because every table counts 1,2,3... from
-- its own start. "Hand #196" identifies nothing.
--
-- THE ALLOCATOR is a Postgres sequence, chosen deliberately over a
-- MAX(hand_number)+1 read or an in-engine counter:
--   * it cannot issue the same value twice even under concurrent deals across
--     tables, clubs and engine instances;
--   * it survives engine restarts and redeploys, which an in-memory counter
--     does not (that is exactly how the current numbers reset);
--   * it never rolls back, so a crashed hand can never free its number for
--     reuse by a later hand.
--
-- GAPS ARE CORRECT, NOT A DEFECT. A hand that is dealt and then abandoned
-- consumes its number permanently. That is the price of "never reused", and it
-- costs nothing: every number still resolves to at most one hand.
--
-- STARTS AT 1,000,000 so the new globally-unique era can never collide with the
-- legacy per-table numbers (max legacy observed: 13,811) and so it is obvious
-- at a glance which era a number belongs to.

CREATE SEQUENCE IF NOT EXISTS public.global_hand_number_seq
  AS bigint
  START WITH 1000000
  MINVALUE 1000000
  NO MAXVALUE
  NO CYCLE;

-- Uniqueness enforced by the database, not by convention. PARTIAL, because the
-- legacy rows below 1,000,000 are genuinely duplicated and cannot be rewritten
-- without falsifying history — this guarantees every hand from the cutover
-- forward is unique while leaving the past intact and clearly separable.
CREATE UNIQUE INDEX IF NOT EXISTS uq_hand_history_global_hand_number
  ON public.hand_history (hand_number)
  WHERE hand_number >= 1000000;

-- Investigation entry point: any number -> that one hand, with its full action
-- log. This is the index that makes "grab literally any hand number" fast.
CREATE INDEX IF NOT EXISTS idx_hand_history_hand_number_lookup
  ON public.hand_history (hand_number);

CREATE OR REPLACE FUNCTION public.fn_next_hand_number()
RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT nextval('public.global_hand_number_seq');
$$;

REVOKE ALL ON FUNCTION public.fn_next_hand_number() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_next_hand_number() TO service_role;

COMMENT ON SEQUENCE public.global_hand_number_seq IS
  'Single global allocator for hand numbers. Never resets, never reuses, ascends in deal order across every table, club, union, cash game and tournament. Starts at 1,000,000 to sit clear of the legacy per-table numbering.';

COMMENT ON FUNCTION public.fn_next_hand_number() IS
  'Allocates the next global hand number. Called once per hand at deal time so ordering reflects when the hand was dealt. Service-role only.';
