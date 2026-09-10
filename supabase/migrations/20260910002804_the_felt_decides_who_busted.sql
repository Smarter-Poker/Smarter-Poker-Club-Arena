/* THE FELT DECIDES WHO BUSTED (2026-09-10)

   tournament_players.chips MIRRORS the seat. The seat is where the engine
   settles every hand; the mirror is a projection. Measured today, 1,540 of
   1,541 live tournament seats agree with their mirror exactly - so the mirror
   is not systematically broken. It diverges when a tournament stalls and
   settlement stops running, and TWO readers trusted it anyway. Between them
   they minted chips, stalled tournaments, and refused hands.

   1. fn_ca_assign_tournament_player_seat_locked took a moved player's new
      stack from the mirror:
          ELSE v_stack := COALESCE(v_tp.chips, 0);
      Night Owl Special b84f312f, from the ENGINE'S OWN hand records:
      256,000 + 128,000 = 384,000 at 18:01, exactly the 48 x 8,000 bought in.
      A move at 22:34:25 wrote 448,000 over a felt of 256,000, and the two
      players whose mirror read 0 were refused a seat (player_stack_invalid)
      and left the felt entirely: +192,000 minted, -128,000 destroyed, net
      +64,000 - the reported drift, to the chip. Platform-wide: 76,500 chips
      across 3 of 64 RUNNING tournaments.

   2. fn_ca_eliminate_absent_tournament_players filtered on
          AND COALESCE(p.chips, 0) <= 0
      the same mirror. Of 68 seatless players, 39 carried chips > 0 there -
      151,500 chips - while the highest stack they ever held on ANY seat in
      that tournament was ZERO. They never held a chip. The sweep skipped
      exactly the rows whose mirror was wrong, which is why it has run every
      fifteen minutes, reported success every time, and repaired none of them.
      Its second clause, NOT EXISTS (... stack > 0), tested every seat row,
      live or vacated - and a vacated seat keeps its stack for history - so
      anyone who had EVER held chips was protected from elimination for good.

   The consequences compound: a roster row saying 'playing' keeps the field
   open, so 34 tournaments had been RUNNING for over six hours holding
   undistributed prize pools; and the engine keeps dealing to a chair that does
   not exist, so the hand is refused - 'accepted tournament hand omitted
   written stack for 611cf850...', 140 times across 4 tables.

   THE FIX. Both readers now read the felt, so the mirror is no longer
   load-bearing and can be as wrong as it likes without moving a chip. And
   because reading the right column is only ever one defect away from the next
   wrong input, a conservation gate makes the class impossible: a seat
   assignment may move chips between chairs, but may never raise a tournament's
   live total above what was bought in. A normal move cannot trip it - the
   player's own live seat is subtracted before the new stack is added back, so
   the total is unchanged BY CONSTRUCTION. An existing overage is tolerated
   (history) and refused only from growing (the future), the same shape as this
   estate's NOT VALID constraints, so the three tournaments already over cap
   are not stranded by their own overage.

   Proved in a transaction that was rolled back before anything shipped:
     roster playing 1270 -> 1212 (58 eliminated)
     WRONGLY_EVICTED_HOLDING_CHIPS = 0
     field_protected 0, refused_by_zero_chip_guard 0
   Nobody holding chips on the felt is touched - verified against Night Owl,
   where one player was seatless for 59 minutes holding 256,000.

   The existing 76,500 is left where it is: tournament chips are scoring units,
   the prize pool is fixed by buy-ins and unaffected by chip counts, and 10.9
   rule 3 forbids taking chips back from a player for our own defect.

   No repair job, no backfill, no sweep, nothing scheduled (10.12). */
DO $mig$
DECLARE
  v_src text; v_new text; v_n int;
  v_da text; v_db text; v_a text; v_b text; v_ea text; v_eb text;
  v_check text;
