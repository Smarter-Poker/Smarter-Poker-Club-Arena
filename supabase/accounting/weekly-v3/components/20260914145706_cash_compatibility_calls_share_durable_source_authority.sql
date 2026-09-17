-- Compatibility callers share the durable cash source authority. The inner
-- whole-hand liability writer remains private to it; no new formula or payer.
-- Refused legacy calls raise: their old void/success-only callers cannot
-- distinguish a durable refusal from a successful financial operation.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $guard$ BEGIN
 IF md5(pg_get_functiondef('public.credit_agent_commission_from_rake(uuid,uuid,numeric,text,uuid,text)'::regprocedure))<>'5d3eeb5f5f261449ffb11df640c18d66'
 OR md5(pg_get_functiondef('public.calculate_cascading_commission(uuid,uuid,uuid,numeric,uuid,uuid)'::regprocedure))<>'efff8097caf387d175fe1003327f5a99'
 OR md5(pg_get_functiondef('public.fn_process_cash_accounting_source(uuid)'::regprocedure))<>'4269a18e6fd4e0b9616663f18b40e516'
 OR md5(pg_get_functiondef('public.fn_accrue_cash_hand_commissions(uuid)'::regprocedure))<>'5924f6c736ee21d0e23ef5febbba6391'
 THEN RAISE EXCEPTION 'cash compatibility authority changed since review'; END IF;
END $guard$;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes) VALUES
 ('credit_agent_commission_from_rake','approved','Legacy service cash inputs delegate the same durable source authority and require a successful accrued receipt. Existing noncash branch unchanged. Source failure raises so void callers cannot misreport success.'),
 ('calculate_cascading_commission','approved','Legacy service hand compatibility delegates the same durable source authority and requires a successful accrued receipt. No independent amount or rate calculation.')
 ON CONFLICT(proname) DO UPDATE SET status=EXCLUDED.status,notes=EXCLUDED.notes;
CREATE OR REPLACE FUNCTION public.credit_agent_commission_from_rake(p_agent_user_id uuid, p_club_id uuid, p_rake_credit numeric, p_source_type text DEFAULT 'rake_settlement'::text, p_source_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_source_record uuid;
  v_source_result jsonb;
  v_agent_id          UUID;
  v_agent_user_id     UUID;
  v_commission_rate   NUMERIC;
  v_parent_agent_id   UUID;
  v_parent_user_id    UUID;
  v_parent_rate       NUMERIC;
  v_direct_commission NUMERIC;
  v_parent_commission NUMERIC;
  v_remaining         NUMERIC;
  v_book_club         UUID;
  v_inserted_direct   INTEGER := 0;
BEGIN
  IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
  IF p_source_type='rake_settlement' THEN
    IF p_source_id IS NULL THEN RAISE EXCEPTION 'cash_hand_id_required' USING ERRCODE='22023'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.rake_records r JOIN public.rake_attributions a ON a.rake_record_id=r.id AND a.hand_id=r.hand_id
      WHERE r.hand_id=p_source_id AND a.player_id=p_agent_user_id AND a.weighted_rake_credit=p_rake_credit
       AND (a.club_id=p_club_id OR r.club_id=p_club_id)) THEN
      RAISE EXCEPTION 'cash_commission_call_disagrees_with_source' USING ERRCODE='23514'; END IF;
    SELECT id INTO STRICT v_source_record FROM public.rake_records WHERE hand_id=p_source_id;
    v_source_result:=public.fn_process_cash_accounting_source(v_source_record);
    IF v_source_result->>'status' IS DISTINCT FROM 'accrued'
     OR v_source_result->>'recorded' IS DISTINCT FROM 'true'
     OR v_source_result->>'receipt_version' IS DISTINCT FROM '3' THEN
      RAISE EXCEPTION 'cash_source_requires_reconciliation' USING ERRCODE='55000',DETAIL=v_source_result::text;
    END IF;
    RETURN;
  END IF;
  IF p_source_type IS DISTINCT FROM 'tournament_rake_settlement' OR p_source_id IS NULL THEN
    RAISE EXCEPTION 'unsupported_commission_source' USING ERRCODE='23514'; END IF;
  -- Tournament settlement remains its existing source caller. Historical
  -- tournament allocation is not certified by this cash-only change.
  -- UNION LAW: the agent follows the PLAYER's club, not the table's club.
  v_book_club := public.fn_resolve_player_club_for_agent(p_agent_user_id, p_club_id, NULL);

  SELECT a.id, a.user_id, a.commission_rate, a.parent_agent_id
    INTO v_agent_id, v_agent_user_id, v_commission_rate, v_parent_agent_id
    FROM club_members cm
    JOIN agents a ON a.user_id = cm.agent_id AND a.club_id = cm.club_id AND a.status = 'active'
   WHERE cm.user_id = p_agent_user_id AND cm.club_id = v_book_club
   LIMIT 1;

  -- The caller may itself be an agent generating rake.
  IF v_agent_id IS NULL THEN
    SELECT id, user_id, commission_rate, parent_agent_id
      INTO v_agent_id, v_agent_user_id, v_commission_rate, v_parent_agent_id
      FROM agents WHERE user_id = p_agent_user_id AND status = 'active'
     ORDER BY (club_id = v_book_club) DESC
     LIMIT 1;
  END IF;

  IF v_agent_id IS NULL THEN RETURN; END IF;

  -- Idempotency is per AGENT and source, never per source alone: a hand has
  -- one row per agent in the chain of every contributing player, and only a
  -- retry for the same agent returns here (Chip Standard P4, lane 2.2).
  IF p_source_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM agent_commissions
     WHERE source_id = p_source_id AND source_type = p_source_type
       AND user_id = v_agent_user_id
     LIMIT 1
  ) THEN
    RETURN;
  END IF;

  v_direct_commission := ROUND(p_rake_credit * COALESCE(v_commission_rate, 0), 2);
  v_remaining         := p_rake_credit - v_direct_commission;

  IF v_direct_commission > 0 THEN
    INSERT INTO agent_commissions (
      club_id, user_id, amount, commission_rate, source_type, source_id, notes
    ) VALUES (
      COALESCE(v_book_club, p_club_id), v_agent_user_id, v_direct_commission, v_commission_rate,
      p_source_type, p_source_id, COALESCE(p_notes, 'agent slice (accrual)')
    )
    ON CONFLICT (user_id, source_id, source_type) WHERE source_id IS NOT NULL
    DO NOTHING;
    GET DIAGNOSTICS v_inserted_direct = ROW_COUNT;

    IF v_inserted_direct > 0 THEN
      UPDATE agents SET
        weekly_rake_generated   = COALESCE(weekly_rake_generated, 0)   + p_rake_credit,
        lifetime_rake_generated = COALESCE(lifetime_rake_generated, 0) + p_rake_credit,
        last_active_at          = NOW(),
        updated_at              = NOW()
      WHERE id = v_agent_id;
    END IF;
  END IF;

  -- Super-agent override on the downstream volume (PokerBros model).
  IF v_parent_agent_id IS NOT NULL AND v_remaining > 0 THEN
    SELECT id, user_id, commission_rate
      INTO v_parent_agent_id, v_parent_user_id, v_parent_rate
      FROM agents WHERE id = v_parent_agent_id AND status = 'active'
     LIMIT 1;

    IF v_parent_agent_id IS NOT NULL AND v_parent_rate IS NOT NULL THEN
      v_parent_commission := ROUND(v_remaining * v_parent_rate, 2);
      IF v_parent_commission > 0 THEN
        INSERT INTO agent_commissions (
          club_id, user_id, amount, commission_rate, source_type, source_id, notes
        ) VALUES (
          COALESCE(v_book_club, p_club_id), v_parent_user_id, v_parent_commission, v_parent_rate,
          p_source_type, p_source_id, 'super-agent slice (accrual)'
        )
        ON CONFLICT (user_id, source_id, source_type) WHERE source_id IS NOT NULL
        DO NOTHING;
      END IF;
    END IF;
  END IF;
