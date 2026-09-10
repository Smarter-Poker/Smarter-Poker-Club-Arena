-- Prepared activation only after expansion, native acceptance and exact
-- compatible engine plus frontend adoption. The release coordinator owns this.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='30s';
SELECT pg_advisory_xact_lock(hashtextextended('ca:tournament-terminal-settlement:v1',0));
LOCK TABLE public.tournaments IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE public.tournament_obligations IN ACCESS EXCLUSIVE MODE NOWAIT;
DO $dependencies$
BEGIN
  IF to_regprocedure('public.fn_assert_tournament_manager_write_scope(uuid)') IS NULL
     OR to_regprocedure('public.fn_complete_tournament_terminal(uuid,uuid,text)') IS NULL
     OR to_regprocedure('public.fn_resolve_tournament_terminal_outcome(uuid,uuid,text)') IS NULL
     OR to_regprocedure('public.fn_get_tournament_deal_consensus(uuid)') IS NULL
     OR to_regprocedure('public.fn_begin_tournament_deal_review(uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_close_tournament_deal_review(uuid,uuid,text)') IS NULL
     OR to_regprocedure('public.fn_cast_tournament_deal_vote(uuid,uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_request_tournament_deal_review(uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_cancel_tournament_deal_review(uuid,uuid,uuid)') IS NULL
     OR to_regprocedure('public.fn_complete_tournament_terminal_proposal(uuid,uuid,text,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'exact-deal activation requires current terminal and proposal authorities';
  END IF;
END;
$dependencies$;
CREATE TRIGGER require_exact_final_deal_proposal
BEFORE INSERT OR UPDATE OF tournament_id,kind,user_id,place,amount_owed ON public.tournament_obligations
FOR EACH ROW EXECUTE FUNCTION public.fn_require_exact_final_deal_proposal();
-- The old vote was never consent to a version. Preserve its historical rows
-- for legacy receipt replay, while new players must use the proposal RPC.
REVOKE INSERT,UPDATE,DELETE ON public.tournament_deal_votes FROM authenticated,anon;
REVOKE EXECUTE ON FUNCTION public.fn_cast_tournament_deal_vote(uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
