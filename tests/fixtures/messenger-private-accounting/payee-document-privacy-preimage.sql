\set ON_ERROR_STOP on
-- The three privacy defects, reproduced on the isolated captured catalog
-- BEFORE 20260921052548 is applied. Nothing here is a payment, a delivery or a
-- live proof: these are synthetic records whose only purpose is to make the
-- installed RLS answer a question, as the browser roles, out loud.
--
-- This file COMMITS, because the migration and the after-regression run in the
-- same psql session immediately afterwards and need this state. The fixture
-- cluster is disposable and is destroyed with the temporary data directory.
BEGIN;
SET LOCAL statement_timeout='30s';
SET LOCAL lock_timeout='3s';
DO $prerequisite$ BEGIN
 IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL
  OR to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('auth.role()') IS NULL
  OR to_regprocedure('public.fn_messenger_invoice_visible_to(uuid,uuid)') IS NULL
  OR to_regprocedure('public.fn_accounting_party_users(text,uuid)') IS NULL
  OR to_regprocedure('public.fn_is_any_union_overseer(uuid)') IS NULL
  OR to_regprocedure('public.fn_union_oversees_club(uuid,uuid)') IS NULL
  OR to_regprocedure('public.fn_is_union_overseer(uuid,uuid)') IS NULL
  OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('anon','authenticated') AND
   (rolsuper OR rolbypassrls OR pg_has_role(rolname,'service_role','USAGE')))
 THEN RAISE EXCEPTION 'payee document privacy fixture requires the real isolated catalog and non-bypass API roles'; END IF;
 IF to_regclass('public.rakeback_distributions') IS NOT NULL
 THEN RAISE EXCEPTION 'rakeback_distributions unexpectedly present; do not shadow a captured relation'; END IF;
END $prerequisite$;

CREATE FUNCTION pg_temp.payee_assert(ok boolean,label text) RETURNS void
 LANGUAGE plpgsql SECURITY INVOKER AS $$BEGIN
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'payee privacy assertion failed: %',label; END IF;
 RAISE NOTICE 'payee privacy assertion passed: %',label;
END$$;
DO $temporary_access$ DECLARE temporary_schema name; BEGIN
 SELECT nspname INTO STRICT temporary_schema FROM pg_namespace WHERE oid=pg_my_temp_schema();
 EXECUTE format('GRANT USAGE ON SCHEMA %I TO anon,authenticated,service_role',temporary_schema);
END $temporary_access$;
GRANT EXECUTE ON FUNCTION pg_temp.payee_assert(boolean,text) TO anon,authenticated,service_role;

-- The exact installed predecessor of the relation this fixture's catalog
-- capture (2026-09-14, union accounting only) does not carry. Columns, grants
-- and the single membership policy are reproduced as production holds them, so
-- the migration replaces a real predecessor and not a convenient stub.
CREATE TABLE public.rakeback_distributions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL,
  period_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  agent_user_id uuid NOT NULL,
  player_user_id uuid NOT NULL,
  player_rake_contributed numeric(14,2) NOT NULL,
  rakeback_percentage numeric(5,4) NOT NULL,
  rakeback_amount numeric(14,2) NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  transferred_at timestamptz,
  chip_transfer_id uuid,
  error_message text,
  invoice_id uuid,
  created_at timestamptz DEFAULT now());
ALTER TABLE public.rakeback_distributions ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.rakeback_distributions TO anon,authenticated;
GRANT INSERT,SELECT,UPDATE,DELETE ON public.rakeback_distributions TO service_role;
-- The 2026-09-14 catalog capture is union-accounting only and does not carry
-- the membership helper this predecessor policy names. Reconstruct it exactly
-- as production holds it, and only when it is genuinely absent, so a captured
-- definition is never overwritten.
DO $membership_helper$ BEGIN
 IF to_regprocedure('public.fn_my_club_ids()') IS NULL THEN
  EXECUTE $ddl$CREATE FUNCTION public.fn_my_club_ids() RETURNS SETOF uuid
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $body$
  SELECT club_id FROM public.club_members
  WHERE user_id = auth.uid()
    AND COALESCE(status, 'active') = 'active';
$body$$ddl$;
  EXECUTE 'REVOKE ALL ON FUNCTION public.fn_my_club_ids() FROM PUBLIC, anon';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.fn_my_club_ids() TO authenticated, service_role';
 END IF;
