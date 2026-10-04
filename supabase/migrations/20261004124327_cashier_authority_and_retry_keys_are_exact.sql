-- CASHIER AUTHORITY AND RETRY KEYS ARE EXACT (20261004124327)
--
-- Browser Cashier mutation doors must reject a missing retry key and bind every
-- supplied key to one global actor/action/club/payload. Cashier authority also
-- follows the live agent status: a suspended agent cannot retain write or read
-- scope, and an inactive hierarchy edge cannot bridge an otherwise active
-- downline. One transaction produces one PostgREST schema-cache reload.

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE public.cashier_rpc_operation_intents (
  operation_id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL,
  action text NOT NULL,
  club_id uuid,
  operation_intent jsonb NOT NULL,
  intent_fingerprint text NOT NULL,
  receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CHECK (jsonb_typeof(operation_intent) = 'object'),
  CHECK (intent_fingerprint = md5(operation_intent::text))
);

ALTER TABLE public.cashier_rpc_operation_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cashier_rpc_operation_intents FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cashier_rpc_operation_intents TO service_role;

CREATE FUNCTION public.fn_cashier_member_is_active(p_club uuid, p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.club_members m
     WHERE m.club_id = p_club
       AND m.user_id = p_user
       AND coalesce(m.status, 'active') IN ('active', 'approved')
       AND (
         coalesce(m.role, 'player') NOT IN ('super_agent', 'agent', 'sub_agent')
         OR EXISTS (
           SELECT 1
             FROM public.agents a
            WHERE a.club_id = m.club_id
              AND a.user_id = m.user_id
              AND a.status = 'active'
         )
       )
  )
$function$;

REVOKE ALL ON FUNCTION public.fn_cashier_member_is_active(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cashier_member_is_active(uuid, uuid) TO service_role;

CREATE FUNCTION public.fn_club_active_cashier_edges(p_club uuid)
RETURNS TABLE(child uuid, parent uuid)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT m.user_id, m.agent_id
    FROM public.club_members m
   WHERE m.club_id = p_club
     AND m.agent_id IS NOT NULL
     AND m.agent_id <> m.user_id
     AND public.fn_cashier_member_is_active(m.club_id, m.user_id)
$function$;

REVOKE ALL ON FUNCTION public.fn_club_active_cashier_edges(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_club_active_cashier_edges(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_club_bank_role(
  p_club_id uuid,
  p_user_id uuid DEFAULT NULL
) RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN p_club_id IS NULL THEN NULL
    WHEN EXISTS (
      SELECT 1 FROM public.clubs c
       WHERE c.id = p_club_id
         AND c.owner_id = coalesce(p_user_id, auth.uid())
    ) THEN 'owner'
    ELSE (
      SELECT m.role
        FROM public.club_members m
       WHERE m.club_id = p_club_id
         AND m.user_id = coalesce(p_user_id, auth.uid())
         AND public.fn_cashier_member_is_active(m.club_id, m.user_id)
       LIMIT 1
    )
  END
$function$;

REVOKE ALL ON FUNCTION public.fn_club_bank_role(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_bank_role(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_club_is_in_downline(
  p_club_id uuid,
  p_upline_user_id uuid,
  p_member_user_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH RECURSIVE dl AS (
    SELECT e.child, 1 AS depth
      FROM public.fn_club_active_cashier_edges(p_club_id) e
     WHERE e.parent = p_upline_user_id
       AND p_upline_user_id IS NOT NULL
       AND p_member_user_id IS NOT NULL
       AND p_upline_user_id <> p_member_user_id
    UNION
    SELECT e.child, dl.depth + 1
      FROM dl
      JOIN public.fn_club_active_cashier_edges(p_club_id) e ON e.parent = dl.child
     WHERE dl.depth < 20
  )
  SELECT EXISTS (SELECT 1 FROM dl WHERE child = p_member_user_id)
$function$;

REVOKE ALL ON FUNCTION public.fn_club_is_in_downline(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_is_in_downline(uuid, uuid, uuid)
  TO authenticated, service_role;

CREATE FUNCTION public.fn_cashier_assert_active_actor(p_club uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
  v_status text;
BEGIN
  IF auth.role() = 'service_role' THEN RETURN; END IF;
  IF v_actor IS NULL OR p_club IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM public.clubs WHERE id = p_club AND owner_id = v_actor) THEN
    RETURN;
  END IF;

  SELECT role INTO v_role
    FROM public.club_members
   WHERE club_id = p_club
     AND user_id = v_actor
     AND coalesce(status, 'active') IN ('active', 'approved')
   LIMIT 1;

  IF v_role IN ('super_agent', 'agent', 'sub_agent') THEN
    -- Serialize against status changes without taking a row lock ahead of the
    -- retained money core's established wallet/club lock order. The matching
    -- agents trigger below takes this same mutex before status/update/delete.
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'cashier-agent-authority:' || p_club || ':' || v_actor, 0));
    SELECT a.status INTO v_status
      FROM public.agents a
     WHERE a.club_id = p_club AND a.user_id = v_actor;
    IF v_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'cashier_agent_inactive' USING ERRCODE = '42501';
    END IF;
  END IF;
END
$function$;

REVOKE ALL ON FUNCTION public.fn_cashier_assert_active_actor(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.fn_cashier_agent_status_mutex()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'DELETE'
     OR NEW.club_id IS DISTINCT FROM OLD.club_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'cashier-agent-authority:' || OLD.club_id || ':' || OLD.user_id, 0));
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'cashier-agent-authority:' || NEW.club_id || ':' || NEW.user_id, 0));
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;

CREATE TRIGGER cashier_agent_status_mutex_update
BEFORE UPDATE OF status, club_id, user_id ON public.agents
FOR EACH ROW EXECUTE FUNCTION public.fn_cashier_agent_status_mutex();
CREATE TRIGGER cashier_agent_status_mutex_delete
BEFORE DELETE ON public.agents
FOR EACH ROW EXECUTE FUNCTION public.fn_cashier_agent_status_mutex();

REVOKE ALL ON FUNCTION public.fn_cashier_agent_status_mutex()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.fn_cashier_balance_actor_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_TABLE_NAME = 'clubs' THEN
    PERFORM public.fn_cashier_assert_active_actor(NEW.id);
  ELSE
    PERFORM public.fn_cashier_assert_active_actor(NEW.club_id);
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER cashier_club_balance_actor_guard
BEFORE UPDATE OF chip_treasury, promo_balance ON public.clubs
FOR EACH ROW EXECUTE FUNCTION public.fn_cashier_balance_actor_guard();
CREATE TRIGGER cashier_member_balance_actor_guard
BEFORE UPDATE OF chip_balance ON public.club_members
FOR EACH ROW EXECUTE FUNCTION public.fn_cashier_balance_actor_guard();
CREATE TRIGGER cashier_agent_balance_actor_guard
BEFORE UPDATE OF agent_wallet_balance, promo_wallet_balance, credit_used ON public.agents
FOR EACH ROW EXECUTE FUNCTION public.fn_cashier_balance_actor_guard();

REVOKE ALL ON FUNCTION public.fn_cashier_balance_actor_guard()
  FROM PUBLIC, anon, authenticated, service_role;

-- Statement triggers run before UPDATE takes any row lock. Retained Cashier
-- RPCs already publish their retry UUID as the ledger correlation before their
-- first balance statement, so they join the same global lock order as the new
-- wrappers without rewriting their audited accounting bodies.
CREATE FUNCTION public.fn_cashier_operation_mutex_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_correlation text := nullif(current_setting('app.ledger_correlation', true), '');
BEGIN
  IF v_correlation ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'cashier-exact-intent:' || v_correlation::uuid, 0));
  END IF;
  RETURN NULL;
