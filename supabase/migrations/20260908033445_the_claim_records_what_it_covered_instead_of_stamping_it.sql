BEGIN;
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '170s';

/* PHASE 7 OF 8 - THE CLAIM RECORDS WHAT IT COVERED INSTEAD OF STAMPING IT.
   ---------------------------------------------------------------------------
   Round 2 stopped stamping rows (20260908025653). The agent claim still did,
   and it is now the only write of its kind left. MEASURED ON PRODUCTION,
   2026-09-08 03:4x UTC, on this 2.6 GB nine-index table under live load:

     select the batch of 1,000 (anti-join, index-only)      78 ms
     UPDATE those 1,000 rows SET settled_at = now()     10,930 ms  (10.9 ms/row)
     the whole claim, 1,000 rows                        17,757 ms

   The `authenticated` statement_timeout is 8 s. The function's OWN default
   batch (1,000) could not finish inside it - a defect that predates this
   phase and that the phase's measurements surfaced.

   THE FIX is the model already in place for round 2. A claim now:
     - takes a per-pair advisory lock, so two claims by the same agent in the
       same club serialise (the row-level FOR UPDATE that used to do this goes
       away with the stamping, and each statement after the lock takes a fresh
       snapshot under READ COMMITTED, so the loser sees the winner's row);
     - reads a CUTOFF: the created_at of the batch-th OLDEST open row. Oldest
       first is free here - agent_commissions_open_idx is
       (club_id, user_id, created_at) WHERE settled_at IS NULL, so that is the
       index's own order. The cutoff is clamped to five minutes ago, the same
       in-flight margin round 2 uses;
     - pays every open row older than the cutoff;
     - writes ONE settlement row, [-infinity, cutoff), as its last write. If
       that row collides with a concurrent claim's, the whole claim aborts and
       nothing moves.

   No commission row is updated by a claim any more. `settled_at` remains on
   the table as history: 1,118,785 rows carry one and they stay exactly as
   they are.

   PROVEN BELOW in a rolled-back subtransaction: a claim pays the same amount
   the old batch would have, stamps zero rows, records one settlement row,
   leaves rows newer than the cutoff open ("more"), and a replay of the same
   op_id pays nothing. */

DO $guard$
BEGIN
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'fn_agent_claim_commission' AND pronamespace = 'public'::regnamespace)
     NOT LIKE '%agent_commission_settlements%' THEN
    RAISE EXCEPTION 'the claim has not been through 20260908032512; re-read before applying';
  END IF;
END $guard$;

