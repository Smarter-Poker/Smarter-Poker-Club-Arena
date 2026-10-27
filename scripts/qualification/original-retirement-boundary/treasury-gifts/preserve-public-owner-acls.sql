
-- Preserve exact original public owner ACLs; these are not anonymous RPCs.
REVOKE ALL ON FUNCTION public.fn_ca_cash_seat_club(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_cash_seat_club(uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_cash_earning_club(uuid,uuid,uuid,uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_cash_original_funding_lineage(uuid,uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_horse_seat_from_treasury(uuid,uuid,integer,numeric,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_horse_seat_from_treasury(uuid,uuid,integer,numeric,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_horse_seat_from_treasury_before_maintenance_gate(uuid,uuid,integer,numeric,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_pnl_cash_hand_evidence(uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_pnl_cash_hand_evidence(uuid,bigint) TO service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_boundary(uuid,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_cash_outcome_accepted(public.union_pnl_cash_outcomes) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_original_flow_evidence(uuid,timestamp with time zone,timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_union_pnl_week_hand_lines(uuid,timestamp with time zone,timestamp with time zone,boolean) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_cash_capture_hand_manifest(uuid,bigint,jsonb,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_cash_capture_hand_manifest(uuid,bigint,jsonb,text,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_cash_record_original_funding(text,text,uuid,uuid,uuid,uuid,uuid,numeric,numeric,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_claim_entry_purchase_receipt(text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
