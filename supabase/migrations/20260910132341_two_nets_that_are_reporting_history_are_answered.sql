-- two_nets_that_are_reporting_history_are_answered
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- Two of the six open drift incidents are nets reporting something that is
-- either finished or deliberate. Both are closed here with what was measured,
-- not with a shrug.
--
-- 1. fn_ca_conservation_sweep:fn_ca_hand_commit_refusals (28119497, warning)
--
--    117 hand commits refused for "lease proof expired" across 99 tables. A
--    refusal rolls its hand back whole before any money step, so no chips
--    moved; what was lost is the hand. The cause was the lease churn fixed
--    today by 20260910063559 (the PostgREST pre-request hook and
--    claim_tournament_lease_v2) and 20260910064701 (the hand-commit and
--    table-close lease reads), which took FOR SHARE off the path of the
--    heartbeat's FOR NO KEY UPDATE.
--
--    Measured now: the newest refusal in the series is 2026-09-10 02:xx and
--    there have been ZERO in the eleven hours since. The detector reads a
--    rolling 24-hour window with a floor of 25, so it will keep reporting the
--    same 117 historic refusals until they age out on their own. Asserted
--    below: no refusal of this class in the last six hours.
--
-- 2. fn_ca_journal_append_only (0ad5625e, info)
--
--    954 append-only bypasses on diamond_transactions, DELETE, by role
--    postgres through PostgREST, reason
--    `certification-cleanup:20260906022000:<uuid>`. That is
--    cleanup_reserved_certification_account, which refuses any identity whose
--    email is not `ca-customization-cert-%@example.invalid` (42501) and
--    refuses to run while the platform is frozen. It removes a CERTIFICATION
--    TEST identity and nothing else, it declares its reason, and every row it
--    deletes is preserved whole in ca_ledger_mutation_log - which is why this
--    incident counts occurrences rather than chips. The net is doing exactly
--    what it exists to do and the bypass is the sanctioned one.
--
--    Asserted below across the WHOLE mutation log, not just this reason:
--    every bypass declares a reason, and not one deleted row anywhere is
--    missing its preserved copy. Measured: 25,382 logged bypasses, ten
--    distinct declared reasons (certification-cleanup 18,896, the 2026-09-01
--    funding redo 5,319, the rakeback chain incident 933, the retired
--    test-account audit 144, and six smaller named cleanups), zero
--    unpreserved deletes.
--
-- The other four open incidents are NOT closed here, deliberately: absent
-- players (7e9ebb40) is still draining, the tournament chip conservation
-- warning (8b8fe26c) names three live events, and the two supply-snapshot
-- warnings need the meter's reader rewritten to window by snapshot rather than
-- by clock. Closing a net that is still finding something would be worse than
-- leaving it open.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $body$
DECLARE
  v_recent integer;
  v_undeclared integer;
  v_unpreserved integer;
  v_rows integer;
BEGIN
  -- 1. no lease-proof hand refusal in the last six hours
  SELECT count(*) INTO v_recent
    FROM public.financial_alerts a
   WHERE a.source = 'ServerTableEngine.authoritative_hand_semantic_refusal'
     AND a.context->>'error' LIKE '%lease_proof_expired%'
     AND a.created_at > now() - interval '6 hours';
  IF v_recent <> 0 THEN
    RAISE EXCEPTION '% lease-proof hand refusal(s) in the last six hours; the cause is not finished', v_recent;
  END IF;

  -- 2. every bypass declares a reason, and every deleted row is preserved
  SELECT count(*) INTO v_undeclared
    FROM public.ca_ledger_mutation_log m
   WHERE COALESCE(btrim(m.reason), '') = '';
  IF v_undeclared <> 0 THEN
    RAISE EXCEPTION '% append-only bypass(es) declare no reason at all', v_undeclared;
  END IF;
  SELECT count(*) INTO v_unpreserved
    FROM public.ca_ledger_mutation_log m
   WHERE m.operation = 'DELETE' AND m.old_row IS NULL;
  IF v_unpreserved <> 0 THEN
    RAISE EXCEPTION '% deleted row(s) were not preserved in the mutation log', v_unpreserved;
  END IF;

  UPDATE public.ca_drift_incidents i
     SET status = 'resolved', resolved_at = now(),
         root_cause = 'Hand commits refused with "lease proof expired" during the tournament-lease churn: the PostgREST pre-request hook and two hand-path lease reads took FOR SHARE, which conflicts with the heartbeat''s FOR NO KEY UPDATE, so managers lost leases under load and their in-flight hand commits were refused. A refusal rolls the hand back whole before any money step - no chips moved, the hand was lost.',
         correction_ref = 'migration a_hand_commit_does_not_hold_the_lease_against_its_own_heartbeat',
         resolution = 'Fixed at the root today, with a_busy_manager_keeps_its_lease alongside it; ZERO refusals of this class in the eleven hours since. The detector reads a rolling 24-hour window, so the historic 117 stay in its count until they age out - asserted here that none has occurred in the last six hours.'
   WHERE i.status = 'open' AND i.source = 'fn_ca_conservation_sweep:fn_ca_hand_commit_refusals';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'expected to resolve 1 hand-refusal incident, resolved %', v_rows; END IF;

  UPDATE public.ca_drift_incidents i
     SET status = 'resolved', resolved_at = now(),
         root_cause = 'cleanup_reserved_certification_account removes a Club Arena customization CERTIFICATION identity and declares the append-only bypass it uses. It refuses any identity whose email is not ca-customization-cert-%@example.invalid (42501) and refuses to run while the platform is frozen; every row it deletes is preserved whole in ca_ledger_mutation_log. The append-only watch counts those declared bypasses, which is what it is for.',
         correction_ref = 'verified: every one of the 25,382 logged bypasses declares a reason and not one deleted row anywhere is missing its preserved copy, asserted in this migration',
         resolution = 'Expected behaviour. The bypass is the sanctioned certification-cleanup path, it refuses every non-certification identity, and nothing it removed was lost. Nothing to correct.'
   WHERE i.status = 'open' AND i.source = 'fn_ca_journal_append_only';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'expected to resolve 1 append-only notice, resolved %', v_rows; END IF;
END
$body$;

COMMIT;
