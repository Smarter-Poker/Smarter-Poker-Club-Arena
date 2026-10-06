-- 20261006062341_a_player_can_read_what_they_bought_in_for.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (launch audit 2026-10-05, session result):
--
-- The Session Summary a player sees on leaving a cash table, and the "Session
-- Complete ... P/L" notice saved with it, subtract "total bought in" from the
-- chips returned. The page kept that total in memory only and, after any
-- reload or remount, re-seeded it with THE STACK AT THAT MOMENT. A player who
-- was down 300 and whose phone slept was shown roughly break-even.
--
-- The platform already keeps the true figure: cash_player_session.baseline is
-- opened with the buy-in (fn_cash_session_open) and raised by every add-on and
-- rebuy that lands (fn_cash_session_add_baseline), for exactly as long as the
-- seat is held. No browser role may read that table. This gives the player
-- the one number that is theirs: their own baseline at one table, bound to
-- auth.uid(), nothing about anyone else.
--
-- Read-only. One function, one transaction.
--
-- @live-proof: has_function_privilege('authenticated', 'public.fn_my_cash_session_baseline(uuid)', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.fn_my_cash_session_baseline(uuid)', 'EXECUTE')

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
  SELECT s.baseline
    FROM public.cash_player_session s
   WHERE s.player_id = auth.uid()
     AND s.scope_type = 'table'
     AND s.scope_id = p_table_id
     AND s.closed_at IS NULL
   ORDER BY s.opened_at DESC
   LIMIT 1;
$function$;

REVOKE ALL ON FUNCTION public.fn_my_cash_session_baseline(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_my_cash_session_baseline(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_my_cash_session_baseline(uuid) IS
  'The caller''s own total bought in (buy-in plus landed add-ons and rebuys) for their open cash session at one table. Bound to auth.uid(); read-only.';

COMMIT;
