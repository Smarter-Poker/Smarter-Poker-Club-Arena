-- F06 MIXED MANAGER CUSTODY: bind the admission to the custody, not to the process.
--
-- 20260918232558 introduced smarter_private.f06_mixed_current_admission with
--   "Admission binds the real lease row, including the process and acquisition."
-- It compared the admission's stored lease_identity to the WHOLE live lease row
-- minus heartbeat_at. public.engine_tournament_leases carries three volatile
-- process facts - instance_id, engine_version, acquired_at - which necessarily
-- change on every engine restart and on every re-claim of the same lease.
-- Consequence: once an admission row existed, ONLY the exact process that wrote
-- it could ever complete the transfer, so every release stranded every open
-- transfer permanently. On 2026-09-26 09:33 a sealed release drained 122
-- transfers; 121 open admissions were refused 100% of the time thereafter,
-- holding 118 RUNNING events and 377 live players with no hand dealt since.
--
-- The property that check was protecting is that the admission was made against
-- a REAL protocol-2 lease for THIS custody - not that the same OS process is
-- still alive. Custody is the tournament + its successor generation + the exact
-- drained hand set, all of which are recorded in append-only rows. This replaces
-- the volatile process triple with the durable custody coordinates and re-proves
-- them from rows, and additionally refuses when the custody itself changed.
--
-- Nothing here weakens the completion proof: fn_f06_complete_mixed_manager_custody
-- still re-proves the whole drained hand set from rows (table set, every operation
-- terminal, no reserved permits, no dispatch, every pending move/park/custody/
-- cleanup/begin/amendment resolved) before it writes a completion.
--
-- Two-process safety is structural and unchanged: smarter_private.f06_try_lane
-- takes an EXCLUSIVE per-tournament advisory xact lock (raising 40001 on
-- contention) and f06_manager_custody_completions has transfer_id as PRIMARY KEY,
-- so at most one completion can ever be written for a transfer.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='8s';

-- Refuse to run against anything but the exact function analysed.
DO $guard$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM pg_proc
    WHERE oid = to_regprocedure('smarter_private.f06_mixed_current_admission(uuid,uuid,uuid)')
      AND md5(pg_get_functiondef(oid)) = '90ff66e263413795edcc691a879595d7'
      AND md5(prosrc) = 'dc612333e6fc9bb08bf70ffa8562ce1a'
      AND pg_get_userbyid(proowner) = 'postgres'
      AND prosecdef
      AND proacl::text = '{postgres=X/postgres}'
      AND proconfig = ARRAY['search_path=pg_catalog, public, smarter_private']
  ) THEN RAISE EXCEPTION 'F06_MIXED_ADMISSION_DEPENDENCY_DRIFT'; END IF;

  -- The drained event is frozen while a transfer is open: this trigger refuses
  -- every new reserved hand permit, so a RUNNING event with an open transfer
  -- cannot leave RUNNING on its own. That is what makes the RUNNING gate below
  -- a real guard rather than a new permanent-refusal class.
  IF NOT EXISTS(
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'smarter_private.f06_hand_permits'::regclass
      AND tgname = 'f06_mixed_preparation_custody'
      AND tgenabled = 'O' AND NOT tgisinternal
      AND pg_get_triggerdef(oid) = 'CREATE TRIGGER f06_mixed_preparation_custody BEFORE INSERT OR UPDATE ON smarter_private.f06_hand_permits FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_mixed_preparation_guard()'
  ) THEN RAISE EXCEPTION 'F06_MIXED_PREPARATION_BINDING_DRIFT'; END IF;

  -- Single-winner guard relied on for two-process safety.
  IF NOT EXISTS(
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'smarter_private.f06_manager_custody_completions'::regclass
      AND contype = 'p' AND pg_get_constraintdef(oid) = 'PRIMARY KEY (transfer_id)' AND convalidated
  ) THEN RAISE EXCEPTION 'F06_MIXED_COMPLETION_KEY_DRIFT'; END IF;
END $guard$;

CREATE OR REPLACE FUNCTION smarter_private.f06_mixed_current_admission(t uuid, g uuid, transfer uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $$
DECLARE
  a smarter_private.f06_manager_custody_admissions;
  tr smarter_private.f06_manager_custody_transfers;
  l public.engine_tournament_leases;
  s text;
BEGIN
  -- Unchanged: the caller must be the tournament-manager actor holding a LIVE
  -- protocol-2 lease for t at generation g (heartbeat within 30s), key-shared.
  PERFORM smarter_private.f06_authority(t,g);

  -- The live lease must still be this tournament's protocol-2 lease at the
  -- named successor generation. Re-read explicitly so the binding is stated.
  SELECT * INTO l FROM public.engine_tournament_leases e WHERE e.tournament_id=t;
  IF NOT FOUND OR l.protocol_version<>2 OR l.lease_generation IS DISTINCT FROM g THEN
    RAISE EXCEPTION 'F06_MIXED_ADMITTED_LEASE_CHANGED'; END IF;

  SELECT * INTO a FROM smarter_private.f06_manager_custody_admissions WHERE transfer_id=transfer FOR SHARE;
  IF NOT FOUND OR a.tournament_id IS DISTINCT FROM t OR a.generation IS DISTINCT FROM g THEN
    RAISE EXCEPTION 'F06_MIXED_ADMITTED_PROCESS_CHANGED'; END IF;

  -- Custody, not process. The admission's stored lease_identity must name a real
  -- protocol-2 lease for THIS tournament at THIS successor generation. Its
  -- instance_id / engine_version / acquired_at are process facts that never
  -- described the custody and cannot survive a restart, so they are not compared.
  IF (a.lease_identity->>'tournament_id')::uuid    IS DISTINCT FROM t
  OR (a.lease_identity->>'lease_generation')::uuid IS DISTINCT FROM g
  OR (a.lease_identity->>'protocol_version')::int  IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'F06_MIXED_ADMITTED_CUSTODY_CHANGED'; END IF;

  -- The custody must still be the admitted custody. The transfer row is
  -- append-only (f06_manager_transfer_immutable) and carries the drained hand
  -- set in local_proof / canonical_proof, which the completion re-proves in full.
  SELECT * INTO tr FROM smarter_private.f06_manager_custody_transfers WHERE transfer_id=transfer;
  IF NOT FOUND OR tr.tournament_id IS DISTINCT FROM t OR tr.successor_generation IS DISTINCT FROM g THEN
    RAISE EXCEPTION 'F06_MIXED_ADMITTED_CUSTODY_CHANGED'; END IF;

  -- A drained event cannot deal while its transfer is open, so it cannot leave
  -- RUNNING by itself. Anything else is an explicit abort/void and must not be
  -- completed as ordinary custody.
  SELECT status INTO s FROM public.tournaments WHERE id=t;
  IF s IS DISTINCT FROM 'RUNNING' THEN
    RAISE EXCEPTION 'F06_MIXED_ADMITTED_EVENT_NOT_RUNNING'; END IF;

  RETURN to_jsonb(a);
END $$;

REVOKE ALL ON FUNCTION smarter_private.f06_mixed_current_admission(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

COMMIT;
