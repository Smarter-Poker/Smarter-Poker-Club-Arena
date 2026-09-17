-- INERT SOURCE ONLY: not installed or connected to an active reader.
-- Caller context is retained as unverified context, NEVER identity authority.
CREATE FUNCTION smarter_private.s7_union_raw_sides_0140(
  p_leg public.chip_ledger, p_unverified_context jsonb
) RETURNS SETOF jsonb
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER
SET search_path TO pg_catalog
AS $function$
DECLARE
  s record;
  v_column text;
  v_candidate_type text;
  v_status text;
  v_reason text;
BEGIN
  -- Emit BOTH original sides before endpoint/type/grouping filters, including
  -- null endpoints. No lookup, identity conversion, aggregation or LIMIT.
  FOR s IN
    SELECT * FROM (VALUES
      ('from'::text,p_leg.from_type,p_leg.from_entity_id,p_leg.from_label,p_leg.to_label,-p_leg.amount),
      ('to'::text,p_leg.to_type,p_leg.to_entity_id,p_leg.to_label,p_leg.from_label,p_leg.amount)
    ) AS raw(side,original_type,endpoint,label,other_label,signed_amount)
  LOOP
    v_column := CASE WHEN s.label IN (
      'union_wallets.chip_balance','union_wallets.rake_wallet',
      'union_wallets.bbj_wallet','union_wallets.promo_wallet',
      'union_wallets.insurance_wallet','union_wallets.spin_reserve_wallet'
    ) THEN s.label ELSE NULL END;
    v_candidate_type := NULL;
    v_status := 'unresolved';
    v_reason := 'immutable_producer_side_join_missing';
    IF s.original_type='union_bank' AND v_column='union_wallets.chip_balance' THEN
      v_candidate_type := 'union_bank';
    ELSIF s.original_type='union_wallet' AND v_column IS NOT NULL THEN
      v_candidate_type := CASE WHEN v_column='union_wallets.chip_balance'
        THEN 'union_bank' ELSE 'union_wallet' END;
    ELSIF s.original_type='promo_wallet' AND v_column='union_wallets.promo_wallet' THEN
      v_candidate_type := 'union_wallet';
    ELSIF s.original_type IN ('union_bank','union_wallet','promo_wallet') OR v_column IS NOT NULL THEN
      v_status := 'unsupported';
      v_reason := 'type_column_or_alias_unproved';
    ELSE
      v_status := 'outside_union_scope';
      v_reason := 'preserve_existing_nonunion_path';
    END IF;
    IF p_leg.id IS NULL OR s.endpoint IS NULL OR s.original_type IS NULL THEN
      v_status := 'unresolved';
      v_reason := 'raw_side_identity_missing';
    END IF;
    RETURN NEXT jsonb_build_object(
      'contract','s7_union_side_inert_0140',
      'ledger_id',p_leg.id,'side',s.side,
      'original_type',s.original_type,'original_endpoint',s.endpoint,
      'original_label',s.label,'other_label',s.other_label,
      'signed_amount',s.signed_amount,'contextual_union_id',p_leg.union_id,
      'candidate_column',v_column,'candidate_type',v_candidate_type,
      'status',v_status,'reason',v_reason,
      'logical_union_id',NULL,'proved_provenance',NULL,
      'unverified_context',p_unverified_context,
      'window_coverage','unknown','remainder_count',NULL
    );
  END LOOP;
  RETURN;
END
$function$;
ALTER FUNCTION smarter_private.s7_union_raw_sides_0140(public.chip_ledger,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.s7_union_raw_sides_0140(public.chip_ledger,jsonb)
  FROM PUBLIC,anon,authenticated,service_role,authenticator;
