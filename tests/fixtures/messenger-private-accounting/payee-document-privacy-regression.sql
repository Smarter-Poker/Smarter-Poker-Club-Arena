\set ON_ERROR_STOP on
-- The same questions, asked of the same records, after 20260921052548. Every
-- defect is refused and every legitimate reader still answers. Rolled back:
-- this file only reads.
BEGIN;
SET LOCAL statement_timeout='30s';
SET LOCAL lock_timeout='3s';
DO $prerequisite$ BEGIN
 IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL
  OR to_regclass('public.rakeback_distributions') IS NULL
  OR NOT EXISTS(SELECT 1 FROM public.settlement_invoices WHERE id='9d1e4000-0000-4000-8000-000000000001')
 THEN RAISE EXCEPTION 'payee document privacy regression requires its committed preimage'; END IF;
 -- The candidate is installed, and the membership-wide predecessor is gone.
 IF EXISTS(SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
            WHERE c.relname='rakeback_distributions' AND p.polname='rakeback_distributions_club_member_select')
 THEN RAISE EXCEPTION 'predecessor rakeback policy still installed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
            WHERE c.relname='rakeback_distributions' AND p.polname='rakeback_distributions_party_select')
 THEN RAISE EXCEPTION 'successor rakeback policy absent'; END IF;
 IF to_regprocedure('public.fn_union_overseer_of_record(uuid,uuid)') IS NULL
  OR has_function_privilege('authenticated','public.fn_union_overseer_of_record(uuid,uuid)','EXECUTE')
  OR has_function_privilege('anon','public.fn_union_overseer_of_record(uuid,uuid)','EXECUTE')
 THEN RAISE EXCEPTION 'unbound overseer predicate missing or reachable from a browser role'; END IF;
END $prerequisite$;

-- The preimage committed in this same psql session, so its temporary helper
-- is still here; replace it rather than depending on which ran first.
CREATE OR REPLACE FUNCTION pg_temp.payee_assert(ok boolean,label text) RETURNS void
 LANGUAGE plpgsql SECURITY INVOKER AS $$BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'payee privacy assertion failed: %',label; END IF;
 RAISE NOTICE 'payee privacy assertion passed: %',label;
END$$;
DO $temporary_access$ DECLARE temporary_schema name; BEGIN
 SELECT nspname INTO STRICT temporary_schema FROM pg_namespace WHERE oid=pg_my_temp_schema();
 EXECUTE format('GRANT USAGE ON SCHEMA %I TO anon,authenticated,service_role',temporary_schema);
END $temporary_access$;
GRANT EXECUTE ON FUNCTION pg_temp.payee_assert(boolean,text) TO anon,authenticated,service_role;
SET LOCAL row_security=on;

-- ---- the club admin ------------------------------------------------------
SET LOCAL request.jwt.claim.role='authenticated';
SET LOCAL request.jwt.claim.sub='9d1e0000-0000-4000-8000-000000000001';
SET LOCAL request.jwt.claims='{"role":"authenticated","sub":"9d1e0000-0000-4000-8000-000000000001"}';
SET LOCAL ROLE authenticated;
SELECT pg_temp.payee_assert(public.fn_is_club_admin_uid('9d1e1000-0000-4000-8000-000000000002') AND NOT public.fn_is_platform_admin() AND NOT public.fn_caller_is_engine(),'club admin still an administrator of his own club');
SELECT pg_temp.payee_assert(NOT EXISTS(SELECT 1 FROM public.settlement_invoices WHERE id='9d1e4000-0000-4000-8000-000000000001'),'D1 after: club admin cannot read the payee prize receipt');
SELECT pg_temp.payee_assert(NOT public.fn_messenger_invoice_visible_to('9d1e4000-0000-4000-8000-000000000001',auth.uid()),'D1 after: the gate itself refuses the club admin');
SELECT pg_temp.payee_assert(EXISTS(SELECT 1 FROM public.settlement_invoices WHERE id='9d1e4000-0000-4000-8000-000000000002' AND net_amount=6.34),'D1 after: the club keeps its one weekly aggregate');
SELECT pg_temp.payee_assert(NOT EXISTS(SELECT 1 FROM public.rakeback_distributions),'D2 after: club admin reads no rakeback distribution row');
SELECT pg_temp.payee_assert((SELECT count(*)=1 FROM public.fn_accounting_party_users('club','9d1e1000-0000-4000-8000-000000000002')),'D3 after: a club party still reads its own roster');
RESET ROLE;

