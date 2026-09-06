-- 20260906135711_phase_3_command_receipt_evidence_is_self_consistent.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A terminal receipt is operator evidence, not just an implementation detail.
-- The gateway has always constructed a consistent payload, but the table did
-- not reject a privileged writer that stored ok=true with status=rejected, a
-- different command UUID, or evidence for another reviewed contract version.
-- Make those relationships a database invariant as well as a client check.

BEGIN;

ALTER TABLE public.managed_game_command_receipts
  ADD CONSTRAINT managed_game_command_receipt_evidence_consistent
  CHECK (
    (
      status = 'processing'
      AND result = '{}'::jsonb
      AND contract_version_after IS NULL
    )
    OR
    (
      status IN ('succeeded', 'rejected')
      AND contract_version_before > 0
      AND contract_version_after > 0
      AND result @> jsonb_build_object(
        'ok', status = 'succeeded',
        'command_id', command_id,
        'command_status', status,
        'expected_version', expected_version,
        'current_version', contract_version_after,
        'version_before', contract_version_before,
        'version_after', contract_version_after
      )
    )
  ) NOT VALID;

ALTER TABLE public.managed_game_command_receipts
  VALIDATE CONSTRAINT managed_game_command_receipt_evidence_consistent;

DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.managed_game_command_receipts'::regclass
       AND conname = 'managed_game_command_receipt_evidence_consistent'
       AND convalidated
  ) THEN
    RAISE EXCEPTION 'ASSERT FAILED: terminal command evidence is not validated';
  END IF;
END;
$assert$;

COMMIT;
