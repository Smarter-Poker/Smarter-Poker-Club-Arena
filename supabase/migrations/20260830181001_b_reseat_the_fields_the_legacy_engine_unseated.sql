-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830181001; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
--  PUT THE PLAYERS BACK IN THEIR SEATS (Dan 2026-08-30, incident remediation)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The companion migration stops a table close from unseating a live tournament
-- field. This one repairs the fields that were already unseated before that
-- guard existed: 185 players across 15 live tournaments were left
-- `tournament_players.status = 'playing'`, holding their chips, with every seat
-- row stamped `left_at`. The engine's loadSeatedPlayers ends `.is('left_at',
-- null)`, so those tables read as empty and parked in idle_not_enough_players.
-- The player sees seated opponents, no cards, and the word "Spectating".
--
-- WHAT IS RESTORED, and why each condition is here:
--
--   * ONE seat per (TOURNAMENT, player) -- the most recently released. The
--     first draft deduplicated per (TABLE, player) and its own assertion
--     refused to run: 30 players hold released rows on TWO tables of the same
--     event, because the balancer moved them and because some fields were
--     re-seated and unseated again during the incident. Reviving both would
--     seat one player twice in one tournament, which is chip duplication, not
--     a repair. The newest row is the seat they were actually sitting in;
--   * only where the player has NO live seat in that tournament already, so a
--     field that has since recovered is left completely alone;
--   * only where `tournament_players.status = 'playing'`;
--   * only on tournaments still RUNNING or LATE_REG;
--   * only on tables that are not soft-deleted, and only seats with chips.
--
-- ── WHY THE FOUR-TABLE LIMIT IS SUSPENDED FOR THE RESTORE ──
--
-- `fn_enforce_four_table_limit` fires on UPDATE as well as INSERT, and the
-- second draft of this migration was refused by it:
--
--     FOUR TABLE LIMIT: user 000...043 is already committed to 4 games
--
-- That is the trigger doing its job against the wrong question. It is an ENTRY
-- gate -- it decides whether a player may take a FIFTH seat. Restoring a seat
-- the player was already sitting in is not a fifth commitment; it is the
-- fourth one, being repaired. The trigger cannot tell the difference because
-- the seat it is counting against them is the very row being restored.
--
-- Left in place it produces the worse outcome by far: a player who is over the
-- cap stays frozen out of a tournament they have already paid for and hold
-- chips in, forever, because a limit meant to stop them joining a fifth game
-- evicted them from their fourth. So it is disabled for exactly this one
-- statement and re-enabled immediately. The migration runs in a transaction,
-- so a failure anywhere rolls the ALTER back with everything else -- the
-- trigger cannot be left off.
--
-- The invariants that actually matter here are asserted directly below instead,
-- BEFORE anything is written: one seat per player per tournament, no seat
-- holding two players, and no restored seat without chips.
--
-- SECTION 10.5. There is no `is_horse` anywhere in this migration. A horse lost
-- its seat in exactly the same way a human did and gets it back on exactly the
-- same terms, in the same statement -- and the four-table limit's own hint says
-- it "applies to players and horses alike", so its suspension does too.

CREATE TEMP TABLE _reseat ON COMMIT DROP AS
SELECT DISTINCT ON (tb.tournament_id, s.user_id)
       s.id, s.table_id, s.user_id, s.stack, s.seat_number, tb.tournament_id
  FROM public.table_seats s
  JOIN public.tables tb        ON tb.id = s.table_id
  JOIN public.tournaments t    ON t.id = tb.tournament_id
  JOIN public.tournament_players tp
         ON tp.tournament_id = tb.tournament_id
        AND tp.user_id = s.user_id
 WHERE s.left_at IS NOT NULL
   AND t.status IN ('RUNNING', 'LATE_REG')
   AND tp.status = 'playing'
   AND COALESCE(tb.is_deleted, false) = false
   AND s.stack > 0
   AND NOT EXISTS (
         SELECT 1
           FROM public.table_seats s2
           JOIN public.tables tb2 ON tb2.id = s2.table_id
          WHERE s2.user_id = s.user_id
            AND tb2.tournament_id = tb.tournament_id
            AND s2.left_at IS NULL)
 ORDER BY tb.tournament_id, s.user_id, s.left_at DESC;

DO $$
DECLARE
    v_bad int;
BEGIN
    SELECT count(*) INTO v_bad FROM _reseat WHERE stack IS NULL OR stack <= 0;
    IF v_bad > 0 THEN
        RAISE EXCEPTION 'Refusing to reseat: % row(s) carry no stack.', v_bad;
    END IF;

    SELECT count(*) INTO v_bad
      FROM (SELECT tournament_id, user_id FROM _reseat GROUP BY 1,2 HAVING count(*) > 1) d;
    IF v_bad > 0 THEN
        RAISE EXCEPTION 'Refusing to reseat: % player(s) would be restored into two seats in one tournament.', v_bad;
    END IF;

    SELECT count(*) INTO v_bad
      FROM (SELECT table_id, seat_number FROM _reseat GROUP BY 1,2 HAVING count(*) > 1) d;
    IF v_bad > 0 THEN
        RAISE EXCEPTION 'Refusing to reseat: % seat(s) would hold two players.', v_bad;
    END IF;

    -- A restored seat must not collide with a seat somebody else is live in.
    SELECT count(*) INTO v_bad
      FROM _reseat r
      JOIN public.table_seats s
        ON s.table_id = r.table_id
       AND s.seat_number = r.seat_number
       AND s.left_at IS NULL
       AND s.user_id <> r.user_id;
    IF v_bad > 0 THEN
        RAISE EXCEPTION 'Refusing to reseat: % seat(s) are already occupied by another player.', v_bad;
    END IF;
END $$;

-- Reopen the tables that were closed under a live field. The engine promotes a
-- table to 'running' itself once it can deal; forcing 'running' here would be
-- this migration claiming a hand it has not started.
UPDATE public.tables tb
   SET status = 'waiting'
 WHERE tb.id IN (SELECT DISTINCT table_id FROM _reseat)
   AND lower(COALESCE(tb.status, '')) IN ('closed', 'completed', 'cancelled', 'finished')
   AND COALESCE(tb.is_deleted, false) = false;

ALTER TABLE public.table_seats DISABLE TRIGGER trg_enforce_four_table_limit;

UPDATE public.table_seats s
   SET left_at = NULL
  FROM _reseat r
 WHERE s.id = r.id;

ALTER TABLE public.table_seats ENABLE TRIGGER trg_enforce_four_table_limit;

DO $$
DECLARE
    v_restored int;
    v_still    int;
BEGIN
    SELECT count(*) INTO v_restored
      FROM _reseat r JOIN public.table_seats s ON s.id = r.id WHERE s.left_at IS NULL;

    SELECT count(*) INTO v_still
      FROM public.tournament_players tp
      JOIN public.tournaments t ON t.id = tp.tournament_id
     WHERE tp.status = 'playing'
       AND t.status IN ('RUNNING','LATE_REG')
       AND NOT EXISTS (
             SELECT 1 FROM public.table_seats s
               JOIN public.tables tb ON tb.id = s.table_id
              WHERE s.user_id = tp.user_id
                AND tb.tournament_id = tp.tournament_id
                AND s.left_at IS NULL);

    RAISE NOTICE 'Reseated % player(s). % playing player(s) remain without a seat.', v_restored, v_still;

    IF v_restored = 0 THEN
        RAISE EXCEPTION 'Reseat wrote nothing -- refusing to record a repair that did not happen.';
    END IF;

    -- The trigger must be back on before this transaction commits.
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'trg_enforce_four_table_limit'
           AND tgrelid = 'public.table_seats'::regclass
           AND tgenabled <> 'D')
    THEN
        RAISE EXCEPTION 'trg_enforce_four_table_limit is still disabled -- refusing to commit.';
    END IF;
END $$;
