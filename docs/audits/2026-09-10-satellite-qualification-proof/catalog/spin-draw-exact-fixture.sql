BEGIN;
DO $$ BEGIN IF current_database()<>'satellite_qualification_verified' THEN RAISE EXCEPTION 'Private fixture'; END IF; END $$;
CREATE TABLE public.spin_draw_receipts("tournament_id" uuid NOT NULL,"launch_id" uuid NOT NULL,"lease_generation" uuid NOT NULL,"rule_manifest" jsonb NOT NULL,"rule_sha256" text NOT NULL,"entrants" jsonb NOT NULL,"receipt" jsonb NOT NULL,"created_at" timestamp with time zone DEFAULT transaction_timestamp() NOT NULL);
ALTER TABLE public.spin_draw_receipts ADD CONSTRAINT "spin_draw_receipts_entrants_check" CHECK ((jsonb_array_length(entrants) = 3));
ALTER TABLE public.spin_draw_receipts ADD CONSTRAINT "spin_draw_receipts_pkey" PRIMARY KEY (tournament_id);
ALTER TABLE public.spin_draw_receipts ADD CONSTRAINT "spin_draw_receipts_rule_sha256_check" CHECK ((rule_sha256 ~ '^[0-9a-f]{64}$'::text));
CREATE OR REPLACE FUNCTION public.trg_spin_draw_receipt_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION 'A booked Spin draw receipt is immutable' USING ERRCODE = '23514';
END;
$function$;
CREATE TRIGGER spin_draw_receipt_is_immutable BEFORE DELETE OR UPDATE ON public.spin_draw_receipts FOR EACH ROW EXECUTE FUNCTION trg_spin_draw_receipt_is_immutable();
ALTER TABLE public.spin_draw_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.spin_draw_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.spin_draw_receipts TO service_role;
COMMIT;