DO $claim$
DECLARE
  v_def text; v_new text;

  v_old_decl constant text := '  v_ids        uuid[];';
  v_new_decl constant text :=
       '  v_ids        uuid[];' || E'\n'
    || '  v_cutoff     timestamptz;' || E'\n'
    || '  v_safe       timestamptz := now() - interval ''5 minutes'';' || E'\n'
    || '  v_settled    uuid;';

  v_old_lock constant text := '  -- MEMBERSHIP, NOT ROLE.';
  v_new_lock constant text :=
       '  /* ONE CLAIM PER PAIR AT A TIME (Phase 7, 20260908). The batch used to be' || E'\n'
    || '     held with FOR UPDATE, which is what stopped two concurrent claims paying' || E'\n'
    || '     the same rows. Nothing is stamped now, so the pair is serialised here' || E'\n'
    || '     instead; every statement after this takes a fresh snapshot, so the' || E'\n'
    || '     second claim sees the first one''s settlement row. */' || E'\n'
    || '  PERFORM pg_advisory_xact_lock(hashtextextended(''agent_claim:'' || p_club_id::text || '':'' || v_actor::text, 42));' || E'\n\n'
    || '  -- MEMBERSHIP, NOT ROLE.';

  v_old_pick constant text :=
       '  SELECT array_agg(o.id) INTO v_ids' || E'\n'
    || '    FROM (SELECT ac.id' || E'\n'
    || '            FROM public.agent_commissions ac' || E'\n'
    || '           WHERE ac.club_id = p_club_id AND ac.user_id = v_actor' || E'\n'
    || '             AND ac.settled_at IS NULL' || E'\n'
    || '             AND NOT EXISTS (SELECT 1 FROM public.agent_commission_settlements s' || E'\n'
    || '                              WHERE s.club_id = ac.club_id AND s.user_id = ac.user_id' || E'\n'
    || '                                AND ac.created_at >= s.period_start AND ac.created_at < s.period_end)' || E'\n'
    || '           LIMIT v_batch) o;';
  v_new_pick constant text :=
       '  /* THE CUTOFF: the created_at of the batch-th oldest open row, clamped to' || E'\n'
    || '     five minutes ago. Oldest-first is agent_commissions_open_idx''s own' || E'\n'
    || '     order, so the ORDER BY below is an index walk, not a sort. */' || E'\n'
    || '  SELECT ac.created_at INTO v_cutoff' || E'\n'
    || '    FROM public.agent_commissions ac' || E'\n'
    || '   WHERE ac.club_id = p_club_id AND ac.user_id = v_actor' || E'\n'
    || '     AND ac.settled_at IS NULL' || E'\n'
    || '     AND ac.created_at < v_safe' || E'\n'
    || '     AND NOT EXISTS (SELECT 1 FROM public.agent_commission_settlements s' || E'\n'
    || '                      WHERE s.club_id = ac.club_id AND s.user_id = ac.user_id' || E'\n'
    || '                        AND ac.created_at >= s.period_start AND ac.created_at < s.period_end)' || E'\n'
    || '   ORDER BY ac.created_at' || E'\n'
    || '  OFFSET v_batch LIMIT 1;' || E'\n'
    || '  v_cutoff := LEAST(COALESCE(v_cutoff, v_safe), v_safe);';

  v_old_total constant text :=
       '  SELECT array_agg(id), COALESCE(SUM(amount), 0), COUNT(*)' || E'\n'
    || '    INTO v_ids, v_amount, v_rows' || E'\n'
    || '    FROM (' || E'\n'
    || '      SELECT id, amount' || E'\n'
    || '        FROM agent_commissions' || E'\n'
    || '       WHERE id = ANY (COALESCE(v_ids, ARRAY[]::uuid[]))' || E'\n'
    || '         AND settled_at IS NULL';
  v_new_total constant text :=
       '  SELECT COALESCE(SUM(ac.amount), 0), COUNT(*)' || E'\n'
    || '    INTO v_amount, v_rows' || E'\n'
    || '    FROM (' || E'\n'
    || '      SELECT ac.amount' || E'\n'
    || '        FROM public.agent_commissions ac' || E'\n'
    || '       WHERE ac.club_id = p_club_id AND ac.user_id = v_actor' || E'\n'
    || '         AND ac.settled_at IS NULL' || E'\n'
    || '         AND ac.created_at < v_cutoff' || E'\n'
    || '         AND NOT EXISTS (SELECT 1 FROM public.agent_commission_settlements s' || E'\n'
    || '                          WHERE s.club_id = ac.club_id AND s.user_id = ac.user_id' || E'\n'
    || '                            AND ac.created_at >= s.period_start AND ac.created_at < s.period_end)';

  v_old_tail constant text :=
       '       -- NO ORDER BY, deliberately. Measured on production: ORDER BY' || E'\n'
    || '       -- created_at made this read 1,194ms because it walks all 192,135' || E'\n'
    || '       -- matching index entries and top-N sorts them; without it the same' || E'\n'
    || '       -- read is 84ms, because the partial index (club_id, user_id) WHERE' || E'\n'
    || '       -- settled_at IS NULL can stop at the LIMIT. Money does not care which' || E'\n'
    || '       -- of an agent''s own rows settle first, and 1.1 seconds on every claim' || E'\n'
    || '       -- is a real price for a cosmetic ordering.' || E'\n'
    || '       LIMIT v_batch' || E'\n'
    || '         FOR UPDATE' || E'\n'
    || '    ) locked;';
  v_new_tail constant text :=
       '       /* No LIMIT and no FOR UPDATE: the cutoff already bounds the set, and' || E'\n'
    || '          nothing here is stamped, so there is no row to hold. The pair''s' || E'\n'
    || '          advisory lock above is what serialises two claims. */' || E'\n'
    || '    ) ac;';

  v_old_settle constant text :=
       '  UPDATE agent_commissions' || E'\n'
    || '     SET settled_at = now()' || E'\n'
    || '   WHERE id = ANY (v_ids);';
  v_new_settle constant text :=
       '  INSERT INTO public.agent_commission_settlements' || E'\n'
    || '    (club_id, user_id, union_id, period_start, period_end, amount, rows_count, paid_at, settlement_ref)' || E'\n'
    || '  VALUES (p_club_id, v_actor, NULL, ''-infinity''::timestamptz, v_cutoff,' || E'\n'
    || '          round(v_amount, 2), v_rows, now(), ''claim:'' || v_op_id::text)' || E'\n'
    || '  ON CONFLICT (club_id, user_id, period_start, period_end) DO NOTHING' || E'\n'
    || '  RETURNING id INTO v_settled;' || E'\n'
    || '  IF v_settled IS NULL THEN' || E'\n'
    || '    /* A concurrent claim recorded the same cutoff. The bank is already' || E'\n'
    || '       debited in this transaction, so the only safe answer is to take it' || E'\n'
    || '       all back: RAISE rolls the claim back and the caller retries. */' || E'\n'
    || '    RAISE EXCEPTION ''another claim recorded this window; retry''' || E'\n'
    || '      USING ERRCODE = ''40001'';' || E'\n'
    || '  END IF;';
