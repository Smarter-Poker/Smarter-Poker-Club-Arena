-- ============================================================================
-- 20260820_ca_player_hands_drilldown.sql
--
-- WHY: every number on the stats page was a dead end. A player could read
-- "Biggest Pot Won 275.38" and had no way to reach the hand behind it.
--
-- ca_player_hands(p_user, p_mode, p_limit) returns the hands themselves:
-- board, position, pot, the player's own profit, table size, variant.
--   p_mode: 'recent' | 'biggest_won' | 'biggest_lost'
--
-- SECURITY: SECURITY DEFINER, so it bypasses hand_history RLS. Aggregate stats
-- are club-visible by design, but HOLE CARDS ARE NOT — they are returned only
-- when the caller is asking about themselves (p_user = auth.uid()). Passing
-- another user's id returns the same shape with hole_cards NULL.
--
-- COST: 'recent' fetches only p_limit hands. The 'biggest' modes must score the
-- whole 750-hand analysis window before ranking it — measured 155ms.
--
-- ROLLBACK: DROP FUNCTION IF EXISTS public.ca_player_hands(uuid, text, int);
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ca_player_hands(
  p_user  uuid,
  p_mode  text DEFAULT 'recent',
  p_limit int  DEFAULT 25
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  c_window constant int := 750;   -- same analysis window as ca_player_stats_full
  v_limit  int := LEAST(GREATEST(coalesce(p_limit, 25), 1), 100);
  v_ids    uuid[];
  v_ceil   timestamptz;
  v_self   boolean := (auth.uid() IS NOT NULL AND auth.uid() = p_user);
  v_mode   text := lower(coalesce(p_mode, 'recent'));
BEGIN
  IF v_mode NOT IN ('recent', 'biggest_won', 'biggest_lost') THEN
    v_mode := 'recent';
  END IF;

  -- 'recent' only needs the newest v_limit hands; the 'biggest' modes have to
  -- score the whole window before they can rank it.
  SELECT array_agg(hand_id ORDER BY created_at DESC)
  INTO v_ids
  FROM (SELECT hand_id, created_at FROM ca_hand_player_idx
        WHERE user_id = p_user
        ORDER BY created_at DESC
        LIMIT CASE WHEN v_mode = 'recent' THEN v_limit ELSE c_window END) q;

  -- Hands newer than the index ceiling are not indexed yet.
  SELECT idx_ceil INTO v_ceil FROM ca_hand_player_idx_state WHERE id;
  IF v_ceil IS NOT NULL THEN
    SELECT coalesce(array_agg(id ORDER BY created_at DESC), '{}'::uuid[])
           || coalesce(v_ids, '{}'::uuid[])
    INTO v_ids
    FROM (SELECT h.id, h.created_at FROM hand_history h
          WHERE h.created_at > v_ceil
            AND h.players @> jsonb_build_array(jsonb_build_object('userId', p_user::text))
          ORDER BY h.created_at DESC
          LIMIT CASE WHEN v_mode = 'recent' THEN v_limit ELSE c_window END) q0;
  END IF;

  IF v_ids IS NULL THEN v_ids := '{}'::uuid[]; END IF;

RETURN (
WITH mine AS (
  SELECT h.id, h.created_at, h.tournament_id,
         lower(coalesce(h.game_variant, 'nlh')) AS variant,
         coalesce(h.big_blind, 0)::numeric  AS big_blind,
         coalesce(h.small_blind, 0)::numeric AS small_blind,
         coalesce(h.pot_size, 0)::numeric   AS pot_size,
         h.button_seat, h.community_cards, h.board, h.hole_cards,
         h.players,
         coalesce(h.actions, '[]'::jsonb) AS actions,
         coalesce(h.winners, '[]'::jsonb) AS winners
  FROM hand_history h
  WHERE h.id = ANY(v_ids)
),
scored AS (
  SELECT m.*,
         w.won_amt,
         w.is_winner,
         a.invested,
         (w.won_amt - a.invested - bl.my_blind) AS profit,
         pos.position
  FROM mine m
  CROSS JOIN LATERAL (
    SELECT coalesce(sum((w1->>'amount')::numeric)
             FILTER (WHERE w1->>'userId' = p_user::text), 0) AS won_amt,
           count(*) FILTER (WHERE w1->>'userId' = p_user::text) > 0 AS is_winner
    FROM jsonb_array_elements(m.winners) w1
  ) w
  CROSS JOIN LATERAL (
    SELECT coalesce(sum((act->>'amount')::numeric) FILTER (
             WHERE act->>'userId' = p_user::text
               AND act->>'action' IN ('bet','call','raise','all_in')), 0) AS invested
    FROM jsonb_array_elements(m.actions) act
  ) a
  CROSS JOIN LATERAL (
    SELECT (SELECT (pl->>'seat')::int FROM jsonb_array_elements(m.players) pl
             WHERE pl->>'userId' = p_user::text LIMIT 1) AS my_seat,
           (SELECT array_agg((pl->>'seat')::int ORDER BY (pl->>'seat')::int)
              FROM jsonb_array_elements(m.players) pl) AS seats
  ) s
  CROSS JOIN LATERAL (
    SELECT CASE
             WHEN m.button_seat IS NULL OR s.seats IS NULL OR s.my_seat IS NULL
               OR array_length(s.seats,1) < 2
               OR array_position(s.seats, m.button_seat::int) IS NULL THEN NULL
             ELSE (array_position(s.seats, s.my_seat)
                   - array_position(s.seats, m.button_seat::int)
                   + array_length(s.seats,1)) % array_length(s.seats,1)
           END AS off,
           array_length(s.seats,1) AS n
  ) o
  CROSS JOIN LATERAL (
    SELECT CASE
             WHEN o.off IS NULL THEN 0
             WHEN o.n = 2 THEN CASE WHEN o.off = 0 THEN m.small_blind ELSE m.big_blind END
             WHEN o.off = 1 THEN m.small_blind
             WHEN o.off = 2 THEN m.big_blind
             ELSE 0 END AS my_blind
  ) bl
  CROSS JOIN LATERAL (
    SELECT CASE
             WHEN o.off IS NULL THEN NULL
             WHEN o.n = 2 THEN CASE WHEN o.off = 0 THEN 'BTN' ELSE 'BB' END
             WHEN o.off = 0 THEN 'BTN'
             WHEN o.off = 1 THEN 'SB'
             WHEN o.off = 2 THEN 'BB'
             WHEN o.off = o.n - 1 THEN 'CO'
             WHEN o.off = 3 THEN 'UTG'
             WHEN o.off = 4 AND o.n >= 8 THEN 'UTG+1'
             ELSE 'MP' END AS position
  ) pos
),
ranked AS (
  SELECT * FROM scored
  ORDER BY CASE WHEN v_mode = 'biggest_won'  THEN profit END DESC NULLS LAST,
           CASE WHEN v_mode = 'biggest_lost' THEN profit END ASC  NULLS LAST,
           CASE WHEN v_mode = 'recent'       THEN created_at END DESC NULLS LAST
  LIMIT v_limit
)
SELECT coalesce(jsonb_agg(jsonb_build_object(
  'id', id,
  'played_at', created_at,
  'variant', variant,
  'big_blind', big_blind,
  'is_tournament', (tournament_id IS NOT NULL),
  'position', position,
  'pot_size', round(pot_size, 2),
  'won', round(won_amt, 2),
  'profit', round(profit, 2),
  'is_winner', is_winner,
  'players', (SELECT count(*) FROM jsonb_array_elements(players)),
  'board', coalesce(board, to_jsonb(community_cards)),
  -- Own cards only. Never expose another player's hole cards.
  'hole_cards', CASE WHEN v_self THEN hole_cards -> p_user::text ELSE NULL END
) ORDER BY CASE WHEN v_mode = 'biggest_won'  THEN profit END DESC NULLS LAST,
           CASE WHEN v_mode = 'biggest_lost' THEN profit END ASC  NULLS LAST,
           CASE WHEN v_mode = 'recent'       THEN created_at END DESC NULLS LAST),
  '[]'::jsonb)
FROM ranked
);
END;
$fn$;

REVOKE ALL ON FUNCTION public.ca_player_hands(uuid, text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ca_player_hands(uuid, text, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.ca_player_hands(uuid, text, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ca_player_hands(uuid, text, int) TO service_role;
