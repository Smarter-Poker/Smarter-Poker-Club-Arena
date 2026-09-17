\set ON_ERROR_STOP on
-- SOURCE ONLY / UNRUN. Real full36 + credit successor and nested delivery.
BEGIN;
SET LOCAL statement_timeout='60s';SET LOCAL lock_timeout='3s';
SET LOCAL TimeZone='UTC';SET LOCAL DateStyle='ISO,YMD';
\ir helpers.sql
\ir seed.sql
CREATE TEMP TABLE cr_saved(label text PRIMARY KEY,intent jsonb NOT NULL,response jsonb NOT NULL,before_state jsonb);
GRANT SELECT,INSERT,UPDATE ON cr_saved TO authenticated;
SELECT pg_temp.cr_actor(pg_temp.cr_id(1));
SET LOCAL ROLE authenticated;
DO $applied$ DECLARE s jsonb;q jsonb;e jsonb;BEGIN
 s:=public.fn_agent_credit_reduction_snapshot_v1(pg_temp.cr_id(1),pg_temp.cr_id(101),pg_temp.cr_id(2));
 PERFORM pg_temp.cr_check(s->'contract_version'='1'::jsonb AND s->>'actor_user_id'=pg_temp.cr_id(1)::text
  AND s->>'club_id'=pg_temp.cr_id(101)::text AND s->>'agent_id'=pg_temp.cr_id(201)::text
  AND s->>'target_user_id'=pg_temp.cr_id(2)::text AND s->'credit_limit'='"100.00"'::jsonb
  AND s->'credit_used'='"25.00"'::jsonb AND s->'is_prepaid'='false'::jsonb AND s->'control_revision'='"0"'::jsonb,
  'manager receives exact scoped current snapshot with text cents/revision');
 q:=pg_temp.cr_intent(s,pg_temp.cr_id(1001),20,'Original exact reduction reason');
 e:=pg_temp.cr_apply(q);PERFORM pg_temp.cr_recorded(e,q,20,80,false);
 INSERT INTO cr_saved VALUES('main',q,e,NULL);
END$applied$;
RESET ROLE;
DO $durable$ DECLARE e jsonb;x jsonb;BEGIN
 SELECT response INTO STRICT e FROM cr_saved WHERE label='main';x:=e->'receipt';
 PERFORM pg_temp.cr_check((SELECT count(*)=1 FROM public.accounting_credit_reduction_operations_v1
  WHERE id=(x->>'receipt_id')::uuid),'receipt is a real persisted operation identity');
 PERFORM pg_temp.cr_check((SELECT count(*)=1 FROM public.credit_assignments WHERE id=(x->>'assignment_id')::uuid
  AND agent_id=pg_temp.cr_id(201) AND assigned_by=pg_temp.cr_id(1) AND old_limit=100 AND new_limit=80
  AND reason='Original exact reduction reason'),'assignment is the existing writer actual exact audit row');
 PERFORM pg_temp.cr_check((SELECT credit_limit=80 AND credit_used=25 AND NOT is_prepaid AND credit_control_revision=1
  FROM public.agents WHERE id=pg_temp.cr_id(201)), 'original target moved once to80 with debt unchanged');
 PERFORM pg_temp.cr_check((SELECT credit_limit=500 AND credit_used=0 AND NOT is_prepaid AND credit_control_revision=0
  FROM public.agents WHERE id=pg_temp.cr_id(301)), 'same target user in another club is unchanged');
 PERFORM public.fn_accounting_credit_reduction_assert_document((x->>'receipt_id')::uuid);
 PERFORM pg_temp.cr_check((SELECT count(*)=1 FROM public.settlement_invoices WHERE id=(x->>'invoice_id')::uuid
  AND club_id=pg_temp.cr_id(101) AND invoice_type='credit_limit_change' AND status='generated'
  AND chips_transferred IS FALSE AND transferred_at IS NULL AND due_at IS NULL
  AND source_ledger_id IS NULL AND source_credit_invoice_id IS NULL AND source_credit_payment_id IS NULL
  AND source_credit_reduction_operation_id=(x->>'receipt_id')::uuid
  AND gross_amount=20 AND net_amount=20 AND deductions=0), 'exact20.00 capacity record has one typed operation source and no paid or chip-transfer claim');
 PERFORM pg_temp.cr_check((SELECT array_agg(recipient_id ORDER BY recipient_id)=ARRAY[pg_temp.cr_id(1),pg_temp.cr_id(2)]
  FROM public.accounting_invoice_deliveries WHERE invoice_id=(x->>'invoice_id')::uuid),
  'only original actor and target receive the immediate record');
