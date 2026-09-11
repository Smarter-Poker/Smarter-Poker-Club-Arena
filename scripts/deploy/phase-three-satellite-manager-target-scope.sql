-- Add the exact target side of the current M2 source-manager transaction.
-- This file is composed into the single Stage B activation transaction.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_sync_tournament_current_players()') AND p.proisstrict=false AND pg_get_function_arguments(p.oid)='' AND pg_get_function_result(p.oid)='trigger' AND md5(p.prosrc)=ANY(ARRAY['ecb120c2c6a4ecee6c2e04d4c9b5ebc7']) AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public']::text[] AND p.prosecdef=true AND p.provolatile='v') THEN
  RAISE EXCEPTION 'satellite manager target requires the exact current roster recount';
 END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.tournament_players'::regclass AND t.tgname='trg_sync_tournament_current_players' AND t.tgfoid=to_regprocedure('public.fn_sync_tournament_current_players()') AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgtype=29 AND t.tgnargs=0 AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgqual IS NULL AND ARRAY(SELECT a.attname::text FROM unnest(t.tgattr::smallint[]) WITH ORDINALITY x(num,ord) JOIN pg_attribute a ON a.attrelid=t.tgrelid AND a.attnum=x.num ORDER BY x.ord)=ARRAY['status','tournament_id']::text[]) THEN
  RAISE EXCEPTION 'satellite manager target requires the exact current roster recount';
 END IF;

 IF EXISTS(SELECT 1 FROM (VALUES
  ('public.fn_ca_satellite_manager_target_immutable()','fba02ebdf76a196cd8997199b56f6da9'),
  ('public.fn_ca_publish_satellite_manager_target(uuid,uuid,jsonb)','92a5126174e4098aa57f4c42fbb9939f'),
  ('public.fn_ca_satellite_manager_target_write(text,text,jsonb,jsonb)','d1b68a808b9ee22eaee833a25bec5ca6')) e(identity,body_md5) WHERE to_regprocedure(e.identity) IS NOT NULL AND NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(e.identity) AND md5(p.prosrc)=e.body_md5 AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[] AND p.proacl=ARRAY['postgres=X/postgres']::aclitem[])) THEN RAISE EXCEPTION 'satellite manager target helper source or owner metadata differs'; END IF;

 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_settle_satellite_tournament(uuid,uuid)')
  AND md5(prosrc)='486d0e6729de8d518d7faf0c253b65d3' AND proowner='postgres'::regrole AND prosecdef)
 OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.fn_ca_satellite_terminal_scope(uuid)')
  AND md5(prosrc)='0bd1220dbfb2e23b27e9e102959829e2' AND proowner='postgres'::regrole AND prosecdef)
 THEN RAISE EXCEPTION 'satellite manager target scope needs the proved current R3 adapter'; END IF;
END $preflight$;