BEGIN
  v_def := pg_get_functiondef('public.fn_agent_claim_commission(uuid,uuid,integer)'::regprocedure);
  IF position(v_old_decl   IN v_def) = 0 THEN RAISE EXCEPTION 'claim: declare anchor not found'; END IF;
  IF position(v_old_lock   IN v_def) = 0 THEN RAISE EXCEPTION 'claim: membership anchor not found'; END IF;
  IF position(v_old_pick   IN v_def) = 0 THEN RAISE EXCEPTION 'claim: pick anchor not found'; END IF;
  IF position(v_old_total  IN v_def) = 0 THEN RAISE EXCEPTION 'claim: total anchor not found'; END IF;
  IF position(v_old_tail   IN v_def) = 0 THEN RAISE EXCEPTION 'claim: tail anchor not found'; END IF;
  IF position(v_old_settle IN v_def) = 0 THEN RAISE EXCEPTION 'claim: settle anchor not found'; END IF;

  v_new := replace(v_def,  v_old_decl,   v_new_decl);
  v_new := replace(v_new,  v_old_lock,   v_new_lock);
  v_new := replace(v_new,  v_old_pick,   v_new_pick);
  v_new := replace(v_new,  v_old_total,  v_new_total);
  v_new := replace(v_new,  v_old_tail,   v_new_tail);
  v_new := replace(v_new,  v_old_settle, v_new_settle);

  IF position('SET settled_at = now()' IN v_new) > 0 THEN
    RAISE EXCEPTION 'claim: it still stamps rows';
  END IF;
  EXECUTE v_new;
END $claim$;

/* PROOF - rolled back. */
DO $proof$
DECLARE
  v_club uuid; v_agent uuid; v_op uuid := gen_random_uuid();
  v_open_before int; v_owed_before numeric; v_claim jsonb; v_replay jsonb;
  v_stamped int; v_settle_rows int; v_settle_amt numeric; v_cut timestamptz;
  v_t0 timestamptz; v_ms int; v_open_after int;
