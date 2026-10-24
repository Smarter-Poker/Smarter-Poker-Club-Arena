-- @live-proof: (SELECT position('LIGHTNING NAMES ITS CHAIR' IN pg_get_functiondef('public.fn_cash_game_join(uuid)'::regprocedure))>0)
-- 20261024150545_a_lightning_join_names_the_chair_it_holds_and_refuses_when_j.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan 2026-10-24: "WHEN YOU CLICK 'JOIN LIGHTNING' AND CONFIRM YOUR BUY IN
-- AMOUNT, YOU ARE 'AUTO ASSIGNED' TO A TABLE AND SEAT, YOU DON'T PICK YOUR
-- SEAT ... CURRENTLY WHEN YOU CLICK 'JOIN LIGHTNING' NOTHING HAPPENS, IT JUST
-- SILENTLY FAILS."
--
-- Read from production: Dan's session called fn_cash_game_join three times
-- (all 200) and atomic_table_buyin never. The join held a chair on a table but
-- named no seat, and a running physical table of a Lightning game paints a
-- pool room's hand (LightningObserverProjection), so every seat on the felt
-- looks taken whatever is free underneath. The client had no chair to open a
-- buy-in on, and the tap was dropped.
--
-- Two changes to the join door, applied on top of 20261024073506 (LIGHTNING
-- NEVER QUEUES), which must be installed first:
--
-- 1. LIGHTNING NAMES ITS CHAIR. Every 'seat' answer for a Lightning game now
--    carries seat_number: the lowest physically free chair on the held table
--    (no live table_seats row), stepping past one chair for every earlier live
--    hold of another player on that table, so two holders are not told the
--    same number. The chair is computed inline in the join's answer, so this
--    migration declares no new object. Classic and must-move answers carry seat_number NULL,
--    and the client keeps the chair the player tapped, exactly as before.
--    The buy-in door (atomic_table_buyin) is still the authority on the seat.
--
-- 2. A STOPPED LIGHTNING GAME SAYS SO. An operator can stop Lightning joins
--    (ruleset_snapshot.lightning.lightning_joins_enabled = false). The join
--    used to hold a chair (and, since 073506, open a table) anyway, and the
--    pool door then refused the buy-in into the pool. It now refuses up front
--    with LIGHTNING_JOINS_DISABLED, before any hold is written. A player
--    already seated is still told where they sit.
--
-- No sweep, no backfill (CLAUDE.md 10.11/10.12): the answer of the live door
-- changes. Horses and humans use the same door (10.5).
--
-- Applied as md5-guarded text replacements of the live definition, so a
-- drifted source aborts instead of overwriting someone else's change.

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';

DO $source$
DECLARE s text; n text;
  -- The chair a Lightning join hands its caller on table %T: the lowest
  -- physically free chair, stepping past one for each other player's earlier
  -- live hold on that table.
  chair CONSTANT text := $c$(SELECT lj_f.lj_n FROM (SELECT lj_n, row_number() OVER (ORDER BY lj_n) AS lj_rn
                FROM public.tables lj_tb, generate_series(1, lj_tb.max_players) AS lj_n
               WHERE lj_tb.id = %T
                 AND NOT EXISTS (SELECT 1 FROM public.table_seats lj_ts
                                  WHERE lj_ts.table_id = %T AND lj_ts.left_at IS NULL
                                    AND lj_ts.seat_number = lj_n)) lj_f
       WHERE lj_f.lj_rn = 1 + (SELECT count(*) FROM public.table_waitlist lj_w
                              WHERE lj_w.table_id = %T AND lj_w.user_id <> v_uid
                                AND lj_w.status = 'notified' AND lj_w.hold_expires_at > now()
                                AND lj_w.notified_at < coalesce((SELECT max(lj_x.notified_at)
                                      FROM public.table_waitlist lj_x
                                     WHERE lj_x.table_id = %T AND lj_x.user_id = v_uid
                                       AND lj_x.status = 'notified'), now())))$c$;
  a_refuse  CONSTANT text := $a$  IF EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=g.club_id AND c.asset='diamonds')
     AND g.cluster_mode IS DISTINCT FROM 'must_move' THEN$a$;
  a_refresh CONSTANT text := $a$                              'open_seats', public.fn_cash_game_open_seats(h.table_id) + 1,
                              'hold_expires_at', v_hold_until);$a$;
  a_loop    CONSTANT text := $a$                              'open_seats', public.fn_cash_game_open_seats(t.id) + 1,
                              'hold_expires_at', v_hold_until);$a$;
  a_opened  CONSTANT text := $a$'hold_expires_at', v_hold_until, 'table_opened', true);$a$;
BEGIN
  s := pg_get_functiondef('public.fn_cash_game_join(uuid)'::regprocedure);
  IF md5(s) <> '2ab096598d5d2240d546a08dd96094ea' THEN
    RAISE EXCEPTION 'Cash join source is not the 20261024073506 definition; install that first, or requalify';
  END IF;
  IF (length(s) - length(replace(s, a_refuse, ''))) / length(a_refuse) <> 1
     OR (length(s) - length(replace(s, a_refresh, ''))) / length(a_refresh) <> 1
     OR (length(s) - length(replace(s, a_loop, ''))) / length(a_loop) <> 1
     OR (length(s) - length(replace(s, a_opened, ''))) / length(a_opened) <> 1 THEN
    RAISE EXCEPTION 'Cash join anchors are not each unique; requalify the Lightning chair change';
  END IF;

  n := replace(s, a_refuse, $r$  -- A STOPPED LIGHTNING GAME SAYS SO (2026-10-24): no hold, no new table,
  -- for a player not already seated (answered above).
  IF g.cluster_mode = 'lightning' AND NOT public.fn_lightning_joins_enabled(g.id) THEN
    RAISE EXCEPTION 'LIGHTNING_JOINS_DISABLED: Lightning is not taking new players right now'
      USING ERRCODE = 'check_violation';
  END IF;
  -- LIGHTNING NAMES ITS CHAIR (2026-10-24): every Lightning 'seat' answer
  -- below carries seat_number, the lowest free chair on the held table.

$r$ || a_refuse);
  -- LIGHTNING NAMES ITS CHAIR (2026-10-24): every Lightning 'seat' answer
  -- carries the chair it holds; other modes carry NULL.
  n := replace(n, a_refresh, $r$                              'open_seats', public.fn_cash_game_open_seats(h.table_id) + 1,
                              'hold_expires_at', v_hold_until,
                              'seat_number', CASE WHEN g.cluster_mode = 'lightning'
                                THEN $r$ || replace(chair, '%T', 'h.table_id') || $r$ END);$r$);
  n := replace(n, a_loop, $r$                              'open_seats', public.fn_cash_game_open_seats(t.id) + 1,
                              'hold_expires_at', v_hold_until,
                              'seat_number', CASE WHEN g.cluster_mode = 'lightning'
                                THEN $r$ || replace(chair, '%T', 't.id') || $r$ END);$r$);
  n := replace(n, a_opened, $r$'hold_expires_at', v_hold_until, 'table_opened', true,
                              'seat_number', $r$ || replace(chair, '%T', 't.id') || $r$);$r$);

  IF n = s OR position('LIGHTNING NAMES ITS CHAIR' IN n) = 0
     OR position('LIGHTNING_JOINS_DISABLED' IN n) = 0 THEN
    RAISE EXCEPTION 'Cash join replacement did not apply; requalify the Lightning chair change';
  END IF;
  EXECUTE n;
END $source$;

COMMIT;
