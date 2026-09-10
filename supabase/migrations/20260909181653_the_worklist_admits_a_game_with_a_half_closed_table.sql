-- 20260909181653_the_worklist_admits_a_game_with_a_half_closed_table
--
-- Version reserved by scripts/reserve-migration-version.sh (CLAUDE.md 4.5).
--
-- ═══════════════════════════════════════════════════════════════════════════
--  THE REPAIR AND THE CONDITION IT REPAIRS WERE MUTUALLY EXCLUSIVE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `tables` carries two liveness fields, `status` and `lifecycle`, and they can
-- disagree. `fn_cash_cluster_tick` repairs BOTH directions - it has since
-- 2026-09-05 one way and 2026-09-09 the other (`lifecycle_followed_status` and
-- `status_followed_lifecycle`). Both repairs live INSIDE the tick.
--
-- `fn_cash_clusters_to_tick` decides which games get a tick. A DISABLED game
-- is admitted only when it still has a table worth ticking:
--
--     AND (g.enabled OR EXISTS (SELECT 1 FROM public.tables t
--                                WHERE t.cluster_id = g.id
--                                  AND t.lifecycle <> 'closed'
--                                  AND coalesce(t.is_deleted, false) = false))
--
-- That test reads ONE of the two fields. A disabled game whose only table is
-- `lifecycle = 'closed'` with `status = 'waiting'` fails it, is never admitted,
-- and so the `status_followed_lifecycle` repair written for exactly that shape
-- can never run on it. The repair is inside the thing the condition excludes.
--
-- This is the same trap `20260906011113_the_worklist_reaches_the_game_the_repair_
-- was_written_for` fixed in the other direction: that time the worklist also
-- required `status IN ('waiting','running','active')` and a table stranded at
-- `lifecycle='live' / status='closed'` was excluded from the repair for its own
-- condition. The status half of the test was removed and the lifecycle half was
-- left, which fixed that shape and created this one.
--
-- MEASURED on production 2026-09-09 18:0x UTC:
--
--   name                | status  | lifecycle | enabled | state   | last_tick_at
--   FLO8 0.50/1 Madness | waiting | closed    | f       | dormant | (null)
--   FLO8 0.50/1 Action  | waiting | closed    | f       | dormant | (null)
--
-- `last_tick_at IS NULL`: neither game has been ticked once in its life.
--
-- WHY IT REACHES A PLAYER. Every status-based read - the lobby, the club home
-- card, `cash_tables_needing_engine` - treats a `waiting` table as joinable,
-- while `fn_refuse_seat_on_closed_cluster_table` refuses the seat with
-- `TABLE_CLOSING` because the lifecycle is closed. The board offers a game that
-- cannot be sat at, and nothing on the platform can correct it, for ever.
--
-- THE FIX. The worklist asks whether a table is non-terminal by EITHER field,
-- which is the same question both repairs answer. One tick then makes the two
-- fields agree, and the game correctly drops out of the worklist on the next
-- pass - so this admits strictly more games exactly once each, not for ever.
--
-- WHY NOT "just close the two rows". That is the band-aid CLAUDE.md 10.12
-- forbids: it fixes today's two rows and leaves the next one to be found by
-- hand. The tick already knows how to close them; it was simply never asked.
--
-- ROLLBACK
--   Restore the WHERE clause to its single `t.lifecycle <> 'closed'` test.
--
-- CREATE OR REPLACE preserves the function's existing privileges, so the
-- service_role-only grant is unchanged; the assertion at the end proves it.
--
-- ONE transaction (production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_cash_clusters_to_tick()
 RETURNS TABLE(game_id uuid, club_id uuid, main1_table_id uuid, state text, enabled boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT g.id, g.club_id,
         (SELECT t.id FROM public.tables t WHERE t.cluster_id = g.id AND t.role = 'main' AND t.main_index = 1
            AND t.lifecycle <> 'closed' AND coalesce(t.is_deleted, false) = false ORDER BY t.created_at LIMIT 1),
         g.state, g.enabled
    FROM public.cash_games g
   WHERE g.must_move
     -- A DISABLED GAME IS ADMITTED ON EITHER LIVENESS FIELD (2026-09-09).
     -- This used to require status IN ('waiting','running','active') as well,
     -- and 20260906011113 removed the status half because a table stranded at
     -- lifecycle='live' / status='closed' was excluded from the repair written
     -- for it. The MIRROR of that stranding - lifecycle='closed' with
     -- status='waiting' - then fell into the same hole against the half that
     -- was left, and `status_followed_lifecycle` (which lives inside the tick)
     -- could never reach it. Two FLO8 0.50/1 games sat that way with
     -- last_tick_at NULL: never ticked once.
     -- So the question is asked of BOTH fields: any table that is non-terminal
     -- by either one is a table the tick has something to say about. One tick
     -- makes them agree and the game leaves this list again.
     AND (g.enabled OR EXISTS (SELECT 1 FROM public.tables t
                                WHERE t.cluster_id = g.id
                                  AND coalesce(t.is_deleted, false) = false
                                  AND (t.lifecycle <> 'closed'
                                       OR lower(coalesce(t.status, '')) NOT IN
                                            ('closed', 'completed', 'cancelled', 'finished'))))
   ORDER BY g.created_at;
$function$;

DO $assert$
DECLARE
  v_def text;
  v_stranded integer;
  v_admitted integer;
BEGIN
  v_def := pg_get_functiondef('public.fn_cash_clusters_to_tick'::regproc);
  IF position('NOT IN' in v_def) = 0 THEN
    RAISE EXCEPTION 'the worklist did not take the either-field test';
  END IF;

  -- Every game whose only tables are half-closed must now be on the worklist.
  SELECT count(DISTINCT t.cluster_id) INTO v_stranded
    FROM public.tables t
    JOIN public.cash_games g ON g.id = t.cluster_id
   WHERE g.must_move AND coalesce(t.is_deleted, false) = false
     AND t.lifecycle = 'closed'
     AND lower(coalesce(t.status, '')) NOT IN ('closed', 'completed', 'cancelled', 'finished');

  SELECT count(*) INTO v_admitted
    FROM public.fn_cash_clusters_to_tick() l
   WHERE l.game_id IN (
     SELECT t.cluster_id FROM public.tables t JOIN public.cash_games g ON g.id = t.cluster_id
      WHERE g.must_move AND coalesce(t.is_deleted, false) = false
        AND t.lifecycle = 'closed'
        AND lower(coalesce(t.status, '')) NOT IN ('closed', 'completed', 'cancelled', 'finished'));

  IF v_admitted < v_stranded THEN
    RAISE EXCEPTION 'a game with a half-closed table is still outside the worklist (% stranded, % admitted)',
      v_stranded, v_admitted;
  END IF;
  RAISE NOTICE 'worklist admits % of % games holding a half-closed table', v_admitted, v_stranded;

  IF NOT has_function_privilege('service_role', 'public.fn_cash_clusters_to_tick()', 'EXECUTE') THEN
    RAISE EXCEPTION 'the replace dropped the service_role grant';
  END IF;
END;
$assert$;

COMMIT;