END
$function$;

CREATE TRIGGER cashier_club_operation_mutex
BEFORE UPDATE ON public.clubs
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_cashier_operation_mutex_guard();
CREATE TRIGGER cashier_member_operation_mutex
BEFORE UPDATE ON public.club_members
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_cashier_operation_mutex_guard();
CREATE TRIGGER cashier_agent_operation_mutex
BEFORE UPDATE ON public.agents
FOR EACH STATEMENT EXECUTE FUNCTION public.fn_cashier_operation_mutex_guard();

INSERT INTO public.ca_declared_money_triggers(table_name, trigger_name, note) VALUES
  ('club_members', 'cashier_member_balance_actor_guard',
   'Cashier authority guard refuses browser balance writes whose admitted actor no longer owns the active money operation.'),
  ('club_members', 'cashier_member_operation_mutex',
   'Cashier retry-key mutex joins retained and wrapped Cashier paths to one global operation lock before member balance writes.')
ON CONFLICT (table_name, trigger_name) DO UPDATE SET note = excluded.note;

REVOKE ALL ON FUNCTION public.fn_cashier_operation_mutex_guard()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.fn_cashier_exact_intent_begin(
  p_action text,
  p_club uuid,
  p_operation uuid,
  p_intent jsonb
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_existing public.cashier_rpc_operation_intents%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('state', 'return', 'response',
      jsonb_build_object('success', false, 'error', 'Not Authenticated'));
  END IF;
  IF p_operation IS NULL THEN
    RETURN jsonb_build_object('state', 'return', 'response',
      jsonb_build_object('success', false, 'error', 'A Retry Key Is Required'));
  END IF;

  -- Global ownership prevents two actors racing the same UUID through the
  -- legacy core's looser metadata replay lookup.
  PERFORM pg_advisory_xact_lock(hashtextextended('cashier-exact-intent:' || p_operation, 0));
  SELECT * INTO v_existing
    FROM public.cashier_rpc_operation_intents
   WHERE operation_id = p_operation
   FOR UPDATE;

  IF FOUND THEN
    IF v_existing.actor_user_id IS DISTINCT FROM v_actor
       OR v_existing.action IS DISTINCT FROM p_action
       OR v_existing.club_id IS DISTINCT FROM p_club
       OR v_existing.operation_intent IS DISTINCT FROM p_intent THEN
      RETURN jsonb_build_object('state', 'return', 'response',
        jsonb_build_object('success', false,
          'error', 'That Retry Key Belongs To A Different Cashier Request'));
    END IF;
    IF v_existing.receipt IS NOT NULL THEN
      RETURN jsonb_build_object('state', 'return', 'response',
        v_existing.receipt || jsonb_build_object('replayed', true));
    END IF;
    RETURN jsonb_build_object('state', 'proceed');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.chip_transactions t
     WHERE t.metadata ->> 'op_id' = p_operation::text
  ) OR EXISTS (
    SELECT 1 FROM public.chip_requests r
     WHERE r.op_id = p_operation
  ) THEN
    RETURN jsonb_build_object('state', 'return', 'response',
      jsonb_build_object('success', false,
        'error', 'That Legacy Retry Key Cannot Be Verified; Reconcile It Before Retrying'));
  END IF;

  INSERT INTO public.cashier_rpc_operation_intents(
    operation_id, actor_user_id, action, club_id, operation_intent, intent_fingerprint
  ) VALUES (
    p_operation, v_actor, p_action, p_club, p_intent, md5(p_intent::text)
  );
  RETURN jsonb_build_object('state', 'proceed');
