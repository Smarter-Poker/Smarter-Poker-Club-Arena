-- Retire both duplicate-chair payment loops only after native ownership is installed.
-- The old planner used table status and an unbound seat number as hand authority.
-- It could also set departure flags without preserving the original occupancy.
-- Commit-time uniqueness now rejects the second ownership and rolls back its
-- entire financial transaction; no compensation/watch process replaces these loops.
-- All other planner logic is preserved byte-for-byte from the inspected live body.
BEGIN;
SET LOCAL lock_timeout='2s';
DO $migration$
DECLARE v_definition text; v_before text; v_after text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='public.table_seats'::regclass AND conname='one_committed_seat_per_game_player'
      AND contype='u' AND convalidated AND condeferrable AND condeferred
      AND pg_get_constraintdef(oid)='UNIQUE (user_id, active_game_scope) DEFERRABLE INITIALLY DEFERRED')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='public.table_seats'::regclass AND conname='active_seat_game_scope_parent'
      AND contype='f' AND convalidated AND confupdtype='c')
  THEN RAISE EXCEPTION 'Native committed seat ownership must be installed before retiring repair cashouts'; END IF;
  SELECT pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure) INTO v_definition;
  IF md5(v_definition) IN ('2303b31672ff35201d2a310d821c0cd4','ae91ea39aef3746371029528cb8e343d') THEN RETURN; END IF;
  IF md5(v_definition)<>'a2ad5aea846e31affa53fa187be8773b' THEN
    RAISE EXCEPTION 'Unreviewed cluster planner body; preserve concurrent changes and re-audit';
  END IF;
  v_before := $old_first$  -- ONE CHAIR PER PLAYER PER GAME, EVERY TICK (2026-09-05). The door
  -- refuses a second chair now; before it did, the fleet seated the same
  -- horse at two tables of one game, and the tick only settled that on a
  -- BREAKING table (below). Found live: one horse on Main 1 since 17:01 and
  -- on the feeder since 19:17 the day before, both chairs idle. The roster
  -- is per player, so every such pair also read as one row of drift. The
  -- oldest chair is the player's; each newer one goes home through the
  -- same door as a Leave: between hands (table waiting) it is cashed out
  -- now, exactly as the breaking branch does; mid-game it is flagged
  -- leave_pending and the engine cashes it out at the hand boundary.
  FOR r IN
    SELECT ts.user_id, ts.table_id, ts.seat_number, ts.stack, tb.status,
           coalesce(ts.club_id, public.fn_player_home_club(ts.user_id, NULL)) AS club_id
      FROM public.table_seats ts
      JOIN public.tables tb ON tb.id = ts.table_id
     WHERE tb.cluster_id = g.id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
       AND tb.lifecycle <> 'closed' AND coalesce(tb.is_deleted, false) = false
       AND coalesce(ts.leave_pending, false) = false
       AND EXISTS (SELECT 1 FROM public.table_seats o JOIN public.tables ot ON ot.id = o.table_id
                    WHERE o.user_id = ts.user_id AND o.left_at IS NULL AND o.table_id <> ts.table_id
                      AND ot.cluster_id = g.id AND ot.lifecycle <> 'closed'
                      AND (o.joined_at < ts.joined_at OR (o.joined_at = ts.joined_at AND o.id < ts.id)))
  LOOP
    IF r.status = 'waiting' AND coalesce(r.stack, 0) > 0 AND r.club_id IS NOT NULL THEN
      PERFORM public.fn_ensure_club_wallet(r.user_id, r.club_id);
      PERFORM public.fn_ca_declare_ledger('table_cashout', 'table_stack', r.table_id);
      v_res := public.atomic_seat_cashout_locked(r.user_id, r.table_id, r.seat_number, 'forced');
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (g.id, r.table_id, 'second_chair_cashed_out',
              jsonb_build_object('player_id', r.user_id, 'seat', r.seat_number, 'stack', r.stack, 'club_id', r.club_id,
                                 'credited', v_res->'credited', 'key', v_res->'idempotency_key', 'where', 'reconcile'));
      v_actions := v_actions || jsonb_build_object('second_chair_cashed_out', r.user_id);
    ELSE
      UPDATE public.table_seats SET leave_pending = true
       WHERE table_id = r.table_id AND user_id = r.user_id AND left_at IS NULL;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (g.id, r.table_id, 'second_chair_leave_pending',
              jsonb_build_object('player_id', r.user_id, 'seat', r.seat_number, 'stack', r.stack, 'table_status', r.status));
      v_actions := v_actions || jsonb_build_object('second_chair_leave_pending', r.user_id);
    END IF;
  END LOOP;

$old_first$;
  v_after := $new_first$  -- Duplicate committed chairs are rejected by one_committed_seat_per_game_player.
  -- The cluster planner never pays away a chair outside its engine hand boundary.

$new_first$;
  IF strpos(v_definition,v_before)=0 THEN RAISE EXCEPTION 'First reviewed repair block not found'; END IF;
  v_definition := replace(v_definition,v_before,v_after);
  v_before := $old_second$    -- A SECOND CHAIR IN ONE GAME (2026-09-05). Before the door refused it, the
    -- fleet could seat the same horse at two tables of one game; found live
    -- with one of the two chairs on this breaking table. There is nowhere to
    -- move that chair to (they are already at the other table), so it goes
    -- home: the stack returns to the wallet through the forced cash-out the
    -- table-close path uses. Nothing is lost; the other chair is untouched.
    FOR r IN SELECT ts.user_id, ts.seat_number, ts.stack,
                    coalesce(ts.club_id, public.fn_player_home_club(ts.user_id, NULL)) AS club_id
               FROM public.table_seats ts
              WHERE ts.table_id = t.id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
                AND coalesce(ts.stack, 0) > 0
                AND EXISTS (SELECT 1 FROM public.table_seats o JOIN public.tables ot ON ot.id = o.table_id
                             WHERE o.user_id = ts.user_id AND o.left_at IS NULL AND o.table_id <> t.id
                               AND ot.cluster_id = g.id AND ot.lifecycle IN ('live', 'opening'))
    LOOP
      CONTINUE WHEN r.club_id IS NULL;
      -- The same three calls fn_cashout_seats_for_closing_table makes, per seat.
      PERFORM public.fn_ensure_club_wallet(r.user_id, r.club_id);
      PERFORM public.fn_ca_declare_ledger('table_cashout', 'table_stack', t.id);
      v_res := public.atomic_seat_cashout_locked(r.user_id, t.id, r.seat_number, 'forced');
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (g.id, t.id, 'second_chair_cashed_out',
              jsonb_build_object('player_id', r.user_id, 'seat', r.seat_number, 'stack', r.stack,
                                 'club_id', r.club_id, 'credited', v_res->'credited', 'key', v_res->'idempotency_key'));
      v_actions := v_actions || jsonb_build_object('second_chair_cashed_out', r.user_id);
    END LOOP;
$old_second$;
  v_after := $new_second$    -- Native committed ownership makes duplicate-chair cashout unnecessary.
$new_second$;
  IF strpos(v_definition,v_before)=0 THEN RAISE EXCEPTION 'Second reviewed repair block not found'; END IF;
  v_definition := replace(v_definition,v_before,v_after);
  IF md5(v_definition)<>'2303b31672ff35201d2a310d821c0cd4' THEN RAISE EXCEPTION 'Unexpected cluster planner patch result'; END IF;
  EXECUTE v_definition;
END
$migration$;
COMMIT;
