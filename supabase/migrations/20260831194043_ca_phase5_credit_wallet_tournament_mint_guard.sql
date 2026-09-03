-- BACKFILLED 2026-09-03 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831194043; the file committed at the time was a placeholder
-- marker (kept below) that said to export the body. Content is byte-exact to
-- what ran. Do NOT re-apply; it is already live.

-- ZERO-DRIFT phase 5 (prod ~19:41 UTC): the tournament-cashout mint had a
-- SECOND path. Besides atomic_table_cashout (guarded 19:29), the engine's
-- seat-exit service also calls atomic_credit_wallet_and_log(user, stack,
-- 'cashout', ..., table_id), which credited tournament play-chip stacks to
-- club_members as real chips - rows kept flowing 19:33-19:39 and were caught
-- by the phase-5 final verification sweep. Same guard: a 'cashout' credit
-- referencing a tournament-attached table is blocked, raises the deduped
-- tourney-cashout-blocked incident, and returns true (handled, nothing
-- credited) so the engine does not retry-loop. Idempotent dynamic patch;
-- verified by rolled-back probe (123.45 credit -> wallet delta 0, incident
-- raised). Canonical body in prod schema_migrations.

-- ZERO-DRIFT phase 5: the tournament-cashout mint had a SECOND path. Besides
-- atomic_table_cashout (guarded 19:29), the engine's seat-exit service also
-- calls atomic_credit_wallet_and_log(user, stack, 'cashout', ..., table_id) —
-- which credited tournament play-chip stacks to club_members as real chips
-- (rows kept flowing 19:33–19:39, caught by the phase-5 final sweep). Same
-- guard here: a 'cashout' credit referencing a tournament-attached table is
-- blocked, raises the deduped tourney-cashout-blocked incident, and returns
-- true (handled — nothing credited) so the engine does not retry-loop.
-- Cash-table credits and every other category are untouched.
DO $$
DECLARE v_def text; v_new text; v_anchor text; v_guard text;
BEGIN
  v_def := pg_get_functiondef('public.atomic_credit_wallet_and_log(uuid,numeric,text,text,uuid,uuid,uuid,text)'::regprocedure);
  IF v_def LIKE '%tournament_mint_blocked%' THEN RETURN; END IF;
  v_anchor := '  /* ZERO-DRIFT (2026-08-31): tell the club_members ledger writer what this';
  IF position(v_anchor in v_def) = 0 THEN
    RAISE EXCEPTION 'credit-wallet guard: anchor not found — refusing to patch blind';
  END IF;
  v_guard :=
    '  -- ZERO-DRIFT phase 5: tournament stacks are play chips and never cash' || E'\n' ||
    '  -- out to a wallet. Blocked here exactly as in atomic_table_cashout.' || E'\n' ||
    '  IF p_category = ''cashout'' AND p_table_id IS NOT NULL AND EXISTS (' || E'\n' ||
    '       SELECT 1 FROM public.tables t WHERE t.id = p_table_id AND t.tournament_id IS NOT NULL) THEN' || E'\n' ||
    '    PERFORM public.fn_ca_raise_drift_incident(' || E'\n' ||
    '      ''atomic_credit_wallet_and_log:tournament_mint_blocked'', ''unauthorized_adjustment'', ''warning'',' || E'\n' ||
    '      ''tourney-cashout-blocked:'' || p_table_id::text,' || E'\n' ||
    '      p_amount, 0, p_amount, ''ledger'', ''tables'', p_table_id, NULL,' || E'\n' ||
    '      NULL, p_table_id, NULL, NULL, NULL, NULL, NULL,' || E'\n' ||
    '      ''engine attempted a real-chip cashout of a tournament-table stack via atomic_credit_wallet_and_log — credit blocked; fix the engine exit path'',' || E'\n' ||
    '      NULL, jsonb_build_object(''user_id'', p_user_id, ''amount'', p_amount));' || E'\n' ||
    '    RETURN true;' || E'\n' ||
    '  END IF;' || E'\n\n';
  v_new := replace(v_def, v_anchor, v_guard || v_anchor);
  EXECUTE v_new;
END $$;
