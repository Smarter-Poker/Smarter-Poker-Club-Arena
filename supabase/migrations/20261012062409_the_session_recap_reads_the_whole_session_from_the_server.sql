-- 20261012062409_the_session_recap_reads_the_whole_session_from_the_server.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (Dan 2026-10-12, Diamond Arena NLH 10/20):
--
--   "THE END OF SESSION RECAP WAS NOT ACCURATE, I 100% LOST, AND ITS SAYING I
--    WON. SMH BUY IN IS OFF, AMOUNT OF HANDS PLAYED, EVERYTHING IS 100% WRONG."
--
-- Read from the rows: he reserved 4,000 Diamonds at 05:47 UTC, played 20
-- hands, and left at 06:20 with 1,376 released: -2,624 over 33 minutes. The
-- card said +400, buy-in 976, 5 hands, 3 minutes.
--
-- The card is built in the browser from counters that start when the table
-- page mounts. After a reload or reconnect the page asks the server what was
-- bought in (fn_my_cash_session_baseline, 20261006062341) and otherwise
-- seeds the buy-in with the stack at that moment. That function reads only
-- cash_player_session, which a Diamond seat never opens, so at a Diamond table
-- it answered NULL and the stack at the reload (976) became the "buy in".
-- Duration and hands were counted from the reload too, on both arenas.
--
-- 1. fn_my_cash_session_baseline answers for a Diamond seat as well: the sum
--    of the 'reserve' movements (buy-in and every top-up) on the caller's
--    open cash_seat custody at that table. Same signature, same grant.
-- 2. fn_my_table_session_facts gives the rest of the card the server's view
--    of the same open session: when it started, how many hands the caller was
--    dealt into since then, how many of those they finished ahead (the next
--    hand's starting stack is higher), and the highest stack they started a
--    hand with. Bound to auth.uid(), read-only, chips or Diamonds.
--
-- Read-only. Two functions, one transaction.
--
-- @live-proof: has_function_privilege('authenticated', 'public.fn_my_table_session_facts(uuid)', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.fn_my_table_session_facts(uuid)', 'EXECUTE')

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.fn_my_cash_session_baseline(p_table_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- What the caller has bought in for at this table in the session that is
  -- open now: the buy-in plus every add-on and rebuy that landed. NULL when
  -- the caller has no open cash session there.
  --
  -- Chips: the open cash_player_session's baseline.
  -- Diamonds (2026-10-12): every 'reserve' movement (buy-in and top-ups) on
  -- the caller's active cash_seat custody at this table.
  SELECT COALESCE(
    (SELECT s.baseline
       FROM public.cash_player_session s
      WHERE s.player_id = auth.uid()
        AND s.scope_type = 'table'
        AND s.scope_id = p_table_id
        AND s.closed_at IS NULL
      ORDER BY s.opened_at DESC
      LIMIT 1),
    (SELECT SUM(m.amount)::numeric
       FROM public.poker_diamond_custody c
       JOIN public.poker_diamond_movements m ON m.custody_id = c.id AND m.action = 'reserve'
      WHERE c.id = (SELECT c2.id
                      FROM public.poker_diamond_custody c2
                     WHERE c2.user_id = auth.uid()
                       AND c2.purpose = 'cash_seat'
                       AND c2.target_id = p_table_id
                       AND c2.state = 'active'
                     ORDER BY c2.created_at DESC
                     LIMIT 1))
  );
$function$;

REVOKE ALL ON FUNCTION public.fn_my_cash_session_baseline(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_my_cash_session_baseline(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_my_cash_session_baseline(uuid) IS
  'The caller''s own total bought in (buy-in plus landed add-ons, rebuys and Diamond top-ups) for their open cash session at one table, chips or Diamonds. Bound to auth.uid(); read-only.';

CREATE OR REPLACE FUNCTION public.fn_my_table_session_facts(p_table_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- The caller's open session at one cash table, as the server recorded it:
  -- when it began, the hands they were dealt into since, the hands they won,
  -- and the largest stack they took into a hand. NULL when no session is open.
  WITH opened AS (
    SELECT COALESCE(
      (SELECT s.opened_at
         FROM public.cash_player_session s
        WHERE s.player_id = auth.uid()
          AND s.scope_type = 'table'
          AND s.scope_id = p_table_id
          AND s.closed_at IS NULL
        ORDER BY s.opened_at DESC
        LIMIT 1),
      (SELECT c.created_at
         FROM public.poker_diamond_custody c
        WHERE c.user_id = auth.uid()
          AND c.purpose = 'cash_seat'
          AND c.target_id = p_table_id
          AND c.state = 'active'
        ORDER BY c.created_at DESC
        LIMIT 1)
    ) AS started_at
  ),
  mine AS (
    -- One row per hand the caller was dealt into since the session opened,
    -- with the stack they started it with (hand_history.players records the
    -- start-of-hand stack).
    SELECT h.created_at,
           h.hand_number,
           (SELECT (p->>'stack')::numeric
              FROM jsonb_array_elements(h.players) p
             WHERE p->>'userId' = auth.uid()::text
               AND (p->>'stack') ~ '^[0-9]+(\.[0-9]+)?$'
             LIMIT 1) AS start_stack
      FROM public.hand_history h, opened o
     WHERE o.started_at IS NOT NULL
       AND h.table_id = p_table_id
       AND h.created_at >= o.started_at
       AND h.players @> jsonb_build_array(jsonb_build_object('userId', auth.uid()::text))
  ),
  stepped AS (
    -- A hand is WON when the caller started the next hand with more than they
    -- started this one with. The pot "winners" list is not used: it also
    -- names a player handed back an uncalled bet in a hand they lost.
    SELECT start_stack,
           lead(start_stack) OVER (ORDER BY created_at, hand_number) AS next_stack
      FROM mine
  )
  SELECT CASE WHEN o.started_at IS NULL THEN NULL ELSE jsonb_build_object(
    'started_at', o.started_at,
    'hands_played', (SELECT count(*) FROM mine),
    'hands_won', (SELECT count(*) FROM stepped WHERE next_stack > start_stack),
    'peak_stack', (SELECT max(start_stack) FROM mine)
  ) END
  FROM opened o;
$function$;

REVOKE ALL ON FUNCTION public.fn_my_table_session_facts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_my_table_session_facts(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_my_table_session_facts(uuid) IS
  'The caller''s own open cash session at one table (chips or Diamonds): started_at, hands_played, hands_won, peak_stack, from hand_history since the session opened. Bound to auth.uid(); read-only.';

COMMIT;
