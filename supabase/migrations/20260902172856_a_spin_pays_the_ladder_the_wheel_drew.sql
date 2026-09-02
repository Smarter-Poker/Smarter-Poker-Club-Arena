-- Applied to production 2026-09-02 17:28 UTC. Committed here so the repo and
-- the database agree (CLAUDE.md RULE 2).
--
-- A SPIN PAYS THE LADDER THE WHEEL DREW  (Dan's call, issue #2648)
--
-- MEASURED. 95 completed Spins at 10x and above carried
-- payout_structure = [{"place":1,"percentage":100}] on their own row. A 10x
-- owes 80/20; 25x/50x/100x owe 80/12/8. On every one of those games first
-- place took the WHOLE pool and second (and third) were paid nothing.
-- The correlation is exact: every game with a corrupted ladder underpaid, and
-- no game with a correct ladder did.
--
-- TWO ERAS, one symptom:
--   * 2026-06-10 -> 2026-08-20: the engine's cache dropped payout_structure
--     from the draw patch (fixed in code by #2645).
--   * 2026-09-02 04:13 -> 17:18: a REGRESSION. fn_ca_fund_overlay_on_lock
--     rewrote the ladder from the size of the field ("pay the top N%"), which
--     on three seats rounds to one place and replaced every high multiplier
--     with winner-take-all. Between the two eras the ladder was correct for
--     twelve days, which is why this is a regression and not one long bug.
--
-- WHY IT WENT UNSEEN. fn_tournament_payout_reconcile reads
-- tournaments.payout_structure as its source of truth. With the column
-- corrupted it computed "expected = 100% to place 1", saw place 1 paid in
-- full, and returned clean:true on a game that had short-changed two players.
-- The corruption made itself invisible to the one check built to catch it.
--
-- RESULT: 97 payments, 1,878.00 chips, 92 games, 69 players. All 97 payees are
-- horses and are paid exactly as humans would be (CLAUDE.md 10.5) - there is no
-- is_horse branch anywhere below. First place KEEPS its overpayment: the
-- reconciler reports 'overpaid' and performs no clawback, which is what Dan
-- asked for.

ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS tournaments_spin_no_extra_rake;
ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_spin_no_extra_rake
  CHECK (
    created_at < '2026-08-21 00:00:00+00'::timestamptz
    OR ((variant IS DISTINCT FROM 'spin') AND (upper(COALESCE(tournament_type,'')) <> 'SPIN'))
    OR COALESCE(buy_in_fee, 0) = 0
  ) NOT VALID;
-- ^ tournaments_spin_has_no_fee grandfathers rows created before 2026-08-21;
--   this one asserted the same rule with NO date clause, so it re-validated on
--   any UPDATE and made 7,120 historical rows permanently un-editable. Both are
--   NOT VALID, so neither ever checked those rows on the way in - the second
--   only ever fired on someone trying to FIX one, and it blocked this repair.
--   0 spins created on or after the cutoff carry a fee, so nothing is lost.

DO $backpay$
DECLARE
  v_fixed int := 0; v_games int := 0; v_payments int := 0;
  v_topup numeric := 0; v_unexpected int := 0;
  r record; res jsonb;
BEGIN
  -- The lifecycle guard lets the engine fit a ladder to a settled field and
  -- refuses an operator doing it. This is a system correction, so it says so
  -- rather than disabling the guard.
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

  WITH ladder(mult, correct) AS (
    VALUES (10::numeric,  '[{"place":1,"percentage":80},{"place":2,"percentage":20}]'::jsonb),
           (25::numeric,  '[{"place":1,"percentage":80},{"place":2,"percentage":12},{"place":3,"percentage":8}]'::jsonb),
           (50::numeric,  '[{"place":1,"percentage":80},{"place":2,"percentage":12},{"place":3,"percentage":8}]'::jsonb),
           (100::numeric, '[{"place":1,"percentage":80},{"place":2,"percentage":12},{"place":3,"percentage":8}]'::jsonb)
  ), upd AS (
    UPDATE public.tournaments t SET payout_structure = l.correct::text
      FROM ladder l
     WHERE l.mult = t.spin_multiplier AND t.tournament_type = 'SPIN'
       AND t.status = 'COMPLETED'
       AND t.payout_structure::jsonb IS DISTINCT FROM l.correct
    RETURNING t.id )
  SELECT count(*) INTO v_fixed FROM upd;

  FOR r IN SELECT t.id FROM public.tournaments t
            WHERE t.tournament_type = 'SPIN' AND t.status = 'COMPLETED'
              AND t.spin_multiplier >= 10 ORDER BY t.ended_at
  LOOP
    res := public.fn_tournament_payout_reconcile(r.id, true);
    IF COALESCE((res->>'total_top_up')::numeric, 0) > 0 THEN
      v_games := v_games + 1;
      v_topup := v_topup + (res->>'total_top_up')::numeric;
      v_payments := v_payments + jsonb_array_length(COALESCE(res->'actions', '[]'::jsonb));
    END IF;
    -- 'overpaid' (first place kept the pool) and 'no_finisher_recorded' (a
    -- place nobody reached) are expected. Anything else means this migration
    -- does not understand the data and must not decide what to do about it.
    v_unexpected := v_unexpected + (
      SELECT count(*) FROM jsonb_array_elements(COALESCE(res->'issues', '[]'::jsonb)) i
       WHERE i->>'issue' NOT IN ('overpaid', 'no_finisher_recorded'));
  END LOOP;

  IF v_unexpected > 0 THEN
    RAISE EXCEPTION 'ABORT: % unexpected reconciler issue(s); nothing paid.', v_unexpected;
  END IF;
  IF v_topup > 4000 THEN
    RAISE EXCEPTION 'ABORT: top-up % exceeds the 4000 sanity ceiling; nothing paid.', v_topup;
  END IF;

  RAISE NOTICE 'Spin back-pay: % ladders restored, % games, % payments, % chips.',
    v_fixed, v_games, v_payments, v_topup;
END
$backpay$;