-- ---- the payee -----------------------------------------------------------
SET LOCAL request.jwt.claim.sub='9d1e0000-0000-4000-8000-000000000002';
SET LOCAL request.jwt.claims='{"role":"authenticated","sub":"9d1e0000-0000-4000-8000-000000000002"}';
SET LOCAL ROLE authenticated;
SELECT pg_temp.payee_assert(EXISTS(SELECT 1 FROM public.settlement_invoices WHERE id='9d1e4000-0000-4000-8000-000000000001' AND net_amount=6.34),'the payee keeps their own prize receipt, exactly');
SELECT pg_temp.payee_assert((SELECT rakeback_amount=144.46 AND player_rake_contributed=412.75 FROM public.rakeback_distributions WHERE id='9d1e8000-0000-4000-8000-000000000001'),'the payee keeps their own rakeback distribution row');
RESET ROLE;

-- ---- an ordinary co-member ----------------------------------------------
SET LOCAL request.jwt.claim.sub='9d1e0000-0000-4000-8000-000000000003';
SET LOCAL request.jwt.claims='{"role":"authenticated","sub":"9d1e0000-0000-4000-8000-000000000003"}';
SET LOCAL ROLE authenticated;
SELECT pg_temp.payee_assert(EXISTS(SELECT 1 FROM public.club_members WHERE club_id='9d1e1000-0000-4000-8000-000000000002' AND user_id=auth.uid()),'the co-member is still a member of the club');
SELECT pg_temp.payee_assert(NOT EXISTS(SELECT 1 FROM public.rakeback_distributions),'D2 after: membership alone reads no rakeback distribution');
SELECT pg_temp.payee_assert(NOT EXISTS(SELECT 1 FROM public.settlement_invoices WHERE id='9d1e4000-0000-4000-8000-000000000001'),'D1 after: a co-member cannot read another payee document');
RESET ROLE;

-- ---- the union overseer, who IS a declared recipient ---------------------
SET LOCAL request.jwt.claim.sub='9d1e0000-0000-4000-8000-000000000004';
SET LOCAL request.jwt.claims='{"role":"authenticated","sub":"9d1e0000-0000-4000-8000-000000000004"}';
SET LOCAL ROLE authenticated;
SELECT pg_temp.payee_assert(public.fn_is_any_union_overseer(auth.uid()) AND public.fn_union_oversees_club('9d1e1000-0000-4000-8000-000000000002',auth.uid()),'the overseer still recognises itself through both predicates');
SELECT pg_temp.payee_assert(EXISTS(SELECT 1 FROM public.settlement_invoices WHERE id='9d1e4000-0000-4000-8000-000000000001' AND net_amount=6.34),'the declared immediate recipient keeps the document it was sent');
SELECT pg_temp.payee_assert(EXISTS(SELECT 1 FROM public.settlement_invoices WHERE id='9d1e4000-0000-4000-8000-000000000002'),'the overseer keeps the club aggregate');
SELECT pg_temp.payee_assert((SELECT rakeback_amount=144.46 FROM public.rakeback_distributions WHERE id='9d1e8000-0000-4000-8000-000000000001'),'the paying agent keeps its own distribution row');
SELECT pg_temp.payee_assert((SELECT count(*)=1 FROM public.fn_accounting_party_users('union','9d1e1000-0000-4000-8000-000000000001')),'D3 after: a union party still reads its own roster');
RESET ROLE;

