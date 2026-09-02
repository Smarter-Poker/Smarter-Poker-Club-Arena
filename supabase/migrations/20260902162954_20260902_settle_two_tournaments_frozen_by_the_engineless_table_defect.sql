-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902162954; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- ============================================================================
--  SETTLE TWO TOURNAMENTS FROZEN BY THE ENGINELESS-TABLE DEFECT (2026-09-02)
-- ============================================================================
--
-- Both events stopped because a table was OPEN in this database while holding
-- no dealer in the engine process. Every sweep on the platform walks the engine
-- map, so none of them could see the table, and the players on it were frozen
-- with the tournament above them still live. The engine fix is PR #2643; this
-- migration settles the two events that were already stuck when it landed.
--
--   f1b134c0  "$100 Freeroll 6:00 PM"   COMPLETING 15h, nothing ever paid
--   39f751e9  "$100 Freeroll 12:00 AM"  COMPLETING, 1st place never awarded
--
-- Both plans below were executed first inside a transaction that was rolled
-- back by RAISE EXCEPTION, and the numbers here are the numbers that probe
-- returned. Money moves only through fn_tournament_payout_reconcile, which
-- reads what was already paid from tournament_payouts and credits shortfalls
-- under a per-user idempotency key, so it cannot pay a place twice.
--
-- ---------------------------------------------------------------------------
-- f1b134c0 - the finishing order was nonsense and no prize was ever paid
-- ---------------------------------------------------------------------------
-- 21 eliminated players held places 1..21 with prize 0.00, no tournament_payouts
-- row existed at all, and the two players still holding chips held no place.
-- The recorded order was also inverted at the tail: the four who busted LAST
-- (00:34, 00:38, 00:42, 00:46) held places 18..21 while players who busted at
-- 00:31 held places 1..16. Nothing had been paid, so nothing is contradicted by
-- restating the order from eliminated_at, which is complete for all 21 rows.
--
-- The two survivors take 1st and 2nd on chip count: 122,593 against 1,781, so
-- the leader holds 98.6% of the chips in play. This is also the ICM answer -- a
-- chip-chop would pay the short stack 0.70, far below the 20.00 that 2nd place
-- guarantees, and no settlement pays a player less than a locked-up place.
-- Pays the full 100.00 pool across 9 places. Nobody is paid twice.
--
-- ---------------------------------------------------------------------------
-- 39f751e9 - a live player was left out of the count, so 2nd was awarded early
-- ---------------------------------------------------------------------------
-- StackRat sat on table 7 with 5,000 chips. That table went engineless at
-- 07:08. At 07:48 KickerWolf busted on table 24 and the engine, which could see
-- only two entrants, recorded him 2nd and paid him 41.71. Three players were
-- alive. StackRat outlasted him and is 2nd; every recorded place from 2 down is
-- one place too good.
--
-- The whole field is NOT re-derived here. A first attempt re-ranked all 215 rows
-- by eliminated_at and moved players by up to three places, which would have
-- produced 168.51 of top-ups on a pool with 282.06 already paid -- the timestamps
-- disagree with the order the live engine recorded, and the live engine, which
-- watched each player bust, is the better witness. So the recorded order is
-- preserved exactly and ONE player is inserted into it.
--
-- Consequence, accepted deliberately: the 20 already-paid places below 2nd are
-- each one place too generous by their own new number, 41.71 down to 6.88, and
-- none of it is clawed back. Those players did nothing wrong and the platform
-- does not take money back from a player for its own defect. The reconciler
-- reports them as 'overpaid' and pays nothing further. The house therefore
-- absorbs 41.71 -- StackRat's 2nd-place money on a pool the winner's 72.64
-- already closes exactly -- which is the correct price for freezing a live
-- player out of a tournament.
--
-- Authority: Dan, 2026-09-02, standing grant that an agent settles real money
-- itself when the path of correction and reconciliation is clear. It is clear
-- here: nothing is paid twice, nothing is taken back, and every number above
-- came out of a rolled-back probe before a single chip moved.
-- ============================================================================

DO $$
DECLARE
  v_six   uuid := 'f1b134c0-6a71-4349-a8ef-e344ff12439e';
  v_mid   uuid := '39f751e9-b905-4735-8cab-fe431220fd43';
  v_res   jsonb;
  v_total numeric;
  v_dupes int;
