-- SOURCE CANDIDATE ONLY; requires coordinated protected admission.
CREATE OR REPLACE FUNCTION public.fn_ca_post_correction(p_from_type text, p_from_entity uuid, p_to_type text, p_to_entity uuid, p_amount numeric, p_reason text, p_incident_id uuid DEFAULT NULL::uuid, p_write_failure_id bigint DEFAULT NULL::bigint, p_club_id uuid DEFAULT NULL::uuid, p_union_id uuid DEFAULT NULL::uuid, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_mgmt boolean := false;
  v_key text;
  v_id uuid;
  v_existing uuid;
  v_intent jsonb;
  v_prior_intent jsonb;
  v_prior_ledger uuid;
  v_expected_ref text;
  v_event_id bigint;
  v_event_detail jsonb;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.ca_incident_recipients r WHERE r.user_id = v_uid AND r.active
      UNION ALL
      SELECT 1 FROM public.profiles p WHERE p.id = v_uid AND p.role IN ('admin','god')
    ) INTO v_mgmt;
    IF NOT v_mgmt THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'management_only');
    END IF;
  END IF;

  IF p_amount IS NULL OR p_amount::text IN ('NaN', 'Infinity', '-Infinity')
     OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'amount_must_be_positive_cents');
  END IF;
  IF COALESCE(btrim(p_reason), '') = '' OR length(p_reason) < 20 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'a_correction_needs_a_real_reason');
  END IF;

  -- THE LINKAGE RULE: no correction without a live reference to what it fixes.
  IF p_incident_id IS NULL AND p_write_failure_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'linkage_required_incident_or_write_failure');
  END IF;
  IF p_incident_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.ca_drift_incidents WHERE id = p_incident_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'incident_not_found');
  END IF;
  IF p_write_failure_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.ca_ledger_write_failures WHERE id = p_write_failure_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'write_failure_not_found');
  END IF;

  v_key := 'correction:' || COALESCE('lwf:' || p_write_failure_id::text,
                                     'inc:' || p_incident_id::text);

  -- Version 1 compares full typed intent, not the truncated ledger projection.
  -- JSONB object key order / numeric scale are semantic; SQL NULL metadata is
  -- deliberately distinct from JSON null and from an explicit empty object.
  v_intent := jsonb_build_object(
    'version', 1, 'actor_uid', v_uid,
    'from_type', p_from_type, 'from_entity', p_from_entity,
    'to_type', p_to_type, 'to_entity', p_to_entity,
    'amount', p_amount, 'reason', p_reason,
    'incident_id', p_incident_id, 'write_failure_id', p_write_failure_id,
    'club_id', p_club_id, 'union_id', p_union_id,
    'metadata_sql_null', p_metadata IS NULL, 'metadata', p_metadata);

  SELECT id INTO v_existing FROM public.chip_ledger WHERE idempotency_key = v_key;
  IF v_existing IS NOT NULL THEN
    SELECT request_intent, ledger_id INTO v_prior_intent, v_prior_ledger
      FROM public.ca_correction_request_intents_v1 WHERE linkage_key = v_key;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'legacy_correction_intent_unavailable');
    END IF;
    IF v_prior_ledger IS DISTINCT FROM v_existing THEN
      RAISE EXCEPTION 'correction_intent_ledger_mismatch';
    END IF;
    IF v_prior_intent IS DISTINCT FROM v_intent THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'correction_intent_conflict');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.chip_ledger l
      WHERE l.id = v_existing AND l.idempotency_key = v_key
        AND l.status IS NOT DISTINCT FROM 'posted'
        AND l.performed_by IS NOT DISTINCT FROM
          COALESCE(v_uid, '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid)
        AND l.from_type IS NOT DISTINCT FROM p_from_type
        AND l.from_entity_id IS NOT DISTINCT FROM p_from_entity
        AND l.to_type IS NOT DISTINCT FROM p_to_type
        AND l.to_entity_id IS NOT DISTINCT FROM p_to_entity
        AND l.amount IS NOT DISTINCT FROM p_amount
        AND l.category IS NOT DISTINCT FROM 'correction'
        AND l.club_id IS NOT DISTINCT FROM p_club_id
        AND l.union_id IS NOT DISTINCT FROM p_union_id
        AND l.description IS NOT DISTINCT FROM left(p_reason, 900)
        AND l.metadata IS NOT DISTINCT FROM
          (COALESCE(p_metadata, '{}'::jsonb)
           || jsonb_build_object('incident_id', p_incident_id,
                                 'write_failure_id', p_write_failure_id,
                                 'posted_via', 'fn_ca_post_correction'))) THEN
      RAISE EXCEPTION 'correction_ledger_projection_mismatch';
    END IF;
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'ledger_id', v_existing);
  END IF;

  INSERT INTO public.chip_ledger
    (performed_by, from_type, from_entity_id, to_type, to_entity_id,
     amount, category, club_id, union_id, description, idempotency_key, metadata)
  VALUES
    (COALESCE(v_uid, '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
     p_from_type, p_from_entity, p_to_type, p_to_entity,
     p_amount, 'correction', p_club_id, p_union_id,
     left(p_reason, 900), v_key,
     COALESCE(p_metadata, '{}'::jsonb)
       || jsonb_build_object('incident_id', p_incident_id,
                             'write_failure_id', p_write_failure_id,
                             'posted_via', 'fn_ca_post_correction'))
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN RAISE EXCEPTION 'correction_ledger_insert_missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.chip_ledger l
    WHERE l.id = v_id AND l.idempotency_key = v_key
      AND l.status IS NOT DISTINCT FROM 'posted'
      AND l.performed_by IS NOT DISTINCT FROM
        COALESCE(v_uid, '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid)
      AND l.from_type IS NOT DISTINCT FROM p_from_type
      AND l.from_entity_id IS NOT DISTINCT FROM p_from_entity
      AND l.to_type IS NOT DISTINCT FROM p_to_type
      AND l.to_entity_id IS NOT DISTINCT FROM p_to_entity
      AND l.amount IS NOT DISTINCT FROM p_amount
      AND l.category IS NOT DISTINCT FROM 'correction'
      AND l.club_id IS NOT DISTINCT FROM p_club_id
      AND l.union_id IS NOT DISTINCT FROM p_union_id
      AND l.description IS NOT DISTINCT FROM left(p_reason, 900)
      AND l.metadata IS NOT DISTINCT FROM
        (COALESCE(p_metadata, '{}'::jsonb)
         || jsonb_build_object('incident_id', p_incident_id,
                               'write_failure_id', p_write_failure_id,
                               'posted_via', 'fn_ca_post_correction'))) THEN
    RAISE EXCEPTION 'correction_ledger_projection_mismatch';
  END IF;

  IF p_incident_id IS NOT NULL THEN
    -- Lock the same incident row the following UPDATE already owns. Freeze
    -- the preexisting reference so a trigger cannot silently replace it.
    SELECT COALESCE(correction_ref, 'chip_ledger ' || v_id::text)
      INTO v_expected_ref FROM public.ca_drift_incidents
      WHERE id = p_incident_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'correction_incident_missing'; END IF;
    UPDATE public.ca_drift_incidents
       SET correction_ref = COALESCE(correction_ref, 'chip_ledger ' || v_id::text)
     WHERE id = p_incident_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'correction_incident_update_missing'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.ca_drift_incidents
      WHERE id = p_incident_id AND correction_ref IS NOT DISTINCT FROM v_expected_ref) THEN
      RAISE EXCEPTION 'correction_incident_reference_mismatch';
    END IF;
    v_event_detail := jsonb_build_object('correction_posted', v_id, 'amount', p_amount,
                                        'from', p_from_type, 'to', p_to_type);
    INSERT INTO public.ca_incident_events (incident_id, kind, actor, detail)
    VALUES (p_incident_id, 'repair_action', v_uid, v_event_detail)
    RETURNING id INTO v_event_id;
    IF v_event_id IS NULL THEN RAISE EXCEPTION 'correction_incident_event_missing'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.ca_incident_events
      WHERE id = v_event_id AND incident_id = p_incident_id
        AND kind = 'repair_action' AND actor IS NOT DISTINCT FROM v_uid
        AND detail IS NOT DISTINCT FROM v_event_detail) THEN
      RAISE EXCEPTION 'correction_incident_event_mismatch';
    END IF;
  END IF;

  -- Same transaction as the original ledger, overlays, documents and incident.
  -- A duplicate/failed/suppressed intent insert must never commit uncovered work.
  IF v_id IS NULL THEN RAISE EXCEPTION 'correction_ledger_insert_missing'; END IF;
  INSERT INTO public.ca_correction_request_intents_v1(linkage_key, ledger_id, request_intent)
    VALUES (v_key, v_id, v_intent);
  IF NOT FOUND THEN RAISE EXCEPTION 'correction_intent_insert_missing'; END IF;

  IF NOT EXISTS (SELECT 1 FROM public.ca_correction_request_intents_v1
    WHERE linkage_key = v_key AND ledger_id = v_id
      AND request_intent IS NOT DISTINCT FROM v_intent) THEN
    RAISE EXCEPTION 'correction_intent_retained_mismatch';
  END IF;

  RETURN jsonb_build_object('ok', true, 'replayed', false, 'ledger_id', v_id);
END $function$;