END$durable$;
DO $immutable_source$ DECLARE before_book jsonb;got_message text;BEGIN
 before_book:=pg_temp.cr_book();
 BEGIN
  UPDATE public.settlement_invoices SET source_credit_reduction_operation_id=pg_temp.cr_id(1999)
   WHERE id=(SELECT (response->'receipt'->>'invoice_id')::uuid FROM cr_saved WHERE label='main');
  RAISE EXCEPTION 'credit invoice source mutation was accepted';
 EXCEPTION WHEN check_violation THEN
  GET STACKED DIAGNOSTICS got_message=MESSAGE_TEXT;
  IF got_message IS DISTINCT FROM 'credit_change_document_is_immutable' THEN RAISE;END IF;
 END;
 PERFORM pg_temp.cr_check(pg_temp.cr_book()=before_book,'issued typed operation source is immutable with complete book unchanged');
END$immutable_source$;
-- Force actual deferred push/document assertions before checking post-commit
-- equivalence. A source acknowledgment alone is insufficient.
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.cr_actor(pg_temp.cr_id(1));SET LOCAL ROLE authenticated;
DO $later_replay$ DECLARE q jsonb;original jsonb;e jsonb;before_book jsonb;updated jsonb;BEGIN
 SELECT intent,response INTO STRICT q,original FROM cr_saved WHERE label='main';
 updated:=public.fn_admin_update_agent(pg_temp.cr_id(201),p_credit_limit=>150,p_credit_reason=>'Later unrelated absolute decision');
 PERFORM pg_temp.cr_check(updated->'success'='true'::jsonb,'existing absolute writer remains callable');
 before_book:=pg_temp.cr_book();e:=pg_temp.cr_apply(q);
 PERFORM pg_temp.cr_recorded(e,q,20,80,false,true);
 PERFORM pg_temp.cr_check(e=jsonb_set(original,'{replayed}','true'::jsonb), 'exact replay returns frozen receipt after later absolute decision');
 PERFORM pg_temp.cr_check(pg_temp.cr_book()=before_book,'replay does not reset later limit, revisions, audit or delivery');
 e:=public.fn_agent_credit_reduction_receipt_v1(pg_temp.cr_id(1),pg_temp.cr_id(1001),pg_temp.cr_id(101));
 PERFORM pg_temp.cr_check(e=jsonb_set(original,'{replayed}','true'::jsonb)
  AND pg_temp.cr_book()=before_book,'own receipt lookup is exact and has no business writes');
END$later_replay$;
DO $clamp$ DECLARE s jsonb;q jsonb;e jsonb;BEGIN
 s:=public.fn_agent_credit_reduction_snapshot_v1(pg_temp.cr_id(1),pg_temp.cr_id(101),pg_temp.cr_id(14));
 q:=pg_temp.cr_intent(s,pg_temp.cr_id(1002),200,NULL);e:=pg_temp.cr_apply(q);
 PERFORM pg_temp.cr_recorded(e,q,100,0,true);
 INSERT INTO cr_saved VALUES('clamped',q,e,NULL);
