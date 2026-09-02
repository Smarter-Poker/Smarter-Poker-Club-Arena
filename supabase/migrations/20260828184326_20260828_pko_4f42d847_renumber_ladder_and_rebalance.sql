-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828184326; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
--  Union PKO Afternoon (PLO4) 4f42d847 — repair the off-by-one finishing
--  ladder that deadlocked the event heads-up.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT HAPPENED. 39 entrants. The bust sweep seeds the finishing ladder from a
-- live `status='playing'` count, which does not include an entrant still
-- sitting in `registered` while ensureLateRegSeated catches up. The first bust
-- was therefore seeded at 38, not 39, and every place after it was one too
-- high. The ladder stayed gapless and collision-free, so nothing detected it —
-- until the last busted player (bigslick mike, the true runner-up) asked for a
-- place, found 2 already taken by kenneth sousa 2, and the sweep `break`-ed.
-- He stayed status='playing' at 0 chips, so remainingCount never reached 1,
-- so finishTournament was unreachable: no champion, no first prize, no results
-- card, table dead since 17:45 while the blind clock climbed from level 13 to
-- 17.
--
-- WHAT THIS DOES. Shifts places 2..38 down to 3..39, which is the truthful
-- order (each of those players really did finish one place lower than they
-- were stamped), reprices each to their new place, and moves the difference.
-- That frees places 1 and 2, so the ENGINE's own sweep finishes the event on
-- its next tick through the normal, tested money path: eliminatePlayer for
-- bigslick at place 2 (prize + fn_collect_bounty) and finishTournament for
-- kingfish (first prize + champion's own bounty + COMPLETED).
--
-- Deliberately NOT done here: no prize is paid to the last two players by
-- hand. Hand-writing a money path the engine already owns is how chips get
-- destroyed (CLAUDE.md 11.5).
--
-- THE ORDER MATTERS. trg_tournament_place_collision fires per row, so a
-- set-based `position = position + 1` collides on its own intermediate state
-- (kenneth 2->3 while joshua still holds 3). The shift walks DOWNWARD, worst
-- place first, so the destination is always vacant when it is claimed.
--
-- THE MONEY. Places 2..9 were each overpaid by exactly one tier:
--   kenneth sousa 2  2->3  120 -> 90  (-30)
--   joshua fuentes   3->4   90 -> 60  (-30)
--   zephyr           4->5   60 -> 48  (-12)
--   phantom          5->6   48 -> 36  (-12)
--   pulsar           6->7   36 -> 30  ( -6)
--   donkbet dan      7->8   30 -> 21  ( -9)
--   rocketman        8->9   21 -> 15  ( -6)
--   setminer pro     9->10  15 ->  0  (-15)
-- Total reclaimed 120.00 — exactly the 2nd-place prize bigslick mike is owed
-- and the engine is about to pay him. Every one of the eight is a horse, and
-- under the HORSES ARE PLAYERS law (CLAUDE.md 10.5) they are repriced by the
-- same rule a human would be, not skipped and not spared. Paid places then
-- sum to 600.00, the pool exactly.
--
-- ROLLBACK. Walk the shift back UPWARD (place 3 first, then 4, ...) with
-- position = position - 1 for positions 3..39, reversing each delta recorded
-- in tournament_place_renumbers for this tournament, then delete the
-- 'tourney:4f42...:prize:{user}:{new_place}' rows this migration inserted into
-- wallet_credit_idempotency. Do NOT roll back once the engine has completed
-- the tournament.

DO $$
DECLARE
  v_tid      uuid := '4f42d847-f583-458f-8659-26392f24f482';
  v_pool     numeric := 600.00;
  v_playing  int;
  v_shifted  int;
  v_delta    numeric;
  v_paid     numeric;
  r          record;
BEGIN
  -- ── PRE-FLIGHT. Every assumption this migration was written against. ──
  IF NOT EXISTS (SELECT 1 FROM tournaments WHERE id = v_tid AND status = 'RUNNING') THEN
    RAISE EXCEPTION 'aborting: tournament % is no longer RUNNING — it moved on since this was written', v_tid;
  END IF;

  SELECT count(*) INTO v_playing
    FROM tournament_players WHERE tournament_id = v_tid AND status = 'playing';
  IF v_playing <> 2 THEN
    RAISE EXCEPTION 'aborting: expected exactly 2 players still playing, found %', v_playing;
  END IF;

  IF EXISTS (SELECT 1 FROM tournament_players WHERE tournament_id = v_tid AND position = 1) THEN
    RAISE EXCEPTION 'aborting: place 1 is already held — the event may already have finished';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tournament_players WHERE tournament_id = v_tid AND position = 2) THEN
    RAISE EXCEPTION 'aborting: place 2 is already free — nothing to renumber';
  END IF;
  IF EXISTS (SELECT 1 FROM tournament_players WHERE tournament_id = v_tid AND position >= 39) THEN
    RAISE EXCEPTION 'aborting: a place >= 39 is occupied — the shift would collide';
  END IF;
  IF EXISTS (
    SELECT 1 FROM tournament_players
     WHERE tournament_id = v_tid AND position IS NOT NULL
     GROUP BY position HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'aborting: the ladder already contains a duplicated place — this needs a human';
  END IF;

  -- ── The repriced ladder. Places 2..38 each move down one. ──
  CREATE TEMP TABLE _shift ON COMMIT DROP AS
  WITH pct(place, p) AS (
    VALUES (1,30.0),(2,20.0),(3,15.0),(4,10.0),(5,8.0),(6,6.0),(7,5.0),(8,3.5),(9,2.5)
  )
  SELECT tp.user_id,
         tp.club_id,
         tp.position                                   AS old_pos,
         tp.position + 1                               AS new_pos,
         tp.prize                                      AS old_prize,
         COALESCE(round(v_pool * pct.p / 100.0, 2), 0) AS new_prize,
         COALESCE(round(v_pool * pct.p / 100.0, 2), 0) - tp.prize AS delta
    FROM tournament_players tp
    LEFT JOIN pct ON pct.place = tp.position + 1
   WHERE tp.tournament_id = v_tid
     AND tp.position BETWEEN 2 AND 38;

  SELECT count(*), COALESCE(sum(delta), 0) INTO v_shifted, v_delta FROM _shift;
  IF v_shifted <> 37 THEN
    RAISE EXCEPTION 'aborting: expected 37 places to shift, found %', v_shifted;
  END IF;
  IF v_delta <> -120.00 THEN
    RAISE EXCEPTION 'aborting: expected the repricing to reclaim exactly 120.00, computed %', v_delta;
  END IF;

  -- ── Audit trail BEFORE the change. ──
  INSERT INTO tournament_place_renumbers
    (tournament_id, user_id, old_position, new_position, prize_paid, reason, applied_at)
  SELECT v_tid, s.user_id, s.old_pos, s.new_pos, s.old_prize,
         'ladder seeded from a live playing count excluded a not-yet-promoted late-reg entrant, so every place from the first bust was one too high; shifted down one so the true runner-up can be placed and the event can finish',
         now()
    FROM _shift s;

  -- ── Money: reclaim the overpay from the club wallet each prize landed in. ──
  UPDATE club_members cm
     SET chip_balance = COALESCE(cm.chip_balance, 0) + s.delta,
         updated_at   = now()
    FROM _shift s
   WHERE cm.user_id = s.user_id
     AND cm.club_id = s.club_id
     AND s.delta <> 0;

  -- Ledger row per adjustment, matching the shape the prize path writes.
  PERFORM public.log_wallet_transaction(
            s.user_id, 'PLAYER', abs(s.delta),
            CASE WHEN s.delta < 0 THEN 'debit' ELSE 'credit' END,
            'prize',
            'Tournament prize correction: place ' || s.old_pos || ' -> ' || s.new_pos
              || ' (' || s.old_prize || ' -> ' || s.new_prize || ')',
            NULL::uuid, NULL::uuid, v_tid)
     FROM _shift s
    WHERE s.delta <> 0;

  -- ── Burn the idempotency key at each NEW place, so the engine can never
  --    re-pay a shifted player at a place it has not paid before. ──
  INSERT INTO wallet_credit_idempotency (key, user_id, amount)
  SELECT 'tourney:' || v_tid || ':prize:' || s.user_id || ':' || s.new_pos,
         s.user_id, s.new_prize
    FROM _shift s
  ON CONFLICT (key) DO NOTHING;

  -- ── The renumber. WORST PLACE FIRST, so every destination is vacant when
  --    it is claimed and the per-row collision trigger stays quiet. ──
  FOR r IN SELECT * FROM _shift ORDER BY old_pos DESC LOOP
    UPDATE tournament_players
       SET position = r.new_pos,
           prize    = r.new_prize
     WHERE tournament_id = v_tid
       AND user_id = r.user_id;
  END LOOP;

  -- ── POST-APPLY ASSERTIONS. ──
  IF EXISTS (SELECT 1 FROM tournament_players WHERE tournament_id = v_tid AND position IN (1,2)) THEN
    RAISE EXCEPTION 'post-check failed: places 1 and 2 must both be free for the engine to finish the event';
  END IF;
  IF EXISTS (
    SELECT 1 FROM tournament_players
     WHERE tournament_id = v_tid AND position IS NOT NULL
     GROUP BY position HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'post-check failed: the renumber produced a duplicated place';
  END IF;

  SELECT COALESCE(sum(prize), 0) INTO v_paid
    FROM tournament_players WHERE tournament_id = v_tid;
  IF v_paid <> 300.00 THEN
    RAISE EXCEPTION 'post-check failed: places 3..39 should now hold 300.00 (600 pool less the 180+120 the engine is about to pay), found %', v_paid;
  END IF;

  SELECT count(*) INTO v_playing
    FROM tournament_players WHERE tournament_id = v_tid AND status = 'playing';
  IF v_playing <> 2 THEN
    RAISE EXCEPTION 'post-check failed: the two finalists must still be playing for the engine to finish them, found %', v_playing;
  END IF;

  RAISE NOTICE 'PKO 4f42d847 ladder repaired: % places shifted, % reclaimed, places 1 and 2 now free for the engine.', v_shifted, v_delta;
END $$;
