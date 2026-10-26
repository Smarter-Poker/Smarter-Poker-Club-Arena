-- 20261026004819_a_called_river_hand_shows_in_previous_hand.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan, 2026-10-25, verbatim: "WHEN A PLAYER CALLS A BET ON THE RIVER AND HIS
-- HAND IS MUCKED, USERS SHOULD STILL BE ABLE TO SEE THE HAND 'THEY FOLDED'
-- INSIDE THE PREVIOUS HAND. BUT ONLY IF THE HAND WAS 'CALLED' ON THE RIVER,
-- IF THEY MUCK THE HAND SHOULDN'T BE SHOWN."
--
-- A player asked it first: his opponent checked the river out of position,
-- called his bet, lost, and the Previous Hand only ever said "Mucked". The
-- engine auto-mucks a showdown hand that cannot win or tie anything
-- (HandController.applyShowdownRevealRules), and hand_history deliberately
-- stores only the holdings the table saw (the 2026-08-17 leak rule), so the
-- caller's cards were nowhere a participant could read them.
--
-- THE RULE, exactly as narrow as Dan stated it. A holding is returned only
-- when ALL of these hold:
--   1. the reader was dealt into the hand - the same predicate as the
--      hand_history_authenticated_select policy, so this reaches no hand the
--      reader could not already open;
--   2. the holder reached showdown and the engine ruled the hand MUCKED
--      (`showdown[].mucked = true`);
--   3. the holder's last voluntary action on the river was a CALL - they paid
--      to see the river bet. A checked-down loser, a player who folded, and a
--      hand that never reached showdown all stay private, exactly as before.
--
-- Measured on production 2026-10-26 over 30 minutes of hands: 1,869 mucked
-- showdown holdings, 677 of them river calls (every one with cards in
-- ca_hand_facts), 1,189 checked down (still hidden), 3 other.
--
-- WHERE THE CARDS COME FROM. ca_hand_facts keeps every dealt seat's holding,
-- horses included (section 10.5: a horse's called hand shows like anyone's),
-- and its SELECT policy stays self-scoped - this function is the single
-- narrow door, it names its rule in its body, and it changes no policy
-- (tests/a-godmode-read-is-always-logged.law.test.ts still holds). Nothing is
-- written; the live table still shows MUCKED, which is what happened there.
-- Works for every hand back to when ca_hand_facts began (2026-08-21).
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '1s';

CREATE OR REPLACE FUNCTION public.fn_ca_called_river_mucked_cards(p_hand_ids uuid[])
RETURNS TABLE (hand_id uuid, user_id uuid, hole_cards jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH viewer AS (
    SELECT auth.uid() AS uid
  ),
  requested AS (
    -- A page of previous hands, never a scan: the first 200 ids only.
    SELECT DISTINCT unnest(p_hand_ids[1:200]) AS id
  ),
  hands AS (
    SELECT h.id, h.showdown, h.actions
    FROM requested r
    JOIN public.hand_history h ON h.id = r.id
    CROSS JOIN viewer v
    WHERE v.uid IS NOT NULL
      -- Rule 1: the reader was dealt in (mirrors hand_history's own RLS).
      AND h.players @> jsonb_build_array(jsonb_build_object('userId', v.uid::text))
      AND jsonb_typeof(h.showdown) = 'array'
  ),
  mucked AS (
    -- Rule 2: the engine ruled this showdown hand mucked.
    SELECT h.id AS hand_id, e->>'user_id' AS holder, h.actions
    FROM hands h
    CROSS JOIN LATERAL jsonb_array_elements(h.showdown) e
    WHERE e->>'mucked' = 'true'
      AND (e->>'user_id') ~ '^[0-9a-fA-F-]{36}$'
  ),
  called AS (
    -- Rule 3: the holder's last voluntary river action was a call. Forced
    -- entries and returned uncalled bets are not decisions and are skipped.
    SELECT m.hand_id, m.holder::uuid AS holder
    FROM mucked m
    WHERE jsonb_typeof(m.actions) = 'array'
      AND (
        SELECT a->>'action'
        FROM jsonb_array_elements(m.actions) WITH ORDINALITY t(a, ord)
        WHERE a->>'userId' = m.holder
          AND a->>'stage' = 'river'
          AND a->>'action' IN ('check', 'bet', 'call', 'raise', 'all_in', 'fold')
        ORDER BY ord DESC
        LIMIT 1
      ) = 'call'
  )
  SELECT c.hand_id, c.holder, f.hole_cards
  FROM called c
  JOIN public.ca_hand_facts f ON f.hand_id = c.hand_id AND f.user_id = c.holder
  WHERE jsonb_typeof(f.hole_cards) = 'array'
    AND jsonb_array_length(f.hole_cards) > 0;
$$;

COMMENT ON FUNCTION public.fn_ca_called_river_mucked_cards(uuid[]) IS
  'Dan 2026-10-25: a hand that CALLED a river bet and was mucked at showdown is shown in Previous Hand to the players dealt into that hand. Checked-down and folded hands stay private. Read-only; ca_hand_facts policies unchanged.';

REVOKE ALL ON FUNCTION public.fn_ca_called_river_mucked_cards(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_called_river_mucked_cards(uuid[]) TO authenticated;

COMMIT;
