BEGIN; SET LOCAL timezone='UTC'; SET LOCAL search_path=public,extensions,pg_temp; SET LOCAL check_function_bodies=off;
DO $$ BEGIN IF session_user<>'fixture_bootstrap' OR current_database() !~ '^qual_spin_expiry_[0-9a-f]{32}$' OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>'' THEN RAISE EXCEPTION 'FEE_CUSTODY_PROVIDER_ISOLATION_REQUIRED'; END IF; END $$;
CREATE TABLE public.accounting_tournament_fee_custody_obligations("id" uuid DEFAULT gen_random_uuid() NOT NULL,"tournament_id" uuid NOT NULL,"source_fingerprint" text NOT NULL,"amount" numeric NOT NULL,"reason" text NOT NULL,"original_fees" jsonb NOT NULL,"original_funding" jsonb NOT NULL,"original_scope" jsonb NOT NULL,"escrow_snapshot" jsonb NOT NULL,"held_at" timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,"transaction_id" bigint DEFAULT txid_current() NOT NULL); ALTER TABLE public.accounting_tournament_fee_custody_obligations OWNER TO postgres; ALTER TABLE public.accounting_tournament_fee_custody_obligations ENABLE ROW LEVEL SECURITY; REVOKE ALL ON public.accounting_tournament_fee_custody_obligations FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE public.accounting_tournament_fee_custody_obligations ADD CONSTRAINT "accounting_tournament_fee_custody_obli_source_fingerprint_check" CHECK (source_fingerprint ~ '^[0-9a-f]{32}$'::text);
ALTER TABLE public.accounting_tournament_fee_custody_obligations ADD CONSTRAINT "accounting_tournament_fee_custody_obliga_original_funding_check" CHECK (jsonb_typeof(original_funding) = 'array'::text);
ALTER TABLE public.accounting_tournament_fee_custody_obligations ADD CONSTRAINT "accounting_tournament_fee_custody_obligat_escrow_snapshot_check" CHECK (jsonb_typeof(escrow_snapshot) = 'object'::text);
ALTER TABLE public.accounting_tournament_fee_custody_obligations ADD CONSTRAINT "accounting_tournament_fee_custody_obligati_original_scope_check" CHECK (jsonb_typeof(original_scope) = 'object'::text);
ALTER TABLE public.accounting_tournament_fee_custody_obligations ADD CONSTRAINT "accounting_tournament_fee_custody_obligatio_original_fees_check" CHECK (jsonb_typeof(original_fees) = 'array'::text);
ALTER TABLE public.accounting_tournament_fee_custody_obligations ADD CONSTRAINT "accounting_tournament_fee_custody_obligations_amount_check" CHECK (amount > 0::numeric AND amount = round(amount, 2) AND (amount::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])));
ALTER TABLE public.accounting_tournament_fee_custody_obligations ADD CONSTRAINT "accounting_tournament_fee_custody_obligations_pkey" PRIMARY KEY (id);
ALTER TABLE public.accounting_tournament_fee_custody_obligations ADD CONSTRAINT "accounting_tournament_fee_custody_obligations_reason_check" CHECK (reason = ANY (ARRAY['tournament_fee_sources_require_reconciliation'::text, 'accounting_terms_not_observed'::text, 'accounting_terms_not_active'::text, 'tournament_fee_not_captured_by_original_producer'::text]));
ALTER TABLE public.accounting_tournament_fee_custody_obligations ADD CONSTRAINT "accounting_tournament_fee_custody_obligations_tournament_id_key" UNIQUE (tournament_id);
CREATE OR REPLACE FUNCTION public.fn_ca_legacy_fee_custody_is_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN RAISE EXCEPTION 'original fee custody obligations are append-only' USING ERRCODE='55000'; END $function$;
ALTER FUNCTION public.fn_ca_legacy_fee_custody_is_append_only() OWNER TO postgres; REVOKE ALL ON FUNCTION public.fn_ca_legacy_fee_custody_is_append_only() FROM PUBLIC,anon,authenticated,service_role; GRANT EXECUTE ON FUNCTION public.fn_ca_legacy_fee_custody_is_append_only() TO postgres;
DO $$ BEGIN IF md5(pg_get_functiondef('public.fn_ca_legacy_fee_custody_is_append_only()'::regprocedure)) IS DISTINCT FROM '4bc1c11e22a8ee54c63c36782b642831' THEN RAISE EXCEPTION 'FEE_CUSTODY_PROVIDER_SOURCE_CHANGED'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.fn_ca_legacy_fee_custody_requires_terminal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.tournament_terminal_settlements h
  WHERE h.tournament_id=NEW.tournament_id AND h.accounting_state='fee_custody_unresolved'
   AND h.receipt_version=3 AND h.rake_amount=NEW.amount AND h.rake_settled_at IS NULL
   AND h.rake_attributed_at IS NULL AND h.escrow_closed_at IS NULL)
 THEN RAISE EXCEPTION 'fee custody cannot commit without its exact player terminal receipt' USING ERRCODE='P0404'; END IF;
 PERFORM public.fn_ca_tournament_terminal_receipt(NEW.tournament_id,NULL);
 RETURN NULL;
END $function$;
ALTER FUNCTION public.fn_ca_legacy_fee_custody_requires_terminal() OWNER TO postgres; REVOKE ALL ON FUNCTION public.fn_ca_legacy_fee_custody_requires_terminal() FROM PUBLIC,anon,authenticated,service_role; GRANT EXECUTE ON FUNCTION public.fn_ca_legacy_fee_custody_requires_terminal() TO postgres;
DO $$ BEGIN IF md5(pg_get_functiondef('public.fn_ca_legacy_fee_custody_requires_terminal()'::regprocedure)) IS DISTINCT FROM '3f9a6541f8016270ba4faae97765e620' THEN RAISE EXCEPTION 'FEE_CUSTODY_PROVIDER_SOURCE_CHANGED'; END IF; END $$;
CREATE TRIGGER legacy_fee_custody_is_append_only BEFORE DELETE OR UPDATE ON accounting_tournament_fee_custody_obligations FOR EACH ROW EXECUTE FUNCTION fn_ca_legacy_fee_custody_is_append_only();
CREATE TRIGGER legacy_fee_custody_refuses_truncate BEFORE TRUNCATE ON accounting_tournament_fee_custody_obligations FOR EACH STATEMENT EXECUTE FUNCTION fn_ca_legacy_fee_custody_is_append_only();
CREATE CONSTRAINT TRIGGER legacy_fee_custody_requires_terminal AFTER INSERT ON accounting_tournament_fee_custody_obligations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_ca_legacy_fee_custody_requires_terminal();
COMMIT;
