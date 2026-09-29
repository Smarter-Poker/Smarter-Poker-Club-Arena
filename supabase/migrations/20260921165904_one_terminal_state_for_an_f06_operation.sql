-- 20260921165904_one_terminal_state_for_an_f06_operation
--
-- ONE definition of a terminal F06 operation. The divergence is deleted.
--
-- WHAT WAS WRONG (2026-09-21)
-- ---------------------------
-- Two things in this database answered "is this table break finished?" and
-- they did not agree.
--
--   public.fn_f06_discover_breaks   state NOT IN ('acknowledged',
--                                                 'withdrawn_before_manifest')
--   smarter_private.f06_lease_has_pending_custody
--                                   state <> 'acknowledged'
--
-- Discovery is the protocol. It is what the engine drives the break state
-- machine from, and the same two-name set is written identically in every
-- other F06 authority in this repo (generation-authority.sql lines 122, 129,
-- 169; mixed-authority.sql lines 280, 287, 340). The custody helper, added on
-- 2026-09-19 in 20260919024039, is the single outlier in the whole protocol.
--
-- Measured on production immediately before this migration:
--
--   acknowledged               423
--   park_requested             153
--   withdrawn_before_manifest   31   <- 30 distinct events
--   begun                        8
--
-- So 30 events kept a dead engine lease that nothing could ever release,
-- because the reaper asked the one predicate that disagrees with the protocol.
-- Waiting could not fix it, and PR #5035 deliberately produces MORE
-- withdrawn_before_manifest rows: it gives an abandoned last-table park a
-- terminal state it previously could not reach at all.
--
-- WHY withdrawn_before_manifest IS TERMINAL, FROM THE PROTOCOL
-- -----------------------------------------------------------
-- Not from anybody's assertion. From this table's own constraints:
--
--   f06_withdrawal_receipt   (state = 'withdrawn_before_manifest')
--                              = (abort_receipt_id IS NOT NULL)
--   f06_operations_check     (state IN ('close_confirmed','acknowledged'))
--                              = (close_receipt IS NOT NULL)
--
-- The state is unreachable without a durable abort receipt, and it is mutually
-- exclusive with ever having closed. The withdrawal is written in one
-- statement together with that receipt (generation-authority.sql line 195).
-- And no manifest was written, so no member was ever enrolled and no attempt
-- was ever made: on production all 31 rows carry zero f06_attempts and zero
-- f06_members. An f06_attempts row IS the player movement - it holds the
-- destination table, the destination seat and the winning receipt - so zero
-- attempts is the proof that nothing is half-moved and no seated stack is in
-- transit. This migration asserts that, and refuses to run if it is untrue.
--
-- WHAT THIS DOES NOT RELAX
-- ------------------------
-- Only the one state moves. park_requested, begun and close_confirmed all
-- still hold the lease, exactly as discovery still pages them. The helper's
-- two other custody tests - a 'reserved' hand permit, and a manager custody
-- transfer with no completion row - are untouched and still hold the lease on
-- their own. An unrecognised state now counts as OPEN rather than terminal,
-- which is the fail-closed direction (CLAUDE.md 10.86 rule 1).
--
-- CLAUDE.md 10.8: two written rules in conflict are not resolved by writing a
-- third. The protocol's set is adopted verbatim and is now named once, in
-- smarter_private.f06_terminal_operation_states(), which is the only thing
-- this database asks. tests/one-terminal-state-for-an-f06-operation.law.test.ts
-- keeps every other restatement of that set in step with it.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $pin$
DECLARE n bigint;
BEGIN
  -- 1. The helper being replaced is byte for byte the one that was measured.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = to_regprocedure('smarter_private.f06_lease_has_pending_custody(uuid,uuid)')
      AND md5(pg_get_functiondef(oid)) = 'e4753ec73b374243880b6515de96f992'
      AND proowner = 'postgres'::regrole
      AND proconfig = ARRAY['search_path=pg_catalog, public, smarter_private']
      AND proacl::text = '{postgres=X/postgres}'
  ) THEN
    RAISE EXCEPTION 'F06_CUSTODY_PREDICATE_PREIMAGE_CHANGED';
  END IF;

  -- 2. Its only caller is NOT touched here, and must still be the pinned one
  --    that 20260919024039 installed.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = to_regprocedure('public.reap_dead_engine_leases(integer)')
      AND md5(pg_get_functiondef(oid)) = '7501ae6661f48127f91d85d1fb0c9c9f'
  ) THEN
    RAISE EXCEPTION 'F06_LEASE_REAPER_PREIMAGE_CHANGED';
  END IF;

  -- 3. The state machine still has exactly the five states this
  --    reconciliation classified. A sixth state must be classified by a human
  --    reading the protocol, never absorbed silently by this predicate.
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conname = 'f06_operations_state_check'
        AND conrelid = 'smarter_private.f06_operations'::regclass)
     IS DISTINCT FROM
     'CHECK ((state = ANY (ARRAY[''park_requested''::text, ''begun''::text, ''close_confirmed''::text, ''acknowledged''::text, ''withdrawn_before_manifest''::text])))'
  THEN
    RAISE EXCEPTION 'F06_OPERATION_STATE_MACHINE_CHANGED';
  END IF;

  -- 4. The constraint that makes withdrawn_before_manifest a receipted,
  --    terminal outcome is still in force.
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conname = 'f06_withdrawal_receipt'
        AND conrelid = 'smarter_private.f06_operations'::regclass)
     IS DISTINCT FROM
     'CHECK (((state = ''withdrawn_before_manifest''::text) = (abort_receipt_id IS NOT NULL)))'
  THEN
    RAISE EXCEPTION 'F06_WITHDRAWAL_RECEIPT_CONSTRAINT_CHANGED';
  END IF;

  -- 5. THE SAFETY NUMBER. Every withdrawn operation really is empty: no
  --    manifest, no close receipt, an abort receipt present, and - the
  --    load-bearing one - no attempt and no member, so no seated stack is
  --    mid-move behind it. If this is ever non-zero the reconciliation would
  --    be waving through live custody, and this migration refuses instead.
  SELECT count(*) INTO n FROM smarter_private.f06_operations o
  WHERE o.state = 'withdrawn_before_manifest'
    AND (o.manifest IS NOT NULL
      OR o.close_receipt IS NOT NULL
      OR o.abort_receipt_id IS NULL
      OR EXISTS (SELECT 1 FROM smarter_private.f06_attempts a WHERE a.break_id = o.break_id)
      OR EXISTS (SELECT 1 FROM smarter_private.f06_members m WHERE m.break_id = o.break_id));
  IF n <> 0 THEN
    RAISE EXCEPTION 'F06_WITHDRAWN_OPERATION_IS_NOT_EMPTY: % row(s) still carry custody', n;
  END IF;

  -- 6. No unclassifiable row exists today either.
  SELECT count(*) INTO n FROM smarter_private.f06_operations WHERE state IS NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION 'F06_OPERATION_STATE_IS_NULL: % row(s)', n;
  END IF;
