-- Stubs for the parts of the close this change does not touch.
-- The tournament week gate answers what the harness asks it to.
CREATE OR REPLACE FUNCTION public.fn_accounting_tournament_week_quality(p_club_id uuid,p_from timestamptz,p_to timestamptz) RETURNS jsonb
 LANGUAGE sql STABLE AS $$ SELECT COALESCE(NULLIF(current_setting('wcs.quality',true),''),'{"status":"ready","checked":0}')::jsonb $$;
-- The union earned plan of production proves union bank receipts this
-- harness does not model; a stub counts its proofs so the memo can be tested.
CREATE TABLE public.wcs_calls(fn text, at timestamptz DEFAULT clock_timestamp());
CREATE OR REPLACE FUNCTION public.fn_accounting_union_earned_plan(p_union_id uuid,p_start timestamptz,p_end timestamptz) RETURNS jsonb
 LANGUAGE plpgsql VOLATILE AS $$ BEGIN INSERT INTO public.wcs_calls(fn) VALUES('earned_plan');
 RETURN jsonb_build_object('accounting_version',3,'union_id',p_union_id,'period_start',p_start,'period_end',p_end,'basis_detail','[]'::jsonb); END $$;
-- The receipt chain of production (fn_accounting_transfer_document_on_insert
-- -> fn_invoice_accounting_ledger_transfer -> fn_deliver_accounting_invoice) is
-- replaced by one trigger that writes the same paid, delivered receipt shape
-- the stages and the statement check for.
CREATE OR REPLACE FUNCTION public.wcs_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inv uuid; msg uuid; note uuid; role text:=NEW.metadata->>'payee_role_at_transfer';
BEGIN
 IF NEW.category NOT IN('rakeback','commission') THEN RETURN NEW; END IF;
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