-- A new non-NULL insertion default or required column changes the allowed row.
-- This exact catalog-only comparison also runs against production before DDL.
DO $target_insert_defaults$
BEGIN
 IF (SELECT jsonb_agg(jsonb_build_array(a.attname,a.atttypid::regtype::text,a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attname)
 FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
 WHERE a.attrelid='public.tournament_players'::regclass AND a.attnum>0 AND NOT a.attisdropped
 AND (a.attnotnull OR d.oid IS NOT NULL)) IS DISTINCT FROM $defaults$[["add_on","boolean",false,"false"],["bounties_collected","integer",false,"0"],["bounty_winnings","numeric",false,"0"],["chip_count","numeric",false,"0"],["chips","integer",false,"0"],["current_bounty","numeric",false,"0"],["id","uuid",true,"gen_random_uuid()"],["is_satellite_qualifier","boolean",false,"false"],["mystery_bounty_value","numeric",false,"0"],["prize","numeric",false,"0"],["push_15m_sent","boolean",false,"false"],["push_2m_sent","boolean",false,"false"],["rebuys","integer",false,"0"],["registered_at","timestamp with time zone",false,"now()"],["status","text",false,"'registered'::text"],["tournament_id","uuid",true,null],["user_id","uuid",true,null]]$defaults$::jsonb THEN
 RAISE EXCEPTION 'satellite target registration insertion defaults differ from reviewed row shape'; END IF;
END $target_insert_defaults$;

-- This child cannot outlive, widen, or replace its source capability.
CREATE TABLE IF NOT EXISTS public.tournament_satellite_manager_targets(
 tournament_id uuid PRIMARY KEY REFERENCES public.tournament_satellite_terminal_authorizations(tournament_id) ON DELETE CASCADE,
 token uuid NOT NULL,
 lease_generation uuid NOT NULL,
 target_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE RESTRICT,
 target_before jsonb NOT NULL CHECK(jsonb_typeof(target_before)='object'),
 escrow_before jsonb NOT NULL CHECK(jsonb_typeof(escrow_before)='object'),
 planned_seats jsonb NOT NULL CHECK(jsonb_typeof(planned_seats)='array')
);
ALTER TABLE public.tournament_satellite_manager_targets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_satellite_manager_targets FROM PUBLIC,anon,authenticated,service_role;
DO $target_table_shape$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.tournament_satellite_manager_targets'::regclass
  AND relowner='postgres'::regrole AND relkind='r' AND relrowsecurity)
 OR (SELECT jsonb_agg(jsonb_build_array(attname,atttypid::regtype::text,attnotnull) ORDER BY attnum)
  FROM pg_attribute WHERE attrelid='public.tournament_satellite_manager_targets'::regclass AND attnum>0 AND NOT attisdropped)
  IS DISTINCT FROM '[["tournament_id","uuid",true],["token","uuid",true],["lease_generation","uuid",true],["target_id","uuid",true],["target_before","jsonb",true],["escrow_before","jsonb",true],["planned_seats","jsonb",true]]'::jsonb
 OR (SELECT count(*) FROM pg_constraint WHERE conrelid='public.tournament_satellite_manager_targets'::regclass)<>6
 OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tournament_satellite_manager_targets'::regclass
  AND contype='p' AND conkey=ARRAY[1]::smallint[] AND convalidated)
 OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tournament_satellite_manager_targets'::regclass
  AND contype='f' AND conkey=ARRAY[1]::smallint[] AND confrelid='public.tournament_satellite_terminal_authorizations'::regclass
  AND confkey=ARRAY[1]::smallint[] AND confdeltype='c' AND convalidated)
 OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.tournament_satellite_manager_targets'::regclass
  AND contype='f' AND conkey=ARRAY[4]::smallint[] AND confrelid='public.tournaments'::regclass
  AND confkey=ARRAY[1]::smallint[] AND confdeltype='r' AND convalidated)
 OR EXISTS(SELECT 1 FROM (VALUES ('target_before','object'),('escrow_before','object'),('planned_seats','array')) e(col,kind)
  WHERE NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.tournament_satellite_manager_targets'::regclass
   AND c.contype='c' AND c.convalidated AND pg_get_expr(c.conbin,c.conrelid)='(jsonb_typeof('||e.col||') = '||quote_literal(e.kind)||'::text)'))
 OR EXISTS(SELECT 1 FROM public.tournament_satellite_manager_targets)
 OR has_table_privilege('anon','public.tournament_satellite_manager_targets','SELECT,INSERT,UPDATE,DELETE')
 OR has_table_privilege('authenticated','public.tournament_satellite_manager_targets','SELECT,INSERT,UPDATE,DELETE')
 OR has_table_privilege('service_role','public.tournament_satellite_manager_targets','SELECT,INSERT,UPDATE,DELETE')
 THEN RAISE EXCEPTION 'satellite manager target table shape, ownership, or empty-state differs'; END IF;
END $target_table_shape$;


CREATE OR REPLACE FUNCTION public.fn_ca_satellite_manager_target_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
AS $immutable$
BEGIN
 IF TG_OP='UPDATE' OR pg_trigger_depth()<2 OR EXISTS(
  SELECT 1 FROM public.tournament_satellite_terminal_authorizations
   WHERE tournament_id=OLD.tournament_id) THEN
  RAISE EXCEPTION 'TOURNAMENT_MANAGER_SCOPE_VIOLATION: published satellite target authority is immutable'
   USING ERRCODE='42501';
 END IF;
 RETURN OLD;
