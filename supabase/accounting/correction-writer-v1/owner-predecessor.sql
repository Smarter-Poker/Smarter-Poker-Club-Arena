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

  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
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

  -- replay-safe: the same linkage posts at most one correction
  SELECT id INTO v_existing FROM public.chip_ledger WHERE idempotency_key = v_key;
  IF v_existing IS NOT NULL THEN
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

  IF p_incident_id IS NOT NULL THEN
    UPDATE public.ca_drift_incidents
       SET correction_ref = COALESCE(correction_ref, 'chip_ledger ' || v_id::text)
     WHERE id = p_incident_id;
    INSERT INTO public.ca_incident_events (incident_id, kind, actor, detail)
    VALUES (p_incident_id, 'repair_action', v_uid,
            jsonb_build_object('correction_posted', v_id, 'amount', p_amount,
                               'from', p_from_type, 'to', p_to_type));
  END IF;

  RETURN jsonb_build_object('ok', true, 'replayed', false, 'ledger_id', v_id);
END $function$
