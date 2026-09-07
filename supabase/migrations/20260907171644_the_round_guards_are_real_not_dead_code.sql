-- THE ROUND GUARDS ARE REAL, NOT DEAD CODE
-- =============================================================================
-- PHASE 1 of 8, second correction, found by verifying my own work rather than
-- trusting it.
--
-- 20260907164234 claimed the cascade "ABORTS after any round that reports
-- failure". That is true of round 1 and FALSE of rounds 2 and 3, because the
-- guards I wrote for them cannot fire:
--
--     IF v_r2 ? 'success' AND ...
--     IF v_r3 ? 'success' AND ...
--
-- Neither function returns a 'success' key. Both have exactly ONE RETURN:
--
--     jsonb_build_object('round', 2, 'name', 'club_to_agents',
--                        'payees', ..., 'amount', ..., 'shortfalls', ..., 'detail', ...)
--
-- so `? 'success'` is always false and the whole branch is unreachable. The one
-- occurrence of the word 'success' inside fn_settle_round2_club_to_agents is a
-- test on v_debit, the treasury-debit result, not on its own return value.
--
-- That is a stub with a comment claiming it is a control. It is exactly the
-- shape of thing this codebase keeps getting bitten by: a guard that reads as
-- armed while being unreachable.
--
-- WHAT ROUNDS 2 AND 3 ACTUALLY DO. They report an error by RAISING, which the
-- per-union handler in fn_union_settlement_cascade_all catches, counts as a
-- failure and alerts on - so a hard failure was never silent. A club that
-- cannot cover its agents is not an error at all: round 2 increments
-- `shortfalls`, records the club in `detail`, and returns normally. Partial
-- payment is the designed behaviour and it is recorded on the round row.
--
-- SO THE GUARD BECOMES A CONTRACT ASSERTION instead of a fiction. If a future
-- change stops returning `amount` or `payees`, the cascade now stops rather
-- than writing a 0-amount round row and continuing to the next round - which
-- is precisely how the 441,230.51 got moved on a floored week: a round
-- reported nothing useful and the cascade carried on regardless.
--
-- The explicit success:false test is kept alongside it, so if either round is
-- ever given a structured failure return it is honoured from day one.
--
-- Applied by exact text substitution on the live definition, so nothing else in
-- 7.5 KB of settlement logic can move.
-- =============================================================================

BEGIN;

DO $migrate$
DECLARE
  v_def text;
  v_new text;
  v_old2 text;
  v_new2 text;
  v_old3 text;
  v_new3 text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def
    FROM pg_proc
   WHERE proname = 'fn_union_settlement_cascade'
     AND pronamespace = 'public'::regnamespace;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fn_union_settlement_cascade not found';
  END IF;

  v_old2 := E'IF v_r2 ? \'success\' AND COALESCE((v_r2->>\'success\')::boolean, false) IS NOT TRUE\n     AND COALESCE(v_r2->>\'error\',\'\') <> \'already_executed\' THEN';

  v_new2 := E'-- Round 2 carries no \'success\' key: it raises on error and returns\n  -- {round,name,payees,amount,shortfalls,detail} otherwise, so a test for\n  -- \'success\' would be unreachable. Assert the CONTRACT instead - a round that\n  -- stops reporting an amount must stop the cascade, not record 0 and carry on.\n  IF (v_r2->>\'amount\') IS NULL OR (v_r2->>\'payees\') IS NULL\n     OR (v_r2 ? \'success\' AND COALESCE((v_r2->>\'success\')::boolean, true) IS FALSE\n         AND COALESCE(v_r2->>\'error\',\'\') <> \'already_executed\') THEN';

  v_old3 := E'IF v_r3 ? \'success\' AND COALESCE((v_r3->>\'success\')::boolean, false) IS NOT TRUE\n     AND COALESCE(v_r3->>\'error\',\'\') <> \'already_executed\' THEN';

  v_new3 := E'-- Same contract assertion for round 3.\n  IF (v_r3->>\'amount\') IS NULL OR (v_r3->>\'payees\') IS NULL\n     OR (v_r3 ? \'success\' AND COALESCE((v_r3->>\'success\')::boolean, true) IS FALSE\n         AND COALESCE(v_r3->>\'error\',\'\') <> \'already_executed\') THEN';

  IF position(v_old2 in v_def) = 0 THEN
    RAISE EXCEPTION 'round 2 guard not found in the expected form';
  END IF;
  IF position(v_old3 in v_def) = 0 THEN
    RAISE EXCEPTION 'round 3 guard not found in the expected form';
  END IF;

  v_new := replace(v_def, v_old2, v_new2);
  v_new := replace(v_new, v_old3, v_new3);

  v_new := replace(v_new, '''round2_failed: ''', '''round2_contract_violated_or_failed: ''');
  v_new := replace(v_new, '''round3_failed: ''', '''round3_contract_violated_or_failed: ''');

  IF v_new = v_def THEN
    RAISE EXCEPTION 'no substitution took effect';
  END IF;

  EXECUTE v_new;
