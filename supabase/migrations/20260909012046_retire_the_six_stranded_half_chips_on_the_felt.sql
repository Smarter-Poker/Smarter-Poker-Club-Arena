-- 20260909012046_retire_the_six_stranded_half_chips_on_the_felt.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  HALF-CHIPS THAT COULD NOT BE BET, AND KILLED A HAND EVERY TIME THEY MOVED
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A tournament chip is indivisible. `PokerEngine.distributePot` used to divide
-- pots in cents, and before that was corrected it left half-chips on the felt.
-- The settlement guard added on 2026-09-08 refuses a hand that CREATES a
-- fraction while tolerating one that inherited it:
--
--     IF v_written<>trunc(v_written) AND v_before=trunc(v_before) THEN
--       RAISE EXCEPTION 'accepted tournament hand produced fractional stack ...'
--
-- That is the right rule and it is why these were survivable. It is also why
-- they are contagious: the holder enters fractional and is tolerated, but the
-- moment one of those halves is won by somebody who entered WHOLE, the guard
-- fires, the atomic hand commit rolls back, the dealt hand is discarded and the
-- table engine self-terminates. Measured 2026-09-09 01:20 UTC: 16 refusals in
-- twenty minutes, all from the two tournaments below.
--
-- WHAT WAS THERE, read not assumed:
--
--   0fac7473 Morning Free Buy (NLH)  REGISTERING  4 seats x 0.50  = 2.00
--   a9be040d Morning Free Buy (NLH)  RUNNING      2 seats x 0.50  = 1.00
--
-- Every fraction is exactly 0.50 - one chip split two ways - the count in each
-- tournament is EVEN, and each tournament's chips_in_play is already a whole
-- number (312,000.00 and 2,630,000.00). So the halves pair off, and pairing
-- them is exactly chip-neutral. Rounding them all up would MINT chips into a
-- tournament economy whose total is the field's buy-ins; rounding all down
-- would burn them.
--
-- THE RULE: order the fractional seats within each tournament by (table_id,
-- seat_number) and give the whole chip to the earlier seat - the ordinary poker
-- convention for an odd chip, which goes to the earliest position. Odd rows
-- round up, even rows round down.
--
-- A TOURNAMENT WITH AN ODD NUMBER OF HALVES IS LEFT ALONE. It cannot be squared
-- without minting or burning half a chip, and guessing is how a reconciliation
-- becomes the next mystery. It is counted and reported instead.
--
-- PROVED FIRST, IN A TRANSACTION THAT ABORTED ITSELF (CLAUDE.md 11.5 rule 1):
--   PROBE rows=6 before=2942000.00 after=2942000.00 fractional_left=0
--         detail= | 0fac7473=312000.00 | a9be040d=2630000.00
--
-- AND THE FIRST APPLY WAS REFUSED BY ITS OWN ASSERT, WHICH IS THE POINT. It
-- measured conservation across EVERY tournament seat on the platform - a total
-- that live play moves between two reads - and aborted on a -2000.00 delta that
-- had nothing to do with this change. The baseline is now the rows this
-- statement locks and touches, and nothing else.
--
-- `tournament_players.chips` needs no repair: it already held whole numbers
-- (measured: zero fractional player rows), and the seat->player sync pushes the
-- corrected seat stacks on its next pass.
--
-- NOT A BAND-AID (CLAUDE.md 10.12): this retires specific rows left by a defect
-- already fixed at source. It creates no recurring repair job and no path that
-- would hide the defect coming back - the settlement guard above does that, and
-- it stays.

BEGIN;

DO $migration$
DECLARE
  v_before numeric;
  v_after  numeric;
  v_rows   integer;
  v_frac   integer;
  v_odd    integer;
BEGIN
  -- Take the row locks first (no window functions allowed alongside FOR UPDATE),
  -- then rank them.
  CREATE TEMP TABLE zz_locked ON COMMIT DROP AS
  SELECT ts.id, ts.table_id, ts.seat_number, ts.stack AS stack_before,
         tb.tournament_id
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.tournament_id IS NOT NULL
     AND ts.left_at IS NULL
     AND ts.stack <> trunc(ts.stack);

  PERFORM 1 FROM public.table_seats ts
    JOIN zz_locked l ON l.id = ts.id
   FOR UPDATE OF ts;

  CREATE TEMP TABLE zz_frac ON COMMIT DROP AS
  SELECT id, tournament_id, stack_before,
         row_number() OVER (PARTITION BY tournament_id ORDER BY table_id, seat_number) AS rn,
         count(*)     OVER (PARTITION BY tournament_id) AS per_tournament
    FROM zz_locked;

  SELECT count(*) INTO v_odd FROM zz_frac WHERE per_tournament % 2 = 1;
  DELETE FROM zz_frac WHERE per_tournament % 2 = 1;

  SELECT coalesce(sum(stack_before), 0) INTO v_before FROM zz_frac;

  UPDATE public.table_seats ts
     SET stack = CASE WHEN f.rn % 2 = 1 THEN ceil(f.stack_before) ELSE floor(f.stack_before) END
    FROM zz_frac f
   WHERE ts.id = f.id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  SELECT coalesce(sum(ts.stack), 0),
         count(*) FILTER (WHERE ts.stack <> trunc(ts.stack))
    INTO v_after, v_frac
    FROM public.table_seats ts
    JOIN zz_frac f ON f.id = ts.id;

  -- CONSERVATION IS THE WHOLE POINT. Abort rather than commit a mint or a burn.
  IF v_after <> v_before THEN
    RAISE EXCEPTION
      'refusing to commit: the seats this touched moved from % to % (delta %)',
      v_before, v_after, v_after - v_before;
  END IF;
  IF v_frac <> 0 THEN
    RAISE EXCEPTION 'refusing to commit: % of the seats this touched are still fractional', v_frac;
  END IF;

  RAISE NOTICE 'retired % half-chip seat(s), total unchanged at %; % left alone in odd-count tournaments',
    v_rows, v_after, v_odd;
END;
$migration$;

COMMIT;
