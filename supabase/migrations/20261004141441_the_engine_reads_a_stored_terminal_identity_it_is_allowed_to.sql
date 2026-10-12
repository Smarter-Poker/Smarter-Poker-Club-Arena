-- 20261004141441_the_engine_reads_a_stored_terminal_identity_it_is_allowed_to.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT WAS WRONG (2026-10-04, read from postgres and engine logs)
--
-- 20260909014534 revoked every privilege on public.tournament_terminal_settlements
-- from service_role. Two engine paths still read it directly through
-- PostgREST (server/src/tournament/terminalSettlementRpc.ts:
-- readCommittedTournamentTerminalReceipt and adoptStoredTerminalReceipt), so
-- every read was refused `permission denied for table
-- tournament_terminal_settlements` (42501): 36 in the 24 hours to 12:45Z,
-- engine context Tournament.external_terminal_receipt_unproven. A manager
-- could never adopt a terminal result another authority had committed, and a
-- refused replay could never be explained by its stored receipt.
--
-- WHAT THIS CHANGES
--
-- One read-only SECURITY DEFINER door returning exactly the two columns those
-- paths read (settlement_mode, winner_id) and whether the row exists. The table
-- stays revoked (asserted); only service_role may execute the door. The engine
-- reads through it from this commit on.
--
-- Applied to production as version 20261004141541 (the apply transport
-- stamps its own version; match by name, never by version).

BEGIN;
SET LOCAL lock_timeout = '2s';

DO $terminal_identity_preimage$
BEGIN
  IF to_regprocedure('public.fn_tournament_terminal_settlement_identity(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'PREIMAGE: fn_tournament_terminal_settlement_identity already exists';
  END IF;
END
$terminal_identity_preimage$;

CREATE FUNCTION public.fn_tournament_terminal_settlement_identity(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT jsonb_build_object(
           'found', s.tournament_id IS NOT NULL,
           'settlement_mode', s.settlement_mode,
           'winner_id', s.winner_id)
    FROM (SELECT 1) AS one
    LEFT JOIN public.tournament_terminal_settlements s ON s.tournament_id = p_tournament_id;
$function$;

REVOKE ALL ON FUNCTION public.fn_tournament_terminal_settlement_identity(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_tournament_terminal_settlement_identity(uuid)
  TO service_role;

DO $terminal_identity_postimage$
BEGIN
  IF has_function_privilege('anon', 'public.fn_tournament_terminal_settlement_identity(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_tournament_terminal_settlement_identity(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fn_tournament_terminal_settlement_identity(uuid)', 'EXECUTE')
     OR has_table_privilege('service_role', 'public.tournament_terminal_settlements', 'SELECT') THEN
    RAISE EXCEPTION 'POSTIMAGE: terminal identity door or table privileges are not as reviewed';
  END IF;
END
$terminal_identity_postimage$;

COMMIT;
