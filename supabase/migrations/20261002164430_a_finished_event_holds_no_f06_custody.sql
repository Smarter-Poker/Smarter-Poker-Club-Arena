-- 20261002164430_a_finished_event_holds_no_f06_custody.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A FINISHED EVENT HOLDS NO F06 CUSTODY (2026-10-02)
-- ==================================================
--
-- WHAT WAS WRONG
-- --------------
-- engine /health reported leaseCustodyRetained.tournaments = 9, oldest
-- ~567,000 s. All nine are COMPLETED events (d3b9ae27, bbd6d4ea, 833616f3,
-- 019b6263, 7c06694b, ed51f41f, eafe7bdb, b48b1993, 3b854dd7) that ended on
-- 2026-09-25/26 and whose leases belong to engine instance 1-1bcee94e, which
-- stopped heartbeating at 2026-09-26 01:58:27 UTC. reap_dead_engine_leases
-- retains each one because smarter_private.f06_lease_has_pending_custody
-- answers TRUE: each event still carries a table-break operation that never
-- reached a terminal state - eight at close_confirmed, one at begun.
--
-- close_confirmed vs acknowledged, read from the code, not assumed:
--   * fn_f06_close_break writes the close receipt and closes the source table
--     in the database; the row becomes close_confirmed. Every member already
--     has its attempt (the move) behind it.
--   * fn_f06_ack_cleanup is the LIVE OWNER's statement that its local engine
--     object for the source table has been unregistered ('retired') or proven
--     absent ('verified_absent'); only it moves the row to acknowledged
--     (TournamentManager.ts: unregisterTableEngine -> confirmAbsent ->
--     ackCleanup). It takes the event lease (f06_lock_break) and the exact
--     custody generation and revision.
-- So close_confirmed is correctly OPEN while an event runs: a successor must
-- claim the custody (fn_f06_claim_custody) and acknowledge it, and the lease
-- is the evidence it claims against. The helper is right about that, and
-- this migration does not change it.
--
-- What it gets wrong is an event that is OVER. The nine events finished
-- seconds-to-minutes after their last break closed (7c06694b: break closed
-- 17:02:02, event ended 17:02:34), before the owner's acknowledgement. Once
-- an event is COMPLETED or CANCELLED no manager is ever started for it again,
-- so nothing can ever claim or acknowledge those rows, and the predicate
-- keeps the lease for ever. Waiting cannot fix it. The same is true of every
-- open operation on a finished event: measured before this migration,
-- 50 non-terminal rows on 35 events (16 close_confirmed, 23 begun,
-- 11 park_requested), every one on a COMPLETED (33) or CANCELLED (2) event
-- from 2026-09-18..29, every event prize-pool-finalized, every table closed,
-- no seat occupied, every entrant 'eliminated' or 'winner'. No RUNNING or
-- REGISTERING event carries an open operation at all.
--
-- WHAT THIS CHANGES
-- -----------------
-- One new predicate, smarter_private.f06_event_is_finished(event), TRUE only
-- when ALL of the following are read from rows:
--   1. tournaments.status is COMPLETED or CANCELLED,
--   2. prize_pool_finalized is true (the escrow is settled and closed),
--   3. every table the event ever owned is 'closed',
--   4. no seat on any of those tables is occupied (player_id set, or a seat
--      that never left),
--   5. every entrant is 'eliminated' or 'winner' (nobody is mid-move, mid-
--      hand, registered or still playing).
-- Anything it cannot read answers FALSE (COALESCE), which keeps the lease:
-- "I could not tell" is never permission to collect (CLAUDE.md 10.86 rule 1).
--
-- f06_lease_has_pending_custody asks it for the OPERATIONS clause only. An
-- open operation of a finished event no longer holds a lease: there is no
-- stack, seat, hand or player left for that operation to protect, and no
-- actor exists that could ever finish it. Everything else is untouched:
--   * the terminal set is still smarter_private.f06_terminal_operation_states()
--     (this migration states no second one - CLAUDE.md 10.8);
--   * a 'reserved' hand permit still holds the lease on its own, finished
--     event or not (it carries original hole-card evidence);
--   * a manager custody transfer with no completion still holds it on its own
--     (fn_f06_close_abandoned_manager_transfer is that record's own door);
--   * a RUNNING / REGISTERING event cannot satisfy rule 1, so live custody is
--     exactly as protected as before, and the reaper still only ever looks at
--     leases whose heartbeat is older than its cutoff.
-- The open rows themselves are left as they are: they are the honest record
-- that the owner never acknowledged, and the state machine has no receipted
-- terminal state a database-side writer could truthfully give them.
--
-- Effect: the next reap_dead_engine_leases call (GameServer housekeeping)
-- deletes the nine dead leases; leaseCustodyRetained then counts only real
-- custody.
--
-- @live-proof: (SELECT pg_get_functiondef('smarter_private.f06_lease_has_pending_custody(uuid,uuid)'::regprocedure) LIKE '%NOT smarter_private.f06_event_is_finished(o.tournament_id)%')

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $pin$
BEGIN
  -- 1. The helper being replaced is byte for byte the one that was read
  --    (installed by 20260921165904).
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid = to_regprocedure('smarter_private.f06_lease_has_pending_custody(uuid,uuid)')
      AND md5(pg_get_functiondef(oid)) = '8f782938af2b3d213a8f1c02dc31d89f'
      AND proowner = 'postgres'::regrole
      AND proconfig = ARRAY['search_path=pg_catalog, public, smarter_private']
      AND proacl::text = '{postgres=X/postgres}'
  ) THEN
    RAISE EXCEPTION 'F06_CUSTODY_PREDICATE_PREIMAGE_CHANGED';
  END IF;

  -- 2. The terminal set is still the protocol's one definition.
  IF smarter_private.f06_terminal_operation_states()
     IS DISTINCT FROM ARRAY['acknowledged', 'withdrawn_before_manifest']::text[] THEN
    RAISE EXCEPTION 'F06_TERMINAL_SET_CHANGED';
  END IF;

  -- 3. The state machine still has exactly the five states classified above.
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint
      WHERE conname = 'f06_operations_state_check'
        AND conrelid = 'smarter_private.f06_operations'::regclass)
     IS DISTINCT FROM
     'CHECK ((state = ANY (ARRAY[''park_requested''::text, ''begun''::text, ''close_confirmed''::text, ''acknowledged''::text, ''withdrawn_before_manifest''::text])))'
  THEN
    RAISE EXCEPTION 'F06_OPERATION_STATE_MACHINE_CHANGED';
  END IF;
