-- Read-only catalog capture, production 2026-09-18 02:50 UTC.
-- The unchanged cash-source immutability trigger consults this relation when
-- target cancellation stamps terminal rake evidence. It stays empty throughout
-- this tournament-only fixture; no cash accrual is fabricated or qualified.
CREATE TABLE public.accounting_cash_accrual_batches(
 rake_record_id uuid NOT NULL, hand_id uuid NOT NULL, earned_at timestamptz NOT NULL,
 source_fingerprint text NOT NULL, status text NOT NULL, plan jsonb,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT accounting_cash_accrual_batches_check CHECK ((status='accrued')=(plan IS NOT NULL)),
 CONSTRAINT accounting_cash_accrual_batches_hand_id_key UNIQUE(hand_id),
 CONSTRAINT accounting_cash_accrual_batches_pkey PRIMARY KEY(rake_record_id),
 CONSTRAINT accounting_cash_accrual_batches_rake_record_id_fkey FOREIGN KEY(rake_record_id) REFERENCES public.rake_records(id),
 CONSTRAINT accounting_cash_accrual_batches_status_check CHECK(status=ANY(ARRAY['accrued'::text,'legacy_unverified'::text])));
ALTER TABLE public.accounting_cash_accrual_batches OWNER TO postgres;
ALTER TABLE public.accounting_cash_accrual_batches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.accounting_cash_accrual_batches FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.accounting_cash_accrual_batches TO service_role;
CREATE TRIGGER accounting_cash_batch_immutable BEFORE DELETE OR UPDATE ON public.accounting_cash_accrual_batches FOR EACH ROW EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
CREATE TRIGGER accounting_cash_batch_no_truncate BEFORE TRUNCATE ON public.accounting_cash_accrual_batches FOR EACH STATEMENT EXECUTE FUNCTION public.fn_accounting_agreement_history_immutable();
