-- @live-proof: md5(pg_get_functiondef('public.fn_ca_settle_approved_agent_adjustment(uuid,uuid,jsonb)'::regprocedure))='d94aa86c87d179e8134b938e406b926a'
-- @live-proof: md5(pg_get_functiondef('public.fn_ca_adjustments_report(timestamptz)'::regprocedure))='a8979bae7eca0bdc74f12306304b44c0'
-- An approved agent earning shortfall is a real commission transfer, not an
-- incident-only correction document (which explicitly proves no new payment).
-- Preserve proposal, independent approval, exact operation key, conservation,
-- original incident validator and previously settled correction receipt replay.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $change$
DECLARE d text;m jsonb;after_d text;old_text text;new_text text;
BEGIN
 SELECT pg_get_functiondef(p.oid),to_jsonb(p)-'prosrc' INTO STRICT d,m FROM pg_proc p
 WHERE p.oid='public.fn_ca_settle_approved_agent_adjustment(uuid,uuid,jsonb)'::regprocedure;
 IF md5(d)<>'6eec29205765cd38ca9e0f6f9bfb8ed5' THEN RAISE EXCEPTION 'earned_agent_document_preimage_changed';END IF;
 after_d:=d;
 old_text:=$old$l.category IS DISTINCT FROM 'correction'$old$;
 new_text:=$new$l.category NOT IN('correction','commission')$new$;
 IF(length(after_d)-length(replace(after_d,old_text,'')))/length(old_text)<>1 THEN RAISE EXCEPTION 'earned_agent_document_replay_anchor_changed';END IF;
 after_d:=replace(after_d,old_text,new_text);
 old_text:=$old$public.fn_ca_declare_ledger('correction','club_treasury'$old$;
 new_text:=$new$public.fn_ca_declare_ledger('commission','club_treasury'$new$;
 IF(length(after_d)-length(replace(after_d,old_text,'')))/length(old_text)<>1 THEN RAISE EXCEPTION 'earned_agent_document_declare_anchor_changed';END IF;
 after_d:=replace(after_d,old_text,new_text);
 old_text:=$old$a.amount,'correction',p_club,a.reason$old$;
 new_text:=$new$a.amount,'commission',p_club,a.reason$new$;
 IF(length(after_d)-length(replace(after_d,old_text,'')))/length(old_text)<>1 THEN RAISE EXCEPTION 'earned_agent_document_category_anchor_changed';END IF;
 after_d:=replace(after_d,old_text,new_text);
 old_text:=$old$  RETURN jsonb_build_object('success',true,'replayed',true$old$;
 new_text:=$new$  IF l.category='commission' AND (SELECT count(*) FROM public.settlement_invoices i WHERE i.source_ledger_id=l.id AND i.club_id=p_club AND i.invoice_type='club_to_agent' AND i.from_entity_type='club' AND i.from_entity_id=p_club::text AND i.to_entity_type='agent' AND i.to_entity_id=a.target_id::text AND i.gross_amount=a.amount AND i.net_amount=a.amount AND i.deductions=0 AND i.status='paid' AND i.chips_transferred IS TRUE AND i.transferred_at=l.created_at AND i.invoice_number IS NOT NULL AND i.message_sent IS TRUE AND i.message_sent_at IS NOT NULL AND i.breakdown->>'category'='commission' AND i.breakdown->>'ledger_id'=l.id::text AND i.breakdown->'approved_intent'=intent)<>1 THEN RAISE EXCEPTION 'approved_agent_adjustment_paid_document_unverified' USING ERRCODE='23514';END IF;
  RETURN jsonb_build_object('success',true,'replayed',true$new$;
 IF(length(after_d)-length(replace(after_d,old_text,'')))/length(old_text)<>1 THEN RAISE EXCEPTION 'earned_agent_document_receipt_anchor_changed';END IF;
 after_d:=replace(after_d,old_text,new_text);
 old_text:=$old$ UPDATE public.ca_manual_adjustments SET status='settled'WHERE$old$;
 new_text:=$new$  IF l.category='commission' AND (SELECT count(*) FROM public.settlement_invoices i WHERE i.source_ledger_id=l.id AND i.club_id=p_club AND i.invoice_type='club_to_agent' AND i.from_entity_type='club' AND i.from_entity_id=p_club::text AND i.to_entity_type='agent' AND i.to_entity_id=a.target_id::text AND i.gross_amount=a.amount AND i.net_amount=a.amount AND i.deductions=0 AND i.status='paid' AND i.chips_transferred IS TRUE AND i.transferred_at=l.created_at AND i.invoice_number IS NOT NULL AND i.message_sent IS TRUE AND i.message_sent_at IS NOT NULL AND i.breakdown->>'category'='commission' AND i.breakdown->>'ledger_id'=l.id::text AND i.breakdown->'approved_intent'=intent)<>1 THEN RAISE EXCEPTION 'approved_agent_adjustment_paid_document_unverified' USING ERRCODE='23514';END IF;
 UPDATE public.ca_manual_adjustments SET status='settled'WHERE$new$;
 IF(length(after_d)-length(replace(after_d,old_text,'')))/length(old_text)<>1 THEN RAISE EXCEPTION 'earned_agent_document_receipt_anchor_changed';END IF;
 after_d:=replace(after_d,old_text,new_text);
 EXECUTE after_d;
 IF md5(pg_get_functiondef('public.fn_ca_settle_approved_agent_adjustment(uuid,uuid,jsonb)'::regprocedure))<>md5(after_d)
 OR(SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE p.oid='public.fn_ca_settle_approved_agent_adjustment(uuid,uuid,jsonb)'::regprocedure)IS DISTINCT FROM m
 THEN RAISE EXCEPTION 'earned_agent_document_postimage_or_metadata_changed';END IF;
END $change$;
DO $audit$
DECLARE d text;m jsonb;after_d text;old_text text:=$old$OR (l.category = 'adjustment' AND COALESCE(l.description, '') NOT LIKE 'auto-%')$old$;
new_text text:=$new$OR (l.category = 'adjustment' AND COALESCE(l.description, '') NOT LIKE 'auto-%')
         OR (l.category='commission' AND l.status='posted' AND l.from_type='club_treasury' AND l.from_entity_id=l.club_id AND l.to_type='agent_wallet' AND l.metadata->>'executed_by_db_role'='postgres' AND l.metadata->>'executed_by_session_user'='postgres' AND EXISTS(SELECT 1 FROM public.ca_manual_adjustments a WHERE a.id::text=l.metadata->>'adjustment_id' AND l.correlation_id=a.id AND l.idempotency_key='manual-agent-adjustment:'||a.id AND a.status IN('approved','settled') AND a.target_kind='agent_wallet' AND a.asset='chips' AND a.target_id=l.to_entity_id AND a.amount=l.amount AND a.approver IS NOT NULL AND a.approver<>a.actor AND l.metadata->'approved_intent'=jsonb_build_object('club_id',l.club_id,'approved_adjustment',to_jsonb(a)-'status')))$new$;
BEGIN
 SELECT pg_get_functiondef(p.oid),to_jsonb(p)-'prosrc' INTO STRICT d,m FROM pg_proc p WHERE p.oid='public.fn_ca_adjustments_report(timestamptz)'::regprocedure;
 IF md5(d)<>'ce9438bbfc0ce1f7c88348889683fb00' OR(length(d)-length(replace(d,old_text,'')))/length(old_text)<>1 THEN RAISE EXCEPTION 'earned_agent_document_audit_preimage_changed';END IF;
 after_d:=replace(d,old_text,new_text);EXECUTE after_d;
 IF md5(pg_get_functiondef('public.fn_ca_adjustments_report(timestamptz)'::regprocedure))<>md5(after_d) OR(SELECT to_jsonb(p)-'prosrc'FROM pg_proc p WHERE p.oid='public.fn_ca_adjustments_report(timestamptz)'::regprocedure)IS DISTINCT FROM m THEN RAISE EXCEPTION 'earned_agent_document_audit_postimage_or_metadata_changed';END IF;
END $audit$;
COMMIT;