END
$function$;

CREATE FUNCTION public.fn_cashier_exact_intent_finish(p_operation uuid, p_receipt jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF coalesce((p_receipt ->> 'success')::boolean, false) THEN
    UPDATE public.cashier_rpc_operation_intents
       SET receipt = p_receipt, completed_at = clock_timestamp()
     WHERE operation_id = p_operation AND actor_user_id = auth.uid();
    IF NOT FOUND THEN
      RAISE EXCEPTION 'cashier_operation_owner_changed' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN p_receipt;
END
$function$;

REVOKE ALL ON FUNCTION public.fn_cashier_exact_intent_begin(text, uuid, uuid, jsonb),
  public.fn_cashier_exact_intent_finish(uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

-- Legacy Cashier functions retain their own exact-action replay contracts.
-- This insertion boundary makes the UUID namespace global across those doors
-- and the wrappers below. Taking the same advisory lock closes the
-- race where a legacy insert and a wrapped request arrive together.
CREATE FUNCTION public.fn_cashier_operation_intent_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_operation uuid;
  v_owner uuid;
  v_action text;
  v_expected_type text;
BEGIN
  IF NEW.metadata ->> 'op_id' IS NULL THEN RETURN NEW; END IF;
  BEGIN
    v_operation := (NEW.metadata ->> 'op_id')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NEW;
  END;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'cashier-exact-intent:' || v_operation, 0));
  SELECT actor_user_id, action INTO v_owner, v_action
    FROM public.cashier_rpc_operation_intents
   WHERE operation_id = v_operation;
  IF NOT FOUND THEN RETURN NEW; END IF;

  v_expected_type := CASE v_action
    WHEN 'club_bank_send' THEN 'club_bank_send'
    WHEN 'club_bank_claim' THEN 'club_bank_claim'
    WHEN 'club_bank_reversal' THEN 'club_bank_reversal'
    WHEN 'admin_removal' THEN 'admin_removal'
    WHEN 'promo_wallet_send' THEN 'promo_wallet_send'
    WHEN 'club_promo_send' THEN 'club_promo_send'
    WHEN 'agent_wallet_send' THEN 'agent_wallet_send'
    WHEN 'agent_wallet_claim_back' THEN 'agent_wallet_claim_back'
  END;
  IF v_owner IS DISTINCT FROM auth.uid()
     OR v_expected_type IS NULL
     OR NEW.transaction_type IS DISTINCT FROM v_expected_type THEN
    RAISE EXCEPTION 'cashier_retry_key_reused_across_actions' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER cashier_operation_intent_guard
BEFORE INSERT ON public.chip_transactions
FOR EACH ROW EXECUTE FUNCTION public.fn_cashier_operation_intent_guard();

REVOKE ALL ON FUNCTION public.fn_cashier_operation_intent_guard()
  FROM PUBLIC, anon, authenticated, service_role;

-- Register the retained cores before ALTER FUNCTION so the DDL money-writer
-- guard never observes an unregistered balance writer.
INSERT INTO public.ca_money_rpc_registry(proname, status, notes) VALUES
  ('fn_club_bank_send_core_20261004', 'approved', 'private retained Club Bank send core behind exact-intent wrapper'),
  ('fn_club_bank_claim_core_20261004', 'approved', 'private retained Club Bank claim core behind exact-intent wrapper'),
  ('fn_club_bank_reverse_core_20261004', 'approved', 'private retained reversal core behind exact-intent wrapper'),
  ('fn_admin_remove_chips_core_20261004', 'approved', 'private retained removal core behind exact-intent wrapper'),
  ('fn_promo_wallet_send_core_20261004', 'approved', 'private retained agent promo core behind exact-intent wrapper'),
  ('fn_club_promo_send_core_20261004', 'approved', 'private retained club promo core behind exact-intent wrapper'),
  ('fn_agent_wallet_send_core_20261004', 'approved', 'private retained agent wallet send entry point behind exact-intent wrapper'),
  ('fn_agent_wallet_claim_back_core_20261004', 'approved', 'private retained agent wallet claim entry point behind exact-intent wrapper')
