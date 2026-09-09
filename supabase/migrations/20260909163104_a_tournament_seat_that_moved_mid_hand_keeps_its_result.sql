DO $mig$
DECLARE v_src text; v_new text;
BEGIN
  /* WHAT THIS ENDS. When a table balancer moves a tournament player, or an
     elimination removes them, while a hand is in flight, their seat row on the
     old table is marked left. The settlement then cannot find the seat and,
     for a tournament, RAISEs - which throws away the WHOLE hand: every other
     player at that table loses the result they just played for, and the engine
     has already moved on, so its stacks and the database's part company.

     The cash branch immediately above has settled this case since 2026-09-04,
     against the club wallet the seat cashed out to. The tournament branch was
     left refusing "as before" because tournament chips are play chips with no
     wallet to settle against - a correct reason not to use the cash path, and
     not a reason to discard the hand.

     A tournament seat that moved has somewhere to go: the chair the player now
     occupies. executePlayerMoves reads the source stack BEFORE marking the old
     seat left and seats the player with that number, so a seat created mid-hand
     carries the stack as it stood BEFORE this hand - which is exactly what
     stack_before says. Adding the delta lands them on the right total from
     either ordering: settle-then-move copies the settled stack and this branch
     never runs, move-then-settle copies stack_before and this branch completes
     it.

     A player with no chair anywhere is not left out of the arithmetic either:
     the delta lands on the seat they left, so the chips stay inside the event
     and fn_ca_stranded_tournament_players can see them, instead of vanishing
     with the discarded hand. Conservation is unchanged - the delta joins
     v_delta_sum exactly as the cash and seated branches add theirs, so the
     tournament sum-to-zero check still judges the whole hand.

     Measured: 47 hands refused this way in two days, and every one of them
     also desynchronised an engine from the database. */
  SELECT pg_get_functiondef(p.oid) INTO v_src FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_settle_hand_stacks_absolute';
  IF v_src IS NULL THEN RAISE EXCEPTION 'fn_ca_settle_hand_stacks_absolute is gone'; END IF;
  IF position($chk$v_moved_seat_id$chk$ IN v_src) <> 0 THEN
    RAISE EXCEPTION 'the tournament branch already keeps a moved seat result';
  END IF;
  IF position($chk$  v_dep record; v_dep_club uuid; v_dep_after numeric; v_dep_key text; v_dep_claimed integer;$chk$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'the declare block moved; re-read it before editing';
  END IF;
  IF position($chk$        RAISE EXCEPTION 'seat missing or left for % - hand write rejected whole', v_uid;$chk$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'the tournament refusal moved; re-read it before editing';
  END IF;

  v_new := replace(v_src,
$old$  v_dep record; v_dep_club uuid; v_dep_after numeric; v_dep_key text; v_dep_claimed integer;$old$,
$new$  v_dep record; v_dep_club uuid; v_dep_after numeric; v_dep_key text; v_dep_claimed integer;
  -- 2026-09-09: a TOURNAMENT seat that moved or was removed mid-hand
  v_moved_seat_id uuid; v_moved_where text; v_this_tournament uuid;$new$);

  v_new := replace(v_new,
$old$        RAISE EXCEPTION 'seat missing or left for % - hand write rejected whole', v_uid;$old$,
$new$        /* A TOURNAMENT SEAT THAT MOVED MID-HAND KEEPS ITS RESULT (2026-09-09).
           See the migration that installed this for the whole reason. In
           short: refusing here threw away a hand every other player at the
           table had already played, and left the moved player's chips outside
           the game. The delta goes to the chair they now occupy, or to the
           chair they left if they have none. */
        IF v_delta_mode AND EXISTS (SELECT 1 FROM public.tables tb
                                     WHERE tb.id = p_table_id AND tb.tournament_id IS NOT NULL) THEN
          v_before := round((e->>'stack_before')::numeric, 2);
          IF v_before IS NULL OR v_before < 0 THEN
            RAISE EXCEPTION 'invalid stack_before for %: %', e->>'user_id', e->>'stack_before';
          END IF;
          -- A seat that moved no chips has nothing to carry anywhere.
          IF round(v_new - v_before, 2) = 0 THEN
            v_n := v_n + 1;
            CONTINUE;
          END IF;

          SELECT tb.tournament_id INTO v_this_tournament
            FROM public.tables tb WHERE tb.id = p_table_id;

          v_moved_seat_id := NULL;
          v_moved_where := NULL;
          SELECT ts.id INTO v_moved_seat_id
            FROM public.table_seats ts
            JOIN public.tables tb2 ON tb2.id = ts.table_id
           WHERE ts.user_id = v_uid
             AND ts.left_at IS NULL
             AND tb2.tournament_id = v_this_tournament
           ORDER BY ts.joined_at DESC
           LIMIT 1;
          IF v_moved_seat_id IS NOT NULL THEN
            v_moved_where := 'the chair they now hold';
          ELSE
            SELECT ts.id INTO v_moved_seat_id
              FROM public.table_seats ts
             WHERE ts.table_id = p_table_id AND ts.user_id = v_uid AND ts.left_at IS NOT NULL
             ORDER BY ts.left_at DESC
             LIMIT 1;
            IF v_moved_seat_id IS NOT NULL THEN
              v_moved_where := 'the chair they left, because they hold none';
            END IF;
          END IF;

          IF v_moved_seat_id IS NULL THEN
            RAISE EXCEPTION 'seat missing or left for % and no seat of theirs remains in this tournament - hand write rejected whole', v_uid;
          END IF;

          UPDATE public.table_seats ts
             SET stack = round(ts.stack + (v_new - v_before), 2), updated_at = now()
           WHERE ts.id = v_moved_seat_id
             AND round(ts.stack + (v_new - v_before), 2) >= 0;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'seat missing or left for % and its delta of % would take that seat below zero - hand write rejected whole',
              v_uid, round(v_new - v_before, 2);
          END IF;

          -- Conservation counts this delta exactly as the other branches do,
          -- so the tournament sum-to-zero check still judges the whole hand.
          v_delta_sum := v_delta_sum + (v_new - v_before);

          PERFORM public.fn_raise_server_financial_alert(
            'warning', 'fn_ca_settle_hand_stacks_absolute',
            format('A tournament seat left mid-hand and its result was carried to %s rather than the hand being discarded', v_moved_where),
            jsonb_build_object('kind','tournament_seat_moved_mid_hand','table_id',p_table_id,
                               'hand_number',p_hand_number,'user_id',v_uid,
                               'delta',round(v_new - v_before, 2),'seat_id',v_moved_seat_id,
                               'carried_to',v_moved_where),
            'seatmoved:' || p_table_id::text || ':' || p_hand_number::text || ':' || v_uid::text);

          v_n := v_n + 1;
          CONTINUE;
        END IF;
        RAISE EXCEPTION 'seat missing or left for % - hand write rejected whole', v_uid;$new$);

  IF v_new = v_src THEN RAISE EXCEPTION 'the settlement was not changed'; END IF;
  EXECUTE v_new;

  IF (SELECT position($chk$A TOURNAMENT SEAT THAT MOVED MID-HAND KEEPS ITS RESULT$chk$ IN pg_get_functiondef(p.oid))
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='fn_ca_settle_hand_stacks_absolute') = 0 THEN
    RAISE EXCEPTION 'the settlement did not take the moved-seat branch';
  END IF;
  -- The cash branch must still be there, unchanged, above it.
  IF (SELECT position($chk$and no club wallet resolves for it - hand write rejected whole$chk$ IN pg_get_functiondef(p.oid))
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='fn_ca_settle_hand_stacks_absolute') = 0 THEN
    RAISE EXCEPTION 'the cash departed branch went missing';
  END IF;
END
$mig$;;
