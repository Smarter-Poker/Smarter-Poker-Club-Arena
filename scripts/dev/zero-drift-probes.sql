-- ═══════════════════════════════════════════════════════════════════════════
-- ZERO-DRIFT PROBE SUITE — verify the hardened ledger invariants.
-- Per CLAUDE.md 11.5: every probe runs inside a transaction that is ROLLED
-- BACK. No chips move, no incidents persist, no notifications are sent
-- (notification inserts roll back with everything else).
--
-- Run:  psql "$DATABASE_URL" -f scripts/dev/zero-drift-probes.sql
-- Every probe prints PASS/FAIL via RAISE NOTICE. The script always ends in
-- ROLLBACK. A FAIL here means a database-level invariant has regressed.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

DO $$
DECLARE
  v_ledger_id uuid;
  v_club uuid;
  v_before numeric;
  v_rows int;
  v_sid uuid;
  v_inc uuid;
  v_err text;
BEGIN
  ------------------------------------------------------------------
  -- P1: posted ledger rows are immutable (UPDATE of amount rejected)
  ------------------------------------------------------------------
  SELECT id INTO v_ledger_id FROM chip_ledger ORDER BY created_at DESC LIMIT 1;
  BEGIN
    UPDATE chip_ledger SET amount = amount + 1 WHERE id = v_ledger_id;
    RAISE NOTICE 'P1 FAIL: chip_ledger amount UPDATE was allowed';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'P1 PASS: chip_ledger UPDATE rejected (%)', SQLERRM;
  END;

  ------------------------------------------------------------------
  -- P2: ledger rows cannot be deleted
  ------------------------------------------------------------------
  BEGIN
    DELETE FROM chip_ledger WHERE id = v_ledger_id;
    RAISE NOTICE 'P2 FAIL: chip_ledger DELETE was allowed';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'P2 PASS: chip_ledger DELETE rejected';
  END;

  ------------------------------------------------------------------
  -- P3: duplicate idempotency key cannot post twice
  ------------------------------------------------------------------
  BEGIN
    INSERT INTO chip_ledger (performed_by, from_type, to_type, amount, category, idempotency_key, description)
    VALUES ('2d1cd6c3-5700-4af9-a271-d4863fdab20d', 'issuance_reserve', 'settlement_suspense', 0.01, 'adjustment', 'zdprobe:dup', 'probe');
    INSERT INTO chip_ledger (performed_by, from_type, to_type, amount, category, idempotency_key, description)
    VALUES ('2d1cd6c3-5700-4af9-a271-d4863fdab20d', 'issuance_reserve', 'settlement_suspense', 0.01, 'adjustment', 'zdprobe:dup', 'probe');
    RAISE NOTICE 'P3 FAIL: duplicate idempotency key accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'P3 PASS: duplicate idempotency key rejected';
  END;

  ------------------------------------------------------------------
  -- P4: invalid category rejected; sub-cent amounts rejected
  ------------------------------------------------------------------
  BEGIN
    INSERT INTO chip_ledger (performed_by, from_type, to_type, amount, category, description)
    VALUES ('2d1cd6c3-5700-4af9-a271-d4863fdab20d', 'issuance_reserve', 'settlement_suspense', 1, 'not_a_category', 'probe');
    RAISE NOTICE 'P4a FAIL: invalid category accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'P4a PASS: invalid category rejected';
  END;
  -- sub-cent: the enrich trigger rounds to 2dp, so the constraint is
  -- belt-and-braces; assert the trigger normalised it.
  INSERT INTO chip_ledger (performed_by, from_type, to_type, amount, category, description)
  VALUES ('2d1cd6c3-5700-4af9-a271-d4863fdab20d', 'issuance_reserve', 'settlement_suspense', 0.011, 'adjustment', 'probe scale')
  RETURNING id INTO v_ledger_id;
  IF (SELECT amount FROM chip_ledger WHERE id = v_ledger_id) = 0.01 THEN
    RAISE NOTICE 'P4b PASS: sub-cent amount normalised to exact 2dp';
  ELSE
    RAISE NOTICE 'P4b FAIL: sub-cent amount stored unrounded';
  END IF;

  ------------------------------------------------------------------
  -- P5: enrichment — every new row gets seq, hash, epoch, actor
  ------------------------------------------------------------------
  IF (SELECT chain_seq IS NOT NULL AND row_hash IS NOT NULL AND epoch_id IS NOT NULL
        AND db_role IS NOT NULL
      FROM chip_ledger WHERE id = v_ledger_id) THEN
    RAISE NOTICE 'P5 PASS: new ledger row enriched (seq/hash/epoch/actor)';
  ELSE
    RAISE NOTICE 'P5 FAIL: enrichment missing on new row';
  END IF;

  ------------------------------------------------------------------
  -- P6: balance stores auto-journal — a treasury delta writes a ledger row
  ------------------------------------------------------------------
  SELECT id INTO v_club FROM clubs ORDER BY created_at LIMIT 1;
  SELECT count(*) INTO v_rows FROM chip_ledger
   WHERE (from_entity_id = v_club OR to_entity_id = v_club) AND created_at = now();
  UPDATE clubs SET chip_treasury = COALESCE(chip_treasury,0) + 0.01 WHERE id = v_club;
  IF EXISTS (SELECT 1 FROM chip_ledger
              WHERE to_entity_id = v_club AND to_type = 'club_treasury'
                AND amount = 0.01 AND created_at = now()) THEN
    RAISE NOTICE 'P6 PASS: clubs.chip_treasury delta auto-journaled';
  ELSE
    RAISE NOTICE 'P6 FAIL: treasury delta produced no ledger row';
  END IF;

  ------------------------------------------------------------------
  -- P7: settlement state machine — single-step advance only, final is final
  ------------------------------------------------------------------
  INSERT INTO ca_settlements (settlement_type, external_ref)
  VALUES ('adjustment', 'zdprobe:' || gen_random_uuid()::text)
  RETURNING id INTO v_sid;
  UPDATE ca_settlements SET state = 'locked_for_calculation' WHERE id = v_sid;
  BEGIN
    UPDATE ca_settlements SET state = 'ledger_posted' WHERE id = v_sid; -- skips 2 states
    RAISE NOTICE 'P7a FAIL: settlement skipped states';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'P7a PASS: state skip rejected';
  END;
  UPDATE ca_settlements SET state = 'calculated' WHERE id = v_sid;
  UPDATE ca_settlements SET state = 'validated' WHERE id = v_sid;
  UPDATE ca_settlements SET state = 'ledger_posted' WHERE id = v_sid;
  UPDATE ca_settlements SET state = 'post_commit_verified' WHERE id = v_sid;
  UPDATE ca_settlements SET state = 'final' WHERE id = v_sid;
  BEGIN
    UPDATE ca_settlements SET state = 'open' WHERE id = v_sid;
    RAISE NOTICE 'P7b FAIL: final settlement re-opened';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'P7b PASS: final settlement is immutable';
  END;

  ------------------------------------------------------------------
  -- P8: duplicate settlement per obligation impossible
  ------------------------------------------------------------------
  BEGIN
    INSERT INTO ca_settlements (settlement_type, external_ref)
    SELECT settlement_type, external_ref FROM ca_settlements WHERE id = v_sid;
    RAISE NOTICE 'P8 FAIL: duplicate settlement accepted';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'P8 PASS: duplicate settlement rejected';
  END;

  ------------------------------------------------------------------
  -- P9: incident lifecycle — raise, dedupe, resolve (all rolled back)
  ------------------------------------------------------------------
  v_inc := public.fn_ca_raise_drift_incident(
    'zdprobe', 'rounding_error', 'info', 'zdprobe:' || txid_current()::text,
    0.01, 1.00, 1.01, 'reporting');
  IF v_inc IS NULL THEN
    RAISE NOTICE 'P9a FAIL: incident not created';
  ELSE
    RAISE NOTICE 'P9a PASS: incident created %', v_inc;
  END IF;
  IF public.fn_ca_raise_drift_incident(
       'zdprobe', 'rounding_error', 'info', 'zdprobe:' || txid_current()::text,
       0.02, 1.00, 1.02, 'reporting') = v_inc THEN
    RAISE NOTICE 'P9b PASS: repeat raise deduped to same incident';
  ELSE
    RAISE NOTICE 'P9b FAIL: repeat raise created a second incident';
  END IF;
  IF (public.fn_ca_incident_action(v_inc, 'resolve', 'probe', NULL, 'probe', NULL)->>'ok')::boolean THEN
    RAISE NOTICE 'P9c PASS: incident resolvable with root cause';
  ELSE
    RAISE NOTICE 'P9c FAIL: incident resolve refused';
  END IF;

  ------------------------------------------------------------------
  -- P10: unknown-classification incidents cannot close without a root cause
  ------------------------------------------------------------------
  v_inc := public.fn_ca_raise_drift_incident(
    'zdprobe', 'unknown', 'info', 'zdprobe:u:' || txid_current()::text, 0);
  IF (public.fn_ca_incident_action(v_inc, 'resolve', 'probe', NULL, NULL, NULL)->>'reason')
       = 'root_cause_required_for_unknown' THEN
    RAISE NOTICE 'P10 PASS: unknown incident refuses to close without root cause';
  ELSE
    RAISE NOTICE 'P10 FAIL: unknown incident closed without root cause';
  END IF;

  ------------------------------------------------------------------
  -- P11: ledger chain verification runs clean on recent rows
  ------------------------------------------------------------------
  IF (SELECT breaks FROM public.fn_ca_verify_ledger_chain(1000)) = 0 THEN
    RAISE NOTICE 'P11 PASS: checksum verification clean';
  ELSE
    RAISE NOTICE 'P11 FAIL: ledger checksum breaks detected';
  END IF;
END $$;

ROLLBACK;
