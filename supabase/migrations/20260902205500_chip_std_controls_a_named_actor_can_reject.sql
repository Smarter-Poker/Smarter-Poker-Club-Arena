-- ═══════════════════════════════════════════════════════════════════════════════
--  A NAMED SERVICE ACTOR CAN REJECT A PROPOSAL
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Found by the rolled-back probe of the four-eyes register, minutes after
-- 20260902203000_chip_std_controls applied. fn_ca_reject_manual_adjustment
-- resolves the proposal's board row with resolved_by = the rejecter, and
-- financial_alerts.resolved_by is a foreign key to auth.users. A rejecter
-- passed as a named service actor (the brief's "approver = auth.uid() or a
-- named service actor") is not an auth user, so the reject raised
-- 23503 and rolled back the rejection with it.
--
-- The board row now resolves with resolved_by = auth.uid() (NULL for a
-- service caller, which the column allows); who rejected is on the
-- ca_manual_adjustments row itself (rejected_by, decision_note). Nothing else
-- changes. fn_ca_clear_payout_freeze already used auth.uid() there.
--
-- One CREATE OR REPLACE, one transaction, one PostgREST reload.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_reject_manual_adjustment(
  p_id             uuid,
  p_note           text,
  p_rejecter       uuid DEFAULT NULL,
  p_rejecter_label text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rejecter uuid := COALESCE(p_rejecter, auth.uid());
  v_label    text := COALESCE(NULLIF(btrim(p_rejecter_label), ''),
                              NULLIF(current_setting('application_name', true), ''),
                              session_user::text);
  v_row      public.ca_manual_adjustments%ROWTYPE;
BEGIN
  IF NOT public.fn_ca_caller_is_management() THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'not_management');
  END IF;
  IF v_rejecter IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'rejecter_required');
  END IF;

  UPDATE public.ca_manual_adjustments
     SET status = 'rejected', rejected_by = v_rejecter, rejected_at = now(),
         decision_note = NULLIF(btrim(p_note), '')
   WHERE id = p_id AND status = 'proposed'
   RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'not_proposed', 'adjustment_id', p_id);
  END IF;

  -- resolved_by references auth.users; a named service actor is not one.
  UPDATE public.financial_alerts
     SET resolved = true, resolved_at = now(), resolved_by = auth.uid()
   WHERE source = 'ca_manual_adjustments'
     AND resolved IS NOT TRUE
     AND context ->> 'dedupe_key' = 'adj:' || p_id::text;

  RETURN jsonb_build_object('ok', true, 'adjustment_id', p_id, 'status', v_row.status,
    'rejected_by', v_rejecter, 'rejected_by_label', v_label, 'rejected_at', v_row.rejected_at);
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_reject_manual_adjustment(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_reject_manual_adjustment(uuid, text, uuid, text) TO service_role;

COMMIT;
