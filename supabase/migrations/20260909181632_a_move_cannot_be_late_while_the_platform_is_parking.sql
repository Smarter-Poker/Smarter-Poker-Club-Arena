-- 20260909181632_a_move_cannot_be_late_while_the_platform_is_parking
--
-- Version reserved by scripts/reserve-migration-version.sh against this tree,
-- origin/main and every sibling worktree (CLAUDE.md 4.5).
--
-- ═══════════════════════════════════════════════════════════════════════════
--  A MOVE'S DEADLINE MUST NOT RUN WHILE THE PLATFORM IS PARKING
-- ═══════════════════════════════════════════════════════════════════════════
--
-- CLAUDE.md 13 rule 4: "Deadlines are thawed, not burned. If you add a
-- wall-clock deadline a player can lose to, add it to fn_thaw_platform in the
-- same PR, or a five-minute break silently eats it."
--
-- `cash_seat_moves.expires_at` IS in fn_thaw_platform (step
-- `cluster_move_expires_at`). It is still eaten, because the freeze the tick
-- observes and the freeze the executor observes are not the same freeze:
--
--   fn_cash_cluster_tick   gates on fn_platform_frozen()
--                          -> true only for phase='counting_down' (:55 to :00)
--   fn_cash_seat_move_execute
--                          gates on fn_entry_purchases_frozen()
--                                OR fn_platform_frozen()
--                          -> ALSO true for phase='last_hand' (from :53) and
--                             for the whole post-thaw release boundary
--
-- So between :53 and :55 the tick is awake and the executor is not. The tick
-- keeps planning moves and keeps EXPIRING them, while every execution attempt
-- in that window returns `platform_frozen` by construction. The row it writes
-- then says:
--
--     note = 'engine_did_not_execute_before_expiry'
--
-- which names the engine for a refusal the platform made. That is CLAUDE.md
-- 10.86 rule 1 - "I could not tell" folded into a confident answer that is
-- wrong - and it is the reason the expiry taxonomy added on 2026-09-07 reads
-- as an engine fault 98% of the time.
--
-- MEASURED on production, 48 hours of `state='expired'` rows bucketed by the
-- minute of expires_at:
--
--     :50-:54   42        <- the announce-and-park window
--     :55-:59   60        <- the freeze itself
--     every other 5-minute bucket   9 to 27
--
-- 102 of 269 expiries, 38%, in 2 of the 12 buckets. One game at 05:51-05:52 UTC
-- on 2026-09-09 lost seventeen moves in ninety seconds and its players waited
-- until 06:01:53 - about ten minutes - for the controller to plan replacements.
--
-- WHY THE THAW DOES NOT ALREADY COVER IT. fn_thaw_platform shifts
--     WHERE state = 'pending' AND expires_at > p_freeze_started
-- and p_freeze_started is break_started_at, i.e. :55:00. A move the tick has
-- already expired is not `pending` any more, and a move whose deadline fell
-- between :53 and :55 is not `> p_freeze_started`. Neither is reachable by the
-- thaw. The hole is upstream of it.
--
-- THE FIX, at the root (CLAUDE.md 10.11 / 10.12 - not a detector, not a repair
-- job, not a sweep). While entry purchases are frozen the tick does not expire
-- a pending move at all: it holds the deadline forward, to the three minutes
-- that fn_cash_seat_move_window guarantees as its floor, and emits
-- `moves_held_for_maintenance` into last_tick_actions so the hold is visible
-- rather than silent. GREATEST() means a longer window (the function scales to
-- 15 minutes with hand pace) is never shortened. The expiry branch below it is
-- byte-identical to what shipped on 2026-09-07.
--
-- The tick still never runs during the freeze proper - fn_platform_frozen() is
-- checked at the top and returns before this - so the held window only ever
-- opens in the :53-to-:55 announce phase and in the post-thaw release
-- boundary, which are exactly the two windows the executor is refused in.
--
-- HOW THIS EDITS THE FUNCTION. The body is 35KB and owns the whole cluster
-- lifecycle. This reads the LIVE definition, does one literal replacement
-- anchored on the complete expiry statement plus its GET DIAGNOSTICS pair (so
-- the edit cannot split an UPDATE from the diagnostics that read it - the
-- mistake 20260909035726 records making), and refuses to proceed if the anchor
-- is absent or if any landmark of the tick goes missing from the result.
--
-- ROLLBACK
--   Replace the IF public.fn_entry_purchases_frozen() ... ELSE ... END IF;
--   wrapper with the single UPDATE it encloses, keeping the ELSE branch's body
--   and its GET DIAGNOSTICS / moves_expired pair exactly as they are.
--
-- Wrap ALL DDL for one change in ONE transaction (CLAUDE.md, production DDL
-- policy).

BEGIN;

