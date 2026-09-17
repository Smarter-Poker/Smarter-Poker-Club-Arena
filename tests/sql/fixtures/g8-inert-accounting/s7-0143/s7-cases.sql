-- AUTHORED UNRUN S7 supplemental cases for Diamond's existing constructor.
-- Requires reviewed owner-only definition loaded in the protected fixture.
-- No ledger inserts or mutation; no W!=U omission experiment is repeated.
DO $cases$
DECLARE
  leg public.chip_ledger;
  rows jsonb;
  r jsonb;
  col text;
  item jsonb;
  typ text;
  ctx jsonb := '{"producer":"claimed","version":7,"proved":true,"snapshot":{"domain":"unverified"}}'::jsonb;
BEGIN
  leg := jsonb_populate_record(NULL::public.chip_ledger,jsonb_build_object(
    'id','00000000-0000-0000-0000-000000000001',
    'from_type','union_wallet','to_type','union_wallet',
    'from_entity_id',NULL,'to_entity_id','00000000-0000-0000-0000-000000000002',
    'from_label','union_wallets.insurance_wallet','to_label','union_wallets.insurance_wallet',
    'amount',7,'union_id','00000000-0000-0000-0000-000000000003'));
  SELECT jsonb_agg(value ORDER BY value->>'side') INTO rows
    FROM smarter_private.s7_union_raw_sides_0140(leg,'{"producer":"trusted","version":"current","proved":true}'::jsonb) AS value;
  IF jsonb_array_length(rows) IS DISTINCT FROM 2
   OR (SELECT count(*) FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='from') IS DISTINCT FROM 1::bigint
   OR (SELECT count(*) FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='to') IS DISTINCT FROM 1::bigint THEN
   RAISE EXCEPTION 'S7_0143_EXACT_SIDE_CARDINALITY_01';
  END IF;
  IF jsonb_array_length(rows) IS DISTINCT FROM 2
     OR rows->0->>'side' IS DISTINCT FROM 'from' OR rows->1->>'side' IS DISTINCT FROM 'to'
     OR rows->0->'original_endpoint' IS DISTINCT FROM 'null'::jsonb
     OR rows->0->>'reason' IS DISTINCT FROM 'raw_side_identity_missing'
     OR (rows->0->>'signed_amount')::numeric IS DISTINCT FROM -7
     OR (rows->1->>'signed_amount')::numeric IS DISTINCT FROM 7 THEN
    RAISE EXCEPTION 'S7_0140_RAW_SIDE_LOSS';
  END IF;
  FOREACH col IN ARRAY ARRAY['chip_balance','rake_wallet','bbj_wallet','promo_wallet','insurance_wallet','spin_reserve_wallet'] LOOP
    leg.to_label := 'union_wallets.'||col;
    SELECT jsonb_agg(value ORDER BY value->>'side') INTO rows
      FROM smarter_private.s7_union_raw_sides_0140(leg,'{"proved":true}'::jsonb) AS value;
    IF jsonb_array_length(rows) IS DISTINCT FROM 2
     OR (SELECT count(*) FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='from') IS DISTINCT FROM 1::bigint
     OR (SELECT count(*) FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='to') IS DISTINCT FROM 1::bigint THEN
     RAISE EXCEPTION 'S7_0143_EXACT_SIDE_CARDINALITY_02';
    END IF;
    SELECT value INTO r FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='to';
    IF r->>'status' IS DISTINCT FROM 'unresolved' OR r->'logical_union_id' IS DISTINCT FROM 'null'::jsonb
       OR r->'proved_provenance' IS DISTINCT FROM 'null'::jsonb OR r->'remainder_count' IS DISTINCT FROM 'null'::jsonb
       OR r->>'candidate_column' IS DISTINCT FROM leg.to_label THEN
      RAISE EXCEPTION 'S7_0140_CALLER_CONTEXT_PROMOTED';
    END IF;
  END LOOP;
  leg.to_type:='insurance_bank';leg.to_label:='union_wallets.insurance_wallet';
  SELECT jsonb_agg(value ORDER BY value->>'side') INTO rows
    FROM smarter_private.s7_union_raw_sides_0140(leg,NULL) AS value;
  IF jsonb_array_length(rows) IS DISTINCT FROM 2
   OR (SELECT count(*) FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='from') IS DISTINCT FROM 1::bigint
   OR (SELECT count(*) FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='to') IS DISTINCT FROM 1::bigint THEN
   RAISE EXCEPTION 'S7_0143_EXACT_SIDE_CARDINALITY_03';
  END IF;
  SELECT value INTO r FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='to';
  IF r->>'status' IS DISTINCT FROM 'unsupported' THEN RAISE EXCEPTION 'S7_0140_ALIAS_WIDENED'; END IF;
  leg.to_type:='union_wallet';leg.from_entity_id:=leg.to_entity_id;leg.amount:=0;
  SELECT jsonb_agg(value ORDER BY value->>'side') INTO rows
    FROM smarter_private.s7_union_raw_sides_0140(leg,NULL) AS value;
  IF jsonb_array_length(rows) IS DISTINCT FROM 2
   OR (SELECT count(*) FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='from') IS DISTINCT FROM 1::bigint
   OR (SELECT count(*) FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='to') IS DISTINCT FROM 1::bigint THEN
   RAISE EXCEPTION 'S7_0143_EXACT_SIDE_CARDINALITY_04';
  END IF;
  IF jsonb_array_length(rows) IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'S7_0140_OPPOSING_ZERO_SIDES_COLLAPSED'; END IF;

  -- Full raw metadata round-trip on each independently retained side.
  leg.id:='00000000-0000-0000-0000-000000000001';
  leg.from_type:='union_bank';leg.to_type:='union_wallet';
  leg.from_label:='union_wallets.chip_balance';leg.to_label:='union_wallets.rake_wallet';
  leg.from_entity_id:='00000000-0000-0000-0000-000000000002';
  leg.to_entity_id:='00000000-0000-0000-0000-000000000003';
  leg.union_id:='00000000-0000-0000-0000-000000000004';leg.amount:=-7;
  SELECT jsonb_agg(value ORDER BY value->>'side') INTO rows
    FROM smarter_private.s7_union_raw_sides_0140(leg,ctx) AS value;
  IF jsonb_array_length(rows) IS DISTINCT FROM 2
   OR (SELECT count(*) FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='from') IS DISTINCT FROM 1::bigint
   OR (SELECT count(*) FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='to') IS DISTINCT FROM 1::bigint THEN
   RAISE EXCEPTION 'S7_0143_EXACT_SIDE_CARDINALITY_05';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(rows) AS value LOOP
    IF item->>'contract' IS DISTINCT FROM 's7_union_side_inert_0140'
       OR item->'ledger_id' IS DISTINCT FROM to_jsonb(leg.id)
       OR item->'contextual_union_id' IS DISTINCT FROM to_jsonb(leg.union_id)
       OR item->'unverified_context' IS DISTINCT FROM ctx
       OR item->>'window_coverage' IS DISTINCT FROM 'unknown'
       OR item->'remainder_count' IS DISTINCT FROM 'null'::jsonb
       OR item->'logical_union_id' IS DISTINCT FROM 'null'::jsonb
       OR item->'proved_provenance' IS DISTINCT FROM 'null'::jsonb
       OR item->>'status' IS DISTINCT FROM 'unresolved'
       OR item->>'reason' IS DISTINCT FROM 'immutable_producer_side_join_missing' THEN
      RAISE EXCEPTION 'S7_0142_RAW_CONTEXT_OR_AUTHORITY';
    END IF;
    IF item->>'side'='from' THEN
      IF item->>'original_type' IS DISTINCT FROM 'union_bank'
       OR item->'original_endpoint' IS DISTINCT FROM to_jsonb(leg.from_entity_id)
       OR item->>'original_label' IS DISTINCT FROM leg.from_label
       OR item->>'other_label' IS DISTINCT FROM leg.to_label
       OR item->>'candidate_type' IS DISTINCT FROM 'union_bank'
       OR item->>'candidate_column' IS DISTINCT FROM leg.from_label
       OR item->'signed_amount' IS DISTINCT FROM '7'::jsonb THEN RAISE EXCEPTION 'S7_0142_FROM_METADATA'; END IF;
    ELSIF item->>'side'='to' THEN
      IF item->>'original_type' IS DISTINCT FROM 'union_wallet'
       OR item->'original_endpoint' IS DISTINCT FROM to_jsonb(leg.to_entity_id)
       OR item->>'original_label' IS DISTINCT FROM leg.to_label
       OR item->>'other_label' IS DISTINCT FROM leg.from_label
       OR item->>'candidate_type' IS DISTINCT FROM 'union_wallet'
       OR item->>'candidate_column' IS DISTINCT FROM leg.to_label
       OR item->'signed_amount' IS DISTINCT FROM '-7'::jsonb THEN RAISE EXCEPTION 'S7_0142_TO_METADATA'; END IF;
    ELSE RAISE EXCEPTION 'S7_0142_UNKNOWN_SIDE'; END IF;
  END LOOP;
  FOREACH col IN ARRAY ARRAY['chip_balance','rake_wallet','bbj_wallet','promo_wallet','insurance_wallet','spin_reserve_wallet'] LOOP
    leg.to_label:='union_wallets.'||col;
    SELECT jsonb_agg(value ORDER BY value->>'side') INTO rows
      FROM smarter_private.s7_union_raw_sides_0140(leg,ctx) AS value;
    IF jsonb_array_length(rows) IS DISTINCT FROM 2
     OR (SELECT count(*) FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='from') IS DISTINCT FROM 1::bigint
     OR (SELECT count(*) FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='to') IS DISTINCT FROM 1::bigint THEN
     RAISE EXCEPTION 'S7_0143_EXACT_SIDE_CARDINALITY_06';
    END IF;
    SELECT value INTO item FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='to';
    IF item->>'candidate_type' IS DISTINCT FROM CASE WHEN col='chip_balance' THEN 'union_bank' ELSE 'union_wallet' END THEN
      RAISE EXCEPTION 'S7_0142_CANONICAL_TYPE_HINT';
    END IF;
  END LOOP;
  leg.amount:=0;
  SELECT jsonb_agg(value ORDER BY value->>'side') INTO rows
    FROM smarter_private.s7_union_raw_sides_0140(leg,NULL) AS value;
  IF jsonb_array_length(rows) IS DISTINCT FROM 2
   OR (SELECT count(*) FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='from') IS DISTINCT FROM 1::bigint
   OR (SELECT count(*) FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='to') IS DISTINCT FROM 1::bigint THEN
   RAISE EXCEPTION 'S7_0143_EXACT_SIDE_CARDINALITY_07';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(rows) AS value LOOP
    IF item->'signed_amount' IS DISTINCT FROM '0'::jsonb OR item->'unverified_context' IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION 'S7_0142_ZERO_OR_NULL_CONTEXT';
    END IF;
  END LOOP;
  leg.from_entity_id:=NULL;leg.to_entity_id:=NULL;
  SELECT jsonb_agg(value ORDER BY value->>'side') INTO rows
    FROM smarter_private.s7_union_raw_sides_0140(leg,NULL) AS value;
  IF jsonb_array_length(rows) IS DISTINCT FROM 2
   OR (SELECT count(*) FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='from') IS DISTINCT FROM 1::bigint
   OR (SELECT count(*) FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='to') IS DISTINCT FROM 1::bigint THEN
   RAISE EXCEPTION 'S7_0143_EXACT_SIDE_CARDINALITY_08';
  END IF;
  IF jsonb_array_length(rows) IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'S7_0142_BOTH_NULL_SIDE_COUNT'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(rows) LOOP
    IF item->'original_endpoint' IS DISTINCT FROM 'null'::jsonb OR item->>'status' IS DISTINCT FROM 'unresolved'
      OR item->>'reason' IS DISTINCT FROM 'raw_side_identity_missing' THEN RAISE EXCEPTION 'S7_0142_BOTH_NULL_LOST'; END IF;
  END LOOP;
  leg.from_entity_id:='00000000-0000-0000-0000-000000000002';leg.to_entity_id:=leg.from_entity_id;leg.id:=NULL;
  SELECT jsonb_agg(value ORDER BY value->>'side') INTO rows
    FROM smarter_private.s7_union_raw_sides_0140(leg,NULL) AS value;
  IF jsonb_array_length(rows) IS DISTINCT FROM 2
   OR (SELECT count(*) FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='from') IS DISTINCT FROM 1::bigint
   OR (SELECT count(*) FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='to') IS DISTINCT FROM 1::bigint THEN
   RAISE EXCEPTION 'S7_0143_EXACT_SIDE_CARDINALITY_09';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(rows) AS value LOOP
    IF item->'ledger_id' IS DISTINCT FROM 'null'::jsonb OR item->>'status' IS DISTINCT FROM 'unresolved' OR item->>'reason' IS DISTINCT FROM 'raw_side_identity_missing' THEN
      RAISE EXCEPTION 'S7_0142_MISSING_LEDGER';
    END IF;
  END LOOP;
  leg.id:='00000000-0000-0000-0000-000000000001';leg.to_type:=NULL;
  SELECT jsonb_agg(value ORDER BY value->>'side') INTO rows
    FROM smarter_private.s7_union_raw_sides_0140(leg,NULL) AS value;
  IF jsonb_array_length(rows) IS DISTINCT FROM 2
   OR (SELECT count(*) FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='from') IS DISTINCT FROM 1::bigint
   OR (SELECT count(*) FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='to') IS DISTINCT FROM 1::bigint THEN
   RAISE EXCEPTION 'S7_0143_EXACT_SIDE_CARDINALITY_10';
  END IF;
  SELECT value INTO item FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='to';
  IF item->'original_type' IS DISTINCT FROM 'null'::jsonb OR item->>'status' IS DISTINCT FROM 'unresolved'
    OR item->>'reason' IS DISTINCT FROM 'raw_side_identity_missing' THEN RAISE EXCEPTION 'S7_0142_MISSING_TYPE'; END IF;
  leg.to_type:='player_wallet';leg.to_label:='club_members.chip_balance';
  SELECT jsonb_agg(value ORDER BY value->>'side') INTO rows
    FROM smarter_private.s7_union_raw_sides_0140(leg,NULL) AS value;
  IF jsonb_array_length(rows) IS DISTINCT FROM 2
   OR (SELECT count(*) FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='from') IS DISTINCT FROM 1::bigint
   OR (SELECT count(*) FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='to') IS DISTINCT FROM 1::bigint THEN
   RAISE EXCEPTION 'S7_0143_EXACT_SIDE_CARDINALITY_11';
  END IF;
  SELECT value INTO item FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='to';
  IF item->>'status' IS DISTINCT FROM 'outside_union_scope'
   OR item->>'reason' IS DISTINCT FROM 'preserve_existing_nonunion_path'
   OR item->'candidate_type' IS DISTINCT FROM 'null'::jsonb
   OR item->'candidate_column' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'S7_0142_NONUNION_CHANGED'; END IF;
  FOREACH typ IN ARRAY ARRAY['union_bank','promo_wallet','insurance_bank','player_wallet'] LOOP
    leg.to_type:=typ;leg.to_label:='union_wallets.rake_wallet';
    SELECT jsonb_agg(value ORDER BY value->>'side') INTO rows
      FROM smarter_private.s7_union_raw_sides_0140(leg,ctx) AS value;
    IF jsonb_array_length(rows) IS DISTINCT FROM 2
     OR (SELECT count(*) FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='from') IS DISTINCT FROM 1::bigint
     OR (SELECT count(*) FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='to') IS DISTINCT FROM 1::bigint THEN
     RAISE EXCEPTION 'S7_0143_EXACT_SIDE_CARDINALITY_12';
    END IF;
    SELECT value INTO item FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='to';
    IF item->>'status' IS DISTINCT FROM 'unsupported' OR item->'candidate_type' IS DISTINCT FROM 'null'::jsonb
      OR item->>'reason' IS DISTINCT FROM 'type_column_or_alias_unproved' THEN RAISE EXCEPTION 'S7_0142_UNSUPPORTED_PAIR'; END IF;
  END LOOP;
  leg.to_type:='union_wallet';leg.to_label:='union_wallets.unknown';
  SELECT jsonb_agg(value ORDER BY value->>'side') INTO rows
    FROM smarter_private.s7_union_raw_sides_0140(leg,NULL) AS value;
  IF jsonb_array_length(rows) IS DISTINCT FROM 2
   OR (SELECT count(*) FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='from') IS DISTINCT FROM 1::bigint
   OR (SELECT count(*) FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='to') IS DISTINCT FROM 1::bigint THEN
   RAISE EXCEPTION 'S7_0143_EXACT_SIDE_CARDINALITY_13';
  END IF;
  SELECT value INTO item FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='to';
  IF item->>'status' IS DISTINCT FROM 'unsupported' OR item->'candidate_column' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'S7_0142_UNKNOWN_COLUMN';
  END IF;
  leg.to_type:='promo_wallet';leg.to_label:='union_wallets.promo_wallet';
  SELECT jsonb_agg(value ORDER BY value->>'side') INTO rows
    FROM smarter_private.s7_union_raw_sides_0140(leg,ctx) AS value;
  IF jsonb_array_length(rows) IS DISTINCT FROM 2
   OR (SELECT count(*) FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='from') IS DISTINCT FROM 1::bigint
   OR (SELECT count(*) FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='to') IS DISTINCT FROM 1::bigint THEN
   RAISE EXCEPTION 'S7_0143_EXACT_SIDE_CARDINALITY_14';
  END IF;
  SELECT value INTO item FROM jsonb_array_elements(rows) AS value WHERE value->>'side'='to';
  IF item->>'status' IS DISTINCT FROM 'unresolved' OR item->>'candidate_type' IS DISTINCT FROM 'union_wallet'
   OR item->'logical_union_id' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'S7_0142_PROMO_ALIAS_PROOF'; END IF;
END
$cases$;
