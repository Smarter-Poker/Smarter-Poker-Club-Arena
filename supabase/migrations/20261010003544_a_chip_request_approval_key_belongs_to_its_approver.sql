-- 20261010003544_a_chip_request_approval_key_belongs_to_its_approver.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (cashier launch audit C6-03, 2026-10-09):
--
-- fn_respond_chip_request derives its send's retry key from the request
-- alone, md5('chip_request_approve:' || request id), so a lost response
-- replays instead of paying twice. Since 20261004124327 that key goes through
-- fn_agent_wallet_send's exact-intent gate (fn_cashier_exact_intent_begin),
-- which binds a key to the FIRST actor that presents it and keeps the claim
-- when the send is refused (success false is a committed answer, not a
-- rollback). So when an approver is refused - an agent with no float, the
-- case reproduced - the claim stays bound to them, and every other approver
-- of that request (the owner, a co-owner, an admin) is answered "That Retry
-- Key Belongs To A Different Cashier Request" forever: the request can never
-- be approved by anybody else. Production's live body (md5 f6b8bf0d7d035d063780b37ff614b068,
-- 20260905040100, reproduced byte for byte) was proved on PostgreSQL 17 with
-- production's own exact-intent gate and wrapper
-- (scripts/ci/test-chip-request-approval-db-postgres.py,
-- tests/fixtures/chip-request-approval-db/scenario.sql: it fails before and
-- passes after).
--
-- The key is now derived from the request AND the approver. A retry by the
-- same approver still replays the same send; an approver who was refused no
-- longer blocks another. Money still moves at most once: the send and the
-- status change commit together under the chip_requests row lock, and any
-- later attempt finds the request answered. A retry of an approval made
-- before this file (under the request-only key) still finds that send and
-- replays it.
--
-- Not changed: who may approve, decline or cancel, the freeze refusal, the
-- send itself, grants (authenticated and service_role EXECUTE, never anon),
-- SECURITY DEFINER and search_path. The release contract
-- (scripts/verification-harness/cashier-release-contract.sql) accepts the
-- installed body and, until it is installed, the live one.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_respond_chip_request(uuid,text)'::regprocedure)) = '10fb3a12f5113521a2366a98af90ecbd')

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_respond_chip_request(uuid,text)'::regprocedure)) IS DISTINCT FROM 'f6b8bf0d7d035d063780b37ff614b068' THEN
    RAISE EXCEPTION 'fn_respond_chip_request is not the live text this migration was written against (md5 %)',
      md5(pg_get_functiondef('public.fn_respond_chip_request(uuid,text)'::regprocedure)) USING ERRCODE = '55000';
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.fn_respond_chip_request(p_request_id uuid, p_action text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_me uuid := auth.uid();
  v_req record;
  v_role text;
  v_send jsonb;
  v_op_id uuid;
  v_prior record;
begin
  if v_me is null then return jsonb_build_object('success', false, 'error', 'not authenticated'); end if;
  if p_action not in ('approve','decline','cancel') then
    return jsonb_build_object('success', false, 'error', 'invalid action');
  end if;

  select * into v_req from chip_requests where id = p_request_id for update;
  if not found then return jsonb_build_object('success', false, 'error', 'request not found'); end if;

  -- THE SAME KEY ON EVERY ATTEMPT BY THE SAME APPROVER. Derived from the
  -- request and the approver, so a retry after a lost response replays the
  -- original send instead of making a new one, and an approval another
  -- approver attempted and was refused (2026-10-09: the exact-intent gate binds
  -- a key to its first actor, so a request-only key left the request
  -- answerable by nobody else) never blocks this one. Money still moves once:
  -- the send and the status change commit together under the row lock above.
  v_op_id := md5('chip_request_approve:' || p_request_id::text || ':' || v_me::text)::uuid;

  if v_req.status <> 'pending' then
    -- A RETRY AFTER A LOST RESPONSE IS NOT A FAILURE. If this caller already
    -- answered this request, say what happened rather than reporting an error
    -- for work that succeeded.
    if v_req.responded_by = v_me then
      if v_req.status = 'approved' then
        -- Only claim a replay against a transaction actually written under
        -- this key. Approvals made before this migration used a random key,
        -- so nothing is found and the honest refusal below stands - re-sending
        -- them is the one outcome that would move money twice.
        select ct.id, ct.amount into v_prior
          from chip_transactions ct
         where ct.club_id = v_req.club_id
           and ct.from_user_id = v_me
           and ct.metadata ->> 'op_id' in (v_op_id::text,
                 md5('chip_request_approve:' || p_request_id::text)::uuid::text)
         limit 1;
        if found then
          return jsonb_build_object('success', true, 'status', 'approved',
                                    'replayed', true, 'transaction_id', v_prior.id,
                                    'amount', v_prior.amount);
        end if;
      else
        return jsonb_build_object('success', true, 'status', v_req.status,
                                  'replayed', true);
      end if;
    end if;
    return jsonb_build_object('success', false, 'error', 'request already ' || v_req.status);
  end if;

  if p_action = 'cancel' then
    if v_req.requester_id <> v_me then
      return jsonb_build_object('success', false, 'error', 'only the requester may cancel');
    end if;
    update chip_requests set status = 'cancelled', responded_by = v_me, responded_at = now()
     where id = p_request_id;
    return jsonb_build_object('success', true, 'status', 'cancelled');
  end if;

  v_role := public.fn_club_bank_role(v_req.club_id);
  if v_role is null or v_role not in ('owner','co_owner','admin','super_agent','agent','sub_agent') then
    return jsonb_build_object('success', false, 'error', 'you cannot answer chip requests here');
  end if;
  if v_role in ('super_agent','agent','sub_agent') and v_req.approver_id is distinct from v_me then
    return jsonb_build_object('success', false, 'error', 'this request is not addressed to you');
  end if;

  if p_action = 'decline' then
    update chip_requests set status = 'declined', responded_by = v_me, responded_at = now()
     where id = p_request_id;
    return jsonb_build_object('success', true, 'status', 'declined');
  end if;

  if v_me = v_req.requester_id then
    return jsonb_build_object('success', false, 'error', 'you cannot approve your own request');
  end if;

  -- Said before the send, so the operator is told WHY rather than reading a
  -- raw trigger message. The guard on chip_transactions is what actually
  -- enforces it; this is the sentence that reaches the screen.
  if public.fn_club_settlement_frozen(v_req.club_id) then
    return jsonb_build_object('success', false,
      'error', 'this club is squaring its books - approvals resume when the settlement freeze lifts');
  end if;

  v_send := public.fn_agent_wallet_send(
    v_req.club_id, v_req.requester_id, v_req.amount,
    'player_wallet', 'Chip Request Approved', v_op_id);
  if not coalesce((v_send ->> 'success')::boolean, false) then
    return jsonb_build_object('success', false,
      'error', coalesce(v_send ->> 'error', 'the send was refused'));
  end if;

  update chip_requests set status = 'approved', responded_by = v_me, responded_at = now()
   where id = p_request_id;

  return jsonb_build_object('success', true, 'status', 'approved',
                            'replayed', coalesce((v_send ->> 'replayed')::boolean, false),
                            'your_balance', (v_send ->> 'agent_wallet_after')::numeric,
                            'their_balance', (v_send ->> 'recipient_balance_after')::numeric);
end $function$;

DO $post$
BEGIN
  IF md5(pg_get_functiondef('public.fn_respond_chip_request(uuid,text)'::regprocedure)) IS DISTINCT FROM '10fb3a12f5113521a2366a98af90ecbd' THEN
    RAISE EXCEPTION 'fn_respond_chip_request is not the reviewed text (md5 %)',
      md5(pg_get_functiondef('public.fn_respond_chip_request(uuid,text)'::regprocedure)) USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_respond_chip_request(uuid,text)'::regprocedure
       AND p.prosecdef AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proconfig @> ARRAY['search_path=public, pg_temp']
  ) OR has_function_privilege('anon', 'public.fn_respond_chip_request(uuid,text)'::regprocedure, 'EXECUTE')
    OR NOT has_function_privilege('authenticated', 'public.fn_respond_chip_request(uuid,text)'::regprocedure, 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.fn_respond_chip_request(uuid,text)'::regprocedure, 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_respond_chip_request lost its definer posture or its grants' USING ERRCODE = '55000';
  END IF;
END $post$;

COMMIT;
