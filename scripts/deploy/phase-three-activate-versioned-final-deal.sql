-- Prepared activation only after expansion, native acceptance and exact
-- compatible engine plus frontend adoption. The release coordinator owns this.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='30s';
-- Current terminal lane takes authority G then hand barrier B before rows.
SELECT public.fn_ca_lock_settlement_lane_global();
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
DO $exact_trigger$
DECLARE expected_columns smallint[];
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_require_exact_final_deal_proposal()')
   AND md5(prosrc)='35f32e6768be09006753ba07f994a93b'
   AND proowner='postgres'::regrole AND prorettype='trigger'::regtype) THEN
  RAISE EXCEPTION 'exact-deal proposal authority differs'; END IF;
 SELECT array_agg(a.attnum ORDER BY n.ordinality) INTO expected_columns
 FROM unnest(ARRAY['tournament_id','kind','user_id','place','amount_owed']) WITH ORDINALITY n(name,ordinality)
 JOIN pg_attribute a ON a.attrelid='public.tournament_obligations'::regclass AND a.attname=n.name AND NOT a.attisdropped;
 IF cardinality(expected_columns)<>5 THEN RAISE EXCEPTION 'exact-deal obligation columns differ'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.tournament_obligations'::regclass
    AND tgname='require_exact_final_deal_proposal') THEN
  CREATE TRIGGER require_exact_final_deal_proposal
  BEFORE INSERT OR UPDATE OF tournament_id,kind,user_id,place,amount_owed ON public.tournament_obligations
  FOR EACH ROW EXECUTE FUNCTION public.fn_require_exact_final_deal_proposal();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.tournament_obligations'::regclass
   AND tgname='require_exact_final_deal_proposal' AND tgfoid='public.fn_require_exact_final_deal_proposal()'::regprocedure
   AND tgtype=23 AND tgenabled='O' AND NOT tgisinternal AND tgconstraint=0
   AND NOT tgdeferrable AND NOT tginitdeferred AND tgqual IS NULL AND tgnargs=0
   AND tgargs=''::bytea AND ARRAY(SELECT unnest(tgattr))=expected_columns) THEN
  RAISE EXCEPTION 'exact-deal proposal trigger shape differs'; END IF;
END $exact_trigger$;
-- The old vote was never consent to a version. Preserve its historical rows
-- for legacy receipt replay, while new players must use the proposal RPC.
REVOKE INSERT,UPDATE,DELETE ON public.tournament_deal_votes FROM authenticated,anon;
DO $legacy_vote$
BEGIN
 IF to_regprocedure('public.fn_cast_tournament_deal_vote(uuid)') IS NOT NULL THEN
  REVOKE EXECUTE ON FUNCTION public.fn_cast_tournament_deal_vote(uuid) FROM PUBLIC,anon,authenticated,service_role;
 END IF;
 IF has_table_privilege('authenticated','public.tournament_deal_votes','INSERT,UPDATE,DELETE')
   OR has_table_privilege('anon','public.tournament_deal_votes','INSERT,UPDATE,DELETE') THEN
  RAISE EXCEPTION 'unversioned direct vote writes remain open'; END IF;
END $legacy_vote$;
COMMIT;
