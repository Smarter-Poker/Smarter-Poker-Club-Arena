-- 20261023124157_a_seated_players_stranded_game_offer_reads_seated.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- 20261023094000 expired the stranded 'notified' game rows whose player sits
-- nowhere in the game, and taught fn_offer_open_seat to mark a notified row
-- 'seated' once its player sits at the game. A row whose player had already
-- sat down again before that install keeps reading 'notified' until the next
-- vacancy offer in that game, and a full Lightning game can go hours without
-- one (row 6955c265, game 56d5d6f0, read 2026-10-23 12:40 UTC: its player is
-- seated at the game, every chair is taken, no offer since). Meanwhile the
-- game's waitlist count and population count her as waiting.
--
-- This applies the same rule once, as data only: a 'notified' game row whose
-- player is seated at one of that game's tables (left_at IS NULL, table not
-- closed: the rule fn_cash_game_join and fn_cash_cluster_tick already use)
-- becomes 'seated'. Bounded, idempotent, and a locked row is left for the
-- offer pass. No function, grant or money path changes.
--
-- @live-proof: NOT EXISTS (SELECT 1 FROM public.cash_game_waitlist w WHERE w.id = '6955c265-9270-485e-8bc4-a23bafc3d2cf' AND w.status = 'notified' AND w.updated_at < '2026-10-23 12:00:00+00')

BEGIN;

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DO $sweep$
DECLARE v_seated integer;
BEGIN
  WITH seated AS (
    SELECT w.id FROM public.cash_game_waitlist w
     WHERE w.status = 'notified'
       AND EXISTS (SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id = s.table_id
                    WHERE s.user_id = w.user_id AND s.left_at IS NULL
                      AND t.cluster_id = w.game_id AND t.lifecycle <> 'closed')
     ORDER BY w.updated_at
     LIMIT 5000
       FOR UPDATE OF w SKIP LOCKED
  ), marked AS (
    UPDATE public.cash_game_waitlist w SET status = 'seated', updated_at = now()
      FROM seated WHERE w.id = seated.id AND w.status = 'notified'
    RETURNING w.id
  )
  SELECT count(*) INTO v_seated FROM marked;
  RAISE NOTICE 'seated_game_offers_marked=%', v_seated;
END $sweep$;

COMMIT;