END $pin$;

-- "Before manifest" is now what the row means, not merely what it is called.
-- Validated against every existing row by this statement.
ALTER TABLE smarter_private.f06_operations
  ADD CONSTRAINT f06_withdrawal_has_no_manifest
  CHECK (state <> 'withdrawn_before_manifest' OR manifest IS NULL);

-- THE ONE DEFINITION. Adopted verbatim from public.fn_f06_discover_breaks,
-- which is the protocol. Nothing else in this database may state this set.
CREATE FUNCTION smarter_private.f06_terminal_operation_states()
RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $function$ SELECT ARRAY['acknowledged', 'withdrawn_before_manifest']::text[] $function$;
REVOKE ALL ON FUNCTION smarter_private.f06_terminal_operation_states()
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION smarter_private.f06_terminal_operation_states() IS
 'The only definition of a finished F06 table break. Identical to the set public.fn_f06_discover_breaks stops paging. A withdrawal carries an abort receipt, no manifest, no member and no attempt, so nothing is half-moved; an acknowledged operation carries a close receipt. Every other state still holds its lease.';

CREATE OR REPLACE FUNCTION smarter_private.f06_lease_has_pending_custody(p_tournament_id uuid,p_table_id uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,smarter_private AS $function$
DECLARE event_id uuid:=p_tournament_id; held boolean;
BEGIN
 IF p_table_id IS NOT NULL THEN
  SELECT tournament_id INTO event_id FROM public.tables WHERE id=p_table_id;
 END IF;
 -- An operation is open unless the protocol calls it finished. COALESCE makes
 -- a state this database cannot classify count as OPEN and keep the lease:
 -- "I could not tell" is never permission to collect (CLAUDE.md 10.86 rule 1).
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits h WHERE h.state='reserved'
  AND (h.tournament_id=event_id OR h.table_id=p_table_id))
 OR EXISTS(SELECT 1 FROM smarter_private.f06_operations o
  WHERE COALESCE(NOT(o.state=ANY(smarter_private.f06_terminal_operation_states())),true)
  AND (o.tournament_id=event_id OR o.source_table_id=p_table_id
   OR EXISTS(SELECT 1 FROM smarter_private.f06_attempts a WHERE a.break_id=o.break_id
    AND a.destination_table_id=p_table_id))) THEN RETURN true; END IF;

 -- The independently delivered custody authority can be installed before or
 -- after this repair. A partial schema keeps every transfer; absence of the
 -- whole schema means no transfer can yet exist. Never read private card data.
 IF to_regclass('smarter_private.f06_manager_custody_transfers') IS NOT NULL THEN
  IF to_regclass('smarter_private.f06_manager_custody_completions') IS NULL THEN
   EXECUTE 'SELECT EXISTS(SELECT 1 FROM smarter_private.f06_manager_custody_transfers t
    WHERE t.tournament_id=$1 OR EXISTS(SELECT 1 FROM jsonb_array_elements(t.local_proof->''engines'') e
     WHERE e->>''table_id''=$2::text))' INTO held USING event_id,p_table_id;
  ELSE
   EXECUTE 'SELECT EXISTS(SELECT 1 FROM smarter_private.f06_manager_custody_transfers t
    WHERE (t.tournament_id=$1 OR EXISTS(SELECT 1 FROM jsonb_array_elements(t.local_proof->''engines'') e
     WHERE e->>''table_id''=$2::text)) AND NOT EXISTS
     (SELECT 1 FROM smarter_private.f06_manager_custody_completions c WHERE c.transfer_id=t.transfer_id))'
    INTO held USING event_id,p_table_id;
  END IF;
  IF held THEN RETURN true; END IF;
 END IF;
 RETURN false;
END $function$;
REVOKE ALL ON FUNCTION smarter_private.f06_lease_has_pending_custody(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMENT ON FUNCTION smarter_private.f06_lease_has_pending_custody(uuid,uuid) IS
 'Holds an expired lease while an F06 operation is still open, a hand permit is still reserved, or a manager custody transfer has no completion. Open is the complement of smarter_private.f06_terminal_operation_states(), the protocol definition public.fn_f06_discover_breaks uses; this function no longer carries a second one.';
COMMIT;
