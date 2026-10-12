-- Current-period discharge offsets the original opening receivable once.
-- It does not backdate the immutable historical boundary or duplicate bank claim.
CREATE OR REPLACE FUNCTION smarter_private.original_erased_cash_discharge_returns(p_union_id uuid,p_start timestamptz,p_end timestamptz)
RETURNS TABLE(ledger_id uuid,club_id uuid,user_id uuid,buyins numeric,cashouts numeric,kind text,valid boolean)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,smarter_private SET timezone='UTC' AS $body$
DECLARE c record;f jsonb;receipt jsonb;h text;
BEGIN
 IF p_union_id IS DISTINCT FROM 'fade0000-0000-0000-0000-000000000001'::uuid
 OR p_start IS NULL OR p_end IS NULL OR NOT isfinite(p_start) OR NOT isfinite(p_end) OR p_end<=p_start THEN RETURN;END IF;
 FOR c IN SELECT * FROM smarter_private.original_inventory_restoration_cases WHERE family='erased_cash_receivable' LOOP
 f:=smarter_private.original_inventory_finite_witness(c.event_id);
 IF f IS NULL THEN RAISE EXCEPTION 'original_discharge_flow_source_refused' USING ERRCODE='55000';END IF;
 h:=md5((f-'original_table_scope'-'original_manifest_scope')::text);
 receipt:=smarter_private.original_erased_cash_base_discharge_receipt(c.event_id,h);
 IF receipt->>'status'='pending' THEN CONTINUE;END IF;
 IF receipt->>'status' IS DISTINCT FROM 'discharged'
 OR receipt->>'discharged_at' IS NULL OR NOT isfinite((receipt->>'discharged_at')::timestamptz)
 OR receipt->>'custody' IS DISTINCT FROM 'canonical_deleted_account_bank'
 OR receipt->'final_player_wallet' IS DISTINCT FROM '0'::jsonb
 OR receipt->>'occupancy_id' IS DISTINCT FROM f#>>'{event,before_row,occupancy_id}'
 OR receipt->>'restoration_key' IS DISTINCT FROM ('retired_completed_cash_base:'||(f#>>'{event,before_row,occupancy_id}'))
 OR (receipt->>'discharged_at')::timestamptz<='2026-10-12 07:00:00Z'::timestamptz
 OR EXISTS(SELECT 1 FROM public.union_pnl_original_flows old WHERE old.ledger_id=(receipt->>'issuance_leg_id')::uuid)
 THEN RAISE EXCEPTION 'original_discharge_flow_proof_refused' USING ERRCODE='55000';END IF;
 IF (receipt->>'discharged_at')::timestamptz<p_start OR (receipt->>'discharged_at')::timestamptz>=p_end THEN CONTINUE;END IF;
 ledger_id:=(receipt->>'issuance_leg_id')::uuid;club_id:=(receipt->>'funding_club_id')::uuid;user_id:=(receipt->>'user_id')::uuid;
 buyins:=0;cashouts:=(receipt->>'amount')::numeric;kind:='cash_return';valid:=true;RETURN NEXT;
 END LOOP;
END $body$;
ALTER FUNCTION smarter_private.original_erased_cash_discharge_returns(uuid,timestamptz,timestamptz) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.original_erased_cash_discharge_returns(uuid,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
