-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260912061157; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260912061157   (the stamp IS the apply time, UTC: 2026-09-12 06:11:57)
--   name        the_felt_may_not_grow_past_what_was_bought_in
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 17414 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260912061157 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_ca_tournament_chip_supply, public.fn_ca_tournament_felt_may_not_exceed_supply
--     TABLE          public.tournament_felt_supply_acknowledgements
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- The felt may not grow past what was bought in.
--
-- Drift incident 8b8fe26c-f2f9-458f-a275-a19508b55b58 has been open since
-- 2026-09-09 19:52Z, 59 occurrences, and it is the last one still firing.
-- fn_tournament_chip_conservation_check reports a RUNNING tournament whose
-- felt is heavier than the chips anybody ever bought. Nothing is owed to
-- anybody and no player stack is rewritten here.
--
-- WHAT HAPPENED, read from rows rather than assumed. The chips are really
-- there. They were created on 2026-09-09 by the one-shot stranded-seat repair
-- (fn_ca_return_stranded_to_the_felt -> fn_ca_move_tournament_seat, migrations
-- 20260909175754 / 20260909175822). That mover took the stack it restored from
-- table_seats.stack on rows that were ALREADY VACATED. A vacated seat's stack
-- is a stale snapshot that nothing zeroes, so the repair re-seated players with
-- chips that had already been paid to whoever busted them. The trail is in
-- ca_tournament_conservation_samples and there are no hands in the windows:
--
--   a5aa6984  2026-09-09 18:00  -22,500  ->  18:10  +2,500   (1 x 2,500)
--   7aa16fa7  2026-09-09 22:40 -105,000  ->  22:50 +10,000   (2 x 5,000)
--
-- Both jumps are whole multiples of the event's starting stack. Three
-- independent witnesses agree the felt is what it says it is: table_seats,
-- sum(tournament_players.chips), and the engine's own hand_history stacks. The
-- supply side is complete and correct; it is the felt that is heavier.
--
-- BOTH MINTING DOORS ARE ALREADY SHUT and nothing here reopens them.
-- fn_ca_move_tournament_seat and fn_ca_return_stranded_to_the_felt no longer
-- exist in pg_proc. fn_ca_assign_tournament_player_seat_locked reads the felt
-- first (2026-09-10), and fn_ca_assert_tournament_chip_grant refuses a minting
-- chip purchase (2026-09-11, 20260911145935_a_tournament_chip_grant_cannot_mint).
--
-- WHAT THIS MIGRATION DOES. It acknowledges the chips that were MEASURABLY
-- created, in a register denominated in PLAY CHIPS. It does NOT touch
-- public.tournament_conservation_baseline: that table looks like the right
-- home and is not, because it is MONEY-denominated - 1,862 rows read by
-- fn_tournament_conservation_delta against wallet_transactions - and putting
-- play chips in it would corrupt the money conservation audit.
--
-- Nothing is confiscated. CLAUDE.md 10.9 rule 3: overpay our defect caused is
-- absorbed by the house, reported, and left alone. These chips have been in
-- play for three days and the hands they were played in are final.
--
-- THE FIGURE IS WHAT WAS MEASURED, NOT WHAT WOULD BE CONVENIENT. a5aa6984 is
-- acknowledged at 2,500 - the overage actually standing on its felt - and NOT
-- at 5,000, which is what it would take to also re-seat the stranded player
-- river222 (dca6c345, status playing, chips 2,500, table_id and seat_number
-- NULL). Inventing supply that was never created in order to solve a seating
-- problem corrupts the meter. river222 is a seating question and is filed as
-- one; this migration deliberately leaves it unresolved rather than paying for
-- it with chips nobody bought.
--
-- 7aa16fa7 COMPLETED at 2026-09-12 05:23:27Z, 33 minutes before this was
-- written, with its felt drained to 0 and its last conservation sample still
-- reading +10,000 at 05:20:02Z. It has therefore already left the sweep, which
-- only looks at RUNNING events. Its acknowledgement is recorded anyway: the
-- 10,000 was real, it was on that felt for three days, and the register is the
-- record of what the defect created, not a live-only suppression list.
--
-- THE GATE. table_seats carries 38 triggers and not one of them constrains the
-- VALUE written to stack; the incident's own root_cause says it plainly -
-- "a0_tournament_live_seat_root_guard never fires on UPDATE OF stack". So the
-- class stays reachable by any future repair that reaches for a vacated row's
-- stale stack, which is the ammunition every one of these repairs used
-- (a5aa6984 alone holds 11 vacated rows carrying 237,384 chips). This adds
-- zzzzzz_tournament_felt_may_not_exceed_supply: a tournament seat write that
-- GROWS the felt is refused when it is the write that carries the felt above
-- recorded supply. Existing overage is tolerated (history) and only growth is
-- refused, the same shape as fn_ca_assert_tournament_chip_grant and the
-- estate's NOT VALID constraints, so it cannot brick the events already over.
--
-- IT IS DEFERRED, AND THAT IS LOAD-BEARING. fn_ca_settle_hand_stacks_absolute
-- writes a hand's seats ONE ROW AT A TIME inside a single transaction. A BEFORE
-- row trigger reading an aggregate would see the winner credited before the
-- losers are debited, refuse a perfectly conserved hand, and brick dealing at
-- random depending on row order. A DEFERRABLE INITIALLY DEFERRED constraint
-- trigger sees only the committed end state, which is the only state the
-- invariant is about. table_seats already carries four such triggers
-- (tournament_live_seat_has_active_roster among them), so this is the house
-- pattern, not a new one.
--
-- The engine is NOT exempted. fn_caller_is_engine() is true for service_role
-- AND for a NULL request context - psql, pg_cron, a migration - so exempting
-- "the engine" would have waved through the 2026-09-09 repair that caused this.
--
-- Every live writer of a tournament stack was checked against the gate and
-- passes, because each ends its transaction with the felt no higher than
-- supply: fn_ca_settle_hand_stacks_absolute (a conserved hand), the seat
-- assignment path (vacates before it seats), the chip purchase money core
-- (grows supply in the same transaction), and the stale-seat credit in
-- TournamentManagerBase (already refuses in JS via selectSeatsToFund when
-- funding would exceed chipSupply). The chip race is the one path that writes
-- seat stacks in separate transactions; it is dead code, CHIP_RACE_ENABLED =
-- false.
--
-- NO CHECK CONSTRAINT ON A VACATED STACK. The obvious companion - CHECK
-- (left_at IS NULL OR stack = 0) NOT VALID - is deliberately NOT added. The
-- ordinary seat exit stamps left_at and does not touch stack, so 203,847 rows
-- platform-wide already sit that way and, NOT VALID or not, the constraint
-- would refuse EVERY FUTURE seat exit. A guard that can refuse a seat exit
-- strands a player mid-hand, which is exactly what CLAUDE.md forbids of the
-- chips-cannot-leave-the-felt trigger. Zeroing stack on exit is refused for the
-- same reason plus a second: fn_log_seat_stack_exit exists to record the
-- non-zero stack leaving a seat, and both fn_poker_bind_diamond_seat and
-- fn_poker_diamond_seat_keeps_custody match custody on stack = balance. The
-- stale snapshot is disarmed here by refusing to let it reach the felt, which
-- needs no rewrite of 203,847 historical rows.
--
-- Proved first in a rolled-back DO block (11.5): a5aa6984 supply 317,500 felt
-- 320,000 drift 2,500; 7aa16fa7 COMPLETED, last sample +10,000; the sweep at
-- tolerance 0.01 returns 1 row now and 0 with the acknowledgement; and the gate
-- predicate refuses the stale-stack revive and the river222 re-seat while
-- passing a normal move, a hand settlement and a seat exit.