END $immutable$;
DROP TRIGGER IF EXISTS satellite_manager_target_immutable ON public.tournament_satellite_manager_targets;
CREATE TRIGGER satellite_manager_target_immutable BEFORE UPDATE OR DELETE ON public.tournament_satellite_manager_targets
 FOR EACH ROW EXECUTE FUNCTION public.fn_ca_satellite_manager_target_immutable();

CREATE OR REPLACE FUNCTION public.fn_ca_publish_satellite_manager_target(
 p_source uuid,p_target uuid,p_plan jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
AS $publish$
DECLARE
 h public.tournament_satellite_settlements%ROWTYPE;
 a public.tournament_satellite_terminal_authorizations%ROWTYPE;
 v_generation uuid; v_before_row jsonb; v_before_escrow jsonb; v_seats jsonb;
BEGIN
 IF current_setting('app.smarter_data_actor',true) IS DISTINCT FROM 'tournament-manager' THEN RETURN; END IF;
 PERFORM public.fn_assert_tournament_manager_write_scope(p_source);
 v_generation:=NULLIF(current_setting('app.smarter_tournament_lease_generation',true),'')::uuid;
 IF NOT public.fn_ca_satellite_terminal_scope(p_source)
  OR current_setting('app.money_path',true) IS DISTINCT FROM 'fn_settle_satellite_tournament' THEN
  RAISE EXCEPTION 'TOURNAMENT_MANAGER_SCOPE_VIOLATION: target plan has no current satellite authority' USING ERRCODE='42501';
 END IF;
 PERFORM 1 FROM public.engine_tournament_leases l WHERE l.tournament_id=p_source
  AND l.protocol_version=2 AND l.lease_generation=v_generation
  AND l.heartbeat_at>=clock_timestamp()-interval '30 seconds' FOR KEY SHARE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'TOURNAMENT_MANAGER_SCOPE_VIOLATION: target plan has no current source lease' USING ERRCODE='42501';
 END IF;
 SELECT * INTO STRICT a FROM public.tournament_satellite_terminal_authorizations WHERE tournament_id=p_source;
 SELECT * INTO STRICT h FROM public.tournament_satellite_settlements WHERE tournament_id=p_source;
 IF h.seat_count=0 THEN RETURN; END IF;
 SELECT to_jsonb(t) INTO STRICT v_before_row FROM public.tournaments t WHERE t.id=p_target;
 SELECT to_jsonb(e) INTO STRICT v_before_escrow FROM public.tournament_escrow e WHERE e.tournament_id=p_target;
 IF p_source IS NOT DISTINCT FROM p_target OR h.target_id IS DISTINCT FROM p_target
  OR h.receipt_version IS DISTINCT FROM 2 OR h.seat_count IS NULL
  OR jsonb_typeof(p_plan) IS DISTINCT FROM 'array'
  OR jsonb_array_length(p_plan) IS DISTINCT FROM h.ticket_award_count
  OR (SELECT count(*) FROM jsonb_array_elements(p_plan) x WHERE x->>'delivery_kind'='seat')<>h.seat_count
  OR (SELECT count(*) FROM jsonb_array_elements(p_plan) x WHERE x->>'delivery_kind'='cash')<>h.cash_ticket_count
  OR (SELECT count(*) FROM jsonb_array_elements(p_plan) x WHERE x->>'delivery_kind'='ticket')<>h.entry_ticket_count
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_plan) x
   WHERE x-ARRAY['place','user_id','delivery_kind']<>'{}'::jsonb
    OR x->>'delivery_kind' NOT IN ('seat','cash','ticket')
    OR NOT EXISTS(SELECT 1 FROM public.tournament_players p WHERE p.tournament_id=p_source
      AND p.user_id=(x->>'user_id')::uuid AND p.position=(x->>'place')::integer))
  OR (SELECT count(DISTINCT x->>'user_id') FROM jsonb_array_elements(p_plan) x)<>h.ticket_award_count
  OR (SELECT count(DISTINCT x->>'place') FROM jsonb_array_elements(p_plan) x)<>h.ticket_award_count
 THEN RAISE EXCEPTION 'TOURNAMENT_MANAGER_SCOPE_VIOLATION: target plan differs from immutable source contract' USING ERRCODE='42501'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id',p.user_id,'place',p.position,'username',p.username)
  ORDER BY p.position),'[]'::jsonb) INTO v_seats
 FROM jsonb_array_elements(p_plan) x JOIN public.tournament_players p
  ON p.tournament_id=p_source AND p.user_id=(x->>'user_id')::uuid AND p.position=(x->>'place')::integer
 WHERE x->>'delivery_kind'='seat';
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_seats) x JOIN public.tournament_players p
  ON p.tournament_id=p_target AND p.user_id=(x->>'user_id')::uuid) THEN
  RAISE EXCEPTION 'TOURNAMENT_MANAGER_SCOPE_VIOLATION: planned target registration already exists' USING ERRCODE='42501';
 END IF;
 INSERT INTO public.tournament_satellite_manager_targets
  (tournament_id,token,lease_generation,target_id,target_before,escrow_before,planned_seats)
 VALUES(p_source,a.token,v_generation,p_target,v_before_row,v_before_escrow,v_seats);