-- ---- the outsider --------------------------------------------------------
SET LOCAL request.jwt.claim.sub='9d1e0000-0000-4000-8000-000000000005';
SET LOCAL request.jwt.claims='{"role":"authenticated","sub":"9d1e0000-0000-4000-8000-000000000005"}';
SET LOCAL ROLE authenticated;
SELECT pg_temp.payee_assert((SELECT count(*)=0 FROM public.fn_accounting_party_users('club','9d1e1000-0000-4000-8000-000000000002')),'D3 after: the club roster is no longer enumerable');
SELECT pg_temp.payee_assert((SELECT count(*)=0 FROM public.fn_accounting_party_users('union','9d1e1000-0000-4000-8000-000000000001')),'D3 after: the union roster is no longer enumerable');
SELECT pg_temp.payee_assert(NOT public.fn_is_any_union_overseer('9d1e0000-0000-4000-8000-000000000004'),'D3 after: another user overseer status is not answerable');
SELECT pg_temp.payee_assert(NOT public.fn_is_union_overseer('9d1e1000-0000-4000-8000-000000000001','9d1e0000-0000-4000-8000-000000000004'),'D3 after: another user union overseer status is not answerable');
SELECT pg_temp.payee_assert(NOT public.fn_union_oversees_club('9d1e1000-0000-4000-8000-000000000002','9d1e0000-0000-4000-8000-000000000004'),'D3 after: another user club oversight is not answerable');
SELECT pg_temp.payee_assert(NOT EXISTS(SELECT 1 FROM public.settlement_invoices),'the outsider reads no document at all');
SELECT pg_temp.payee_assert(NOT EXISTS(SELECT 1 FROM public.rakeback_distributions),'the outsider reads no rakeback distribution');
SELECT pg_temp.payee_assert(NOT has_function_privilege(current_user,'public.fn_union_overseer_of_record(uuid,uuid)','EXECUTE'),'the unbound predicate is unreachable from an authenticated session');
RESET ROLE;

-- ---- anonymous -----------------------------------------------------------
SET LOCAL request.jwt.claim.role='anon';
SET LOCAL request.jwt.claim.sub='9d1e0000-0000-4000-8000-000000000002';
SET LOCAL request.jwt.claims='{"role":"anon","sub":"9d1e0000-0000-4000-8000-000000000002"}';
SET LOCAL ROLE anon;
SELECT pg_temp.payee_assert(NOT EXISTS(SELECT 1 FROM public.settlement_invoices),'an anonymous subject-shaped claim reads no document');
SELECT pg_temp.payee_assert(NOT EXISTS(SELECT 1 FROM public.rakeback_distributions),'an anonymous subject-shaped claim reads no rakeback distribution');
SELECT pg_temp.payee_assert(NOT has_function_privilege(current_user,'public.fn_accounting_party_users(text,uuid)','EXECUTE'),'anonymous roster enumeration is unavailable');
RESET ROLE;

-- ---- the engine keeps the whole roster and the unbound answer ------------
SET LOCAL request.jwt.claim.role='service_role';
SET LOCAL request.jwt.claim.sub='';
SET LOCAL request.jwt.claims='{"role":"service_role"}';
SET LOCAL ROLE service_role;
SELECT pg_temp.payee_assert(public.fn_caller_is_engine() AND auth.uid() IS NULL,'the engine arm is the service-role session');
SELECT pg_temp.payee_assert((SELECT count(*)=1 FROM public.fn_accounting_party_users('club','9d1e1000-0000-4000-8000-000000000002')),'the engine still reads the whole club roster with no actor');
SELECT pg_temp.payee_assert(public.fn_is_union_overseer('9d1e1000-0000-4000-8000-000000000001','9d1e0000-0000-4000-8000-000000000004'),'the engine still evaluates a third party overseer');
SELECT pg_temp.payee_assert(public.fn_messenger_invoice_visible_to('9d1e4000-0000-4000-8000-000000000001','9d1e0000-0000-4000-8000-000000000002'),'the engine still resolves the payee document for its payee');
SELECT pg_temp.payee_assert(NOT public.fn_messenger_invoice_visible_to('9d1e4000-0000-4000-8000-000000000001','9d1e0000-0000-4000-8000-000000000001'),'the engine arm does not resolve it for a non-recipient');
RESET ROLE;
RESET request.jwt.claim.sub;
RESET request.jwt.claim.role;
RESET request.jwt.claims;
ROLLBACK;