END
$migrate$;

DO $assert$
DECLARE
  v_src text;
  v_res jsonb;
  r2_good jsonb := '{"round":2,"name":"club_to_agents","payees":83,"amount":441230.51,"shortfalls":0}'::jsonb;
  r2_bad  jsonb := '{"round":2,"name":"club_to_agents"}'::jsonb;
  v_fires_on_good boolean;
  v_fires_on_bad  boolean;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname='fn_union_settlement_cascade' AND pronamespace='public'::regnamespace;

  IF v_src LIKE '%IF v_r2 ? ''success'' AND%' OR v_src LIKE '%IF v_r3 ? ''success'' AND%' THEN
    RAISE EXCEPTION 'the unreachable guard is still there';
  END IF;
  IF v_src NOT LIKE '%(v_r2->>''amount'') IS NULL%'
     OR v_src NOT LIKE '%(v_r3->>''amount'') IS NULL%' THEN
    RAISE EXCEPTION 'the contract assertion was not installed';
  END IF;

  v_fires_on_good := ((r2_good->>'amount') IS NULL OR (r2_good->>'payees') IS NULL
     OR (r2_good ? 'success' AND COALESCE((r2_good->>'success')::boolean, true) IS FALSE
         AND COALESCE(r2_good->>'error','') <> 'already_executed'));
  v_fires_on_bad := ((r2_bad->>'amount') IS NULL OR (r2_bad->>'payees') IS NULL
     OR (r2_bad ? 'success' AND COALESCE((r2_bad->>'success')::boolean, true) IS FALSE
         AND COALESCE(r2_bad->>'error','') <> 'already_executed'));

  IF v_fires_on_good THEN
    RAISE EXCEPTION 'the guard would abort a healthy round 2';
  END IF;
  IF NOT v_fires_on_bad THEN
    RAISE EXCEPTION 'the guard does not fire on a round that stopped reporting an amount';
  END IF;

  IF v_src NOT LIKE '%before_settlement_floor%'
     OR v_src NOT LIKE '%round1_failed%'
     OR v_src NOT LIKE '%weekly_invoices_enabled%'
     OR v_src NOT LIKE '%fn_union_weekly_rakeback_close%'
     OR v_src NOT LIKE '%fn_settle_round2_club_to_agents%'
     OR v_src NOT LIKE '%fn_settle_round3_agents_to_players%'
     OR v_src LIKE '%FUNCTION_BODY_MARKER%' THEN
    RAISE EXCEPTION 'the substitution lost something from the cascade';
  END IF;

  v_res := public.fn_union_settlement_cascade(
             'fade0000-0000-0000-0000-000000000001',
             '2026-08-24 07:00:00+00', '2026-08-31 07:00:00+00');
  IF (v_res->>'success')::boolean IS NOT FALSE
     OR v_res->>'error' <> 'before_settlement_floor' THEN
    RAISE EXCEPTION 'a floored period is no longer refused: %', v_res::text;
  END IF;
  IF EXISTS (SELECT 1 FROM union_settlement_rounds
              WHERE period_start='2026-08-24 07:00:00+00' AND period_end='2026-08-31 07:00:00+00') THEN
    RAISE EXCEPTION 'the refused period wrote round rows';
  END IF;
END
$assert$;

COMMIT;
