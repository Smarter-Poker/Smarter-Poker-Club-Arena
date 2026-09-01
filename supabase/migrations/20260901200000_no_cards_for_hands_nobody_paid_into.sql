-- ═══════════════════════════════════════════════════════════════════════════
--  A HAND NOBODY PAID INTO IS NOT RECORDED
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan, 2026-09-01, verbatim:
--   "MUCKED HANDS SHOULDN'T BE RECORDED AND TRACKED, ONLY HANDS WHERE THE
--    HERO PUTS CHIPS IN POT."
--
-- WHAT WAS HAPPENING. `ca_hand_facts` writes one row per player per hand and
-- stored `hole_cards` on every one of them, including hands the player was
-- dealt and folded for free. Measured the day of the ruling: 640 of 2,265
-- rows, 28%, carried the exact holding of a hand nobody put a chip into, kept
-- indefinitely (this table is deliberately never pruned - it is four orders of
-- magnitude smaller than hand_history precisely so it can be).
--
-- `invested` is the engine's own contributions map, so 0 means no chips of
-- this player's reached the pot at all: not a blind, not an ante.
--
-- WHAT IS KEPT. `hand_class` - the 169-bucket label, which carries no suit
-- identity and no board. It is the DENOMINATOR of the only chart that reads
-- this table's holdings: `ca_player_hand_grid`'s default view is "how often
-- you played this hand", computed as hands_vpip / hands per class. Removing
-- the folded-for-free rows would make every cell read 100% and delete the
-- feature rather than improve it. That function never selects `hole_cards`.
--
-- WHY A TRIGGER AND NOT A CHECK. `handFacts.ts` writes these rows as ONE batch
-- upsert for the whole table of players. A CHECK constraint would 400 the
-- entire batch on a single offending row and take every other player's stats
-- row down with it - the file's own comments already record that failure mode
-- for a different column. A BEFORE trigger that NULLS the value cannot lose a
-- row and cannot be got past.
--
-- One transaction, one PostgREST schema reload (CLAUDE.md production DDL
-- policy).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. The rule, enforced where it cannot be forgotten ────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_hand_facts_strip_unpaid_holding()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  -- COALESCE: a NULL invested is "we do not know it was paid for", which is
  -- not the same as knowing it was, so it strips too.
  IF COALESCE(NEW.invested, 0) = 0 THEN
    NEW.hole_cards := NULL;
  END IF;
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.fn_ca_hand_facts_strip_unpaid_holding() IS
  'Dan 2026-09-01: mucked hands are not recorded, only hands where chips went in. Nulls hole_cards when invested = 0. Nulls rather than rejects so a batch upsert can never be lost.';

DROP TRIGGER IF EXISTS trg_ca_hand_facts_strip_unpaid_holding ON public.ca_hand_facts;
CREATE TRIGGER trg_ca_hand_facts_strip_unpaid_holding
  BEFORE INSERT OR UPDATE ON public.ca_hand_facts
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_ca_hand_facts_strip_unpaid_holding();

-- ── 2. The rows already written ───────────────────────────────────────────
UPDATE public.ca_hand_facts
   SET hole_cards = NULL
 WHERE COALESCE(invested, 0) = 0
   AND hole_cards IS NOT NULL;

-- ── 3. Prove both, or roll the whole thing back ───────────────────────────
DO $$
DECLARE
  v_left    bigint;
  v_trigger int;
  v_class   bigint;
BEGIN
  SELECT count(*) INTO v_left
    FROM public.ca_hand_facts
   WHERE COALESCE(invested, 0) = 0 AND hole_cards IS NOT NULL;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'backfill left % unpaid holdings behind', v_left;
  END IF;

  SELECT count(*) INTO v_trigger
    FROM pg_trigger
   WHERE tgname = 'trg_ca_hand_facts_strip_unpaid_holding'
     AND tgrelid = 'public.ca_hand_facts'::regclass
     AND NOT tgisinternal;
  IF v_trigger <> 1 THEN
    RAISE EXCEPTION 'trigger not installed (found %)', v_trigger;
  END IF;

  -- The denominator must survive. If this ever goes to zero the hand grid has
  -- lost its "hands dealt" side and every cell will read 100%.
  SELECT count(*) INTO v_class
    FROM public.ca_hand_facts
   WHERE COALESCE(invested, 0) = 0 AND hand_class IS NOT NULL;
  IF v_class = 0 THEN
    RAISE EXCEPTION 'no unpaid rows retained a hand_class - the grid denominator is gone';
  END IF;

  RAISE NOTICE 'unpaid holdings stripped; % unpaid rows still carry a hand_class', v_class;
END $$;

COMMIT;
