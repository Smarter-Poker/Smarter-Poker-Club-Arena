-- Harness only: the production triggers and framers the migration's preimage
-- checks require (bodies are production's, md5-checked). The immutability and
-- framing triggers exist as in production but are DISABLED here, because the
-- harness truncates and writes books with explicit frames.
CREATE OR REPLACE FUNCTION public.fn_union_pnl_inventory_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN RAISE EXCEPTION 'original_pnl_inventory_is_immutable' USING ERRCODE='55000'; END $function$
;
CREATE OR REPLACE FUNCTION public.fn_union_pnl_receipt_frame()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 PERFORM public.fn_union_pnl_original_frame();
 NEW.transaction_id:=pg_current_xact_id();
 RETURN NEW;
END $function$
;
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_accounting_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'tournament_accounting_evidence_is_immutable' USING ERRCODE='55000'; END $$;
CREATE TRIGGER original_pnl_inventory_events_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.union_pnl_inventory_events
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_union_pnl_inventory_immutable();
CREATE TRIGGER original_pnl_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.union_pnl_cash_outcomes
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_union_pnl_inventory_immutable();
CREATE TRIGGER original_pnl_immutable BEFORE DELETE OR UPDATE OR TRUNCATE ON public.union_pnl_transaction_frames
 FOR EACH STATEMENT EXECUTE FUNCTION public.fn_union_pnl_inventory_immutable();
CREATE TRIGGER original_evidence_immutable BEFORE DELETE OR UPDATE ON public.tournament_accounting_credit_receipts
 FOR EACH ROW EXECUTE FUNCTION public.fn_ca_tournament_accounting_evidence_immutable();
CREATE TRIGGER original_union_pnl_frame BEFORE INSERT ON public.tournament_accounting_credit_receipts
 FOR EACH ROW EXECUTE FUNCTION public.fn_union_pnl_receipt_frame();
ALTER TABLE public.union_pnl_inventory_events DISABLE TRIGGER original_pnl_inventory_events_immutable;
ALTER TABLE public.union_pnl_cash_outcomes DISABLE TRIGGER original_pnl_immutable;
ALTER TABLE public.union_pnl_transaction_frames DISABLE TRIGGER original_pnl_immutable;
ALTER TABLE public.tournament_accounting_credit_receipts DISABLE TRIGGER original_evidence_immutable;
ALTER TABLE public.tournament_accounting_credit_receipts DISABLE TRIGGER original_union_pnl_frame;
