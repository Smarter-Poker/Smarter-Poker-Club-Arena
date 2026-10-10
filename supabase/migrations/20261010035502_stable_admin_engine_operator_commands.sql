-- Durable, authenticated operator intent belongs to the engine's existing
-- hand boundary and maintenance owners. A lost HTTP acknowledgement reuses
-- one UUID. Floor holds are independent of Lightning and tournament holds.
-- Cash closure returns every occupancy through the existing cashout owner;
-- this migration never credits, deletes seats, or alters a player balance.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $preflight$ BEGIN
 IF to_regprocedure('public.fn_ca_operator_permissions(uuid)') IS NULL OR to_regprocedure('public.fn_log_admin_action(uuid,text,text,text,jsonb,jsonb,jsonb,text,text,text)') IS NULL OR to_regclass('public.table_seats') IS NULL OR to_regclass('public.hand_state_snapshots') IS NULL OR to_regclass('public.ca_declared_money_triggers') IS NULL THEN RAISE EXCEPTION 'engine_operator_prerequisite_missing'; END IF;
 IF to_regclass('public.ca_engine_operator_commands') IS NOT NULL OR to_regclass('public.ca_operator_floor_hold') IS NOT NULL OR to_regclass('public.ca_operator_table_closes') IS NOT NULL THEN RAISE EXCEPTION 'engine_operator_contract_already_present_do_not_replay'; END IF;
END $preflight$;
CREATE TABLE public.ca_engine_operator_commands (
 id uuid PRIMARY KEY, actor_id uuid NOT NULL, domain text NOT NULL CHECK(domain IN ('floor','maintenance')),
 action text NOT NULL, reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 500),
 status text NOT NULL, announced_at timestamptz, result jsonb, end_requested_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.ca_engine_operator_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_engine_operator_commands FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.ca_engine_operator_commands TO service_role;
CREATE INDEX ca_engine_operator_maintenance_queue ON public.ca_engine_operator_commands(announced_at) WHERE domain='maintenance' AND status='queued';
CREATE TABLE public.ca_operator_floor_hold (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), operation_id uuid NOT NULL,
 mode text NOT NULL CHECK(mode IN ('pause','park')), reason text NOT NULL
);
ALTER TABLE public.ca_operator_floor_hold ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_operator_floor_hold FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.ca_operator_floor_hold TO service_role;
CREATE TABLE public.ca_operator_table_closes (
 table_id uuid PRIMARY KEY, operation_id uuid NOT NULL, actor_id uuid NOT NULL,
 reason text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','closed'))
);
ALTER TABLE public.ca_operator_table_closes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_operator_table_closes FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.ca_operator_table_closes TO service_role;

