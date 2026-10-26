-- 20261026031500_a_river_all_in_call_shows_in_previous_hand.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- 20261026004819 shows a mucked hand in Previous Hand when its last river
-- decision was a CALL (Dan 2026-10-25). A player who calls a river bet with
-- every chip he has is recorded as `all_in`, not `call`, so that hand still
-- read "Mucked" - the gap Dan approved closing on 2026-10-25 ("do all 6").
--
-- An `all_in` is a call exactly when it does not put in more than the bet the
-- player faced: the acting seat's stack before the action is at most the
-- amount to call. Both numbers are on the action's own `publicNode` snapshot
-- (seats[] rows are [seat, stack, ...]; `toCall` and `actorSeat` beside them).
-- An all-in with no snapshot, or one that raised, is not a call and stays
-- private. Measured on production over 6 hours: 5 mucked river all-ins, all 5
-- calls by this test.
--
-- Everything else is unchanged: reader dealt into the hand, seat ruled mucked
-- at showdown, read-only, signed-in players only, no policy change.
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
  last_river AS (
    -- The holder's last voluntary river action. Forced entries and returned
    -- uncalled bets are not decisions and are skipped.
    SELECT m.hand_id, m.holder,
      (
        SELECT a
        FROM jsonb_array_elements(m.actions) WITH ORDINALITY t(a, ord)
        WHERE a->>'userId' = m.holder
          AND a->>'stage' = 'river'
          AND a->>'action' IN ('check', 'bet', 'call', 'raise', 'all_in', 'fold')
        ORDER BY ord DESC
        LIMIT 1
      ) AS a
    FROM mucked m
    WHERE jsonb_typeof(m.actions) = 'array'
  ),
  called AS (
    -- Rule 3: that action was a call - a plain call, or an all-in that put
    -- in no more than the bet it faced.
    SELECT l.hand_id, l.holder::uuid AS holder
    FROM last_river l
    WHERE l.a->>'action' = 'call'
       OR (
         l.a->>'action' = 'all_in'
         AND EXISTS (
           SELECT 1
           FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(l.a->'publicNode'->'seats') = 'array'
                  THEN l.a->'publicNode'->'seats' ELSE '[]'::jsonb END
           ) s
           WHERE jsonb_typeof(s) = 'array'
             AND (s->>0) = (l.a->'publicNode'->>'actorSeat')
             AND (s->>1) ~ '^[0-9.]+$'
             AND (l.a->'publicNode'->>'toCall') ~ '^[0-9.]+$'
             AND (s->>1)::numeric <= (l.a->'publicNode'->>'toCall')::numeric
         )
       )
  )
  SELECT c.hand_id, c.holder, f.hole_cards
  FROM called c
  JOIN public.ca_hand_facts f ON f.hand_id = c.hand_id AND f.user_id = c.holder
  WHERE jsonb_typeof(f.hole_cards) = 'array'
    AND jsonb_array_length(f.hole_cards) > 0;
$$;

COMMENT ON FUNCTION public.fn_ca_called_river_mucked_cards(uuid[]) IS
  'Dan 2026-10-25: a hand that CALLED a river bet (a call, or an all-in for no more than the bet faced) and was mucked at showdown is shown in Previous Hand to the players dealt into that hand. Checked-down and folded hands stay private. Read-only; ca_hand_facts policies unchanged.';

REVOKE ALL ON FUNCTION public.fn_ca_called_river_mucked_cards(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_called_river_mucked_cards(uuid[]) TO authenticated;

COMMIT;
