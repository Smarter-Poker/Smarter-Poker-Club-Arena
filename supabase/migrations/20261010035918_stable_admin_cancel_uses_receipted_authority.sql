-- 20261010035918_stable_admin_cancel_uses_receipted_authority
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-10 03:59:18 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
-- TIER 3. Stable Admin reaches the existing atomic cancellation authority.
-- No new wallet/ledger/refund writer. Started/awarded events retain the
-- existing resume/settle refusal. A caller UUID, frozen review snapshot,
-- current DB permissions and established configurable approval policy guard
-- the original request. The immutable cancellation receipt proves refunds.
-- Measured production request-approval preimage a8699a8b1ebebda4b4ae012698117494.
-- No production tournament is changed by installation or qualification.
-- Rollback: archive ca_operator_tournament_operations, then remove this
-- wrapper/table via a new qualified migration. Preserve approval history and
-- the additive tournament_cancel kind while historical records reference it.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='45s';
DO $patch$
DECLARE old_definition text; new_definition text;
BEGIN
 SELECT pg_get_functiondef('public.fn_ca_operator_request_approval(text,jsonb,uuid,numeric,text,text,text,text,text,text)'::regprocedure) INTO old_definition;
 IF md5(old_definition)<>'a8699a8b1ebebda4b4ae012698117494' THEN RAISE EXCEPTION 'operator approval preimage changed'; END IF;
 new_definition:=replace(old_definition,
  $needle$('mint','burn','fund_club','cashout','fleet_policy','sanction')$needle$,
  $replacement$('mint','burn','fund_club','cashout','fleet_policy','sanction','tournament_cancel')$replacement$);
 IF new_definition=old_definition THEN RAISE EXCEPTION 'approval kind patch missing'; END IF;
 old_definition:=new_definition;
 new_definition:=replace(old_definition,
  $needle$when 'cashout' then coalesce(v_policy.cashout_threshold, 0)$needle$,
  $replacement$when 'cashout' then coalesce(v_policy.cashout_threshold, 0)
                   when 'tournament_cancel' then coalesce(v_policy.cashout_threshold, 0)$replacement$);
 IF new_definition=old_definition THEN RAISE EXCEPTION 'approval threshold patch missing'; END IF;
 EXECUTE new_definition;
END $patch$;
ALTER TABLE public.ca_operator_approvals DROP CONSTRAINT ca_operator_approvals_kind_check;
ALTER TABLE public.ca_operator_approvals ADD CONSTRAINT ca_operator_approvals_kind_check
 CHECK(kind IN('mint','burn','fund_club','cashout','fleet_policy','sanction','daily_close','tournament_cancel')) NOT VALID;
ALTER TABLE public.ca_operator_approvals VALIDATE CONSTRAINT ca_operator_approvals_kind_check;

CREATE TABLE public.ca_operator_tournament_operations (
 op_id uuid PRIMARY KEY,
 tournament_id uuid NOT NULL,
 actor_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 500),
 review_snapshot jsonb NOT NULL,
 amount numeric NOT NULL CHECK(amount>=0 AND amount=round(amount,2)),
 asset text NOT NULL CHECK(asset IN('chips','diamonds')),
 approval_id uuid,
 state text NOT NULL CHECK(state IN('pending','completed')),
 result jsonb,
 created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
 completed_at timestamptz
);
ALTER TABLE public.ca_operator_tournament_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_operator_tournament_operations FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.ca_operator_tournament_operations TO service_role;

