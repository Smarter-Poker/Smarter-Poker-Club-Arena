CREATE OR REPLACE FUNCTION public.fn_union_pnl_tournament_entry_club_of(p_asset text, p_amount numeric, p_funding_club_id uuid, p_ledger_id uuid, p_entitlement_id uuid, p_registration_snapshot jsonb)
 RETURNS uuid
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT CASE WHEN p_asset='chips' AND p_amount>0 THEN p_funding_club_id
  WHEN p_asset='chips' AND p_amount=0 AND p_ledger_id IS NULL AND p_entitlement_id IS NULL
   AND p_registration_snapshot->>'source_satellite_id' IS NULL
   AND p_registration_snapshot->'is_satellite_qualifier'='false'::jsonb
   THEN (p_registration_snapshot->>'club_id')::uuid END;
$function$;