ON CONFLICT (proname) DO UPDATE SET status = excluded.status, notes = excluded.notes;

ALTER FUNCTION public.fn_club_bank_send(uuid, uuid, numeric, text, text, uuid)
  RENAME TO fn_club_bank_send_core_20261004;
ALTER FUNCTION public.fn_club_bank_claim_back(uuid, uuid, numeric, text, text, uuid)
  RENAME TO fn_club_bank_claim_core_20261004;
ALTER FUNCTION public.fn_club_bank_reverse(uuid, text, uuid)
  RENAME TO fn_club_bank_reverse_core_20261004;
ALTER FUNCTION public.fn_admin_remove_player_chips(uuid, uuid, numeric, text, uuid)
  RENAME TO fn_admin_remove_chips_core_20261004;
ALTER FUNCTION public.fn_promo_wallet_send(uuid, uuid, numeric, text, text, uuid)
  RENAME TO fn_promo_wallet_send_core_20261004;
ALTER FUNCTION public.fn_club_promo_wallet_send(uuid, uuid, numeric, text, text, uuid)
  RENAME TO fn_club_promo_send_core_20261004;
ALTER FUNCTION public.fn_agent_wallet_send(uuid, uuid, numeric, text, text, uuid)
  RENAME TO fn_agent_wallet_send_core_20261004;
ALTER FUNCTION public.fn_agent_wallet_claim_back(uuid, uuid, numeric, text, uuid)
  RENAME TO fn_agent_wallet_claim_back_core_20261004;
ALTER FUNCTION public.fn_request_chips(uuid, numeric, text, uuid)
  RENAME TO fn_request_chips_core_20261004;

