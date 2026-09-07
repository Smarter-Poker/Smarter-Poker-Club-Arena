-- THE PAYER ASKS WHO IS ASKING
-- =============================================================================
-- PHASE 5 of 8, part 8 - closing what check-definer-authorization found.
--
-- fn_close_settlement_period is SECURITY DEFINER, it debits a club treasury and
-- credits a player wallet, and it had no authorization check of any kind. It
-- was safe only because of a GRANT: production has anon=false, authenticated=
-- false, service_role=true, so today nothing in a browser can reach it.
--
-- A grant is not an authorization check. It lives outside the function, it is
-- invisible to anyone reading the function, and CREATE OR REPLACE carries
-- whatever grant it finds forward without comment - which is exactly how
-- settle_club_rakeback still had an anon grant this afternoon, four function
-- bodies after anyone last thought about it. One GRANT typed in a future
-- migration and this function pays anybody, from any club, to any player, and
-- nothing in its own text would object.
--
-- So it asks now, and the grants are restated in the same migration so the
-- intent is written where the function is:
--
--   - the engine and every server-side job (fn_caller_is_engine);
--   - a platform admin;
--   - the club's owner, for their own club;
--   - THE PLAYER THEMSELVES, for their own period - which is what
--     fn_claim_rakeback is, and it stays working because auth.uid() is the
--     player inside a SECURITY DEFINER body, not the definer.
--
-- Anyone else gets not_authorised, and gets it before the freeze check and the
-- membership check, which is where an authorization check belongs: Phase 3 shipped
-- three writers that authorised LAST and leaked what they were about on the way.
-- =============================================================================

BEGIN;

DO $migrate$
DECLARE v_def text; v_new text; v_a text; v_r text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_def FROM pg_proc
   WHERE proname='fn_close_settlement_period' AND pronamespace='public'::regnamespace;

  v_a := E'  -- ---- EVERY CHEAP REFUSAL FIRST -------------------------------------------';

  v_r := E'  -- WHO IS ASKING. A grant is not an authorization check: it lives outside\n'
      || E'  -- the function and CREATE OR REPLACE carries it forward unexamined. This\n'
      || E'  -- function debits a treasury and credits a wallet, so it asks.\n'
      || E'  IF NOT public.fn_caller_is_engine()\n'
      || E'     AND (auth.uid() IS NULL\n'
      || E'          OR (auth.uid() <> v_period.user_id\n'
      || E'              AND NOT public.fn_is_platform_admin()\n'
      || E'              AND NOT EXISTS (SELECT 1 FROM public.clubs c\n'
      || E'                               WHERE c.id = v_period.club_id\n'
      || E'                                 AND c.owner_id = auth.uid()))) THEN\n'
      || E'    RETURN jsonb_build_object(''success'', false, ''error'', ''not_authorised'');\n'
      || E'  END IF;\n\n'
      || v_a;

  IF position(v_a in v_def) = 0 THEN
    RAISE EXCEPTION 'the cheap-refusal marker is not where this migration expects it';
  END IF;
  v_new := replace(v_def, v_a, v_r);
  IF v_new = v_def THEN RAISE EXCEPTION 'the authorization check did not take'; END IF;
  EXECUTE v_new;
END
$migrate$;

-- Stated here so the next reader of this function sees who may call it without
-- going to look up a grant. This matches what production already holds.
REVOKE ALL ON FUNCTION public.fn_close_settlement_period(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_close_settlement_period(uuid) TO service_role;

DO $assert$
DECLARE v_src text; v_auth_at int; v_frozen_at int; v_debit_at int;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname='fn_close_settlement_period' AND pronamespace='public'::regnamespace;

  v_auth_at   := position('not_authorised' in v_src);
  v_frozen_at := position('fn_platform_frozen' in v_src);
  v_debit_at  := position('fn_debit_treasury' in v_src);

  IF v_auth_at = 0 THEN RAISE EXCEPTION 'the payer still does not ask who is asking'; END IF;
  IF v_auth_at > v_frozen_at THEN
    RAISE EXCEPTION 'authorization runs after the freeze check instead of first';
  END IF;
  IF v_auth_at > v_debit_at THEN
    RAISE EXCEPTION 'authorization runs after the treasury debit';
  END IF;
  IF v_src NOT LIKE '%auth.uid() <> v_period.user_id%' THEN
    RAISE EXCEPTION 'a player can no longer claim their own rakeback';
  END IF;
  -- Everything Phase 5 built must still be there.
  IF v_src NOT LIKE '%fn_player_rakeback_rate%'
     OR v_src NOT LIKE '%rakeback_daily_user%'
     OR v_src NOT LIKE '%no_membership_at_earning_club%'
     OR v_src NOT LIKE '%app.ledger_club_id%'
     OR v_src NOT LIKE '%before_basis%' THEN
    RAISE EXCEPTION 'the substitution lost part of the payer';
  END IF;

  IF has_function_privilege('anon','public.fn_close_settlement_period(uuid)'::regprocedure,'EXECUTE')
     OR has_function_privilege('authenticated','public.fn_close_settlement_period(uuid)'::regprocedure,'EXECUTE') THEN
    RAISE EXCEPTION 'a browser role can still call the payer directly';
  END IF;
END
$assert$;

-- And prove the player path still works, in a subtransaction that rolls back.
DO $fixture$
DECLARE v_msg text; v_uid uuid; v_pid uuid; v_res jsonb;
BEGIN
  BEGIN
    SELECT rp.id, rp.user_id INTO v_pid, v_uid
      FROM rakeback_periods rp
     WHERE rp.status='pending' AND rp.period_end < CURRENT_DATE
     LIMIT 1;
    IF v_pid IS NULL THEN RAISE EXCEPTION 'FIXTURE_ROLLBACK nothing pending to test with'; END IF;

    -- As the engine (no auth.uid()), it must be allowed through.
    v_res := public.fn_close_settlement_period(v_pid);
    IF v_res->>'error' = 'not_authorised' THEN
      RAISE EXCEPTION 'FIXTURE_FAIL the engine was refused by its own payer';
    END IF;

    RAISE EXCEPTION 'FIXTURE_ROLLBACK engine accepted, result=%', v_res::text;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'FIXTURE_ROLLBACK%' THEN
      RAISE EXCEPTION 'authorization fixture failed: %', v_msg;
    END IF;
  END;
END
$fixture$;

COMMIT;