CREATE FUNCTION public.fn_ca_engine_operator_command(p_actor_id uuid,p_operation_id uuid,p_domain text,p_action text,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE v public.ca_engine_operator_commands; v_permissions jsonb; v_announcement timestamptz; v_before jsonb;
BEGIN
 IF current_setting('request.jwt.claim.role',true) IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'engine_operator_forbidden' USING ERRCODE='42501'; END IF;
 v_permissions := public.fn_ca_operator_permissions(p_actor_id)->'permissions';
 IF jsonb_typeof(v_permissions) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'engine_operator_authority_unknown' USING ERRCODE='58000'; END IF;
 IF NOT coalesce(v_permissions ? CASE WHEN p_domain='floor' THEN 'clubs.write' ELSE 'settings.write' END,false) THEN RAISE EXCEPTION 'engine_operator_forbidden' USING ERRCODE='42501'; END IF;
 IF p_operation_id IS NULL OR p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 10 AND 500 OR p_domain NOT IN ('floor','maintenance') THEN RAISE EXCEPTION 'invalid_operator_command'; END IF;
 PERFORM pg_advisory_xact_lock(530093);
 SELECT * INTO v FROM public.ca_engine_operator_commands WHERE id=p_operation_id FOR UPDATE;
 IF FOUND THEN
  IF v.actor_id<>p_actor_id OR v.domain<>p_domain THEN RAISE EXCEPTION 'operation_identity_conflict'; END IF;
  v_before:=to_jsonb(v);
  IF p_action IN ('cancel','end') AND p_domain='maintenance' THEN
   IF p_action='cancel' AND v.status='queued' AND clock_timestamp()<v.announced_at THEN
    UPDATE public.ca_engine_operator_commands SET status='cancelled',updated_at=clock_timestamp() WHERE id=v.id RETURNING * INTO v;
    PERFORM public.fn_log_admin_action(p_actor_id,'engine_operator.maintenance.cancel','engine_operator_command',v.id::text,jsonb_build_object('reason',p_reason),v_before,to_jsonb(v),NULL,NULL,v.id::text||':cancel');
   ELSIF p_action='cancel' AND v.status<>'cancelled' THEN RAISE EXCEPTION 'maintenance_already_applied';
   ELSIF p_action='end' AND v.status NOT IN ('applying','active','completed') THEN RAISE EXCEPTION 'maintenance_request_not_applied';
   ELSIF p_action='end' AND clock_timestamp()<v.announced_at+interval '7 minutes' THEN RAISE EXCEPTION 'maintenance_deadline_not_reached';
   ELSIF p_action='end' AND v.end_requested_at IS NULL THEN
    UPDATE public.ca_engine_operator_commands SET end_requested_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=v.id RETURNING * INTO v;
    PERFORM public.fn_log_admin_action(p_actor_id,'engine_operator.maintenance.end','engine_operator_command',v.id::text,jsonb_build_object('reason',p_reason),v_before,to_jsonb(v),NULL,NULL,v.id::text||':end');
   END IF;
  ELSIF v.action<>p_action OR v.reason<>p_reason THEN RAISE EXCEPTION 'operation_identity_conflict'; END IF;
  RETURN to_jsonb(v);
 END IF;
 IF p_domain='maintenance' AND p_action='start' THEN
  v_announcement:=date_trunc('hour',clock_timestamp())+interval '53 minutes';
  IF v_announcement<=clock_timestamp() THEN v_announcement:=v_announcement+interval '1 hour'; END IF;
  IF EXISTS(SELECT 1 FROM public.ca_engine_operator_commands WHERE domain='maintenance' AND status='queued') THEN RAISE EXCEPTION 'maintenance_request_already_queued'; END IF;
  INSERT INTO public.ca_engine_operator_commands(id,actor_id,domain,action,reason,status,announced_at,result,created_at,updated_at) VALUES(p_operation_id,p_actor_id,p_domain,p_action,p_reason,'queued',v_announcement,NULL,clock_timestamp(),clock_timestamp()) RETURNING * INTO v;
 ELSIF p_domain='floor' AND p_action IN ('pause','park','resume','close_cash') THEN
  INSERT INTO public.ca_engine_operator_commands(id,actor_id,domain,action,reason,status) VALUES(p_operation_id,p_actor_id,p_domain,p_action,p_reason,'accepted') RETURNING * INTO v;
  IF p_action='resume' THEN DELETE FROM public.ca_operator_floor_hold WHERE id=true;
  ELSIF p_action IN ('pause','park') THEN
   INSERT INTO public.ca_operator_floor_hold VALUES(true,p_operation_id,p_action,p_reason) ON CONFLICT(id) DO UPDATE SET operation_id=excluded.operation_id,mode=excluded.mode,reason=excluded.reason;
  ELSE
   IF EXISTS(SELECT 1 FROM public.ca_operator_table_closes WHERE status='pending') THEN RAISE EXCEPTION 'cash_floor_close_in_progress'; END IF;
   INSERT INTO public.ca_operator_table_closes(table_id,operation_id,actor_id,reason)
    SELECT id,p_operation_id,p_actor_id,p_reason FROM public.tables WHERE tournament_id IS NULL AND status IN ('running','active','waiting')
    ON CONFLICT(table_id) DO UPDATE SET operation_id=excluded.operation_id,actor_id=excluded.actor_id,reason=excluded.reason,status='pending' WHERE public.ca_operator_table_closes.status='closed';
   UPDATE public.ca_engine_operator_commands SET status=CASE WHEN EXISTS(SELECT 1 FROM public.ca_operator_table_closes WHERE operation_id=p_operation_id) THEN 'accepted' ELSE 'completed' END,result=jsonb_build_object('targetedTables',(SELECT count(*) FROM public.ca_operator_table_closes WHERE operation_id=p_operation_id),'scope','cash_tables_only') WHERE id=p_operation_id RETURNING * INTO v;
  END IF;
 ELSE RAISE EXCEPTION 'invalid_operator_command'; END IF;
 PERFORM public.fn_log_admin_action(p_actor_id,'engine_operator.'||p_domain||'.'||p_action,'engine_operator_command',v.id::text,jsonb_build_object('reason',p_reason,'operation_id',v.id),NULL,to_jsonb(v),NULL,NULL,v.id::text||':'||p_action);
 RETURN to_jsonb(v);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_engine_operator_command(uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_engine_operator_command(uuid,uuid,text,text,text) TO service_role;

CREATE FUNCTION public.fn_ca_operator_floor_state(p_table_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
 SELECT jsonb_build_object('hold',(SELECT to_jsonb(h) FROM public.ca_operator_floor_hold h),
 'close',(SELECT to_jsonb(c) FROM public.ca_operator_table_closes c WHERE c.table_id=p_table_id AND c.status='pending'));
$fn$;
REVOKE ALL ON FUNCTION public.fn_ca_operator_floor_state(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_operator_floor_state(uuid) TO service_role;

CREATE FUNCTION public.fn_ca_engine_operator_observe(p_operation_id uuid,p_status text,p_result jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
BEGIN
 IF current_setting('request.jwt.claim.role',true) IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'engine_operator_forbidden' USING ERRCODE='42501'; END IF;
 IF p_status NOT IN ('active','completed','accepted') THEN RAISE EXCEPTION 'invalid_operator_status'; END IF;
 UPDATE public.ca_engine_operator_commands SET status=p_status,result=p_result,updated_at=clock_timestamp()
 WHERE id=p_operation_id AND status<>'cancelled';
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_engine_operator_observe(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_engine_operator_observe(uuid,text,jsonb) TO service_role;

CREATE FUNCTION public.fn_ca_operator_finish_cash_close(p_table_id uuid,p_operation_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
BEGIN
 IF current_setting('request.jwt.claim.role',true) IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'engine_operator_forbidden' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.tables WHERE id=p_table_id AND tournament_id IS NULL FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.ca_operator_table_closes WHERE table_id=p_table_id AND operation_id=p_operation_id AND status='pending') THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.table_seats WHERE table_id=p_table_id AND left_at IS NULL)
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=p_table_id AND is_complete=false) THEN RETURN false; END IF;
 UPDATE public.tables SET status='closed' WHERE id=p_table_id;
 UPDATE public.ca_operator_table_closes SET status='closed' WHERE table_id=p_table_id AND operation_id=p_operation_id;
 IF NOT EXISTS(SELECT 1 FROM public.ca_operator_table_closes WHERE operation_id=p_operation_id AND status='pending') THEN
  UPDATE public.ca_engine_operator_commands SET status='completed',updated_at=clock_timestamp() WHERE id=p_operation_id;
 END IF;
 RETURN true;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_operator_finish_cash_close(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_operator_finish_cash_close(uuid,uuid) TO service_role;


CREATE FUNCTION public.fn_ca_engine_operator_claim_hourly(p_announced_at timestamptz)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE v_id uuid;
BEGIN
 IF current_setting('request.jwt.claim.role',true) IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'engine_operator_forbidden' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(530093);
 SELECT id INTO v_id FROM public.ca_engine_operator_commands WHERE domain='maintenance' AND status='queued' AND announced_at<=p_announced_at ORDER BY announced_at LIMIT 1 FOR UPDATE;
 IF v_id IS NOT NULL THEN
  UPDATE public.ca_engine_operator_commands SET status='applying',announced_at=p_announced_at,updated_at=clock_timestamp() WHERE id=v_id;
 END IF;
 RETURN v_id;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_engine_operator_claim_hourly(timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_engine_operator_claim_hourly(timestamptz) TO service_role;

-- Park and close block new occupancies, including rows re-used on a rejoin.
CREATE FUNCTION public.fn_ca_operator_floor_entry_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
BEGIN
 -- Seat admission and floor commands share the original transaction edge.
 PERFORM pg_advisory_xact_lock_shared(530093);
 IF NEW.left_at IS NULL AND (TG_OP='INSERT' OR OLD.left_at IS NOT NULL OR NEW.occupancy_id IS DISTINCT FROM OLD.occupancy_id) AND
 (EXISTS(SELECT 1 FROM public.ca_operator_floor_hold WHERE mode='park') OR EXISTS(SELECT 1 FROM public.ca_operator_table_closes WHERE table_id=NEW.table_id)) THEN
  RAISE EXCEPTION 'OPERATOR_FLOOR_PARKED' USING ERRCODE='55006';
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_ca_operator_floor_entry_guard() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_operator_floor_entry_guard() TO service_role;
CREATE TRIGGER ca_operator_floor_entry_guard BEFORE INSERT OR UPDATE OF left_at,occupancy_id ON public.table_seats FOR EACH ROW EXECUTE FUNCTION public.fn_ca_operator_floor_entry_guard();
INSERT INTO public.ca_declared_money_triggers(table_name,trigger_name,note) VALUES ('table_seats','ca_operator_floor_entry_guard','Serialize new seat occupancies with the operator park and cash-close transaction; retain existing hands and original cashout owners.');
DO $postflight$ DECLARE v_name text; BEGIN
 FOREACH v_name IN ARRAY ARRAY['ca_engine_operator_commands','ca_operator_floor_hold','ca_operator_table_closes'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=v_name AND c.relrowsecurity) OR has_table_privilege('authenticated','public.'||v_name,'INSERT') OR has_table_privilege('anon','public.'||v_name,'UPDATE') THEN RAISE EXCEPTION 'engine_operator_storage_security_not_installed:%',v_name; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM public.ca_declared_money_triggers WHERE table_name='table_seats' AND trigger_name='ca_operator_floor_entry_guard') THEN RAISE EXCEPTION 'engine_operator_floor_trigger_not_declared'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='ca_operator_floor_entry_guard' AND tgrelid='public.table_seats'::regclass AND tgenabled='O') OR has_function_privilege('authenticated','public.fn_ca_engine_operator_command(uuid,uuid,text,text,text)','EXECUTE') OR NOT has_function_privilege('service_role','public.fn_ca_engine_operator_command(uuid,uuid,text,text,text)','EXECUTE') THEN RAISE EXCEPTION 'engine_operator_owner_contract_not_installed'; END IF;
END $postflight$;
COMMIT;