BEGIN
  -- ── f1b134c0: restate the order from scratch ──────────────────────────────
  UPDATE tournament_players SET position = NULL WHERE tournament_id = v_six;

  WITH ranked AS (
    SELECT id, row_number() OVER (
             ORDER BY (status = 'playing') DESC,
                      CASE WHEN status = 'playing' THEN chips END DESC NULLS LAST,
                      eliminated_at DESC NULLS LAST,
                      user_id) AS newpos
      FROM tournament_players WHERE tournament_id = v_six)
  UPDATE tournament_players tp SET position = r.newpos FROM ranked r WHERE tp.id = r.id;

  -- ── 39f751e9: preserve the engine's order, insert the frozen-out player ───
  CREATE TEMP TABLE _old_places ON COMMIT DROP AS
    SELECT id, position FROM tournament_players
     WHERE tournament_id = v_mid AND position IS NOT NULL;

  UPDATE tournament_players SET position = NULL WHERE tournament_id = v_mid;
  UPDATE tournament_players tp SET position = o.position + 1
    FROM _old_places o WHERE tp.id = o.id;
  UPDATE tournament_players SET position = 1
   WHERE tournament_id = v_mid AND user_id = '649d02d1-ce26-4c24-adde-b3f428ec2353';  -- WheelWolf, 1,636,506
  UPDATE tournament_players SET position = 2
   WHERE tournament_id = v_mid AND user_id = 'face0000-0000-0000-0000-000000000003';  -- StackRat, frozen out at 07:08

  -- ── close both events ────────────────────────────────────────────────────
  UPDATE tournament_players SET status = 'winner'
   WHERE tournament_id IN (v_six, v_mid) AND position = 1;
  UPDATE tournament_players SET status = 'eliminated', eliminated_at = COALESCE(eliminated_at, now())
   WHERE tournament_id IN (v_six, v_mid) AND status = 'playing';
  UPDATE tournaments SET status = 'COMPLETED' WHERE id IN (v_six, v_mid);

  -- A place held by two players is paid twice: the prize idempotency key
  -- carries the user id. trg_tournament_place_collision enforces this per row;
  -- this asserts the finished shape.
  SELECT count(*) INTO v_dupes FROM (
    SELECT tournament_id, position FROM tournament_players
     WHERE tournament_id IN (v_six, v_mid) AND position IS NOT NULL
     GROUP BY 1, 2 HAVING count(*) > 1) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION 'refusing to pay: % contested place(s) after renumber', v_dupes;
  END IF;

  -- ── pay ──────────────────────────────────────────────────────────────────
  v_res := public.fn_tournament_payout_reconcile(v_six, true);
  IF COALESCE(v_res->>'ok', 'false') <> 'true' THEN
    RAISE EXCEPTION 'f1b134c0 reconcile refused: %', v_res;
  END IF;

  v_res := public.fn_tournament_payout_reconcile(v_mid, true);
  IF COALESCE(v_res->>'ok', 'false') <> 'true' THEN
    RAISE EXCEPTION '39f751e9 reconcile refused: %', v_res;
  END IF;

  -- The probe said 100.00 and 396.41. If the live run disagrees, something
  -- moved underneath this migration and it must not commit.
  SELECT round(COALESCE(sum(amount), 0), 2) INTO v_total
    FROM tournament_payouts WHERE tournament_id = v_six;
  IF v_total <> 100.00 THEN
    RAISE EXCEPTION 'f1b134c0 paid %, expected 100.00', v_total;
  END IF;

  SELECT round(COALESCE(sum(amount), 0), 2) INTO v_total
    FROM tournament_payouts WHERE tournament_id = v_mid;
  IF v_total <> 396.41 THEN
    RAISE EXCEPTION '39f751e9 paid %, expected 396.41 (282.06 already paid + 72.64 + 41.71)', v_total;
  END IF;

  -- ── release the felt ─────────────────────────────────────────────────────
  -- Tournament chips are not wallet chips, so a tournament seat exit is not a
  -- money movement: ca_seat_stack_exits holds zero rows for the 216 seats of
  -- the 6:00 AM event that completed normally today. Same treatment here.
  UPDATE table_seats s SET left_at = now()
    FROM tables t
   WHERE t.id = s.table_id AND t.tournament_id IN (v_six, v_mid) AND s.left_at IS NULL;

  UPDATE tables SET status = 'closed'
   WHERE tournament_id IN (v_six, v_mid) AND status <> 'closed';
END $$;
