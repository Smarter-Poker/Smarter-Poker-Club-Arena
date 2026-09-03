-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902172856; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
--  A SPIN PAYS THE LADDER THE WHEEL DREW  (Dan's call, 2026-09-02, issue #2648)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- MEASURED. 95 completed Spins at 10x and above carry
-- payout_structure = [{"place":1,"percentage":100}] on their own row. A 10x
-- owes 80/20 and a 25x/50x/100x owes 80/12/8. On every one of those 95 games
-- first place was paid the WHOLE pool and second (and third) were paid nothing.
-- Correlation is exact: every game with a corrupted ladder underpaid, and no
-- game with a correct ladder did.
--
-- TWO ERAS, one symptom:
--   * 2026-06-10 -> 2026-08-20, compact JSON: the engine's cache dropped
--     payout_structure from the draw patch (fixed in code by #2645).
--   * 2026-09-02 04:13 -> 17:18, numeric-formatted JSON: a REGRESSION.
--     fn_ca_fund_overlay_on_lock rewrote the ladder from the size of the field
--     ("pay the top N%"), which on three seats rounds to one place and
--     replaced every high multiplier with winner-take-all. Between those eras
--     the ladder was correct for twelve days, which is why this is a
--     regression and not one long-running bug. That trigger now skips spins.
--
-- WHY THIS WENT UNSEEN. fn_tournament_payout_reconcile reads
-- tournaments.payout_structure as its source of truth. With the column
-- corrupted it computed "expected = 100% to place 1", saw place 1 paid in
-- full, and returned clean:true. The corruption made itself invisible to the
-- one check that would have caught it. Restoring the column is therefore not
-- cosmetic: it is what lets every existing guard see these games at all.
--
-- WHAT THIS DOES, in one transaction:
--   1. Aligns tournaments_spin_no_extra_rake with its sibling constraint.
--   2. Restores the drawn ladder on completed Spins.
--   3. Pays the shortfall through fn_tournament_payout_reconcile.
--   4. Aborts on any assumption it does not like.
--
-- HORSES ARE PAID (CLAUDE.md 10.5). All 97 payments are horses. They pay the
-- same buy-in from the same wallet and they are paid the same, with no
-- is_horse branch anywhere below.
--
-- FIRST PLACE KEEPS ITS OVERPAYMENT. The reconciler reports 'overpaid' and
-- deliberately performs no clawback. Dan asked for the shortfall to be paid,
-- not for money to be taken back off winners.

-- ── 1. the constraint that blocked its own repair ──────────────────────────
-- tournaments_spin_has_no_fee grandfathers rows created before 2026-08-21;
-- tournaments_spin_no_extra_rake asserts the same rule with NO date clause,
-- so it re-validates on any UPDATE and makes 7,120 historical rows
-- permanently un-editable. Both are NOT VALID, so neither ever checked those
-- rows on the way in - the second one only ever fired on someone trying to
-- FIX one. It protects nothing the first does not (0 spins created on or
-- after the cutoff carry a fee) and it blocked this repair.
ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS tournaments_spin_no_extra_rake;
ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_spin_no_extra_rake
  CHECK (
    created_at < '2026-08-21 00:00:00+00'::timestamptz
    OR ((variant IS DISTINCT FROM 'spin') AND (upper(COALESCE(tournament_type,'')) <> 'SPIN'))
    OR COALESCE(buy_in_fee, 0) = 0
  ) NOT VALID;

-- ── 2 + 3. restore the ladder, then pay what it says ───────────────────────
DO $backpay$
DECLARE
  v_fixed     int := 0;
  v_games     int := 0;
  v_payments  int := 0;
  v_topup     numeric := 0;
  v_unexpected int := 0;
  r record;
  res jsonb;
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
    UPDATE public.tournaments t
       SET payout_structure = l.correct::text
      FROM ladder l
     WHERE l.mult = t.spin_multiplier
       AND t.tournament_type = 'SPIN'
       AND t.status = 'COMPLETED'
       AND t.payout_structure::jsonb IS DISTINCT FROM l.correct
    RETURNING t.id
  )
  SELECT count(*) INTO v_fixed FROM upd;

  FOR r IN
    SELECT t.id FROM public.tournaments t
     WHERE t.tournament_type = 'SPIN' AND t.status = 'COMPLETED'
       AND t.spin_multiplier >= 10
     ORDER BY t.ended_at
  LOOP
    res := public.fn_tournament_payout_reconcile(r.id, true);

    IF COALESCE((res->>'total_top_up')::numeric, 0) > 0 THEN
      v_games    := v_games + 1;
      v_topup    := v_topup + (res->>'total_top_up')::numeric;
      v_payments := v_payments + jsonb_array_length(COALESCE(res->'actions', '[]'::jsonb));
    END IF;

    -- 'overpaid' (first place kept the pool) and 'no_finisher_recorded' (a
    -- place nobody reached) are expected and accepted here. Anything else -
    -- a refused idempotency key, duplicate finishers, a place already paid to
    -- someone else - means this migration does not understand the data and
    -- must not decide what to do about it.
    v_unexpected := v_unexpected + (
      SELECT count(*) FROM jsonb_array_elements(COALESCE(res->'issues', '[]'::jsonb)) i
       WHERE i->>'issue' NOT IN ('overpaid', 'no_finisher_recorded')
    );
  END LOOP;

  IF v_unexpected > 0 THEN
    RAISE EXCEPTION 'ABORT: % unexpected reconciler issue(s); nothing paid.', v_unexpected;
  END IF;

  -- Sanity ceiling. The probe measured 1,878.00 across 97 payments; a few more
  -- games can complete between probe and apply, but an order of magnitude more
  -- means the ladder table or the affected set is not what was measured.
  IF v_topup > 4000 THEN
    RAISE EXCEPTION 'ABORT: top-up % exceeds the 4000 sanity ceiling; nothing paid.', v_topup;
  END IF;

  IF v_fixed = 0 AND v_topup = 0 THEN
    RAISE NOTICE 'Nothing to do: no corrupted ladders and no shortfall.';
  END IF;

  RAISE NOTICE 'Spin back-pay: % ladders restored, % games, % payments, % chips.',
    v_fixed, v_games, v_payments, v_topup;
END
$backpay$;