END $publish$;

CREATE OR REPLACE FUNCTION public.fn_ca_satellite_manager_target_write(
 p_relation text,p_operation text,p_old jsonb,p_new jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
AS $target_write$
DECLARE
 v_source_id uuid; v_target_id uuid; v_expected jsonb; v_plan jsonb;
 a public.tournament_satellite_manager_targets%ROWTYPE;
 h public.tournament_satellite_settlements%ROWTYPE;
 v_seat_count integer; v_registered_seats integer; v_unreceipted_seats integer;
 v_live_count integer; v_base_count integer; v_counted_target boolean;
BEGIN
 -- No table, chair, roster UPDATE/DELETE, or tournament INSERT/DELETE exception.
 IF NOT ((p_relation='tournament_players' AND p_operation='INSERT')
  OR (p_relation='tournaments' AND p_operation='UPDATE')) THEN RETURN false; END IF;
 v_source_id:=NULLIF(current_setting('app.smarter_tournament_id',true),'')::uuid;
 IF v_source_id IS NULL THEN RETURN false; END IF;
 PERFORM public.fn_assert_tournament_manager_write_scope(v_source_id);
 v_target_id:=CASE p_relation WHEN 'tournaments' THEN (p_new->>'id')::uuid
  ELSE (p_new->>'tournament_id')::uuid END;
 SELECT * INTO a FROM public.tournament_satellite_manager_targets t
  WHERE t.tournament_id=v_source_id AND t.target_id=v_target_id;
 IF NOT FOUND OR a.lease_generation IS DISTINCT FROM
  NULLIF(current_setting('app.smarter_tournament_lease_generation',true),'')::uuid
  OR a.token IS DISTINCT FROM NULLIF(current_setting('app.tournament_seat_exit_token',true),'')::uuid
  OR NOT public.fn_ca_satellite_terminal_scope(v_source_id)
  OR current_setting('app.money_path',true) IS DISTINCT FROM 'fn_settle_satellite_tournament'
 THEN RETURN false; END IF;
 SELECT * INTO STRICT h FROM public.tournament_satellite_settlements WHERE tournament_id=v_source_id;
 v_seat_count:=jsonb_array_length(a.planned_seats);
 IF h.target_id IS DISTINCT FROM v_target_id OR h.seat_count IS DISTINCT FROM v_seat_count THEN RETURN false; END IF;

 IF p_relation='tournament_players' THEN
  SELECT x INTO v_plan FROM jsonb_array_elements(a.planned_seats) x WHERE x->>'user_id'=p_new->>'user_id';
  IF v_plan IS NULL OR p_old IS NOT NULL OR p_new->>'id' IS NULL
   OR EXISTS(SELECT 1 FROM public.tournament_players p WHERE p.tournament_id=v_target_id
    AND p.user_id=(v_plan->>'user_id')::uuid) THEN RETURN false; END IF;
  v_expected:=jsonb_build_object(
   'id',p_new->'id','tournament_id',v_target_id,'user_id',v_plan->'user_id','username',v_plan->'username',
   'chips',0,'status','registered','prize',0,'rebuys',0,'add_on',false,
   'registered_at',transaction_timestamp(),'bounties_collected',0,'bounty_winnings',0,
   'mystery_bounty_value',0,'current_bounty',0,'chip_count',0,
   'is_satellite_qualifier',true,'source_satellite_id',v_source_id,'push_15m_sent',false,'push_2m_sent',false);
  -- Every unlisted field must retain its NULL insertion default. Never admit a
  -- pre-seated row, terminal marker, rebuy generation, bounty, or unrelated club.
  RETURN jsonb_strip_nulls(p_new)=jsonb_strip_nulls(v_expected);
 END IF;

 -- The live, source-pinned roster trigger recounts each newly inserted row
 -- before M2 writes that row's award. It changes only the lobby headcount.
 v_base_count:=(a.target_before->>'current_players')::integer;
 v_counted_target:=a.target_before->>'status' IN ('ANNOUNCED','REGISTERING');
 SELECT count(*),count(*) FILTER(WHERE NOT EXISTS(
   SELECT 1 FROM public.tournament_satellite_awards w WHERE w.tournament_id=v_source_id
    AND w.delivery_kind='seat' AND w.registration_id=p.id
    AND w.user_id=p.user_id AND w.place=(x->>'place')::integer))
  INTO v_registered_seats,v_unreceipted_seats
 FROM jsonb_array_elements(a.planned_seats) x JOIN public.tournament_players p
  ON p.tournament_id=v_target_id AND p.user_id=(x->>'user_id')::uuid
 WHERE p.status='registered' AND p.chips=0 AND p.chip_count=0
  AND p.table_id IS NULL AND p.seat_number IS NULL
  AND p.username IS NOT DISTINCT FROM x->>'username'
  AND p.is_satellite_qualifier AND p.source_satellite_id=v_source_id;
 SELECT count(*) INTO v_live_count FROM public.tournament_players p
  WHERE p.tournament_id=v_target_id AND p.status IN ('registered','playing');
 IF v_counted_target AND pg_trigger_depth()>=2
  AND v_registered_seats BETWEEN 1 AND v_seat_count AND v_unreceipted_seats=1
  AND (p_old->>'id')::uuid=v_target_id AND (p_new->>'id')::uuid=v_target_id
  AND (p_new-'current_players')=(p_old-'current_players')
  AND (p_old-ARRAY['current_players','updated_at'])=(a.target_before-ARRAY['current_players','updated_at'])
  AND ((p_old->>'updated_at')::timestamptz IS NOT DISTINCT FROM (a.target_before->>'updated_at')::timestamptz
    OR (p_old->>'updated_at')::timestamptz=transaction_timestamp())
  AND (p_old->>'current_players')::integer=v_base_count+v_registered_seats-1
  AND (p_new->>'current_players')::integer=v_base_count+v_registered_seats
  AND (p_new->>'current_players')::integer=v_live_count
 THEN RETURN true; END IF;

 -- M2's final assignment uses its captured target count. The genuine nested
 -- recount has already included the inserted rows for a registering target;
 -- a RUNNING target is not touched by that roster trigger.
 IF (p_old-ARRAY['current_players','updated_at'])
    IS DISTINCT FROM (a.target_before-ARRAY['current_players','updated_at'])
  OR (p_old->>'id')::uuid IS DISTINCT FROM v_target_id
  OR ((p_old->>'updated_at')::timestamptz IS DISTINCT FROM (a.target_before->>'updated_at')::timestamptz
    AND (p_old->>'updated_at')::timestamptz IS DISTINCT FROM transaction_timestamp())
  OR (p_old->>'current_players')::integer IS DISTINCT FROM
     (v_base_count+CASE WHEN v_counted_target THEN v_seat_count ELSE 0 END)
  OR (p_new-ARRAY['current_players','prize_pool','total_rake','updated_at'])
   IS DISTINCT FROM (p_old-ARRAY['current_players','prize_pool','total_rake','updated_at'])
  OR (p_new->>'current_players')::integer IS DISTINCT FROM v_base_count+v_seat_count
  OR (p_new->>'prize_pool')::numeric IS DISTINCT FROM round((a.target_before->>'prize_pool')::numeric+v_seat_count*h.target_buy_in,2)
  OR (p_new->>'total_rake')::numeric IS DISTINCT FROM round((a.target_before->>'total_rake')::numeric+v_seat_count*h.target_fee,2)
  OR (p_new->>'updated_at')::timestamptz IS DISTINCT FROM transaction_timestamp()
 THEN RETURN false; END IF;
 -- The registration precedes its award. This aggregate update follows all
 -- awards, so every planned registration must now have its exact funded receipt.
 IF (SELECT count(*) FROM public.tournament_satellite_awards w
      WHERE w.tournament_id=v_source_id AND w.delivery_kind='seat')<>v_seat_count
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(a.planned_seats) x WHERE NOT EXISTS(
  SELECT 1 FROM public.tournament_satellite_awards w
   JOIN public.tournament_players p ON p.id=w.registration_id
   JOIN public.tournament_payouts pay ON pay.id=w.payout_id
   JOIN public.chip_ledger l ON l.idempotency_key='tourney:'||v_source_id::text||':seat:'||(x->>'user_id')||':pool_transfer'
  WHERE w.tournament_id=v_source_id AND w.user_id=(x->>'user_id')::uuid
   AND w.place=(x->>'place')::integer AND w.delivery_kind='seat' AND w.amount=h.ticket_cost
   AND p.tournament_id=v_target_id AND p.user_id=w.user_id AND p.status='registered'
   AND p.chips=0 AND p.table_id IS NULL AND p.seat_number IS NULL
   AND p.is_satellite_qualifier AND p.source_satellite_id=v_source_id
   AND pay.tournament_id=v_source_id AND pay.user_id=w.user_id AND pay.amount=h.ticket_cost
   AND pay.source='satellite_seat' AND pay.idempotency_key=w.idempotency_key
   AND l.from_type='prize_liability' AND l.from_entity_id=v_source_id
   AND l.to_type='prize_liability' AND l.to_entity_id=v_target_id AND l.amount=h.ticket_cost
   AND l.category='tournament_buyin' AND l.metadata->>'registration_id'=p.id::text))
 OR NOT EXISTS(SELECT 1 FROM public.tournament_escrow e WHERE e.tournament_id=v_target_id
   AND e.prize_balance=(a.escrow_before->>'prize_balance')::numeric+v_seat_count*h.target_buy_in
   AND e.fee_balance=(a.escrow_before->>'fee_balance')::numeric+v_seat_count*h.target_fee
   AND e.satellite_in=(a.escrow_before->>'satellite_in')::numeric+v_seat_count*h.target_buy_in
   AND e.satellite_fee_in=(a.escrow_before->>'satellite_fee_in')::numeric+v_seat_count*h.target_fee
   AND (to_jsonb(e)-ARRAY['satellite_in','satellite_fee_in','prize_balance','fee_balance','updated_at'])
    IS NOT DISTINCT FROM (a.escrow_before-ARRAY['satellite_in','satellite_fee_in','prize_balance','fee_balance','updated_at'])
   AND e.enforced AND e.closed_at IS NULL)
 THEN RETURN false; END IF;
 RETURN true;