END$clamp$;
DO $no_change$ DECLARE s jsonb;q jsonb;e jsonb;before_book jsonb;after_book jsonb;BEGIN
 s:=public.fn_agent_credit_reduction_snapshot_v1(pg_temp.cr_id(1),pg_temp.cr_id(101),pg_temp.cr_id(12));
 q:=pg_temp.cr_intent(s,pg_temp.cr_id(1003),200,'');before_book:=pg_temp.cr_book();e:=pg_temp.cr_apply(q);
 PERFORM pg_temp.cr_recorded(e,q,0,0,true);after_book:=pg_temp.cr_book();
 PERFORM pg_temp.cr_check(jsonb_array_length(after_book->'public.accounting_credit_reduction_operations_v1')=
  jsonb_array_length(before_book->'public.accounting_credit_reduction_operations_v1')+1,
  'true no-change appends exactly one operation');
 after_book:=jsonb_set(after_book,'{public.accounting_credit_reduction_operations_v1}',
  (SELECT COALESCE(jsonb_agg(value ORDER BY value::text),'[]'::jsonb)
   FROM jsonb_array_elements(after_book->'public.accounting_credit_reduction_operations_v1')
   WHERE value->>'id' IS DISTINCT FROM e->'receipt'->>'receipt_id'));
 PERFORM pg_temp.cr_check(before_book=after_book,
  'true no-change preserves every prior operation, audit, invoice, message, notification and current row');
 INSERT INTO cr_saved VALUES('no_change',q,e,before_book);
END$no_change$;
RESET ROLE;
SET CONSTRAINTS ALL IMMEDIATE;
DO $no_change_row$ DECLARE x jsonb;BEGIN
 SELECT response->'receipt' INTO STRICT x FROM cr_saved WHERE label='no_change';
 PERFORM pg_temp.cr_check((SELECT count(*)=1 FROM public.accounting_credit_reduction_operations_v1 WHERE id=(x->>'receipt_id')::uuid),
  'no-change has one persisted operation rather than fabricated success');
 PERFORM public.fn_accounting_credit_reduction_assert_document((x->>'receipt_id')::uuid);
END$no_change_row$;
-- Exercise the new immediate document assertion independently. The inherited
-- notification→push constraint legitimately needs its later delivery link and
-- therefore remains deferred during construction.
SET CONSTRAINTS ALL DEFERRED;
SET CONSTRAINTS zz_accounting_credit_change_deferred_v1 IMMEDIATE;
SELECT pg_temp.cr_actor(pg_temp.cr_id(1));SET LOCAL ROLE authenticated;
DO $exact_range$ DECLARE s jsonb;q jsonb;e jsonb;a jsonb;BEGIN
 a:=public.fn_admin_update_agent(pg_temp.cr_id(239),p_credit_limit=>9999999999999.99,
  p_credit_reason=>'Exact numeric15,2 maximum starting limit');
 PERFORM pg_temp.cr_check(a->'success'='true'::jsonb,'existing writer accepts exact declared limit domain');
 s:=public.fn_agent_credit_reduction_snapshot_v1(pg_temp.cr_id(1),pg_temp.cr_id(101),pg_temp.cr_id(39));
 PERFORM pg_temp.cr_check(s->'credit_limit'='"9999999999999.99"'::jsonb,'snapshot preserves numeric15,2 maximum as text');
 q:=pg_temp.cr_intent(s,pg_temp.cr_id(1004),0.01,'One exact cent at maximum limit');e:=pg_temp.cr_apply(q);
 PERFORM pg_temp.cr_recorded(e,q,0.01,9999999999999.98,false);
 INSERT INTO cr_saved VALUES('maximum_limit',q,e,NULL);
 s:=public.fn_agent_credit_reduction_snapshot_v1(pg_temp.cr_id(1),pg_temp.cr_id(101),pg_temp.cr_id(38));
 q:=pg_temp.cr_intent(s,pg_temp.cr_id(1005),1000000000,'Largest admitted requested reduction');e:=pg_temp.cr_apply(q);
 PERFORM pg_temp.cr_recorded(e,q,100,0,true);
 INSERT INTO cr_saved VALUES('maximum_request',q,e,NULL);
END$exact_range$;
RESET ROLE;
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
\ir delivery-failure-regression.sql
\ir refusal-replay-regression.sql
\ir audit-failure-regression.sql
\ir roles-history-regression.sql
\ir authority-regression.sql
-- Separate-session cases run in the separately seeded disposable cluster.
ROLLBACK;
\ir isolation-regression.sql