END;
$function$;
CREATE OR REPLACE FUNCTION public.calculate_cascading_commission(p_hand_id uuid DEFAULT NULL,p_club_id uuid DEFAULT NULL,p_player_user_id uuid DEFAULT NULL,p_rake_amount numeric DEFAULT 0,p_rake_record_id uuid DEFAULT NULL,p_table_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE source public.rake_records%ROWTYPE;result jsonb;
BEGIN
 IF NOT public.fn_caller_is_engine() THEN RAISE EXCEPTION 'service_role_required' USING ERRCODE='42501'; END IF;
 IF p_rake_record_id IS NOT NULL THEN
  SELECT * INTO source FROM public.rake_records WHERE id=p_rake_record_id;
 ELSE
  IF p_hand_id IS NULL THEN RAISE EXCEPTION 'cash_hand_id_required' USING ERRCODE='22023'; END IF;
  SELECT * INTO STRICT source FROM public.rake_records WHERE hand_id=p_hand_id;
 END IF;
 IF source.id IS NULL OR source.hand_id IS NULL OR (p_hand_id IS NOT NULL AND p_hand_id<>source.hand_id)
  OR (p_table_id IS NOT NULL AND p_table_id IS DISTINCT FROM source.table_id)
  OR (p_club_id IS NOT NULL AND p_club_id<>source.club_id AND NOT EXISTS(
   SELECT 1 FROM public.rake_attributions WHERE rake_record_id=source.id AND club_id=p_club_id))
  OR (p_player_user_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.rake_attributions
   WHERE rake_record_id=source.id AND player_id=p_player_user_id)) THEN
  RAISE EXCEPTION 'cash_commission_source_mismatch' USING ERRCODE='23514'; END IF;
 -- The caller's amount is never a financial basis. The durable source owns
 -- every player's original share and the observed hierarchy agreement.
 result:=public.fn_process_cash_accounting_source(source.id);
 IF result->>'status' IS DISTINCT FROM 'accrued' OR result->>'recorded' IS DISTINCT FROM 'true'
  OR result->>'receipt_version' IS DISTINCT FROM '3' THEN
  RAISE EXCEPTION 'cash_source_requires_reconciliation' USING ERRCODE='55000',DETAIL=result::text;
 END IF;
 RETURN result||jsonb_build_object('success',true);
END $function$;
REVOKE ALL ON FUNCTION public.fn_accrue_cash_hand_commissions(uuid),public.credit_agent_commission_from_rake(uuid,uuid,numeric,text,uuid,text),public.calculate_cascading_commission(uuid,uuid,uuid,numeric,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.credit_agent_commission_from_rake(uuid,uuid,numeric,text,uuid,text),public.calculate_cascading_commission(uuid,uuid,uuid,numeric,uuid,uuid) TO service_role;
COMMIT;
