-- Harness stand-ins for what the evidence path calls but this change does not
-- touch. Each returns deterministic facts from an hx_ table the generator fills.
CREATE TABLE public.hx_inventory(boundary timestamptz PRIMARY KEY, result jsonb NOT NULL);
CREATE TABLE public.hx_lineage(seat_id uuid PRIMARY KEY, result jsonb NOT NULL);
CREATE TABLE public.hx_eco(union_id uuid PRIMARY KEY, result jsonb NOT NULL);
CREATE TABLE public.hx_rake_basis(union_id uuid, club_id uuid, payout numeric);
CREATE SEQUENCE public.hx_reports;
CREATE FUNCTION public.fn_union_pnl_inventory_as_of(p_at timestamptz) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
 SELECT COALESCE((SELECT result FROM public.hx_inventory WHERE boundary=p_at),jsonb_build_object('status','blocked','reason','harness_boundary_missing')) $$;
CREATE FUNCTION public.fn_cash_original_funding_lineage(p_user uuid,p_table uuid,p_seat uuid,p_occupancy uuid,p_joined timestamptz,p_at timestamptz,p_strict boolean)
 RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT COALESCE((SELECT result FROM public.hx_lineage WHERE seat_id=p_seat),'{"issues":[],"funding_receipts":[]}'::jsonb) $$;
-- one call per computed report: the memo test counts these
CREATE FUNCTION public.fn_union_eco_terms_evidence(p_union_id uuid,p_start timestamptz,p_end timestamptz) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
 SELECT COALESCE((SELECT result FROM public.hx_eco WHERE union_id=p_union_id),'{"status":"ready","segments":[]}'::jsonb)
  ||jsonb_build_object('harness_call',(nextval('public.hx_reports')*0)) $$;
CREATE FUNCTION public.fn_accounting_union_earned_plan_v3(p_union_id uuid,p_start timestamptz,p_end timestamptz) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('accounting_version',3,'union_id',p_union_id,'basis_detail','[]'::jsonb) $$;
CREATE FUNCTION public.fn_union_club_rake_basis(p_union_id uuid,p_start timestamptz,p_end timestamptz,p_detail boolean DEFAULT false)
 RETURNS TABLE(club_id uuid,game_type text,rake_in numeric,rate numeric,payout numeric) LANGUAGE sql STABLE AS $$
 SELECT h.club_id,'cash'::text,0::numeric,0::numeric,h.payout FROM public.hx_rake_basis h WHERE h.union_id=p_union_id $$;
CREATE TABLE public.hx_meta(union_id uuid, other_union_id uuid);