BEGIN;

-- The board must not have moved underneath the probe.
DO $before$
DECLARE
  v_a5 uuid := 'a5aa6984-6c1c-4b59-aeb7-9e7878853bdd';
  v_7a uuid := '7aa16fa7-adf7-4fb9-81b9-b565d8e4af7d';
  v_drift numeric;
  v_status text;
  v_last numeric;
BEGIN
  v_drift := public.fn_ca_tournament_felt_total(v_a5)
           - public.fn_ca_tournament_chip_supply(v_a5);
  IF v_drift <> 2500 THEN
    RAISE EXCEPTION
      'a5aa6984 drift is %, not the 2500 that was measured and decided', v_drift;
  END IF;

  SELECT t.status::text INTO v_status FROM public.tournaments t WHERE t.id = v_7a;
  SELECT s.drift INTO v_last FROM public.ca_tournament_conservation_samples s
   WHERE s.tournament_id = v_7a ORDER BY s.taken_at DESC LIMIT 1;
  -- 7aa16fa7 finished at 05:23:27Z carrying exactly this overage. Either it is
  -- still RUNNING at +10,000, or it is COMPLETED and its last live measurement
  -- was +10,000. Anything else means the board moved and the figure is stale.
  IF NOT ((v_status = 'RUNNING'
           AND public.fn_ca_tournament_felt_total(v_7a)
             - public.fn_ca_tournament_chip_supply(v_7a) = 10000)
          OR (v_status = 'COMPLETED' AND v_last = 10000)) THEN
    RAISE EXCEPTION
      '7aa16fa7 is % with last sampled drift %, not the 10000 that was decided',
      v_status, v_last;
  END IF;
