\set ON_ERROR_STOP on
-- SOURCE ONLY / UNRUN. Actual application roles and private-reader entrypoints.
RESET ROLE;
DO $managers$ DECLARE who integer;target integer;s jsonb;q jsonb;e jsonb;BEGIN
 FOREACH who IN ARRAY ARRAY[3,4] LOOP
  target:=who+18;PERFORM pg_temp.cr_actor(pg_temp.cr_id(who));EXECUTE 'SET LOCAL ROLE authenticated';
  s:=public.fn_agent_credit_reduction_snapshot_v1(pg_temp.cr_id(who),pg_temp.cr_id(101),pg_temp.cr_id(target));
  q:=pg_temp.cr_intent(s,pg_temp.cr_id(1400+who),9,'Private original manager intent');e:=pg_temp.cr_apply(q);
  PERFORM pg_temp.cr_recorded(e,q,9,91,false);
  INSERT INTO cr_saved VALUES('manager_'||who,q,e,NULL);EXECUTE 'RESET ROLE';
 END LOOP;
END$managers$;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
CREATE TEMP TABLE cr_public_delivery AS
 SELECT s.label,o.actor_user_id,o.target_user_id,o.id AS receipt_id,o.invoice_id,o.agent_id,o.assignment_id,
  d.recipient_id,d.message_id,d.notification_id,m.conversation_id,
  public.fn_accounting_credit_change_contract_v1(o.invoice_id) AS payload
 FROM cr_saved s JOIN public.accounting_credit_reduction_operations_v1 o ON o.id=(s.response->'receipt'->>'receipt_id')::uuid
 JOIN public.accounting_invoice_deliveries d ON d.invoice_id=o.invoice_id
 JOIN public.social_messages m ON m.id=d.message_id WHERE s.label IN('manager_3','manager_4');
GRANT SELECT ON cr_public_delivery TO authenticated;
DO $private_audience$ DECLARE who integer;d record;p record;before_book jsonb;BEGIN
 before_book:=pg_temp.cr_book();
 FOREACH who IN ARRAY ARRAY[3,21] LOOP
  SELECT * INTO STRICT d FROM cr_public_delivery WHERE label='manager_3' AND recipient_id=pg_temp.cr_id(who);
  PERFORM pg_temp.cr_actor(pg_temp.cr_id(who));EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM pg_temp.cr_check((SELECT count(*)=1 FROM public.settlement_invoices WHERE id=d.invoice_id),
   'frozen actor/target can read exact nonpayable invoice '||who);
  PERFORM pg_temp.cr_check((SELECT count(*)=1 FROM public.social_messages WHERE id=d.message_id)
   AND (SELECT count(*)=1 FROM public.notifications WHERE id=d.notification_id),'own immediate message and notice are readable '||who);
  SELECT * INTO STRICT p FROM public.fn_messenger_message_page(auth.uid(),d.conversation_id) WHERE id=d.message_id;
  PERFORM pg_temp.cr_check(p.media_metadata=jsonb_build_object('kind','accounting_invoice','accounting_verified',true,
   'invoice_id',d.invoice_id,'invoice_type','credit_limit_change','club_id',pg_temp.cr_id(101),'source_ledger_id',NULL,
   'amount','9.00','status','generated','chips_transferred',false,'due_at',NULL,'transferred_at',NULL,
   'cashier_verified',false,'correction_verified',false,'credit_change_verified',true,'credit_change',d.payload)
   AND p.content='This records a credit-capacity change. No chips were transferred and no payment is due.',
   'page reconstructs only canonical public credit fields '||who);
  PERFORM pg_temp.cr_check(NOT(p.media_metadata->'credit_change' ?| ARRAY['reason','assignment_reason','credit_used','wallet_balance'])
   AND NOT EXISTS(SELECT 1 FROM public.fn_messenger_search_messages(auth.uid(),ARRAY[d.conversation_id],'Private original manager intent')),
   'private reason/debt cannot leak through page or search matching '||who);
  SELECT * INTO STRICT p FROM public.fn_messenger_private_message_page(auth.uid(),d.conversation_id) WHERE id=d.message_id;
  PERFORM pg_temp.cr_check(p.media_metadata->'credit_change'=d.payload,'private wrapper keeps the canonical credit contract '||who);
  SELECT * INTO STRICT p FROM public.fn_messenger_private_search_messages(auth.uid(),ARRAY[d.conversation_id],'credit-capacity') WHERE id=d.message_id;
  PERFORM pg_temp.cr_check(p.media_metadata->'credit_change'=d.payload,'private search uses sanitized content and exact contract '||who);
  SELECT * INTO STRICT p FROM public.fn_messenger_private_accounting_threads(auth.uid(),ARRAY[d.conversation_id]);
  PERFORM pg_temp.cr_check(p.recipient_visible AND p.last_message_preview IS NOT NULL,'own private thread remains available '||who);
  EXECUTE 'RESET ROLE';
 END LOOP;
 -- A different current owner/admin/member is not an audience substitute.
 FOREACH who IN ARRAY ARRAY[1,4,6,7] LOOP
  SELECT * INTO STRICT d FROM cr_public_delivery WHERE label='manager_3' AND recipient_id=pg_temp.cr_id(21);
  PERFORM pg_temp.cr_actor(pg_temp.cr_id(who));EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM pg_temp.cr_check(NOT public.fn_messenger_invoice_visible_to(d.invoice_id,auth.uid())
   AND NOT EXISTS(SELECT 1 FROM public.settlement_invoices WHERE id=d.invoice_id)
   AND NOT EXISTS(SELECT 1 FROM public.social_messages WHERE id=d.message_id)
   AND NOT EXISTS(SELECT 1 FROM public.notifications WHERE id=d.notification_id)
   AND NOT EXISTS(SELECT 1 FROM public.accounting_invoice_deliveries WHERE invoice_id=d.invoice_id),
   'current unrelated role cannot read another actor/target credit detail '||who);
  BEGIN PERFORM public.fn_messenger_private_message_page(auth.uid(),d.conversation_id);RAISE EXCEPTION 'nonparticipant page accepted';
  EXCEPTION WHEN insufficient_privilege THEN IF SQLERRM<>'message_page_not_authorised' THEN RAISE;END IF;END;
  EXECUTE 'RESET ROLE';
 END LOOP;
 PERFORM pg_temp.cr_check(pg_temp.cr_book()=before_book,'all actor/target/manager reader probes preserve every row');
