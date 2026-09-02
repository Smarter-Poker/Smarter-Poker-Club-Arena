-- the_club_share_comes_from_the_rake_treasury_weekly patched
-- atomic_distribute_rake and left record_rake alone, because the assignment
-- there is padded differently and the guard correctly refused to touch what it
-- did not recognise rather than guessing.
--
-- record_rake is the LEGACY club-side path. It delegates union games to
-- atomic_distribute_rake, so it only runs for a private or union-less game -
-- but it carries exactly the same per-hand pre-payment and would re-open the
-- hole the first time such a game ran. A half-applied ruling is worse than an
-- unapplied one, because it looks finished.
--
-- ROLLBACK: restore `chip_balance = chip_balance + (p_rake_amount - v_bbj_amount),`

DO $legacy$
DECLARE
  v_def text;
  v_old text := 'chip_balance              = chip_balance + (p_rake_amount - v_bbj_amount),';
  v_new text := 'chip_balance              = chip_balance,  -- 2026-09-02 ruling: the club share is paid weekly from the rake treasury, not per hand';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'record_rake';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'record_rake not found';
  END IF;
  IF position('the club share is paid weekly' in v_def) > 0 THEN
    RAISE NOTICE 'already applied; nothing to do';
    RETURN;
  END IF;
  IF position(v_old in v_def) = 0 THEN
    RAISE EXCEPTION 'the club_wallets credit in record_rake is not where this migration expects it; read the function before re-running';
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END $legacy$;
