-- Residue of the 2026-09-26 09:34 UTC mass mixed-custody drain: a manager
-- custody transfer (smarter_private.f06_manager_custody_transfers) with no
-- completion row is "open" everywhere this codebase reads that state
-- (f06_lease_has_pending_custody, fn_f06_find_mixed_manager_custody,
-- f06_mixed_preparation_guard, f06_mixed_movement_generation,
-- f06_retired_origin_claim_guard, fn_f06_abort_abandoned_generation). The
-- ordinary door, fn_f06_complete_mixed_manager_custody, can only ever close
-- one: smarter_private.f06_mixed_current_admission demands the event still
-- be RUNNING before it will complete a handover ("a drained event cannot
-- deal while its transfer is open, so it cannot leave RUNNING by itself" -
-- true only while the transfer is the reason it's still running).
--
-- Two provable shapes never fit that door and never will:
--
--  (a) EVENT_TERMINAL: the event left RUNNING by a path that has nothing to
--      do with this transfer at all - its own normal completion, a
--      cancellation, or a reviewed void - while an admitted-but-never-
--      completed (or never-admitted) transfer sat untouched. Every chip this
--      event ever owed was already settled by whatever terminated it; nothing
--      here moves one. The recovery sweep
--      (server/src/tournament/drainedF06Custody.ts readF06RecoveryAdmission,
--      calling fn_f06_assert_drained_manager_custody) demands RUNNING even
--      more directly and so refuses this shape forever, every few seconds,
--      as F06_DRAINED_CUSTODY_EVENT_CHANGED / f06_drained_custody_unproven.
--
--  (b) ABANDONED_UNADMITTED: the event is still RUNNING, but no lease has
--      existed for it at all (not stale - ABSENT), the origin's own F06
--      bookkeeping shows nothing outstanding (no reserved hand, no open
--      break), and the transfer was never admitted. Its successor_generation
--      was minted once, for one specific successor that never claimed it;
--      nothing will ever mint that exact value again. A transfer with a
--      reserved original hand still on the table is never closed here - that
--      is fn_f06_void_stranded_mixed_original's proof to make, hand by hand -
--      and a transfer already admitted with a live event and no lease is a
--      stale-lease recovery, never this door's to decide.
--
-- This door closes the paperwork the same way the ordinary door does - one
-- row in f06_manager_custody_completions, keyed by transfer_id, so every
-- reader above sees it resolved and the recovery sweep has nothing left to
-- offer - except its presence_receipts names itself as an administrative
-- closure instead of running f06_mixed_adopt_presence (which assumes a live
-- table and would simply misfire against a closed or abandoned one). It
-- never writes to a table_seats, tournament_players or chip_ledger row.
CREATE OR REPLACE FUNCTION public.fn_f06_close_abandoned_manager_transfer(
  p_tournament_id uuid,
  p_transfer_id uuid,
  p_receipt_id uuid,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
DECLARE
  v_actor text := current_setting('app.smarter_data_actor', true);
  v_has_admission boolean;
  t public.tournaments;
  xfer smarter_private.f06_manager_custody_transfers;
  a smarter_private.f06_manager_custody_admissions;
  c smarter_private.f06_manager_custody_completions;
  l public.engine_tournament_leases;
  operations jsonb;
  presence jsonb;
  v_basis text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' OR v_actor IS DISTINCT FROM 'service' THEN
    RAISE EXCEPTION 'F06_TRANSFER_CLOSE_SERVICE_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF p_tournament_id IS NULL OR p_transfer_id IS NULL OR p_receipt_id IS NULL
     OR length(btrim(COALESCE(p_reason, ''))) < 40 THEN
    RAISE EXCEPTION 'F06_TRANSFER_CLOSE_IDENTITY_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'PLATFORM_FROZEN: manager-transfer close refused' USING ERRCODE = '55000';
  END IF;

  PERFORM smarter_private.f06_try_lane(p_tournament_id);

  SELECT * INTO t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF t.id IS NULL THEN
    RAISE EXCEPTION 'F06_TRANSFER_CLOSE_EVENT_MISSING' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO xfer FROM smarter_private.f06_manager_custody_transfers
   WHERE transfer_id = p_transfer_id FOR SHARE;
  IF NOT FOUND OR xfer.tournament_id IS DISTINCT FROM p_tournament_id THEN
    RAISE EXCEPTION 'F06_TRANSFER_CLOSE_TRANSFER_CHANGED' USING ERRCODE = '55000';
  END IF;

  -- Idempotent replay: a transfer already completed, by this door or the
  -- ordinary one, is answered from its own stored receipt, never re-run.
  SELECT * INTO c FROM smarter_private.f06_manager_custody_completions WHERE transfer_id = p_transfer_id;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'transfer_id', p_transfer_id,
      'tournament_id', p_tournament_id, 'basis', 'replayed', 'completion', to_jsonb(c));
  END IF;

  IF upper(t.status) IN ('COMPLETED', 'CANCELLED') THEN
    v_basis := 'event_terminal';
  ELSIF upper(t.status) = 'RUNNING' THEN
    SELECT * INTO l FROM public.engine_tournament_leases WHERE tournament_id = p_tournament_id FOR SHARE;
    IF FOUND THEN
      RAISE EXCEPTION 'F06_TRANSFER_CLOSE_EVENT_STILL_RUNNING' USING ERRCODE = '55000';
    END IF;
    IF EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits WHERE tournament_id = p_tournament_id AND state = 'reserved')
       OR EXISTS (SELECT 1 FROM smarter_private.f06_operations WHERE tournament_id = p_tournament_id
                   AND state NOT IN ('acknowledged', 'withdrawn_before_manifest'))
    THEN
      RAISE EXCEPTION 'F06_TRANSFER_CLOSE_RECOVERY_INCOMPLETE' USING ERRCODE = '55000';
    END IF;
    IF EXISTS (SELECT 1 FROM smarter_private.f06_manager_custody_admissions a2 WHERE a2.transfer_id = p_transfer_id) THEN
      RAISE EXCEPTION 'F06_TRANSFER_CLOSE_ALREADY_ADMITTED' USING ERRCODE = '55000';
    END IF;
    v_basis := 'abandoned_unadmitted';
  ELSE
    RAISE EXCEPTION 'F06_TRANSFER_CLOSE_EVENT_STATUS_UNPROVEN' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO a FROM smarter_private.f06_manager_custody_admissions WHERE transfer_id = p_transfer_id;
  v_has_admission := FOUND;
  IF v_has_admission AND (a.tournament_id, a.generation) IS DISTINCT FROM (p_tournament_id, xfer.successor_generation) THEN
    RAISE EXCEPTION 'F06_TRANSFER_CLOSE_ADMISSION_CHANGED' USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(o) ORDER BY o.break_id), '[]') INTO operations
    FROM smarter_private.f06_operations o WHERE o.tournament_id = p_tournament_id;

  presence := jsonb_build_object(
    'kind', 'f06_manager_transfer_administrative_closure',
    'basis', v_basis,
    'receipt_id', p_receipt_id,
    'reason', p_reason,
    'tournament_status', t.status,
    'tournament_ended_at', t.ended_at,
    'closed_at', clock_timestamp());

  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'PLATFORM_FROZEN: manager-transfer close refused' USING ERRCODE = '55000';
  END IF;

  INSERT INTO smarter_private.f06_manager_custody_completions
    (transfer_id, tournament_id, generation, admission, operation_receipts, presence_receipts)
  VALUES (p_transfer_id, p_tournament_id, xfer.successor_generation,
          CASE WHEN v_has_admission THEN to_jsonb(a) ELSE 'null'::jsonb END,
          operations, presence)
  RETURNING * INTO c;

  RETURN jsonb_build_object('ok', true, 'transfer_id', p_transfer_id, 'tournament_id', p_tournament_id,
    'basis', v_basis, 'completion', to_jsonb(c));
END
$function$;