DO $migration$
DECLARE
  v_src text;
  v_new text;
  v_anchor CONSTANT text := $old$  UPDATE public.cash_seat_moves m SET state = 'expired',
         note = CASE
                  WHEN NOT EXISTS (SELECT 1 FROM public.table_seats ts
                                    WHERE ts.table_id = m.from_table_id
                                      AND ts.user_id = m.player_id AND ts.left_at IS NULL)
                    THEN 'player_left_before_boundary'
                  WHEN EXISTS (SELECT 1 FROM public.table_seats ts
                                WHERE ts.table_id = m.from_table_id
                                  AND ts.user_id = m.player_id AND ts.left_at IS NULL
                                  AND coalesce(ts.stack, 0) = 0)
                    THEN 'player_busted_before_boundary'
                  ELSE 'engine_did_not_execute_before_expiry'
                END
   WHERE m.game_id = g.id AND m.state = 'pending' AND m.expires_at <= v_now;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN v_actions := v_actions || jsonb_build_object('moves_expired', v_n); END IF;$old$;
  v_repl CONSTANT text := $new$  -- A DEADLINE DOES NOT RUN WHILE THE PLATFORM IS PARKING (2026-09-09).
  -- fn_platform_frozen() (checked at the top of this function) is the :55-:00
  -- freeze. fn_entry_purchases_frozen() is WIDER: it is also true from :53,
  -- when the break is announced and the last hand is called, and through the
  -- post-thaw release boundary. fn_cash_seat_move_execute refuses on the wider
  -- one. So in that window the tick is awake and the executor cannot act, and
  -- expiring a move there blames the engine for a refusal the platform made
  -- (CLAUDE.md 10.86 rule 1). Measured: 38% of all expiries fell in the two
  -- five-minute buckets either side of :55.
  --
  -- So the deadline is held instead, forward to the three minutes
  -- fn_cash_seat_move_window guarantees as its floor. GREATEST never shortens
  -- a longer window. fn_thaw_platform then shifts what is still pending at
  -- :00, exactly as CLAUDE.md 13 rule 4 requires.
  IF public.fn_entry_purchases_frozen() THEN
    UPDATE public.cash_seat_moves m
       SET expires_at = GREATEST(m.expires_at, v_now + interval '3 minutes')
     WHERE m.game_id = g.id AND m.state = 'pending'
       AND m.expires_at <= v_now + interval '3 minutes';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN v_actions := v_actions || jsonb_build_object('moves_held_for_maintenance', v_n); END IF;
  ELSE
    UPDATE public.cash_seat_moves m SET state = 'expired',
           note = CASE
                    WHEN NOT EXISTS (SELECT 1 FROM public.table_seats ts
                                      WHERE ts.table_id = m.from_table_id
                                        AND ts.user_id = m.player_id AND ts.left_at IS NULL)
                      THEN 'player_left_before_boundary'
                    WHEN EXISTS (SELECT 1 FROM public.table_seats ts
                                  WHERE ts.table_id = m.from_table_id
                                    AND ts.user_id = m.player_id AND ts.left_at IS NULL
                                    AND coalesce(ts.stack, 0) = 0)
                      THEN 'player_busted_before_boundary'
                    ELSE 'engine_did_not_execute_before_expiry'
                  END
     WHERE m.game_id = g.id AND m.state = 'pending' AND m.expires_at <= v_now;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN v_actions := v_actions || jsonb_build_object('moves_expired', v_n); END IF;
  END IF;$new$;
BEGIN
  v_src := pg_get_functiondef('public.fn_cash_cluster_tick'::regproc);

  IF position('moves_held_for_maintenance' in v_src) > 0 THEN
    RAISE NOTICE 'already applied; nothing to do';
    RETURN;
  END IF;
  IF position(v_anchor in v_src) = 0 THEN
    RAISE EXCEPTION
      'the expiry statement and its diagnostics are not in the live definition in the shape this migration expects';
  END IF;

  v_new := replace(v_src, v_anchor, v_repl);

  IF position('moves_held_for_maintenance' in v_new) = 0
     OR position('engine_did_not_execute_before_expiry' in v_new) = 0
     OR position('moves_expired' in v_new) = 0 THEN
    RAISE EXCEPTION 'the replacement did not take';
  END IF;
  -- Landmarks: every other mechanism of the tick must survive the edit.
  IF position('fn_platform_frozen' in v_new) = 0
     OR position('lifecycle_followed_status' in v_new) = 0
     OR position('status_followed_lifecycle' in v_new) = 0
     OR position('feeder_abandoned' in v_new) = 0
     OR position('main1_reopened' in v_new) = 0
     OR position('table_break_started' in v_new) = 0
     OR position('main_demoted_to_feeder' in v_new) = 0 THEN
    RAISE EXCEPTION 'a landmark of the cluster tick went missing in the edit';
  END IF;

  EXECUTE v_new;
END;
$migration$;

-- The definition on the database is the one this migration meant to write.
DO $assert$
DECLARE v_def text;
BEGIN
  v_def := pg_get_functiondef('public.fn_cash_cluster_tick'::regproc);
  IF position('IF public.fn_entry_purchases_frozen() THEN' in v_def) = 0 THEN
    RAISE EXCEPTION 'the maintenance hold is not in the live definition after apply';
  END IF;
  IF position('moves_held_for_maintenance' in v_def) = 0
     OR position('engine_did_not_execute_before_expiry' in v_def) = 0 THEN
    RAISE EXCEPTION 'the live definition lost a branch of the expiry taxonomy';
  END IF;
END;
$assert$;

REVOKE ALL ON FUNCTION public.fn_cash_cluster_tick(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_tick(uuid, integer) TO service_role;

COMMIT;