BEGIN
  IF NOT (current_user IN ('postgres','service_role')) THEN
    RAISE EXCEPTION 'operator-only';
  END IF;

  ---------------------------------------------------------------------------
  -- 1. THE MOVE READS THE FELT, AND A MOVE NEVER MINTS
  ---------------------------------------------------------------------------
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_assign_tournament_player_seat_locked';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_ca_assign_tournament_player_seat_locked not found';
  END IF;

  IF position('THE FELT IS THE BANK ON A MOVE' in v_src) > 0 THEN
    RAISE NOTICE 'assign already carries the felt-first read; skipping';
  ELSE
    v_da := '  v_stack numeric;';
    v_n := (length(v_src)-length(replace(v_src,v_da,'')))/length(v_da);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the v_stack declaration appears % times, expected exactly 1 - the function has changed and this edit must be re-read against it', v_n;
    END IF;
    v_db := '  v_stack numeric;' || E'\n' ||
            '  v_felt_stack numeric;' || E'\n' ||
            '  v_live_total numeric;' || E'\n' ||
            '  v_own_live numeric;' || E'\n' ||
            '  v_cap_chips numeric;';

    v_a := 'IF v_tp.status::text=''registered'' THEN' || E'\n' ||
           '    v_stack:=COALESCE(v_t.starting_chips,0)' || E'\n' ||
           '             +GREATEST(COALESCE(v_tp.chips,0),0);' || E'\n' ||
           '  ELSE' || E'\n' ||
           '    v_stack:=COALESCE(v_tp.chips,0);' || E'\n' ||
           '  END IF;';
    v_n := (length(v_src)-length(replace(v_src,v_a,'')))/length(v_a);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the stack branch appears % times, expected exactly 1 - the function has changed and this edit must be re-read against it', v_n;
    END IF;

    v_b := 'IF v_tp.status::text=''registered'' THEN' || E'\n' ||
           '    v_stack:=COALESCE(v_t.starting_chips,0)' || E'\n' ||
           '             +GREATEST(COALESCE(v_tp.chips,0),0);' || E'\n' ||
           '  ELSE' || E'\n' ||
           '    /* THE FELT IS THE BANK ON A MOVE (2026-09-10). This took the new' || E'\n' ||
           '       seat''s stack from tournament_players.chips, a MIRROR, rather than' || E'\n' ||
           '       from the seat the player is leaving. In the ordinary case the two' || E'\n' ||
           '       agree - measured 1,540 of 1,541 live tournament seats. When they' || E'\n' ||
           '       do not, this statement silently minted or destroyed the gap.' || E'\n' ||
           '       Night Owl Special b84f312f: the engine''s own hands show 256,000 +' || E'\n' ||
           '       128,000 = 384,000 at 18:01, exactly the 48 x 8,000 bought in; a' || E'\n' ||
           '       move at 22:34:25 wrote 448,000 over a felt of 256,000 and the' || E'\n' ||
           '       tournament has held 64,000 chips nobody bought ever since.' || E'\n' ||
           '       The seat is where the engine settles every hand, so the seat is' || E'\n' ||
           '       the witness; the mirror is a projection. Read the felt first and' || E'\n' ||
           '       fall back to the mirror only when the player holds no live seat. */' || E'\n' ||
           '    SELECT ts.stack INTO v_felt_stack' || E'\n' ||
           '      FROM public.table_seats ts' || E'\n' ||
           '      JOIN public.tables tb ON tb.id=ts.table_id' || E'\n' ||
           '     WHERE tb.tournament_id=p_tournament_id' || E'\n' ||
           '       AND ts.user_id=p_user_id' || E'\n' ||
           '       AND ts.left_at IS NULL' || E'\n' ||
           '     ORDER BY ts.joined_at DESC, ts.id' || E'\n' ||
           '     LIMIT 1;' || E'\n' ||
           '    v_stack:=COALESCE(v_felt_stack,COALESCE(v_tp.chips,0));' || E'\n' ||
           '  END IF;' || E'\n' ||
           '' || E'\n' ||
           '  /* A SEAT ASSIGNMENT NEVER MINTS TOURNAMENT CHIPS (2026-09-10).' || E'\n' ||
           '     Whatever corrupts an input, this gate makes the class impossible:' || E'\n' ||
           '     an assignment may move chips between chairs but may never RAISE the' || E'\n' ||
           '     tournament''s live total above what was bought in. A normal move' || E'\n' ||
           '     cannot trip it - the player''s own live seat is subtracted before' || E'\n' ||
           '     v_stack is added back, so the total is unchanged. It fires only when' || E'\n' ||
           '     seating a player would ADD chips beyond the cap. An existing overage' || E'\n' ||
           '     is tolerated (history) and refused only from growing (the future),' || E'\n' ||
           '     the same shape as this estate''s NOT VALID constraints. */' || E'\n' ||
           '  IF v_tp.status::text<>''registered'' THEN' || E'\n' ||
           '    SELECT COALESCE(sum(ts.stack),0) INTO v_live_total' || E'\n' ||
           '      FROM public.table_seats ts JOIN public.tables tb ON tb.id=ts.table_id' || E'\n' ||
           '     WHERE tb.tournament_id=p_tournament_id AND ts.left_at IS NULL;' || E'\n' ||
           '    SELECT COALESCE(sum(ts.stack),0) INTO v_own_live' || E'\n' ||
           '      FROM public.table_seats ts JOIN public.tables tb ON tb.id=ts.table_id' || E'\n' ||
           '     WHERE tb.tournament_id=p_tournament_id AND ts.user_id=p_user_id' || E'\n' ||
           '       AND ts.left_at IS NULL;' || E'\n' ||
           '    SELECT (count(*)*COALESCE(v_t.starting_chips,0))' || E'\n' ||
           '           +(COALESCE(sum(tp2.rebuys),0)*COALESCE(v_t.rebuy_chips,0))' || E'\n' ||
           '           +(count(*) FILTER (WHERE tp2.add_on)*COALESCE(v_t.addon_chips,0))' || E'\n' ||
           '      INTO v_cap_chips' || E'\n' ||
           '      FROM public.tournament_players tp2' || E'\n' ||
           '     WHERE tp2.tournament_id=p_tournament_id;' || E'\n' ||
           '    IF (v_live_total-v_own_live+v_stack)>v_live_total' || E'\n' ||
           '       AND (v_live_total-v_own_live+v_stack)>v_cap_chips THEN' || E'\n' ||
           '      RETURN jsonb_build_object(' || E'\n' ||
           '        ''ok'',false,''reason'',''tournament_chip_conservation'',' || E'\n' ||
           '        ''live_total'',v_live_total,''own_live'',v_own_live,' || E'\n' ||
           '        ''proposed_stack'',v_stack,''bought_in_cap'',v_cap_chips);' || E'\n' ||
           '    END IF;' || E'\n' ||
           '  END IF;';

    v_new := replace(replace(v_src, v_da, v_db), v_a, v_b);
    IF v_new = v_src THEN
      RAISE EXCEPTION 'assign substitution produced no change';
    END IF;
    EXECUTE v_new;
  END IF;

  ---------------------------------------------------------------------------
  -- 2. THE ELIMINATOR READS THE FELT TOO
  ---------------------------------------------------------------------------
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_eliminate_absent_tournament_players';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_ca_eliminate_absent_tournament_players not found';
  END IF;

  IF position('THE FELT DECIDES WHO BUSTED' in v_src) > 0 THEN
    RAISE NOTICE 'eliminator already reads the felt; skipping';
  ELSE
    v_ea := '       AND COALESCE(p.chips, 0) <= 0' || E'\n' ||
            '       AND NOT EXISTS (' || E'\n' ||
            '             SELECT 1 FROM public.table_seats s' || E'\n' ||
            '               JOIN public.tables tb ON tb.id = s.table_id' || E'\n' ||
            '              WHERE tb.tournament_id = t.id AND s.user_id = p.user_id' || E'\n' ||
            '                AND s.left_at IS NULL)' || E'\n' ||
            '       AND NOT EXISTS (' || E'\n' ||
            '             SELECT 1 FROM public.table_seats s' || E'\n' ||
            '               JOIN public.tables tb ON tb.id = s.table_id' || E'\n' ||
            '              WHERE tb.tournament_id = t.id AND s.user_id = p.user_id' || E'\n' ||
            '                AND COALESCE(s.stack, 0) > 0)';
    v_n := (length(v_src)-length(replace(v_src,v_ea,'')))/length(v_ea);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'the eliminator predicate appears % times, expected exactly 1 - the function has changed and this edit must be re-read against it', v_n;
    END IF;

    v_eb := '       /* THE FELT DECIDES WHO BUSTED, NOT THE MIRROR (2026-09-10).' || E'\n' ||
            '          Two clauses here read the wrong thing and between them this' || E'\n' ||
            '          sweep has never been able to eliminate the players it exists' || E'\n' ||
            '          for. Measured 2026-09-10: 68 seatless players across 18 RUNNING' || E'\n' ||
            '          tournaments, 34 of which had been RUNNING for over six hours' || E'\n' ||
            '          and cannot end while a roster row still says playing.' || E'\n' ||
            '            1. COALESCE(p.chips,0) <= 0 trusts tournament_players.chips,' || E'\n' ||
            '               a MIRROR. 39 of the 68 carry chips > 0 there - 151,500' || E'\n' ||
            '               chips in total - while max(stack) across every seat they' || E'\n' ||
            '               have ever held in the tournament is ZERO. They never held' || E'\n' ||
            '               a chip on the felt. The sweep skipped exactly the rows' || E'\n' ||
            '               whose mirror was wrong, which is why it has run every 15' || E'\n' ||
            '               minutes, succeeded every time, and repaired none of them.' || E'\n' ||
            '            2. NOT EXISTS (... stack > 0) tested EVERY seat row, live or' || E'\n' ||
            '               vacated. A vacated seat keeps its stack for history, so a' || E'\n' ||
            '               player who ever held chips was protected from elimination' || E'\n' ||
            '               permanently.' || E'\n' ||
            '          The felt is where the engine settles every hand. A player has' || E'\n' ||
            '          busted when they hold NO live seat and the seat they last left' || E'\n' ||
            '          held nothing. A player between tables mid-consolidation still' || E'\n' ||
            '          has a non-zero last seat, so this cannot evict them - measured' || E'\n' ||
            '          on Night Owl b84f312f, where one player was seatless for 59' || E'\n' ||
            '          minutes holding 256,000 and is correctly untouched. */' || E'\n' ||
            '       AND NOT EXISTS (' || E'\n' ||
            '             SELECT 1 FROM public.table_seats s' || E'\n' ||
            '               JOIN public.tables tb ON tb.id = s.table_id' || E'\n' ||
            '              WHERE tb.tournament_id = t.id AND s.user_id = p.user_id' || E'\n' ||
            '                AND s.left_at IS NULL)' || E'\n' ||
            '       AND COALESCE((' || E'\n' ||
            '             SELECT s.stack FROM public.table_seats s' || E'\n' ||
            '               JOIN public.tables tb ON tb.id = s.table_id' || E'\n' ||
            '              WHERE tb.tournament_id = t.id AND s.user_id = p.user_id' || E'\n' ||
            '              ORDER BY s.left_at DESC NULLS FIRST, s.joined_at DESC' || E'\n' ||
            '              LIMIT 1), 0) <= 0';

    v_new := replace(v_src, v_ea, v_eb);
    IF v_new = v_src THEN
      RAISE EXCEPTION 'eliminator substitution produced no change';
    END IF;
    EXECUTE v_new;
  END IF;

  ---------------------------------------------------------------------------
  -- POST-CONDITION: both readers changed, and neither reads the mirror
  ---------------------------------------------------------------------------
  SELECT pg_get_functiondef(p.oid) INTO v_check
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_assign_tournament_player_seat_locked';
  IF v_check IS NULL
     OR position('THE FELT IS THE BANK ON A MOVE' in v_check) = 0
     OR position('tournament_chip_conservation' in v_check) = 0 THEN
    RAISE EXCEPTION 'post-condition failed: the assign path is missing the felt read or the conservation gate. Nothing written.';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_check
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='fn_ca_eliminate_absent_tournament_players';
  IF v_check IS NULL
     OR position('THE FELT DECIDES WHO BUSTED' in v_check) = 0
     OR position('AND COALESCE(p.chips, 0) <= 0' in v_check) > 0 THEN
    RAISE EXCEPTION 'post-condition failed: the eliminator still reads the mirror. Nothing written.';
  END IF;

  RAISE NOTICE 'both readers now read the felt; the conservation gate is armed';
END $mig$;
