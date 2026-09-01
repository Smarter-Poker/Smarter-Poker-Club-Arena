-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").

-- ═══════════════════════════════════════════════════════════════════════════
-- HARDENING ROUND 2, PHASE 1: sanctioned corrections.
--   fn_ca_post_correction: THE one way to post a compensating ledger entry.
--     Refuses without a linkage (an incident or a write-failure reference),
--     is replay-safe (same linkage twice returns the existing row), stamps
--     the incident's correction_ref and files an incident event.
--   fn_ca_repair_write_failure: one call turns a swallowed-journal-row
--     failure into its compensating entry (suspense counterparty unless the
--     caller states the true one) and resolves the qr:lwf incident.
-- Nobody hand-writes a ledger INSERT for a correction again.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_ca_post_correction(
  p_from_type text, p_from_entity uuid,
  p_to_type text, p_to_entity uuid,
  p_amount numeric, p_reason text,
  p_incident_id uuid DEFAULT NULL,
  p_write_failure_id bigint DEFAULT NULL,
  p_club_id uuid DEFAULT NULL,
  p_union_id uuid DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb)
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
    VALUES (p_incident_id, 'commented', v_uid,
            jsonb_build_object('correction_posted', v_id, 'amount', p_amount,
                               'from', p_from_type, 'to', p_to_type));
  END IF;

  RETURN jsonb_build_object('ok', true, 'replayed', false, 'ledger_id', v_id);
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_post_correction(text, uuid, text, uuid, numeric, text, uuid, bigint, uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_post_correction(text, uuid, text, uuid, numeric, text, uuid, bigint, uuid, uuid, jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_repair_write_failure(
  p_write_failure_id bigint,
  p_counterparty_type text DEFAULT 'settlement_suspense',
  p_counterparty_entity uuid DEFAULT NULL,
  p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  f RECORD;
  v_store text;
  v_res jsonb;
  v_inc uuid;
BEGIN
  SELECT * INTO f FROM public.ca_ledger_write_failures WHERE id = p_write_failure_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'write_failure_not_found');
  END IF;

  -- map the failed writer's table.column (kept in the message prefix) to the
  -- ledger account vocabulary; unknown shapes fall back to player/club stores
  v_store := CASE
    WHEN f.message LIKE '%clubs.chip_treasury%'            THEN 'club_treasury'
    WHEN f.message LIKE '%clubs.chip_pool%'                THEN 'club_treasury'
    WHEN f.message LIKE '%clubs.promo_balance%'            THEN 'promo_wallet'
    WHEN f.message LIKE '%club_members.chip_balance%'      THEN 'player_wallet'
    WHEN f.message LIKE '%club_members.promo_balance%'     THEN 'promo_wallet'
    WHEN f.message LIKE '%club_wallets.chip_balance%'      THEN 'club_wallet'
    WHEN f.message LIKE '%union_wallets.chip_balance%'     THEN 'union_bank'
    WHEN f.message LIKE '%union_wallets.%'                 THEN 'union_wallet'
    WHEN f.message LIKE '%agents.agent_wallet_balance%'    THEN 'agent_wallet'
    WHEN f.message LIKE '%agents.promo_wallet_balance%'    THEN 'promo_wallet'
    WHEN f.message LIKE '%bbj_pools.%'                     THEN 'bbj_pool'
    WHEN f.message LIKE '%spin_bonus_pools.%'              THEN 'spin_reserve'
    WHEN f.user_id IS NOT NULL                             THEN 'player_wallet'
    ELSE 'club_treasury' END;

  SELECT id INTO v_inc FROM public.ca_drift_incidents
   WHERE dedupe_key = 'qr:lwf:' || p_write_failure_id::text
   ORDER BY detected_at DESC LIMIT 1;

  v_res := public.fn_ca_post_correction(
    CASE WHEN f.delta >= 0 THEN p_counterparty_type ELSE v_store END,
    CASE WHEN f.delta >= 0 THEN p_counterparty_entity ELSE COALESCE(f.user_id, f.club_id) END,
    CASE WHEN f.delta >= 0 THEN v_store ELSE p_counterparty_type END,
    CASE WHEN f.delta >= 0 THEN COALESCE(f.user_id, f.club_id) ELSE p_counterparty_entity END,
    abs(round(f.delta, 2)),
    COALESCE(p_reason,
      'Compensating entry for swallowed journal row (ca_ledger_write_failures '
      || p_write_failure_id::text || '): ' || left(f.message, 300)),
    v_inc, p_write_failure_id, f.club_id, NULL,
    jsonb_build_object('repaired_via', 'fn_ca_repair_write_failure',
                       'store', v_store, 'original_delta', f.delta));

  IF (v_res->>'ok')::boolean AND v_inc IS NOT NULL THEN
    PERFORM public.fn_ca_incident_action(v_inc, 'resolve',
      'Compensating entry posted via fn_ca_repair_write_failure (chip_ledger '
        || (v_res->>'ledger_id') || ').',
      NULL,
      'Swallowed journal row restored; ledger completeness re-established.',
      'chip_ledger ' || (v_res->>'ledger_id'));
  END IF;

  RETURN v_res || jsonb_build_object('incident_id', v_inc, 'store', v_store);
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_repair_write_failure(bigint, text, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_repair_write_failure(bigint, text, uuid, text) TO authenticated, service_role;

INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
SELECT v.proname, 'approved', v.notes FROM (VALUES
 ('fn_ca_post_correction', 'Hardening round 2 phase 1 (2026-09-01): THE sanctioned correction path. Management/service only, linkage to an incident or write failure required, replay-safe on the linkage key, files incident events and correction_ref.'),
 ('fn_ca_repair_write_failure', 'Hardening round 2 phase 1 (2026-09-01): one-call repair for swallowed journal rows - derives the store from the failure message, posts via fn_ca_post_correction, resolves the qr:lwf incident.')
) AS v(proname, notes)
WHERE NOT EXISTS (SELECT 1 FROM public.ca_money_rpc_registry r WHERE r.proname = v.proname);

NOTIFY pgrst, 'reload schema';;
