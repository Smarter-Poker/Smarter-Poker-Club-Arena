-- Explicit external-helper boundaries only. Actual entire quality bodies execute.
-- These fixtures do NOT qualify producer/refund/owner-direct receipt writers.
CREATE TABLE fixture.direct_proofs(rake_record_id uuid PRIMARY KEY,valid boolean NOT NULL);
CREATE TABLE fixture.mixed_proofs(rake_record_id uuid PRIMARY KEY,valid boolean NOT NULL);
CREATE FUNCTION public.fn_accounting_owner_direct_fee_proof_valid(uuid)RETURNS boolean LANGUAGE sql STABLE AS $$SELECT coalesce((SELECT valid FROM fixture.direct_proofs WHERE rake_record_id=$1),false)$$;
CREATE OR REPLACE FUNCTION public.fn_accounting_mixed_cutover_spin_proof_valid(uuid)RETURNS boolean LANGUAGE sql STABLE AS $$SELECT coalesce((SELECT valid FROM fixture.mixed_proofs WHERE rake_record_id=$1),false)$$;

CREATE VIEW public.accounting_owner_direct_fee_proofs AS SELECT rake_record_id FROM fixture.direct_proofs;
