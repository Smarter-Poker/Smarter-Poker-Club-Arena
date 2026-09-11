-- Mutating an accepted hand after consent must invalidate the exact proposal.
-- The exception rolls back the synthetic witness mutation AND invalidation.
DO $stale_witness$
DECLARE original jsonb:=pg_temp.final_deal_exact_state(); r record; result jsonb; caught boolean:=false; stale_refused boolean:=false;
BEGIN
 SELECT * INTO STRICT r FROM native_deal_request;
 BEGIN
  UPDATE public.hand_atomic_commits SET committed_at=committed_at+interval '1 second'
   WHERE hand_number=9800007;
  result:=public.fn_get_tournament_deal_consensus('87000000-0000-0000-0000-000000000001');
  PERFORM pg_temp.deal_assert(result->>'ready'='false','changed accepted witness invalidates unanimous consent');
  BEGIN
  result:=public.fn_complete_tournament_terminal_proposal(
   '87000000-0000-0000-0000-000000000001',NULL,'final_table_deal',r.proposal_id,r.revision);
  EXCEPTION WHEN OTHERS THEN
   IF SQLERRM='deal proposal is stale' THEN stale_refused:=true; ELSE RAISE; END IF;
  END;
  PERFORM pg_temp.deal_assert(stale_refused,'stale witness cannot execute the old consent');
  PERFORM pg_temp.deal_assert(NOT EXISTS(SELECT 1 FROM public.tournament_final_table_deal_batches
   WHERE tournament_id='87000000-0000-0000-0000-000000000001'), 'stale witness creates no deal batch');
  RAISE EXCEPTION 'restore synthetic witness drift' USING ERRCODE='ZX019';
 EXCEPTION WHEN SQLSTATE 'ZX019' THEN caught:=true;
 END;
 PERFORM pg_temp.deal_assert(caught AND pg_temp.final_deal_exact_state()=original,
  'stale-consent experiment restores every financial and proposal row');
END $stale_witness$;