END $pin$;

CREATE FUNCTION smarter_private.f06_event_is_finished(p_tournament_id uuid)
RETURNS boolean LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $function$
  SELECT COALESCE((
    SELECT upper(t.status) IN ('COMPLETED', 'CANCELLED')
       AND COALESCE(t.prize_pool_finalized, false)
       AND NOT EXISTS (SELECT 1 FROM public.tables tb
                        WHERE tb.tournament_id = t.id
                          AND lower(COALESCE(tb.status, '')) <> 'closed')
       AND NOT EXISTS (SELECT 1 FROM public.tables tb
                         JOIN public.table_seats s ON s.table_id = tb.id
                        WHERE tb.tournament_id = t.id
                          AND (s.player_id IS NOT NULL OR s.left_at IS NULL))
       AND NOT EXISTS (SELECT 1 FROM public.tournament_players tp
                        WHERE tp.tournament_id = t.id
                          AND COALESCE(tp.status, '') NOT IN ('eliminated', 'winner'))
      FROM public.tournaments t
     WHERE t.id = p_tournament_id
  ), false)
$function$;
REVOKE ALL ON FUNCTION smarter_private.f06_event_is_finished(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION smarter_private.f06_event_is_finished(uuid) IS
 'TRUE only when an event is COMPLETED or CANCELLED, prize-pool-finalized, every table closed, no seat occupied and every entrant eliminated or winner. No F06 operation of such an event can protect a stack, seat, hand or player, and no manager will ever run for it again. Unreadable answers FALSE.';

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
 -- An open operation of a FINISHED event protects nothing and can never be
 -- acknowledged (no manager runs for it again), so it holds no lease
 -- (20261002164430). A reserved permit and an uncompleted transfer still do.
 IF EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits h WHERE h.state='reserved'
  AND (h.tournament_id=event_id OR h.table_id=p_table_id))
 OR EXISTS(SELECT 1 FROM smarter_private.f06_operations o
  WHERE COALESCE(NOT(o.state=ANY(smarter_private.f06_terminal_operation_states())),true)
  AND (o.tournament_id=event_id OR o.source_table_id=p_table_id
   OR EXISTS(SELECT 1 FROM smarter_private.f06_attempts a WHERE a.break_id=o.break_id
    AND a.destination_table_id=p_table_id))
  AND NOT smarter_private.f06_event_is_finished(o.tournament_id)) THEN RETURN true; END IF;

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
 'Holds an expired lease while an F06 operation of an unfinished event is still open, a hand permit is still reserved, or a manager custody transfer has no completion. Open is the complement of smarter_private.f06_terminal_operation_states(); finished is smarter_private.f06_event_is_finished().';

-- Post-image: no live event lost its protection. Every open operation on an
-- event that is not finished must still hold its event's lease.
DO $post$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n
    FROM (SELECT DISTINCT o.tournament_id FROM smarter_private.f06_operations o
           WHERE NOT (o.state = ANY (smarter_private.f06_terminal_operation_states()))) e
    JOIN public.tournaments t ON t.id = e.tournament_id
   WHERE upper(t.status) NOT IN ('COMPLETED', 'CANCELLED')
     AND NOT smarter_private.f06_lease_has_pending_custody(e.tournament_id, NULL);
  IF n <> 0 THEN
    RAISE EXCEPTION 'F06_LIVE_EVENT_LOST_CUSTODY: % unfinished event(s)', n;
  END IF;
END $post$;

COMMIT;
