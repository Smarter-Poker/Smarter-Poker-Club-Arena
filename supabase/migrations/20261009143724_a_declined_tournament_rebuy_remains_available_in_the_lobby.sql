-- Owner request 2026-10-09: declining or missing the brief rebuy prompt must
-- not prevent a later lobby rebuy while the event purchase window is open.
-- Preserve the exact latest accepted-hand knockout, unpaid zero stack, caps,
-- bounty completion, financial receipt, seat assignment and maintenance gates.
-- Only remove the rebuy-only restriction to a pending (rather than eliminated)
-- candidate. The existing re-entry path already supports this same transition.
-- No player rows, paid results, balances, receipts or prompt deadlines change.
-- Version reserved by scripts/new-migration.mjs.
BEGIN;
SET LOCAL lock_timeout = '250ms';
SET LOCAL statement_timeout = '8s';

DO $lobby_rebuy$
DECLARE
  v_oid regprocedure := 'public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)'::regprocedure;
  v_source text;
  v_next text;
  v_needle text := $needle$       OR (v_type='rebuy' AND v_candidate.state<>'pending')
$needle$;
BEGIN
  SELECT pg_get_functiondef(v_oid) INTO v_source;
  IF (length(v_source)-length(replace(v_source,v_needle,'')))/length(v_needle) <> 1
     OR position('public.fn_ca_latest_committed_knockout_candidate(' IN v_source)=0
     OR position('public.fn_ca_tournament_rebuy_window(' IN v_source)=0
     OR position('public.fn_record_entry_purchase_receipt(' IN v_source)=0
     OR position('public.fn_ca_assign_tournament_player_seat_locked(' IN v_source)=0
     OR position('v_player.prize' IN v_source)=0
     OR position('v_candidate.rebuy_prompt_until<=clock_timestamp()' IN v_source)=0 THEN
    RAISE EXCEPTION 'Lobby rebuy preimage differs from the qualified atomic purchase authority';
  END IF;
  v_next := replace(v_source,v_needle,'');
  EXECUTE v_next;
  IF pg_get_functiondef(v_oid) IS DISTINCT FROM v_next THEN
    RAISE EXCEPTION 'Lobby rebuy postimage differs from the exact one-clause correction';
  END IF;
END;
$lobby_rebuy$;
COMMIT;