END $membership_helper$;
-- Production grants EXECUTE on all four roster/overseer predicates to
-- `authenticated`; the union-only catalog capture carries only some of them.
-- Restore the installed ACL, so the oracle below is the real one and the
-- refusal after the candidate is a real refusal.
DO $installed_acl$ DECLARE s text; BEGIN
 FOREACH s IN ARRAY ARRAY['public.fn_accounting_party_users(text,uuid)',
                          'public.fn_is_any_union_overseer(uuid)',
                          'public.fn_union_oversees_club(uuid,uuid)',
                          'public.fn_is_union_overseer(uuid,uuid)'] LOOP
  IF to_regprocedure(s) IS NULL THEN RAISE EXCEPTION 'captured catalog is missing %',s; END IF;
  EXECUTE 'GRANT EXECUTE ON FUNCTION '||s||' TO authenticated, service_role';
  EXECUTE 'REVOKE ALL ON FUNCTION '||s||' FROM PUBLIC, anon';
 END LOOP;
END $installed_acl$;
CREATE POLICY rakeback_distributions_club_member_select ON public.rakeback_distributions
  FOR SELECT TO authenticated
  USING ((SELECT public.fn_is_platform_admin()) OR (club_id IN (SELECT public.fn_my_club_ids())));

SET LOCAL session_replication_role=replica;
INSERT INTO auth.users(id) SELECT ('9d1e0000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid FROM generate_series(1,5)n;
INSERT INTO public.users(id,username) SELECT ('9d1e0000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'payee_privacy_'||n FROM generate_series(1,5)n;
INSERT INTO public.profiles(id,username,display_name,role,is_admin)
 SELECT ('9d1e0000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'payee_privacy_'||n,'Payee Privacy '||n,'user',false FROM generate_series(1,5)n;

-- 0001 club owner/admin  0002 payee player  0003 ordinary co-member
-- 0004 union owner (overseer)  0005 outsider with no membership anywhere
INSERT INTO public.clubs(id,club_id,name,owner_id,chip_treasury,is_union)
 VALUES('9d1e1000-0000-4000-8000-000000000001',991701,'Payee Privacy Union','9d1e0000-0000-4000-8000-000000000004',0,true),
       ('9d1e1000-0000-4000-8000-000000000002',991702,'Payee Privacy Club','9d1e0000-0000-4000-8000-000000000001',0,false);
INSERT INTO public.unions(id,name,owner_id,slug)
 VALUES('9d1e1000-0000-4000-8000-000000000001','Payee Privacy Union','9d1e0000-0000-4000-8000-000000000004','payee-privacy-union');
INSERT INTO public.union_clubs(union_id,club_id)
 VALUES('9d1e1000-0000-4000-8000-000000000001','9d1e1000-0000-4000-8000-000000000002');
INSERT INTO public.club_members(club_id,user_id,role,status,is_active,membership_lifecycle_status,chip_balance)
 VALUES('9d1e1000-0000-4000-8000-000000000002','9d1e0000-0000-4000-8000-000000000001','owner','active',true,'active',0),
       ('9d1e1000-0000-4000-8000-000000000002','9d1e0000-0000-4000-8000-000000000002','player','active',true,'active',0),
       ('9d1e1000-0000-4000-8000-000000000002','9d1e0000-0000-4000-8000-000000000003','player','active',true,'active',0),
       ('9d1e1000-0000-4000-8000-000000000001','9d1e0000-0000-4000-8000-000000000004','owner','active',true,'active',0);
INSERT INTO public.settlement_periods(id,club_id,period_number,year,start_at,end_at,status)
 VALUES('9d1e2000-0000-4000-8000-000000000001','9d1e1000-0000-4000-8000-000000000002',38,2026,'2026-09-14 07:00Z','2026-09-21 07:00Z','open');
INSERT INTO public.chip_ledger(id,performed_by,from_type,from_entity_id,to_type,to_entity_id,amount,category,club_id)
 VALUES('9d1e3000-0000-4000-8000-000000000001','9d1e0000-0000-4000-8000-000000000004','union_wallet',
 '9d1e1000-0000-4000-8000-000000000001','player_wallet','9d1e0000-0000-4000-8000-000000000002',6.34,'wheel_prize','9d1e1000-0000-4000-8000-000000000002');

-- The exact shape that fell outside the old gate: a UNION sender, a prize
-- category, addressed to one identified player, carrying an amount.
INSERT INTO public.settlement_invoices(id,club_id,source_ledger_id,invoice_type,invoice_number,from_entity_type,from_entity_id,to_entity_type,to_entity_id,gross_amount,net_amount,deductions,status,breakdown)
 VALUES('9d1e4000-0000-4000-8000-000000000001','9d1e1000-0000-4000-8000-000000000002','9d1e3000-0000-4000-8000-000000000001',
 'transaction_receipt','PRIVATE-PRIZE-TOKEN','union','9d1e1000-0000-4000-8000-000000000001','player','9d1e0000-0000-4000-8000-000000000002',6.34,6.34,0,'paid','{"category":"wheel_prize"}');
-- The club's one weekly aggregate. It is addressed to the club, so the widened
-- arm must never touch it.
INSERT INTO public.settlement_invoices(id,club_id,period_id,invoice_type,invoice_number,from_entity_type,from_entity_id,to_entity_type,to_entity_id,gross_amount,net_amount,deductions,status,breakdown)
 VALUES('9d1e4000-0000-4000-8000-000000000002','9d1e1000-0000-4000-8000-000000000002','9d1e2000-0000-4000-8000-000000000001',
 'club_weekly_accounting','WEEKLY-AGGREGATE-TOKEN','club','9d1e1000-0000-4000-8000-000000000002','club','9d1e1000-0000-4000-8000-000000000002',6.34,6.34,0,'paid','{"paid_players":6.34}');

INSERT INTO public.social_conversations(id,is_group,group_name,last_message_preview)
 SELECT ('9d1e5000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,true,'Payee Privacy','Accounting Conversation' FROM generate_series(1,2)n;
INSERT INTO public.social_messages(id,conversation_id,sender_id,content,message_type,media_metadata,created_at)
 VALUES('9d1e6000-0000-4000-8000-000000000001','9d1e5000-0000-4000-8000-000000000001','9d1e0000-0000-4000-8000-000000000004','PRIVATE-PRIZE-TOKEN 6.34 Chips','invoice','{"invoice_id":"9d1e4000-0000-4000-8000-000000000001","status":"paid"}','2026-09-20 10:00Z'),
       ('9d1e6000-0000-4000-8000-000000000002','9d1e5000-0000-4000-8000-000000000001','9d1e0000-0000-4000-8000-000000000004','PRIVATE-PRIZE-TOKEN union copy','invoice','{}','2026-09-20 10:00Z'),
       ('9d1e6000-0000-4000-8000-000000000003','9d1e5000-0000-4000-8000-000000000002','9d1e0000-0000-4000-8000-000000000004','WEEKLY-AGGREGATE-TOKEN 6.34 Chips','invoice','{}','2026-09-20 10:00Z');
INSERT INTO public.notifications(id,user_id,type,title,message)
 VALUES('9d1e7000-0000-4000-8000-000000000001','9d1e0000-0000-4000-8000-000000000002','accounting_invoice','PRIVATE-PRIZE-TOKEN','6.34 Chips'),
       ('9d1e7000-0000-4000-8000-000000000002','9d1e0000-0000-4000-8000-000000000004','accounting_invoice','PRIVATE-PRIZE-TOKEN','6.34 Chips'),
       ('9d1e7000-0000-4000-8000-000000000003','9d1e0000-0000-4000-8000-000000000001','accounting_invoice','WEEKLY-AGGREGATE-TOKEN','weekly aggregate');
-- The payee and the paying union are the declared immediate recipients. The
-- club admin is not a recipient of this document at all.
INSERT INTO public.accounting_invoice_deliveries(invoice_id,recipient_id,message_id,notification_id,delivery_mode)
 VALUES('9d1e4000-0000-4000-8000-000000000001','9d1e0000-0000-4000-8000-000000000002','9d1e6000-0000-4000-8000-000000000001','9d1e7000-0000-4000-8000-000000000001','immediate'),
       ('9d1e4000-0000-4000-8000-000000000001','9d1e0000-0000-4000-8000-000000000004','9d1e6000-0000-4000-8000-000000000002','9d1e7000-0000-4000-8000-000000000002','immediate'),
       ('9d1e4000-0000-4000-8000-000000000002','9d1e0000-0000-4000-8000-000000000001','9d1e6000-0000-4000-8000-000000000003','9d1e7000-0000-4000-8000-000000000003','immediate');

INSERT INTO public.rakeback_distributions(id,club_id,period_id,agent_id,agent_user_id,player_user_id,player_rake_contributed,rakeback_percentage,rakeback_amount,status)
 VALUES('9d1e8000-0000-4000-8000-000000000001','9d1e1000-0000-4000-8000-000000000002','9d1e2000-0000-4000-8000-000000000001',
 '9d1e9000-0000-4000-8000-000000000001','9d1e0000-0000-4000-8000-000000000004','9d1e0000-0000-4000-8000-000000000002',412.75,0.3500,144.46,'transferred');
SET LOCAL session_replication_role=origin;
SET LOCAL row_security=on;

-- D1 BEFORE: the club admin reads a document addressed to one of his players.
SET LOCAL request.jwt.claim.role='authenticated';
SET LOCAL request.jwt.claim.sub='9d1e0000-0000-4000-8000-000000000001';
SET LOCAL request.jwt.claims='{"role":"authenticated","sub":"9d1e0000-0000-4000-8000-000000000001"}';
SET LOCAL ROLE authenticated;
SELECT pg_temp.payee_assert(auth.uid()='9d1e0000-0000-4000-8000-000000000001' AND NOT public.fn_caller_is_engine(),'D1 before: real club-admin browser JWT, no engine authority');
SELECT pg_temp.payee_assert(public.fn_is_club_admin_uid('9d1e1000-0000-4000-8000-000000000002') AND NOT public.fn_is_platform_admin(),'D1 before: club admin, not a platform admin');
SELECT pg_temp.payee_assert(EXISTS(SELECT 1 FROM public.settlement_invoices WHERE id='9d1e4000-0000-4000-8000-000000000001' AND net_amount=6.34),'D1 before: DEFECT - club admin reads the payee prize receipt and its amount');
SELECT pg_temp.payee_assert(NOT EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries WHERE invoice_id='9d1e4000-0000-4000-8000-000000000001' AND recipient_id=auth.uid()),'D1 before: club admin holds no delivery row for that document');
-- D2 BEFORE: plain membership reads another member's rakeback summary.
SELECT pg_temp.payee_assert((SELECT rakeback_amount=144.46 FROM public.rakeback_distributions WHERE id='9d1e8000-0000-4000-8000-000000000001'),'D2 before: DEFECT - a co-member reads another member rakeback summary');
RESET ROLE;
SET LOCAL request.jwt.claim.sub='9d1e0000-0000-4000-8000-000000000003';
SET LOCAL request.jwt.claims='{"role":"authenticated","sub":"9d1e0000-0000-4000-8000-000000000003"}';
SET LOCAL ROLE authenticated;
SELECT pg_temp.payee_assert((SELECT player_rake_contributed=412.75 FROM public.rakeback_distributions WHERE id='9d1e8000-0000-4000-8000-000000000001'),'D2 before: DEFECT - an ordinary player co-member reads it too');
RESET ROLE;
-- D3 BEFORE: an outsider enumerates rosters and probes another user's status.
SET LOCAL request.jwt.claim.sub='9d1e0000-0000-4000-8000-000000000005';
SET LOCAL request.jwt.claims='{"role":"authenticated","sub":"9d1e0000-0000-4000-8000-000000000005"}';
SET LOCAL ROLE authenticated;
SELECT pg_temp.payee_assert(NOT EXISTS(SELECT 1 FROM public.club_members WHERE user_id=auth.uid()),'D3 before: the prober holds no membership anywhere');
SELECT pg_temp.payee_assert((SELECT count(*)>0 FROM public.fn_accounting_party_users('club','9d1e1000-0000-4000-8000-000000000002')),'D3 before: DEFECT - outsider enumerates the club roster');
SELECT pg_temp.payee_assert((SELECT count(*)>0 FROM public.fn_accounting_party_users('union','9d1e1000-0000-4000-8000-000000000001')),'D3 before: DEFECT - outsider enumerates the union roster');
SELECT pg_temp.payee_assert(public.fn_is_any_union_overseer('9d1e0000-0000-4000-8000-000000000004'),'D3 before: DEFECT - outsider probes another user overseer status');
SELECT pg_temp.payee_assert(public.fn_is_union_overseer('9d1e1000-0000-4000-8000-000000000001','9d1e0000-0000-4000-8000-000000000004'),'D3 before: DEFECT - outsider probes another user union overseer status');
SELECT pg_temp.payee_assert(public.fn_union_oversees_club('9d1e1000-0000-4000-8000-000000000002','9d1e0000-0000-4000-8000-000000000004'),'D3 before: DEFECT - outsider probes another user club oversight');
RESET ROLE;
RESET request.jwt.claim.sub;
RESET request.jwt.claim.role;
RESET request.jwt.claims;
COMMIT;