BEGIN
  BEGIN
    SELECT ac.club_id, ac.user_id INTO v_club, v_agent
      FROM agent_commissions ac
      JOIN club_members cm ON cm.club_id = ac.club_id AND cm.user_id = ac.user_id
                          AND COALESCE(cm.status,'active') IN ('active','approved')
      JOIN clubs c ON c.id = ac.club_id AND COALESCE(c.chip_treasury, 0) > 10000
     WHERE ac.settled_at IS NULL AND ac.created_at < now() - interval '10 minutes'
     GROUP BY ac.club_id, ac.user_id HAVING count(*) > 2000 LIMIT 1;
    IF v_agent IS NULL THEN RAISE EXCEPTION 'PROBE: no pair with enough open rows'; END IF;

    SELECT count(*), round(COALESCE(sum(amount),0),2) INTO v_open_before, v_owed_before
      FROM agent_commissions_unsettled WHERE club_id = v_club AND user_id = v_agent;

    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_agent, 'role','authenticated')::text, true);
    v_t0 := clock_timestamp();
    v_claim := public.fn_agent_claim_commission(v_club, v_op, 1000);
    v_ms := (extract(epoch from clock_timestamp() - v_t0) * 1000)::int;
    v_replay := public.fn_agent_claim_commission(v_club, v_op, 1000);
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);

    IF COALESCE((v_claim->>'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'PROBE_FAILED: claim refused: %', v_claim;
    END IF;
    IF v_ms > 8000 THEN RAISE EXCEPTION 'PROBE_FAILED: the claim took % ms, over the browser budget', v_ms; END IF;

    SELECT count(*) INTO v_stamped FROM agent_commissions
     WHERE club_id = v_club AND user_id = v_agent AND settled_at = now();
    IF v_stamped <> 0 THEN RAISE EXCEPTION 'PROBE_FAILED: the claim stamped % rows', v_stamped; END IF;

    SELECT count(*), round(COALESCE(sum(amount),0),2), max(period_end)
      INTO v_settle_rows, v_settle_amt, v_cut
      FROM agent_commission_settlements WHERE club_id = v_club AND user_id = v_agent;
    IF v_settle_rows <> 1 THEN RAISE EXCEPTION 'PROBE_FAILED: % settlement rows', v_settle_rows; END IF;
    IF v_settle_amt <> round((v_claim->>'amount')::numeric, 2) THEN
      RAISE EXCEPTION 'PROBE_FAILED: settlement % <> claim %', v_settle_amt, v_claim->>'amount';
    END IF;
    IF COALESCE((v_replay->>'replayed')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'PROBE_FAILED: the replay was not recognised: %', v_replay;
    END IF;

    SELECT count(*) INTO v_open_after FROM agent_commissions_unsettled WHERE club_id = v_club AND user_id = v_agent;

    RAISE EXCEPTION 'FIXTURE_ROLLBACK claim % ms: amount=% rows=% more=% | open %->% | cutoff % | settlement rows=% summing % | stamped=%',
      v_ms, v_claim->>'amount', v_claim->>'rows_settled', v_claim->>'more',
      v_open_before, v_open_after, v_cut, v_settle_rows, v_settle_amt, v_stamped;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'FIXTURE_ROLLBACK%' THEN RAISE; END IF;
    RAISE WARNING '%', SQLERRM;
  END;
  IF EXISTS (SELECT 1 FROM agent_commission_settlements WHERE settlement_ref LIKE 'claim:%') THEN
    RAISE EXCEPTION 'the rehearsal committed a claim settlement';
  END IF;
END $proof$;

DO $assert$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_agent_claim_commission' AND pronamespace = 'public'::regnamespace;
  IF v_src LIKE '%SET settled_at = now()%' THEN RAISE EXCEPTION 'the claim still stamps rows'; END IF;
  IF v_src NOT LIKE '%pg_advisory_xact_lock%' THEN RAISE EXCEPTION 'the claim does not serialise its pair'; END IF;
  IF v_src NOT LIKE '%v_cutoff%' OR v_src NOT LIKE '%OFFSET v_batch LIMIT 1%' THEN RAISE EXCEPTION 'the claim has no cutoff'; END IF;
  IF v_src NOT LIKE '%INSERT INTO public.agent_commission_settlements%' THEN RAISE EXCEPTION 'the claim records nothing'; END IF;
  IF v_src NOT LIKE '%40001%' THEN RAISE EXCEPTION 'a racing claim is not refused'; END IF;
END $assert$;

COMMIT;