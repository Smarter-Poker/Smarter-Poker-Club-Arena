-- ═══════════════════════════════════════════════════════════════════════════
--  CRAZY PINEAPPLE - THE CARD YOU THREW IS YOURS ALONE (Phase 4 of 4)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The hand replay has known the word "Discard" since the variant shipped, but
-- never WHICH card - the only decision Crazy Pineapple adds to poker was the
-- one thing a player could not review.
--
-- WHY THIS IS ITS OWN TABLE, AND NOT A COLUMN ON hand_history.
--
-- The obvious home is hand_history: it is where the replay reads from, and it
-- already carries `hole_cards`. It is also the wrong home, and the RLS is why:
--
--   hand_history_authenticated_select
--     USING (players @> jsonb_build_array(jsonb_build_object('userId', auth.uid())))
--
-- Any player who was IN a hand can read the WHOLE row - every other seat's
-- entry included. That is safe today only because the engine writes cards
-- there exclusively for hands that were SHOWN: measured 2026-08-31 over 785
-- hands containing a fold, a folded player's cards were stored zero times.
--
-- A discarded card is never shown. Not on the discard, not at showdown - that
-- is the rule of the variant. Putting it in hand_history would publish every
-- player's discard to every opponent at that table, permanently, and it would
-- do it through a policy that looks correct. That is the same shape as the
-- god-mode vulnerability that created table_hole_cards in the first place
-- (migration 20260312_secure_hole_cards_fix.sql).
--
-- So this table copies table_hole_cards' proven shape instead: keyed by the
-- same three columns, readable only by the row's own user, and never writable
-- from a browser at all.
--
-- Retention deliberately mirrors hand_history's (20260820c): a hand with a
-- human in it is kept forever, so a human's discard is kept forever; a
-- horse-only hand ages out, and its discards go with it. A replay that can
-- show you the hand can show you the card you threw in it.

CREATE TABLE IF NOT EXISTS public.hand_discards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  user_id uuid NOT NULL,
  seat_number integer NOT NULL,
  -- One card, stored the way the engine holds it: {"rank":"A","suit":"h"}.
  -- An object rather than a string so it needs no parser on either side, and
  -- so a future variant that throws more than one card is an array change
  -- here rather than a format change everywhere.
  discarded_card jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A seat discards exactly once per hand. The uniqueness is the rule.
  UNIQUE (table_id, hand_number, user_id)
);

-- The replay lists a player's own recent hands, newest first.
CREATE INDEX IF NOT EXISTS hand_discards_user_recent_idx
  ON public.hand_discards (user_id, created_at DESC);
-- The prune walks by hand.
CREATE INDEX IF NOT EXISTS hand_discards_hand_idx
  ON public.hand_discards (table_id, hand_number);

ALTER TABLE public.hand_discards ENABLE ROW LEVEL SECURITY;

-- ── THE ONLY READ THAT EXISTS ─────────────────────────────────────────────
-- Your own row, and nothing else. There is deliberately no "players at this
-- table" clause, no showdown exception and no admin bypass: the whole point
-- of the variant is that this card stays private, and an exception is how a
-- private column becomes a public one two refactors later.
DROP POLICY IF EXISTS hand_discards_read_own ON public.hand_discards;
CREATE POLICY hand_discards_read_own ON public.hand_discards
  FOR SELECT
  USING ((SELECT auth.uid()) = user_id);

-- ── NOTHING WRITES FROM A BROWSER ─────────────────────────────────────────
-- Same posture as table_hole_cards: the engine writes with the service role,
-- which bypasses RLS, so authenticated needs no write path at all. These are
-- explicit denials rather than absent policies because an absent policy is
-- indistinguishable from an oversight when somebody reads this later.
DROP POLICY IF EXISTS hand_discards_block_insert ON public.hand_discards;
CREATE POLICY hand_discards_block_insert ON public.hand_discards
  FOR INSERT TO authenticated WITH CHECK (false);

DROP POLICY IF EXISTS hand_discards_block_update ON public.hand_discards;
CREATE POLICY hand_discards_block_update ON public.hand_discards
  FOR UPDATE TO authenticated USING (false);

DROP POLICY IF EXISTS hand_discards_block_delete ON public.hand_discards;
CREATE POLICY hand_discards_block_delete ON public.hand_discards
  FOR DELETE TO authenticated USING (false);

REVOKE ALL ON public.hand_discards FROM anon;
GRANT SELECT ON public.hand_discards TO authenticated;
GRANT ALL ON public.hand_discards TO service_role;

COMMENT ON TABLE public.hand_discards IS
  'Crazy Pineapple: the card each player threw, readable ONLY by that player. Never in hand_history - its RLS lets any seat in the hand read the whole row, and a discard is never revealed to opponents. Written by the engine with the service role.';

-- ── RETENTION, MIRRORING hand_history ─────────────────────────────────────
-- A discard outlives nothing and nothing outlives it: a row survives exactly
-- as long as a hand_history row for its (table_id, hand_number) does. The
-- grace window keeps a discard that was written moments before its hand row
-- exists - the engine writes the discard mid-hand and hand_history at hand
-- completion, so for the length of one hand there is legitimately no parent.
CREATE OR REPLACE FUNCTION public.sp_prune_hand_discards(p_limit integer DEFAULT 5000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  WITH doomed AS (
    SELECT d.id
    FROM public.hand_discards d
    WHERE d.created_at < now() - interval '1 day'
      AND NOT EXISTS (
        SELECT 1 FROM public.hand_history h
        WHERE h.table_id = d.table_id AND h.hand_number = d.hand_number
      )
    ORDER BY d.created_at
    LIMIT GREATEST(p_limit, 0)
  )
  DELETE FROM public.hand_discards d
  USING doomed WHERE d.id = doomed.id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION public.sp_prune_hand_discards(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sp_prune_hand_discards(integer) TO service_role;

COMMENT ON FUNCTION public.sp_prune_hand_discards(integer) IS
  'Deletes hand_discards rows whose hand is no longer in hand_history, after a one-day grace window so a discard written mid-hand is never pruned before its own hand row is written.';
