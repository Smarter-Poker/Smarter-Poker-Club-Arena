-- Actual live readback 2026-10-12: all three existing readers are postgres only.
-- CREATE OR REPLACE must retain these existing ACLs, not fixture defaults.
REVOKE ALL ON FUNCTION public.fn_union_pnl_original_flow_evidence(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_evidence_report(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_cash_outcome_accepted(public.union_pnl_cash_outcomes) FROM PUBLIC,anon,authenticated,service_role;