REVOKE ALL ON FUNCTION
  public.fn_club_bank_send_core_20261004(uuid, uuid, numeric, text, text, uuid),
  public.fn_club_bank_claim_core_20261004(uuid, uuid, numeric, text, text, uuid),
  public.fn_club_bank_reverse_core_20261004(uuid, text, uuid),
  public.fn_admin_remove_chips_core_20261004(uuid, uuid, numeric, text, uuid),
  public.fn_promo_wallet_send_core_20261004(uuid, uuid, numeric, text, text, uuid),
  public.fn_club_promo_send_core_20261004(uuid, uuid, numeric, text, text, uuid),
  public.fn_agent_wallet_send_core_20261004(uuid, uuid, numeric, text, text, uuid),
  public.fn_agent_wallet_claim_back_core_20261004(uuid, uuid, numeric, text, uuid),
  public.fn_request_chips_core_20261004(uuid, numeric, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.fn_club_bank_send(
  p_club_id uuid, p_to_user_id uuid, p_amount numeric,
  p_destination text DEFAULT 'agent_wallet', p_reason text DEFAULT NULL,
  p_op_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_intent jsonb := jsonb_build_object(
    'actor', auth.uid(), 'club', p_club_id, 'action', 'club_bank_send',
    'target', p_to_user_id, 'amount', p_amount,
    'effective_wallet', lower(coalesce(p_destination, 'agent_wallet')),
    'reason', coalesce(nullif(btrim(p_reason), ''), 'Club Bank Send'));
  v_gate jsonb; v_result jsonb;
BEGIN
  IF p_op_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'A Retry Key Is Required'); END IF;
  v_gate := public.fn_cashier_exact_intent_begin('club_bank_send', p_club_id, p_op_id, v_intent);
  IF v_gate ->> 'state' = 'return' THEN RETURN v_gate -> 'response'; END IF;
  v_result := public.fn_club_bank_send_core_20261004(p_club_id, p_to_user_id, p_amount, p_destination, p_reason, p_op_id);
  RETURN public.fn_cashier_exact_intent_finish(p_op_id, v_result);
END
$function$;

CREATE FUNCTION public.fn_club_bank_claim_back(
  p_club_id uuid, p_from_user_id uuid, p_amount numeric,
  p_source text DEFAULT 'agent_wallet', p_reason text DEFAULT NULL,
  p_op_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_intent jsonb := jsonb_build_object(
    'actor', auth.uid(), 'club', p_club_id, 'action', 'club_bank_claim',
    'source_user', p_from_user_id, 'amount', p_amount,
    'effective_wallet', lower(coalesce(p_source, 'agent_wallet')),
    'reason', coalesce(nullif(btrim(p_reason), ''), 'Club Bank Claim Back'));
  v_gate jsonb; v_result jsonb;
BEGIN
  IF p_op_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'A Retry Key Is Required'); END IF;
  v_gate := public.fn_cashier_exact_intent_begin('club_bank_claim', p_club_id, p_op_id, v_intent);
  IF v_gate ->> 'state' = 'return' THEN RETURN v_gate -> 'response'; END IF;
  v_result := public.fn_club_bank_claim_core_20261004(p_club_id, p_from_user_id, p_amount, p_source, p_reason, p_op_id);
  RETURN public.fn_cashier_exact_intent_finish(p_op_id, v_result);
END
$function$;

CREATE FUNCTION public.fn_club_bank_reverse(
  p_transaction_id uuid, p_reason text DEFAULT NULL, p_op_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_club uuid; v_amount numeric; v_intent jsonb; v_gate jsonb; v_result jsonb;
BEGIN
  IF p_op_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'A Retry Key Is Required'); END IF;
  SELECT club_id, amount INTO v_club, v_amount
    FROM public.chip_transactions WHERE id = p_transaction_id;
  v_intent := jsonb_build_object(
    'actor', auth.uid(), 'club', v_club, 'action', 'club_bank_reversal',
    'referenced_transaction', p_transaction_id, 'amount', v_amount,
    'reason', coalesce(nullif(btrim(p_reason), ''), 'Club Bank Send Reversed'));
  v_gate := public.fn_cashier_exact_intent_begin('club_bank_reversal', v_club, p_op_id, v_intent);
  IF v_gate ->> 'state' = 'return' THEN RETURN v_gate -> 'response'; END IF;
  v_result := public.fn_club_bank_reverse_core_20261004(p_transaction_id, p_reason, p_op_id);
  RETURN public.fn_cashier_exact_intent_finish(p_op_id, v_result);
END
$function$;

CREATE FUNCTION public.fn_admin_remove_player_chips(
  p_club_id uuid, p_player_id uuid, p_amount numeric,
  p_reason text DEFAULT NULL, p_op_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_intent jsonb := jsonb_build_object(
    'actor', auth.uid(), 'club', p_club_id, 'action', 'admin_removal',
    'source_user', p_player_id, 'amount', p_amount,
    'effective_wallet', 'player_wallet',
    'reason', coalesce(nullif(btrim(p_reason), ''), 'Chips Pulled By Club Staff'));
  v_gate jsonb; v_result jsonb;
BEGIN
  IF p_op_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'A Retry Key Is Required'); END IF;
  v_gate := public.fn_cashier_exact_intent_begin('admin_removal', p_club_id, p_op_id, v_intent);
  IF v_gate ->> 'state' = 'return' THEN RETURN v_gate -> 'response'; END IF;
  v_result := public.fn_admin_remove_chips_core_20261004(p_club_id, p_player_id, p_amount, p_reason, p_op_id);
  RETURN public.fn_cashier_exact_intent_finish(p_op_id, v_result);
END
$function$;

CREATE FUNCTION public.fn_promo_wallet_send(
  p_club_id uuid, p_to_user_id uuid, p_amount numeric,
  p_destination text DEFAULT 'player_wallet', p_reason text DEFAULT NULL,
  p_op_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_intent jsonb := jsonb_build_object(
    'actor', auth.uid(), 'club', p_club_id, 'action', 'promo_wallet_send',
    'target', p_to_user_id, 'amount', p_amount,
    'effective_wallet', lower(coalesce(p_destination, 'player_wallet')),
    'reason', coalesce(nullif(btrim(p_reason), ''), 'Promo Wallet Send'));
  v_gate jsonb; v_result jsonb;
BEGIN
  IF p_op_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'A Retry Key Is Required'); END IF;
  v_gate := public.fn_cashier_exact_intent_begin('promo_wallet_send', p_club_id, p_op_id, v_intent);
  IF v_gate ->> 'state' = 'return' THEN RETURN v_gate -> 'response'; END IF;
  v_result := public.fn_promo_wallet_send_core_20261004(p_club_id, p_to_user_id, p_amount, p_destination, p_reason, p_op_id);
  RETURN public.fn_cashier_exact_intent_finish(p_op_id, v_result);
END
$function$;

CREATE FUNCTION public.fn_club_promo_wallet_send(
  p_club_id uuid, p_to_user_id uuid, p_amount numeric,
  p_destination text DEFAULT 'player_wallet', p_reason text DEFAULT NULL,
  p_op_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_intent jsonb := jsonb_build_object(
    'actor', auth.uid(), 'club', p_club_id, 'action', 'club_promo_send',
    'target', p_to_user_id, 'amount', p_amount,
    'effective_wallet', lower(coalesce(p_destination, 'player_wallet')),
    'reason', coalesce(nullif(btrim(p_reason), ''), 'Club Promo Wallet Send'));
  v_gate jsonb; v_result jsonb;
BEGIN
  IF p_op_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'A Retry Key Is Required'); END IF;
  v_gate := public.fn_cashier_exact_intent_begin('club_promo_send', p_club_id, p_op_id, v_intent);
  IF v_gate ->> 'state' = 'return' THEN RETURN v_gate -> 'response'; END IF;
  v_result := public.fn_club_promo_send_core_20261004(p_club_id, p_to_user_id, p_amount, p_destination, p_reason, p_op_id);
  RETURN public.fn_cashier_exact_intent_finish(p_op_id, v_result);
END
$function$;

-- These retained browser entry points previously reached their audited cores
-- before claiming the global retry key. Wrap the entry points themselves so
-- the global exact-intent lock is always first; their accounting cores remain
-- byte-for-byte unchanged behind the private names above.
CREATE FUNCTION public.fn_agent_wallet_send(
  p_club_id uuid, p_to_user_id uuid, p_amount numeric,
  p_destination text DEFAULT 'player_wallet', p_reason text DEFAULT NULL,
  p_op_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_intent jsonb := jsonb_build_object(
    'actor', auth.uid(), 'club', p_club_id, 'action', 'agent_wallet_send',
    'target', p_to_user_id, 'amount', p_amount,
    'requested_destination', lower(coalesce(p_destination, 'player_wallet')),
    'reason', coalesce(nullif(btrim(p_reason), ''), 'Agent Wallet Send'));
  v_gate jsonb; v_result jsonb;
BEGIN
  IF p_op_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'A Retry Key Is Required For Every Send'); END IF;
  v_gate := public.fn_cashier_exact_intent_begin('agent_wallet_send', p_club_id, p_op_id, v_intent);
  IF v_gate ->> 'state' = 'return' THEN RETURN v_gate -> 'response'; END IF;
  v_result := public.fn_agent_wallet_send_core_20261004(
    p_club_id, p_to_user_id, p_amount, p_destination, p_reason, p_op_id);
  RETURN public.fn_cashier_exact_intent_finish(p_op_id, v_result);
END
$function$;

CREATE FUNCTION public.fn_agent_wallet_claim_back(
  p_club_id uuid, p_transaction_id uuid, p_amount numeric DEFAULT NULL,
  p_reason text DEFAULT NULL, p_op_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_intent jsonb := jsonb_build_object(
    'actor', auth.uid(), 'club', p_club_id, 'action', 'agent_wallet_claim_back',
    'referenced_transaction', p_transaction_id, 'amount', p_amount,
    'reason', coalesce(nullif(btrim(p_reason), ''),
      'Agent Wallet Claim Back Inside The Ten Minute Window'));
  v_gate jsonb; v_result jsonb;
BEGIN
  IF p_op_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'A Retry Key Is Required For Every Claim Back'); END IF;
  v_gate := public.fn_cashier_exact_intent_begin('agent_wallet_claim_back', p_club_id, p_op_id, v_intent);
  IF v_gate ->> 'state' = 'return' THEN RETURN v_gate -> 'response'; END IF;
  v_result := public.fn_agent_wallet_claim_back_core_20261004(
    p_club_id, p_transaction_id, p_amount, p_reason, p_op_id);
  RETURN public.fn_cashier_exact_intent_finish(p_op_id, v_result);
END
$function$;

-- A chip request does not move a balance, but it shares the browser's retry
-- UUID namespace with every money mutation. Claim that UUID before the
-- retained request core can write chip_requests, so request-versus-money
-- races and cross-action retries have one deterministic owner.
CREATE FUNCTION public.fn_request_chips(
  p_club_id uuid, p_amount numeric, p_note text DEFAULT NULL,
  p_op_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_intent jsonb := jsonb_build_object(
    'actor', auth.uid(), 'club', p_club_id, 'action', 'chip_request',
    'amount', p_amount,
    'note', nullif(btrim(coalesce(p_note, '')), ''));
  v_gate jsonb; v_result jsonb;
BEGIN
  IF p_op_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error', 'A Retry Key Is Required'); END IF;
  v_gate := public.fn_cashier_exact_intent_begin('chip_request', p_club_id, p_op_id, v_intent);
  IF v_gate ->> 'state' = 'return' THEN RETURN v_gate -> 'response'; END IF;
  v_result := public.fn_request_chips_core_20261004(p_club_id, p_amount, p_note, p_op_id);
  RETURN public.fn_cashier_exact_intent_finish(p_op_id, v_result);
END
$function$;

REVOKE ALL ON FUNCTION
  public.fn_club_bank_send(uuid, uuid, numeric, text, text, uuid),
  public.fn_club_bank_claim_back(uuid, uuid, numeric, text, text, uuid),
  public.fn_club_bank_reverse(uuid, text, uuid),
  public.fn_admin_remove_player_chips(uuid, uuid, numeric, text, uuid),
  public.fn_promo_wallet_send(uuid, uuid, numeric, text, text, uuid),
  public.fn_club_promo_wallet_send(uuid, uuid, numeric, text, text, uuid),
  public.fn_agent_wallet_send(uuid, uuid, numeric, text, text, uuid),
  public.fn_agent_wallet_claim_back(uuid, uuid, numeric, text, uuid),
  public.fn_request_chips(uuid, numeric, text, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.fn_club_bank_send(uuid, uuid, numeric, text, text, uuid),
  public.fn_club_bank_claim_back(uuid, uuid, numeric, text, text, uuid),
  public.fn_club_bank_reverse(uuid, text, uuid),
  public.fn_admin_remove_player_chips(uuid, uuid, numeric, text, uuid),
  public.fn_promo_wallet_send(uuid, uuid, numeric, text, text, uuid),
  public.fn_club_promo_wallet_send(uuid, uuid, numeric, text, text, uuid),
  public.fn_agent_wallet_send(uuid, uuid, numeric, text, text, uuid),
  public.fn_agent_wallet_claim_back(uuid, uuid, numeric, text, uuid),
  public.fn_request_chips(uuid, numeric, text, uuid)
  TO authenticated, service_role;

-- The member chooser uses the same active edge definition as the refusal.
CREATE OR REPLACE FUNCTION public.fn_club_cashier_members(p_club_id uuid)
RETURNS TABLE(user_id uuid, role text, role_rank integer, depth integer,
  chip_balance numeric, name text, username text, player_number text, avatar_url text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_scope text;
BEGIN
  IF v_actor IS NULL OR p_club_id IS NULL THEN RETURN; END IF;
  v_scope := public.fn_club_cashier_scope(p_club_id, v_actor);
  IF v_scope = 'none' THEN RETURN; END IF;

  RETURN QUERY
  WITH RECURSIVE
  edges AS (
    SELECT edge.child, edge.parent
      FROM public.fn_club_active_cashier_edges(p_club_id) edge
  ),
  tree AS (
    SELECT e.child, ARRAY[e.child] AS path, 1 AS depth
      FROM edges e WHERE e.parent = v_actor
    UNION ALL
    SELECT e.child, t.path || e.child, t.depth + 1
      FROM tree t JOIN edges e ON e.parent = t.child
     WHERE NOT (e.child = ANY(t.path)) AND t.depth < 20
  ),
  flat AS (
    SELECT t.child AS uid, min(t.depth)::int AS d FROM tree t GROUP BY t.child
  ),
  scoped AS (
    SELECT cm.user_id AS uid,
           coalesce(cm.role, 'player') AS r,
           coalesce(cm.chip_balance, 0)::numeric AS bal,
           coalesce(f.d, 0) AS d
      FROM public.club_members cm
      LEFT JOIN flat f ON f.uid = cm.user_id
     WHERE cm.club_id = p_club_id
       AND public.fn_cashier_member_is_active(cm.club_id, cm.user_id)
       AND (v_scope = 'all' OR f.uid IS NOT NULL)
  )
  SELECT s.uid, s.r,
         (CASE s.r
           WHEN 'owner' THEN 100 WHEN 'co_owner' THEN 90 WHEN 'admin' THEN 80
           WHEN 'super_agent' THEN 60 WHEN 'agent' THEN 40 WHEN 'sub_agent' THEN 20
           ELSE 0 END)::int,
         s.d, s.bal,
         public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                              pr.first_name, pr.last_name, pr.full_name)::text,
         coalesce(pr.username, '')::text,
         coalesce(pr.player_number, '')::text,
         coalesce(nullif(btrim(pr.avatar_url), ''),
                  nullif(btrim(pr.arena_avatar_url), ''), '')::text
    FROM scoped s
    LEFT JOIN public.profiles pr ON pr.id = s.uid
   ORDER BY s.d ASC,
            (CASE s.r
              WHEN 'owner' THEN 100 WHEN 'co_owner' THEN 90 WHEN 'admin' THEN 80
              WHEN 'super_agent' THEN 60 WHEN 'agent' THEN 40 WHEN 'sub_agent' THEN 20
              ELSE 0 END) DESC,
            lower(public.fn_arena_name(pr.alias, pr.username, pr.display_name,
                                       pr.first_name, pr.last_name, pr.full_name));
END
$function$;

REVOKE ALL ON FUNCTION public.fn_club_cashier_members(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_cashier_members(uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_cashier_statement_downline(p_club_id uuid, p_viewer uuid)
RETURNS uuid[]
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH RECURSIVE downline AS (
    SELECT p_viewer AS user_id
    UNION
    SELECT edge.child
      FROM public.fn_club_active_cashier_edges(p_club_id) edge
      JOIN downline d ON edge.parent = d.user_id
  )
  SELECT array_agg(user_id ORDER BY user_id)
    FROM downline WHERE user_id IS NOT NULL
$function$;

-- This recursive primitive accepts an arbitrary viewer. Keep it private; the
-- SECURITY DEFINER statement scope owns the only browser-facing use.
REVOKE ALL ON FUNCTION public.fn_cashier_statement_downline(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_cashier_statement_scope(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_viewer uuid := auth.uid();
  v_role text;
  v_scope text := 'none';
  v_ids uuid[];
  v_reason text;
BEGIN
  IF v_viewer IS NULL THEN
    v_reason := 'sign_in_required';
  ELSIF p_club_id IS NULL THEN
    v_reason := 'club_required';
  ELSE
    v_role := public.fn_club_bank_role(p_club_id, v_viewer);
    IF v_role IS NULL THEN
      v_reason := 'not_an_active_member';
    ELSIF v_role IN ('owner', 'co_owner', 'admin', 'super_agent') THEN
      v_scope := 'all';
    ELSIF v_role IN ('agent', 'sub_agent') THEN
      v_scope := 'downline';
      v_ids := public.fn_cashier_statement_downline(p_club_id, v_viewer);
    ELSE
      v_scope := 'self';
    END IF;
  END IF;
  RETURN jsonb_build_object(
    'authorized', v_scope <> 'none', 'reason', v_reason,
    'role', CASE WHEN v_scope <> 'none' THEN v_role END,
    'scope', v_scope, 'viewer', v_viewer,
    'fingerprint', md5(concat_ws('|', v_viewer::text, p_club_id::text,
      v_scope, array_to_string(v_ids, ',')))
  );
END
$function$;

REVOKE ALL ON FUNCTION public.fn_cashier_statement_scope(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cashier_statement_scope(uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_club_trade_ledger(
  p_club_id uuid, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0
) RETURNS TABLE(id uuid, created_at timestamptz, transaction_type text,
  amount numeric, from_user_id uuid, to_user_id uuid, notes text,
  from_name text, to_name text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_viewer uuid := auth.uid();
  v_role text;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
BEGIN
  IF v_viewer IS NULL OR p_club_id IS NULL THEN RETURN; END IF;
  v_role := public.fn_club_bank_role(p_club_id, v_viewer);
  IF v_role IS NULL THEN RETURN; END IF;

  IF v_role IN ('owner', 'co_owner', 'admin', 'super_agent') THEN
    RETURN QUERY
    SELECT ct.id, ct.created_at, ct.transaction_type, ct.amount,
           ct.from_user_id, ct.to_user_id, ct.notes,
           coalesce(pf.alias, pf.display_name, pf.username),
           coalesce(pt.alias, pt.display_name, pt.username)
      FROM public.chip_transactions ct
      LEFT JOIN public.profiles pf ON pf.id = ct.from_user_id
      LEFT JOIN public.profiles pt ON pt.id = ct.to_user_id
     WHERE ct.club_id = p_club_id
     ORDER BY ct.created_at DESC LIMIT v_limit OFFSET v_offset;
  ELSIF v_role IN ('agent', 'sub_agent') THEN
    RETURN QUERY
    WITH RECURSIVE dl AS (
      SELECT v_viewer AS user_id
      UNION
      SELECT edge.child
        FROM public.fn_club_active_cashier_edges(p_club_id) edge
        JOIN dl ON edge.parent = dl.user_id
    )
    SELECT ct.id, ct.created_at, ct.transaction_type, ct.amount,
           ct.from_user_id, ct.to_user_id, ct.notes,
           coalesce(pf.alias, pf.display_name, pf.username),
           coalesce(pt.alias, pt.display_name, pt.username)
      FROM public.chip_transactions ct
      LEFT JOIN public.profiles pf ON pf.id = ct.from_user_id
      LEFT JOIN public.profiles pt ON pt.id = ct.to_user_id
     WHERE ct.club_id = p_club_id
       AND (ct.from_user_id IN (SELECT user_id FROM dl)
         OR ct.to_user_id IN (SELECT user_id FROM dl))
     ORDER BY ct.created_at DESC LIMIT v_limit OFFSET v_offset;
  ELSE
    RETURN QUERY
    SELECT ct.id, ct.created_at, ct.transaction_type, ct.amount,
           ct.from_user_id, ct.to_user_id, ct.notes,
           coalesce(pf.alias, pf.display_name, pf.username),
           coalesce(pt.alias, pt.display_name, pt.username)
      FROM public.chip_transactions ct
      LEFT JOIN public.profiles pf ON pf.id = ct.from_user_id
      LEFT JOIN public.profiles pt ON pt.id = ct.to_user_id
     WHERE ct.club_id = p_club_id
       AND (ct.from_user_id = v_viewer OR ct.to_user_id = v_viewer)
     ORDER BY ct.created_at DESC LIMIT v_limit OFFSET v_offset;
  END IF;
END
$function$;

REVOKE ALL ON FUNCTION public.fn_club_trade_ledger(uuid, integer, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_club_trade_ledger(uuid, integer, integer)
  TO authenticated, service_role;

DO $postconditions$
BEGIN
  IF has_function_privilege('authenticated',
      'public.fn_club_bank_send_core_20261004(uuid,uuid,numeric,text,text,uuid)',
      'EXECUTE') THEN
    RAISE EXCEPTION 'private cashier core is executable';
  END IF;
  IF (SELECT count(*) FROM pg_trigger
      WHERE NOT tgisinternal AND tgenabled <> 'D'
        AND tgname IN ('cashier_agent_status_mutex_update',
                       'cashier_agent_status_mutex_delete',
                       'cashier_operation_intent_guard')) <> 3 THEN
    RAISE EXCEPTION 'cashier authority serialization triggers missing';
  END IF;
END
$postconditions$;

COMMIT;