END $target_write$;

REVOKE ALL ON FUNCTION public.fn_ca_satellite_manager_target_immutable(),
 public.fn_ca_publish_satellite_manager_target(uuid,uuid,jsonb),
 public.fn_ca_satellite_manager_target_write(text,text,jsonb,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;

-- Exact transformations are generated from the reviewed adapter/Stage B bodies.
DO $patch_core$
DECLARE f oid:=to_regprocedure('public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)');
 body text; definition text; before_meta jsonb; after_meta jsonb;
BEGIN
 SELECT prosrc,pg_get_functiondef(oid),to_jsonb(p)-'prosrc' INTO body,definition,before_meta FROM pg_proc p WHERE oid=f;
 IF f IS NULL OR md5(body) NOT IN ('0e2066fafe3c4e1fceb96db9937b3140','c5ba0595fc5363ecc94243b003a3d326')
  OR (before_meta->>'proowner')::oid<>'postgres'::regrole::oid
  OR (before_meta->>'prosecdef')::boolean IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'satellite manager target core preimage differs'; END IF;
 IF md5(body)='0e2066fafe3c4e1fceb96db9937b3140' THEN
  EXECUTE replace(definition,body,replace(body,'  UPDATE public.tournaments
     SET status = ''COMPLETING'', updated_at = now()','  PERFORM public.fn_ca_publish_satellite_manager_target(
    p_tournament_id,v_target_id,v_plan);

  UPDATE public.tournaments
     SET status = ''COMPLETING'', updated_at = now()'));
 END IF;
 SELECT prosrc,to_jsonb(p)-'prosrc' INTO body,after_meta FROM pg_proc p WHERE oid=f;
 IF md5(body)<>'c5ba0595fc5363ecc94243b003a3d326' OR before_meta IS DISTINCT FROM after_meta THEN
  RAISE EXCEPTION 'satellite manager target core source or metadata postimage differs'; END IF;
END $patch_core$;


DO $postflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.fn_sync_tournament_current_players()') AND p.proisstrict=false AND pg_get_function_arguments(p.oid)='' AND pg_get_function_result(p.oid)='trigger' AND md5(p.prosrc)=ANY(ARRAY['ecb120c2c6a4ecee6c2e04d4c9b5ebc7']) AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text='{postgres=X/postgres,service_role=X/postgres}' AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public']::text[] AND p.prosecdef=true AND p.provolatile='v') THEN
  RAISE EXCEPTION 'satellite manager target requires the exact current roster recount';
 END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid='public.tournament_players'::regclass AND t.tgname='trg_sync_tournament_current_players' AND t.tgfoid=to_regprocedure('public.fn_sync_tournament_current_players()') AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgtype=29 AND t.tgnargs=0 AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgqual IS NULL AND ARRAY(SELECT a.attname::text FROM unnest(t.tgattr::smallint[]) WITH ORDINALITY x(num,ord) JOIN pg_attribute a ON a.attrelid=t.tgrelid AND a.attnum=x.num ORDER BY x.ord)=ARRAY['status','tournament_id']::text[]) THEN
  RAISE EXCEPTION 'satellite manager target requires the exact current roster recount';
 END IF;

 IF EXISTS(SELECT 1 FROM (VALUES
  ('public.fn_ca_satellite_manager_target_immutable()','fba02ebdf76a196cd8997199b56f6da9'),
  ('public.fn_ca_publish_satellite_manager_target(uuid,uuid,jsonb)','92a5126174e4098aa57f4c42fbb9939f'),
  ('public.fn_ca_satellite_manager_target_write(text,text,jsonb,jsonb)','d1b68a808b9ee22eaee833a25bec5ca6')) e(identity,body_md5) WHERE NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(e.identity) AND md5(p.prosrc)=e.body_md5 AND p.proowner='postgres'::regrole AND p.prosecdef AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[] AND p.proacl=ARRAY['postgres=X/postgres']::aclitem[])) THEN RAISE EXCEPTION 'satellite manager target helper source or owner metadata differs'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.tournament_satellite_manager_targets'::regclass AND tgname='satellite_manager_target_immutable' AND tgenabled='O' AND tgfoid='public.fn_ca_satellite_manager_target_immutable()'::regprocedure AND tgtype=27) THEN RAISE EXCEPTION 'satellite target immutability trigger differs'; END IF;
END $postflight$;
COMMIT;

