-- Captured original audit relation from installed20260918080939. Local bootstrap only.
CREATE TABLE public.ca_stranded_fee_reconciliations(
  rake_record_id    uuid PRIMARY KEY REFERENCES public.rake_records(id),
  tournament_id     uuid NOT NULL,
  rake_amount       numeric NOT NULL CHECK (rake_amount > 0 AND rake_amount = round(rake_amount,2)),
  contributor_count integer NOT NULL CHECK (contributor_count > 0),
  source_ids        uuid[] NOT NULL CHECK (cardinality(source_ids) > 0),
  charged_at        timestamptz NOT NULL,
  cutover_at        timestamptz NOT NULL,
  reconciled_at     timestamptz NOT NULL DEFAULT transaction_timestamp(),
  reconciled_by     uuid NOT NULL DEFAULT COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
  CHECK (charged_at < cutover_at),
  CHECK (cardinality(source_ids) = contributor_count)
);

COMMENT ON TABLE public.ca_stranded_fee_reconciliations IS
  'One row per tournament fee captured after its producing transaction ended. Append only. The population it exists for is closed: ca_fee_cutover_is_drained stops another from being created.';

CREATE OR REPLACE FUNCTION public.fn_ca_stranded_fee_reconciliations_immutable()
RETURNS trigger LANGUAGE plpgsql AS $imm$
BEGIN
  RAISE EXCEPTION 'ca_stranded_fee_reconciliations is append only' USING ERRCODE = '55000';
END
$imm$;

CREATE TRIGGER ca_stranded_fee_reconciliations_immutable
  BEFORE UPDATE OR DELETE ON public.ca_stranded_fee_reconciliations
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_stranded_fee_reconciliations_immutable();

CREATE TRIGGER ca_stranded_fee_reconciliations_no_truncate
  BEFORE TRUNCATE ON public.ca_stranded_fee_reconciliations
  FOR EACH STATEMENT EXECUTE FUNCTION public.fn_ca_stranded_fee_reconciliations_immutable();

ALTER TABLE public.ca_stranded_fee_reconciliations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_stranded_fee_reconciliations FROM PUBLIC, anon, authenticated;