END$private_audience$;
DO $unapproved$ DECLARE who integer;q jsonb;s jsonb;before_book jsonb;state text;message text;BEGIN
 SELECT q0.q INTO STRICT q FROM cr_failure_intent q0;
 FOREACH who IN ARRAY ARRAY[5,6,7] LOOP
  PERFORM pg_temp.cr_actor(pg_temp.cr_id(who));EXECUTE 'SET LOCAL ROLE authenticated';before_book:=pg_temp.cr_book();
  BEGIN PERFORM public.fn_agent_credit_reduction_snapshot_v1(pg_temp.cr_id(who),pg_temp.cr_id(101),pg_temp.cr_id(20));
   RAISE EXCEPTION 'unauthorized snapshot accepted';
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS state=RETURNED_SQLSTATE,message=MESSAGE_TEXT;
   IF state IS DISTINCT FROM '42501' OR message IS DISTINCT FROM 'credit_reduction_not_authorized' THEN RAISE;END IF;END;
  PERFORM pg_temp.cr_check(pg_temp.cr_book()=before_book,'suspended/member/other-club owner snapshot refused '||who);
  PERFORM pg_temp.cr_expect_atomic_failure(q||jsonb_build_object('actor_user_id',pg_temp.cr_id(who),'operation_id',pg_temp.cr_id(1450+who)),
   '42501','credit_reduction_not_authorized');
  s:=public.fn_agent_credit_reduction_receipt_v1(pg_temp.cr_id(who),pg_temp.cr_id(1001),pg_temp.cr_id(101));
  PERFORM pg_temp.cr_check(s->>'state'='absent' AND s->'receipt'='null'::jsonb AND s->'retirement'='null'::jsonb,
   'same operation UUID under another actor cannot expose original receipt '||who);
  EXECUTE 'RESET ROLE';
 END LOOP;
END$unapproved$;
-- Remove current authorization and current agent/audit rows only after the
-- original complete document is recorded. These are explicit owner fixture
-- mutations under origin, not replacement financial RPCs or production repair.
SELECT pg_temp.cr_actor(pg_temp.cr_id(1));
UPDATE public.club_members SET status='suspended',is_active=false WHERE club_id=pg_temp.cr_id(101) AND user_id=pg_temp.cr_id(4);
DELETE FROM public.agents WHERE id=pg_temp.cr_id(222);
DO $history$ DECLARE q jsonb;original jsonb;e jsonb;before_book jsonb;d record;page record;BEGIN
 SELECT intent,response INTO STRICT q,original FROM cr_saved WHERE label='manager_4';
 SELECT * INTO STRICT d FROM cr_public_delivery WHERE label='manager_4' AND recipient_id=pg_temp.cr_id(4);
 PERFORM pg_temp.cr_check(NOT EXISTS(SELECT 1 FROM public.agents WHERE id=d.agent_id)
  AND NOT EXISTS(SELECT 1 FROM public.credit_assignments WHERE id=d.assignment_id),
  'actual agent removal cascaded original assignment while immutable receipt remains');
 before_book:=pg_temp.cr_book();PERFORM pg_temp.cr_actor(pg_temp.cr_id(4));EXECUTE 'SET LOCAL ROLE authenticated';
 e:=public.fn_agent_credit_reduction_receipt_v1(pg_temp.cr_id(4),pg_temp.cr_id(1404),pg_temp.cr_id(101));
 PERFORM pg_temp.cr_check(e=jsonb_set(original,'{replayed}','true'::jsonb),'demoted original actor retrieves recorded receipt after agent/audit removal');
 e:=pg_temp.cr_apply(q);
 PERFORM pg_temp.cr_check(e=jsonb_set(original,'{replayed}','true'::jsonb),'exact apply replay preserves original authority without recreating deleted agent/audit');
 e:=public.fn_retire_agent_credit_reduction_v1(pg_temp.cr_id(4),pg_temp.cr_id(1404),pg_temp.cr_id(101));
 PERFORM pg_temp.cr_check(e=jsonb_set(original,'{replayed}','true'::jsonb),'retire cannot rewrite a completed historical operation');
 SELECT * INTO STRICT page FROM public.fn_messenger_private_message_page(auth.uid(),d.conversation_id) WHERE id=d.message_id;
 PERFORM pg_temp.cr_check(page.media_metadata->'credit_change'=d.payload,'historical public document survives current agent/audit removal');
 EXECUTE 'RESET ROLE';
 PERFORM pg_temp.cr_check(pg_temp.cr_book()=before_book,'all historical replay paths leave every current and historical row unchanged');
END$history$;
SELECT pg_temp.cr_actor(pg_temp.cr_id(1));
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
