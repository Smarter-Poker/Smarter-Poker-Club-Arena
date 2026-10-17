-- Explicit nonfinancial receipt/delivery isolation boundary.
CREATE OR REPLACE FUNCTION public.wcs_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inv uuid; msg uuid; note uuid; role text:=NEW.metadata->>'payee_role_at_transfer';
BEGIN
 IF NEW.category NOT IN('rakeback','commission') THEN RETURN NEW; END IF;
 IF current_setting('dr.refuse_invoice',true)='on' THEN RETURN NEW; END IF;
 IF NEW.category='rakeback' AND current_setting('dr.delay_one_r3',true)='on' THEN
  PERFORM set_config('dr.delay_one_r3','off',true); PERFORM pg_sleep(90.1);
 END IF;
 INSERT INTO public.settlement_invoices(club_id,invoice_type,from_entity_type,from_entity_id,to_entity_type,to_entity_id,gross_amount,net_amount,deductions,
   breakdown,status,chips_transferred,message_sent,transferred_at,source_ledger_id)
 VALUES(COALESCE(NEW.club_id,NEW.union_id),'transaction_receipt',CASE WHEN NEW.from_type='club_treasury' THEN 'club' ELSE 'agent' END,NEW.from_entity_id::text,
   CASE WHEN role='player' THEN 'player' ELSE 'agent' END,NEW.to_entity_id::text,NEW.amount,NEW.amount,0,
   COALESCE(NEW.metadata,'{}')||jsonb_build_object('ledger_id',NEW.id,'category',NEW.category,'payee_role_at_transfer',role),
   'paid',true,true,NEW.created_at,NEW.id) RETURNING id INTO inv;
 INSERT INTO public.social_messages(content,message_type,media_metadata) VALUES('receipt','invoice',jsonb_build_object('invoice_id',inv)) RETURNING id INTO msg;
 INSERT INTO public.notifications(user_id,type,title,data,metadata) VALUES(NEW.to_entity_id,'accounting_invoice','Invoice',jsonb_build_object('invoice_id',inv),jsonb_build_object('invoice_id',inv)) RETURNING id INTO note;
 INSERT INTO public.accounting_invoice_deliveries(invoice_id,recipient_id,message_id,notification_id) VALUES(inv,NEW.to_entity_id,msg,note);
 RETURN NEW;
END $$;
CREATE TRIGGER wcs_receipt AFTER INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION public.wcs_receipt();
