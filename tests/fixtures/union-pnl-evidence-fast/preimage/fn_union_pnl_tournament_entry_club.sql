CREATE FUNCTION public.fn_union_pnl_tournament_entry_club(r public.tournament_participant_funding_receipts)
RETURNS uuid LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN r.asset='chips' AND r.amount>0 THEN r.funding_club_id
  WHEN r.asset='chips' AND r.amount=0 AND r.ledger_id IS NULL AND r.entitlement_id IS NULL
   AND r.registration_snapshot->>'source_satellite_id' IS NULL
   AND r.registration_snapshot->'is_satellite_qualifier'='false'::jsonb
   THEN (r.registration_snapshot->>'club_id')::uuid END;
$$
