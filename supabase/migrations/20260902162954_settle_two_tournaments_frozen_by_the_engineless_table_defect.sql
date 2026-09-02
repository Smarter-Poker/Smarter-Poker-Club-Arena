-- ============================================================================
--  SETTLE TWO TOURNAMENTS FROZEN BY THE ENGINELESS-TABLE DEFECT (2026-09-02)
-- ============================================================================
--  Applied to production 2026-09-02 16:29Z. Recorded here because the repo is
--  where the reasoning has to live; the ledger only keeps the SQL.
--
--  Both events stopped because a table was OPEN in the database while holding
--  no dealer in the engine process. Every sweep walks the engine map, so none
--  could see the table, and the players on it froze under a live tournament.
--  Engine fix: PR #2643. This settles the two already stuck when it landed.
--
--    f1b134c0  "$100 Freeroll 6:00 PM"   COMPLETING 15h, nothing ever paid
--    39f751e9  "$100 Freeroll 12:00 AM"  COMPLETING, 1st place never awarded
--
--  Both plans ran first in a transaction ended by RAISE EXCEPTION and the
--  numbers below are that probe's numbers. Money moves only through
--  fn_tournament_payout_reconcile, which reads prior payment from
--  tournament_payouts and credits under a per-user idempotency key.
--
--  f1b134c0: 21 eliminated players held places 1-21 with prize 0.00, no payout
--  row existed at all, and the two players still holding chips held no place.
--  The order was inverted at the tail: the four who busted LAST held 18-21.
--  Nothing had been paid, so restating from eliminated_at contradicts nothing.
--  Survivors take 1st and 2nd on chip count (122,593 v 1,781) which is also the
--  ICM answer: a chip-chop pays the short stack 0.70 against a locked 20.00.
--
--  39f751e9: StackRat sat on table 7 with 5,000 chips; that table went
--  engineless at 07:08; at 07:48 KickerWolf busted on table 24 and the engine,
--  seeing two entrants where three were alive, recorded him 2nd and paid 41.71.
--  The field is NOT re-derived: re-ranking all 215 places from eliminated_at
--  moved players by up to three places and wanted 168.51 in top-ups on a pool
--  with 282.06 already out the door. The live engine watched each player bust;
--  the timestamps had not. Recorded order preserved, ONE player inserted.
--  The 20 already-paid places below 2nd are each one place too generous and
--  none is clawed back. The house absorbed 41.71.
--
--  Authority: Dan 2026-09-02, CLAUDE.md 10.9.
-- ============================================================================

DO $$
DECLARE
  v_six   uuid := 'f1b134c0-6a71-4349-a8ef-e344ff12439e';
  v_mid   uuid := '39f751e9-b905-4735-8cab-fe431220fd43';
  v_res   jsonb;
  v_total numeric;
  v_dupes int;
BEGIN
  UPDATE tournament_players SET position = NULL WHERE tournament_id = v_six;

  WITH ranked AS (
    SELECT id, row_number() OVER (
             ORDER BY (status = 'playing') DESC,
                      CASE WHEN status = 'playing' THEN chips END DESC NULLS LAST,
                      eliminated_at DESC NULLS LAST,
                      user_id) AS newpos
      FROM tournament_players WHERE tournament_id = v_six)
  UPDATE tournament_players tp SET position = r.newpos FROM ranked r WHERE tp.id = r.id;

  CREATE TEMP TABLE _old_places ON COMMIT DROP AS
    SELECT id, position FROM tournament_players
     WHERE tournament_id = v_mid AND position IS NOT NULL;

  UPDATE tournament_players SET position = NULL WHERE tournament_id = v_mid;
  UPDATE tournament_players tp SET position = o.position + 1
    FROM _old_places o WHERE tp.id = o.id;
  UPDATE tournament_players SET position = 1
   WHERE tournament_id = v_mid AND user_id = '649d02d1-ce26-4c24-adde-b3f428ec2353';
  UPDATE tournament_players SET position = 2
   WHERE tournament_id = v_mid AND user_id = 'face0000-0000-0000-0000-000000000003';

  UPDATE tournament_players SET status = 'winner'
   WHERE tournament_id IN (v_six, v_mid) AND position = 1;
  UPDATE tournament_players SET status = 'eliminated', eliminated_at = COALESCE(eliminated_at, now())
   WHERE tournament_id IN (v_six, v_mid) AND status = 'playing';
  UPDATE tournaments SET status = 'COMPLETED' WHERE id IN (v_six, v_mid);

  SELECT count(*) INTO v_dupes FROM (
    SELECT tournament_id, position FROM tournament_players
     WHERE tournament_id IN (v_six, v_mid) AND position IS NOT NULL
     GROUP BY 1, 2 HAVING count(*) > 1) d;
  IF v_dupes > 0 THEN
    RAISE EXCEPTION 'refusing to pay: % contested place(s) after renumber', v_dupes;
  END IF;

  v_res := public.fn_tournament_payout_reconcile(v_six, true);
  IF COALESCE(v_res->>'ok', 'false') <> 'true' THEN
    RAISE EXCEPTION 'f1b134c0 reconcile refused: %', v_res;
  END IF;

  v_res := public.fn_tournament_payout_reconcile(v_mid, true);
  IF COALESCE(v_res->>'ok', 'false') <> 'true' THEN
    RAISE EXCEPTION '39f751e9 reconcile refused: %', v_res;
  END IF;

  SELECT round(COALESCE(sum(amount), 0), 2) INTO v_total
    FROM tournament_payouts WHERE tournament_id = v_six;
  IF v_total <> 100.00 THEN
    RAISE EXCEPTION 'f1b134c0 paid %, expected 100.00', v_total;
  END IF;

  SELECT round(COALESCE(sum(amount), 0), 2) INTO v_total
    FROM tournament_payouts WHERE tournament_id = v_mid;
  IF v_total <> 396.41 THEN
    RAISE EXCEPTION '39f751e9 paid %, expected 396.41', v_total;
  END IF;

  UPDATE table_seats s SET left_at = now()
    FROM tables t
   WHERE t.id = s.table_id AND t.tournament_id IN (v_six, v_mid) AND s.left_at IS NULL;

  UPDATE tables SET status = 'closed'
   WHERE tournament_id IN (v_six, v_mid) AND status <> 'closed';
END $$;