END $before$;

-- The register. Denominated in PLAY CHIPS, which is why it is not
-- tournament_conservation_baseline.
CREATE TABLE public.tournament_felt_supply_acknowledgements (
  tournament_id uuid PRIMARY KEY
    REFERENCES public.tournaments(id) ON DELETE CASCADE,
  chips         numeric NOT NULL CHECK (chips > 0),
  incident_id   uuid,
  reason        text NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.tournament_felt_supply_acknowledgements IS
  'Play-chip supply this platform CREATED by defect and has chosen to absorb '
  'rather than confiscate (CLAUDE.md 10.9 rule 3). Added to '
  'fn_ca_tournament_chip_supply so the conservation meter measures the felt '
  'against what is really on it. NOT money: the money-denominated register is '
  'public.tournament_conservation_baseline, read by '
  'fn_tournament_conservation_delta against wallet_transactions. Never put a '
  'chip figure there or a currency figure here.';

REVOKE ALL ON public.tournament_felt_supply_acknowledgements FROM PUBLIC;
REVOKE ALL ON public.tournament_felt_supply_acknowledgements FROM anon;
REVOKE ALL ON public.tournament_felt_supply_acknowledgements FROM authenticated;
GRANT SELECT ON public.tournament_felt_supply_acknowledgements TO service_role;

INSERT INTO public.tournament_felt_supply_acknowledgements
  (tournament_id, chips, incident_id, reason)
VALUES
  ('7aa16fa7-adf7-4fb9-81b9-b565d8e4af7d', 10000,
   '8b8fe26c-f2f9-458f-a275-a19508b55b58',
   '$100 Freeroll 12:00 PM. 10,000 play chips (2 x starting_chips 5,000) were '
   'created on the felt on 2026-09-09 by the one-shot stranded-seat repair '
   'fn_ca_return_stranded_to_the_felt -> fn_ca_move_tournament_seat '
   '(migrations 20260909175754 / 20260909175822), which restored seats from '
   'table_seats.stack on ALREADY-VACATED rows - a stale snapshot nothing '
   'zeroes - so players were re-seated with chips already paid to whoever '
   'busted them. ca_tournament_conservation_samples: 2026-09-09 22:40 drift '
   '-105,000 -> 22:50 drift +10,000, zero hands dealt in the window. Absorbed, '
   'not confiscated, under CLAUDE.md 10.9 rule 3. Incident '
   '8b8fe26c-f2f9-458f-a275-a19508b55b58.'),
  ('a5aa6984-6c1c-4b59-aeb7-9e7878853bdd', 2500,
   '8b8fe26c-f2f9-458f-a275-a19508b55b58',
   'Early Bird Freeroll (NLH). 2,500 play chips (1 x starting_chips 2,500) '
   'were created on the felt on 2026-09-09 by the one-shot stranded-seat '
   'repair fn_ca_return_stranded_to_the_felt -> fn_ca_move_tournament_seat '
   '(migrations 20260909175754 / 20260909175822), which restored seats from '
   'table_seats.stack on ALREADY-VACATED rows - a stale snapshot nothing '
   'zeroes - so players were re-seated with chips already paid to whoever '
   'busted them. ca_tournament_conservation_samples: 2026-09-09 18:00 drift '
   '-22,500 -> 18:10 drift +2,500, zero hands dealt in the window. This is the '
   'overage STANDING ON THE FELT and is deliberately not 5,000: the stranded '
   'player river222 (dca6c345-c2ab-456f-98d9-dfbca3a43f7d) is a seating '
   'problem and is not paid for with supply that was never created. Absorbed, '
   'not confiscated, under CLAUDE.md 10.9 rule 3. Incident '
   '8b8fe26c-f2f9-458f-a275-a19508b55b58.')
ON CONFLICT (tournament_id) DO NOTHING;

-- The meter counts the chips that are really there. This is the body that was
-- in pg_proc, with the acknowledgement added and nothing else changed.
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_chip_supply(p_tournament_id uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(r.entrants,0)*COALESCE(t.starting_chips,0)
       + COALESCE(r.rebuys,0)
         *COALESCE(NULLIF(t.rebuy_chips,0),t.starting_chips,0)
       + COALESCE(r.addons,0)
         *COALESCE(NULLIF(t.addon_chips,0),t.starting_chips,0)
       + COALESCE(a.chips,0)
    FROM public.tournaments t
    LEFT JOIN LATERAL (
      SELECT count(*) AS entrants,
             COALESCE(sum(GREATEST(COALESCE(tp.rebuys,0),0)),0) AS rebuys,
             count(*) FILTER (WHERE tp.add_on) AS addons
        FROM public.tournament_players tp
       WHERE tp.tournament_id=t.id
    ) r ON true
    LEFT JOIN public.tournament_felt_supply_acknowledgements a
           ON a.tournament_id = t.id
   WHERE t.id=p_tournament_id;
$function$;

-- The gate. Refuses the write that carries a tournament's felt above supply.
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_felt_may_not_exceed_supply()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_was numeric;
  v_now numeric;
  v_delta numeric;
  v_felt numeric;
  v_supply numeric;
BEGIN
  -- What this row contributes to the felt. A vacated seat contributes nothing,
  -- whatever its stack still says - that stale figure is the whole defect.
  v_now := CASE WHEN NEW.left_at IS NULL THEN COALESCE(NEW.stack,0) ELSE 0 END;
  v_was := CASE WHEN TG_OP = 'INSERT' THEN 0
                WHEN OLD.left_at IS NULL THEN COALESCE(OLD.stack,0)
                ELSE 0 END;
  v_delta := v_now - v_was;

  -- Only growth is judged. A seat exit, a losing bet and a no-op never refuse:
  -- a guard that can refuse a seat exit strands a player mid-hand.
  IF v_delta <= 0 THEN
    RETURN NULL;
  END IF;

  SELECT tb.tournament_id INTO v_tournament_id
    FROM public.tables tb WHERE tb.id = NEW.table_id;
  IF v_tournament_id IS NULL THEN
    RETURN NULL;                      -- a cash seat; supply is not the meter
  END IF;

  -- DEFERRED, so this is the committed end state of the whole transaction:
  -- every seat of a settled hand, or the vacate and the re-seat of a move.
  v_felt   := public.fn_ca_tournament_felt_total(v_tournament_id);
  v_supply := public.fn_ca_tournament_chip_supply(v_tournament_id);

  -- Tolerate history, refuse growth: only the write that CARRIES the felt over
  -- the line is refused. An event already over stays playable.
  IF v_felt > v_supply AND (v_felt - v_delta) <= v_supply THEN
    RAISE EXCEPTION
      'TOURNAMENT_FELT_WOULD_EXCEED_SUPPLY: seat % (table %, seat %) adds % chips, '
      'leaving % on the felt of tournament % against % ever bought in',
      NEW.id, NEW.table_id, NEW.seat_number, v_delta, v_felt,
      v_tournament_id, v_supply
      USING ERRCODE = '55000',
            HINT = 'A vacated seat''s stack is a stale snapshot, not chips. '
                   'Fund a seat from the felt the player is leaving, or record '
                   'the creation in tournament_felt_supply_acknowledgements.';
  END IF;

  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER zzzzzz_tournament_felt_may_not_exceed_supply
  AFTER INSERT OR UPDATE OF stack, left_at ON public.table_seats
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_ca_tournament_felt_may_not_exceed_supply();

-- The outcome, asserted in the same transaction that made it.
DO $after$
DECLARE
  v_a5 uuid := 'a5aa6984-6c1c-4b59-aeb7-9e7878853bdd';
  v_7a uuid := '7aa16fa7-adf7-4fb9-81b9-b565d8e4af7d';
  v_n integer;
  v_felt numeric;
BEGIN
  IF (SELECT count(*) FROM public.tournament_felt_supply_acknowledgements) <> 2 THEN
    RAISE EXCEPTION 'the register must hold exactly the two acknowledged events';
  END IF;
  IF public.fn_ca_tournament_chip_supply(v_a5) <> 320000 THEN
    RAISE EXCEPTION 'a5aa6984 supply is % after the acknowledgement, not 320000',
      public.fn_ca_tournament_chip_supply(v_a5);
  END IF;
  IF public.fn_ca_tournament_chip_supply(v_7a) <> 2515000 THEN
    RAISE EXCEPTION '7aa16fa7 supply is % after the acknowledgement, not 2515000',
      public.fn_ca_tournament_chip_supply(v_7a);
  END IF;

  -- Not one player's stack moved: the felt is the figure the probe measured.
  v_felt := public.fn_ca_tournament_felt_total(v_a5);
  IF v_felt <> 320000 THEN
    RAISE EXCEPTION 'a5aa6984 felt is % - a stack moved during this migration', v_felt;
  END IF;
  IF public.fn_ca_tournament_felt_total(v_a5)
     - public.fn_ca_tournament_chip_supply(v_a5) <> 0 THEN
    RAISE EXCEPTION 'a5aa6984 drift did not close';
  END IF;

  -- The incident's own instrument, at the tolerance the sweep uses.
  SELECT count(*) INTO v_n FROM public.fn_tournament_chip_conservation_check(0.01);
  IF v_n <> 0 THEN
    RAISE EXCEPTION
      'fn_tournament_chip_conservation_check(0.01) still returns % row(s)', v_n;
  END IF;

  -- And the gate is armed, deferred, on the two columns that carry the felt.
  SELECT count(*) INTO v_n FROM pg_trigger t
   WHERE t.tgrelid = 'public.table_seats'::regclass
     AND t.tgname = 'zzzzzz_tournament_felt_may_not_exceed_supply'
     AND t.tgdeferrable AND t.tginitdeferred;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the felt gate is not armed as a deferred constraint trigger';
  END IF;
END $after$;

COMMIT;
