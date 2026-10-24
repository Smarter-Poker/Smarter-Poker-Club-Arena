-- @live-proof: (SELECT position('LIGHTNING NEVER QUEUES' IN pg_get_functiondef('public.fn_cash_game_join(uuid)'::regprocedure))>0)
-- 20261024073506_lightning_join_opens_a_table_instead_of_queueing.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan 2026-10-24: "THERE SHOULDN'T BE A WAITING LIST WHEN THERE ARE ALWAYS
-- OPEN SEATS. REMOVE THE ABILITY TO EVEN JOIN A WAITING LIST IN A LIGHTNING
-- GAME, PLAYER BUYS IN AND GETS DEALT INTO A NEW TABLE ASAP, NO WAITING".
--
-- Read from production at 07:40 UTC: 17 Lightning games, and in 13 of them
-- every physical table was 6/6 with fn_cash_game_open_seats = 0. JOIN
-- LIGHTNING calls fn_cash_game_join, which looks for an open chair, finds
-- none, and writes a cash_game_waitlist row ('waitlisted'). Nothing ever
-- answers that row for a Lightning game: fn_cash_cluster_tick stands down for
-- cluster_mode = 'lightning' (it is the only caller that opens a feeder), and
-- fn_cash_cluster_lightning_drive only moves the mode. So a Lightning player
-- waited for a horse to leave. Players were queued this way tonight (PLO5
-- 1.00/2.00 six times, PLO4 1.00/2.00 three times, PLO5 0.50/1.00 twice).
--
-- The fix is in the door itself, not a sweep (CLAUDE.md 10.11/10.12): when a
-- Lightning game has no unreserved chair anywhere, the join opens one more
-- live table for the game through the existing fn_cash_cluster_open_table
-- (same ruleset snapshot as every other table of the game) and holds a chair
-- on it exactly as the existing seat branch does: same advisory lock, same
-- 60-second hold row, same one-hold-per-player-per-game rule, same answer
-- shape ('seat'). The player's buy-in then goes through the normal buy-in
-- door and the normal anchor handoff into the pool.
--
-- Bounded by construction: the cash_games row is held FOR NO KEY UPDATE for
-- the whole join, so concurrent joins of one game serialize, and a table is
-- opened only when every open table of the game has zero unreserved chairs.
-- The next joiner sees the new table's free chairs and is seated there. The
-- auth, private-membership, VPIP bar, Diamond and wallet-coverage checks all
-- run before this point, unchanged. Classic and must-move games keep their
-- waiting list exactly as before. Horses use the same door and are treated
-- the same (CLAUDE.md 10.5).
--
-- Applied as one md5-guarded text replacement of the live definition (the
-- house pattern from 20261023230807), so a drifted source aborts instead of
-- overwriting someone else's change.

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';

DO $source$
DECLARE s text; n text;
BEGIN
  s := pg_get_functiondef('public.fn_cash_game_join(uuid)'::regprocedure);
  IF md5(s) <> 'e8292ca4aac342132ffe8c0d903ebb06' THEN
    RAISE EXCEPTION 'Cash join source changed; requalify the Lightning no-queue branch';
  END IF;

  n := replace(s,
    '  -- A LAPSED GAME OFFER IS NOT A PLACE IN LINE (2026-10-23).',
    $branch$  -- LIGHTNING NEVER QUEUES (Dan 2026-10-24: "PLAYER BUYS IN AND GETS DEALT
  -- INTO A NEW TABLE ASAP, NO WAITING"). No chair is open anywhere in this
  -- Lightning game, so the game gets one more live table and the caller holds
  -- a chair on it, exactly as the seat branch above holds one. The game row is
  -- held for the whole join, so two joiners cannot both open a table: the
  -- second sees this table's free chairs in the loop above.
  IF g.cluster_mode = 'lightning' THEN
    v_probe_table := public.fn_cash_cluster_open_table(g.id, 'feeder', NULL, 'live', NULL);
    PERFORM pg_advisory_xact_lock(hashtextextended('table_seat:' || v_probe_table::text, 0));
    v_hold_until := now() + v_hold_ttl;
    UPDATE public.table_waitlist w SET status = 'expired'
      FROM public.tables tb
     WHERE tb.id = w.table_id AND tb.cluster_id = g.id AND w.table_id <> v_probe_table
       AND w.user_id = v_uid AND w.status = 'notified';
    INSERT INTO public.table_waitlist (table_id, user_id, position, status, notified_at, hold_expires_at)
    VALUES (v_probe_table, v_uid, 0, 'notified', now(), v_hold_until);
    UPDATE public.cash_game_waitlist SET status = 'notified', updated_at = now()
     WHERE game_id = g.id AND user_id = v_uid AND status IN ('waiting', 'notified');
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
    VALUES (g.id, v_probe_table, 'lightning_table_opened_for_join', jsonb_build_object('player_id', v_uid));
    SELECT tb.id, tb.name, tb.role, tb.main_index INTO t FROM public.tables tb WHERE tb.id = v_probe_table;
    RETURN jsonb_build_object('ok', true, 'action', 'seat', 'table_id', t.id, 'table_name', t.name,
                              'role', t.role, 'main_index', t.main_index,
                              'open_seats', public.fn_cash_game_open_seats(t.id) + 1,
                              'hold_expires_at', v_hold_until, 'table_opened', true);
  END IF;

  -- A LAPSED GAME OFFER IS NOT A PLACE IN LINE (2026-10-23).$branch$);

  IF n = s OR position('LIGHTNING NEVER QUEUES' IN n) = 0 THEN
    RAISE EXCEPTION 'Cash join waitlist anchor changed; requalify the Lightning no-queue branch';
  END IF;
  EXECUTE n;
END $source$;

COMMIT;