CREATE FUNCTION public.fn_ca_operator_cancel_tournament(p_tournament_id uuid,p_op_id uuid,p_reason text,p_actor_id uuid,p_request_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET statement_timeout='120s' AS $body$
DECLARE permissions jsonb; event public.tournaments%ROWTYPE; prior public.ca_operator_tournament_operations%ROWTYPE;
 snapshot jsonb; amount numeric; asset text; approval jsonb; receipt jsonb; v_result jsonb; marked jsonb;
BEGIN
 IF p_tournament_id IS NULL OR p_op_id IS NULL OR p_actor_id IS NULL OR p_reason IS NULL
  OR length(btrim(p_reason)) NOT BETWEEN 10 AND 500 OR length(COALESCE(p_request_id,'')) NOT BETWEEN 1 AND 200
 THEN RAISE EXCEPTION 'invalid_tournament_operation' USING ERRCODE='22023'; END IF;
 permissions:=public.fn_ca_operator_permissions(p_actor_id)->'permissions';
 IF NOT COALESCE(permissions ?& ARRAY['console.read','clubs.write','money.write','money.read'],false)
 THEN RAISE EXCEPTION 'tournament_cancel_permission_denied' USING ERRCODE='42501'; END IF;
 -- Same global settlement lane as the existing cancellation/finish authorities.
 PERFORM public.fn_ca_lock_settlement_lane_global();
 PERFORM pg_advisory_xact_lock(hashtextextended('ca-tournament-op:'||p_op_id::text,0));
 SELECT * INTO prior FROM public.ca_operator_tournament_operations WHERE op_id=p_op_id FOR UPDATE;
 IF FOUND THEN
  IF prior.actor_id IS DISTINCT FROM p_actor_id OR prior.tournament_id IS DISTINCT FROM p_tournament_id OR prior.reason IS DISTINCT FROM btrim(p_reason)
  THEN RAISE EXCEPTION 'tournament_operation_conflict' USING ERRCODE='22023'; END IF;
  IF prior.state='completed' THEN
   -- Re-prove the same financial receipt. A stale success record cannot hide
   -- lost refund/custody evidence; no second settlement occurs on replay.
   receipt:=public.fn_ca_tournament_cancellation_receipt(p_tournament_id,NULL);
   IF receipt IS DISTINCT FROM prior.result->'receipt' THEN RAISE EXCEPTION 'cancellation_receipt_changed' USING ERRCODE='P0404'; END IF;
   RETURN prior.result||jsonb_build_object('replayed',true);
  END IF;
 END IF;
 SELECT * INTO event FROM public.tournaments WHERE id=p_tournament_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'tournament_not_found' USING ERRCODE='P0002'; END IF;
 -- Eligibility is still rechecked by atomic_cancel_tournament, including
 -- committed awards, launch receipts, draw receipts and hand history.
 IF event.started_at IS NOT NULL OR upper(COALESCE(event.status::text,'')) NOT IN('SCHEDULED','REGISTERING','UPCOMING','WAITING','PENDING')
 THEN RAISE EXCEPTION 'started_or_terminal_event_requires_resume_or_settle' USING ERRCODE='55000'; END IF;
 PERFORM 1 FROM public.tournament_players WHERE tournament_id=p_tournament_id ORDER BY user_id,id FOR UPDATE;
 snapshot:=jsonb_build_object('state',event.status,'started_at',event.started_at,
  'prize_pool',event.prize_pool,'bounty_pool',event.bounty_pool,'total_rake',event.total_rake,
  'roster',COALESCE((SELECT md5(jsonb_agg(to_jsonb(tp) ORDER BY tp.id)::text) FROM public.tournament_players tp WHERE tp.tournament_id=p_tournament_id),'empty'));
 amount:=round(COALESCE(event.prize_pool,0)+COALESCE(event.bounty_pool,0)+COALESCE(event.total_rake,0),2);
 IF amount<0 OR amount::text IN('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'tournament_exposure_unverified' USING ERRCODE='P0404'; END IF;
 asset:=CASE WHEN public.fn_poker_diamond_tournament(p_tournament_id) THEN 'diamonds' ELSE 'chips' END;
 IF prior.op_id IS NOT NULL AND (prior.review_snapshot IS DISTINCT FROM snapshot OR prior.amount IS DISTINCT FROM amount OR prior.asset IS DISTINCT FROM asset)
 THEN RAISE EXCEPTION 'tournament_review_changed' USING ERRCODE='40001'; END IF;
 approval:=public.fn_ca_operator_request_approval('tournament_cancel',
  jsonb_build_object('tournament_id',p_tournament_id,'op_id',p_op_id,'reason',btrim(p_reason),'review_snapshot',snapshot),
  p_actor_id,amount,asset,'tournament',p_tournament_id::text,btrim(p_reason),p_op_id::text,p_request_id);
 IF approval->>'ok' IS DISTINCT FROM 'true' THEN
  RETURN jsonb_build_object('ok',false,'refused',true,'reason',COALESCE(approval->>'reason','approval_refused'),'approval',approval,'op_id',p_op_id,'tournament_id',p_tournament_id);
 END IF;
 IF prior.op_id IS NULL THEN
  INSERT INTO public.ca_operator_tournament_operations(op_id,tournament_id,actor_id,reason,review_snapshot,amount,asset,approval_id,state)
  VALUES(p_op_id,p_tournament_id,p_actor_id,btrim(p_reason),snapshot,amount,asset,(approval->>'approval_id')::uuid,'pending');
 END IF;
 IF approval->>'required'='true' THEN
  RETURN jsonb_build_object('ok',true,'pending',true,'op_id',p_op_id,'tournament_id',p_tournament_id,'approval_id',approval->>'approval_id','amount',amount,'asset',asset,'state','pending');
 END IF;
 IF approval->>'status' NOT IN('approved','auto_approved','executed') THEN RAISE EXCEPTION 'approval_status_unverified' USING ERRCODE='P0404'; END IF;
 receipt:=public.atomic_cancel_tournament(p_tournament_id,p_actor_id);
 IF receipt->>'ok' IS DISTINCT FROM 'true' OR receipt->>'fully_settled' IS DISTINCT FROM 'true' OR receipt->>'tournament_id' IS DISTINCT FROM p_tournament_id::text
 THEN RAISE EXCEPTION 'cancellation_receipt_unverified' USING ERRCODE='P0404'; END IF;
 v_result:=jsonb_build_object('ok',true,'pending',false,'op_id',p_op_id,'tournament_id',p_tournament_id,'approval_id',approval->>'approval_id','state','completed','receipt',receipt,'replayed',false);
 marked:=public.fn_ca_operator_mark_executed((approval->>'approval_id')::uuid,v_result,'executed');
 IF marked->>'ok' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'cancellation_approval_close_refused' USING ERRCODE='P0404'; END IF;
 UPDATE public.ca_operator_tournament_operations SET state='completed',result=v_result,completed_at=transaction_timestamp() WHERE op_id=p_op_id;
 PERFORM public.fn_log_admin_action(p_actor_id,'tournament.cancel_refund','tournament',p_tournament_id::text,
  jsonb_build_object('op_id',p_op_id,'reason',btrim(p_reason),'approval_id',approval->>'approval_id'),snapshot,v_result,NULL,NULL,p_request_id);
 RETURN v_result;
END $body$;
REVOKE ALL ON FUNCTION public.fn_ca_operator_cancel_tournament(uuid,uuid,text,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_operator_cancel_tournament(uuid,uuid,text,uuid,text) TO service_role;
DO $$ BEGIN
 IF position('tournament_cancel' in pg_get_functiondef('public.fn_ca_operator_request_approval(text,jsonb,uuid,numeric,text,text,text,text,text,text)'::regprocedure))=0 THEN RAISE EXCEPTION 'cancellation approval kind missing'; END IF;
 IF has_function_privilege('authenticated','public.fn_ca_operator_cancel_tournament(uuid,uuid,text,uuid,text)','EXECUTE') THEN RAISE EXCEPTION 'browser cancellation authority exposed'; END IF;
END $$;
COMMIT;

-- Executable rollback entry point through a separately qualified migration.
-- Keep operation receipts, approval history and additive approval kind: a code
-- rollback cannot undo settled refunds or invalidate their durable evidence.
-- BEGIN;
-- DROP FUNCTION public.fn_ca_operator_cancel_tournament(uuid,uuid,text,uuid,text);
-- COMMIT;
