-- SOURCE ONLY. One request decision and the existing credit authority share
-- a transaction. Requires the full weekly bundle, including 150500.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
LOCK TABLE public.credit_requests IN ACCESS EXCLUSIVE MODE;
DO $preimage$
DECLARE actual jsonb; role_name text; column_name text;
BEGIN
 IF to_regprocedure('public.fn_guard_credit_request_creation()') IS NOT NULL
 THEN RAISE EXCEPTION 'credit_request_creation_guard_preexists';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.oid='public.credit_requests'::regclass
  AND c.relkind='r' AND pg_get_userbyid(c.relowner)='postgres' AND c.relrowsecurity AND NOT c.relforcerowsecurity
  AND NOT EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid))
 THEN RAISE EXCEPTION 'credit_request_table_preimage_changed';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
   'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'acl',a.attacl) ORDER BY a.attnum)
 INTO actual FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
 WHERE a.attrelid='public.credit_requests'::regclass AND a.attnum>0 AND NOT a.attisdropped;
 IF actual IS DISTINCT FROM $columns$[{"acl":null,"name":"id","type":"uuid","default":"gen_random_uuid()","not_null":true},{"acl":null,"name":"requester_id","type":"uuid","default":null,"not_null":true},{"acl":null,"name":"approver_id","type":"uuid","default":null,"not_null":false},{"acl":null,"name":"club_id","type":"uuid","default":null,"not_null":true},{"acl":null,"name":"requested_amount","type":"numeric","default":"0","not_null":true},{"acl":null,"name":"approved_amount","type":"numeric","default":null,"not_null":false},{"acl":null,"name":"reason","type":"text","default":null,"not_null":false},{"acl":null,"name":"status","type":"text","default":"'pending'::text","not_null":true},{"acl":null,"name":"reviewer_notes","type":"text","default":null,"not_null":false},{"acl":null,"name":"created_at","type":"timestamp with time zone","default":"now()","not_null":true},{"acl":null,"name":"reviewed_at","type":"timestamp with time zone","default":null,"not_null":false},{"acl":null,"name":"reviewed_by","type":"uuid","default":null,"not_null":false}]$columns$::jsonb THEN RAISE EXCEPTION 'credit_request_columns_changed';END IF;
 SELECT jsonb_agg(to_jsonb(p) ORDER BY policyname) INTO actual FROM pg_policies p
 WHERE schemaname='public' AND tablename='credit_requests';
 IF actual IS DISTINCT FROM $policies$[{"cmd":"INSERT","qual":null,"roles":["authenticated"],"tablename":"credit_requests","permissive":"PERMISSIVE","policyname":"credit_requests_insert_own","schemaname":"public","with_check":"(requester_id = ( SELECT auth.uid() AS uid))"},{"cmd":"SELECT","qual":"((requester_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1\n   FROM clubs c\n  WHERE ((c.id = credit_requests.club_id) AND (c.owner_id = ( SELECT auth.uid() AS uid))))) OR (EXISTS ( SELECT 1\n   FROM club_members cm\n  WHERE ((cm.club_id = credit_requests.club_id) AND (cm.user_id = ( SELECT auth.uid() AS uid)) AND (cm.role = ANY (ARRAY['owner'::text, 'co_owner'::text, 'admin'::text]))))))","roles":["authenticated"],"tablename":"credit_requests","permissive":"PERMISSIVE","policyname":"credit_requests_select","schemaname":"public","with_check":null},{"cmd":"UPDATE","qual":"((EXISTS ( SELECT 1\n   FROM clubs c\n  WHERE ((c.id = credit_requests.club_id) AND (c.owner_id = ( SELECT auth.uid() AS uid))))) OR (EXISTS ( SELECT 1\n   FROM club_members cm\n  WHERE ((cm.club_id = credit_requests.club_id) AND (cm.user_id = ( SELECT auth.uid() AS uid)) AND (cm.role = ANY (ARRAY['owner'::text, 'co_owner'::text, 'admin'::text]))))))","roles":["authenticated"],"tablename":"credit_requests","permissive":"PERMISSIVE","policyname":"credit_requests_update_manager","schemaname":"public","with_check":null},{"cmd":"SELECT","qual":"(( SELECT fn_is_any_union_overseer(( SELECT auth.uid() AS uid)) AS fn_is_any_union_overseer) AND fn_union_oversees_club(club_id, ( SELECT auth.uid() AS uid)))","roles":["authenticated"],"tablename":"credit_requests","permissive":"PERMISSIVE","policyname":"union_overseer_read","schemaname":"public","with_check":null}]$policies$::jsonb THEN RAISE EXCEPTION 'credit_request_policies_changed';END IF;
 IF (SELECT array_agg(a::text ORDER BY a::text) FROM pg_class c,LATERAL unnest(c.relacl) a
   WHERE c.oid='public.credit_requests'::regclass) IS DISTINCT FROM ARRAY['anon=arwdxtm/postgres','authenticated=arwdxtm/postgres','postgres=arwdDxtm/postgres','service_role=arwdDxtm/postgres']::text[]
 THEN RAISE EXCEPTION 'credit_request_acl_changed';END IF;
 IF (SELECT count(*) FROM pg_constraint WHERE conrelid='public.credit_requests'::regclass)<>1
 OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.credit_requests'::regclass
   AND contype='p' AND conkey=ARRAY[1]::smallint[] AND convalidated AND NOT condeferrable)
 THEN RAISE EXCEPTION 'credit_request_constraints_changed';END IF;
 IF (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.credit_requests'::regclass AND NOT tgisinternal)<>1
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.credit_requests'::regclass
   AND tgname='trg_notify_credit_request' AND tgenabled='O' AND tgtype=21
   AND tgfoid='public.fn_notify_credit_request()'::regprocedure AND tgattr::text='8' AND tgqual IS NULL)
 THEN RAISE EXCEPTION 'credit_request_trigger_changed';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_notify_credit_request()'::regprocedure
  AND md5(pg_get_functiondef(oid))='bce8aaeffc421ff88abdd31f428a5aaa' AND prosecdef AND pg_get_userbyid(proowner)='postgres')
 THEN RAISE EXCEPTION 'credit_request_notification_preimage_changed';END IF;
 -- This is a hash of the literal prosrc from the preceding source component,
 -- not a claimed measured post-install pg_get_functiondef hash.
 IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.fn_admin_update_agent(uuid,text,text,numeric,numeric,numeric,uuid,text,boolean)'::regprocedure
  AND md5(prosrc)='d35ffecfde82d1d24582d95759ec4ed8' AND prosecdef AND pg_get_userbyid(proowner)='postgres')
 THEN RAISE EXCEPTION 'credit_request_requires_exact_150500_authority';END IF;
END $preimage$;

-- Untouched historical decisions remain explicitly unverified. Only this
-- authority may stamp version 1 in the same transaction as the reviewed limit.
ALTER TABLE public.credit_requests ADD COLUMN decision_authority_version smallint;

-- Existing INSERT/read scope remains. Clients can no longer independently
-- change a decision, recipient, review stamp or delete an issued request.
REVOKE UPDATE,DELETE,TRUNCATE,TRIGGER ON public.credit_requests FROM PUBLIC,anon,authenticated,service_role;
DO $columns$ DECLARE role_name text; column_name text; BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  FOR column_name IN SELECT attname FROM pg_attribute WHERE attrelid='public.credit_requests'::regclass AND attnum>0 AND NOT attisdropped LOOP
   EXECUTE format('REVOKE UPDATE (%I) ON public.credit_requests FROM %I',column_name,role_name);
  END LOOP;
 END LOOP;
END $columns$;
DROP POLICY credit_requests_update_manager ON public.credit_requests;

-- An agent cannot see every upline membership through roster RLS. This
-- INSERT-only private validator reads eligibility as owner without granting
-- roster access or changing the INVOKER terminal-decision caller fence.
CREATE FUNCTION public.fn_guard_credit_request_creation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
BEGIN
 IF NEW.status IS DISTINCT FROM 'pending' OR NEW.approved_amount IS NOT NULL OR NEW.reviewed_at IS NOT NULL
   OR NEW.reviewed_by IS NOT NULL OR NEW.reviewer_notes IS NOT NULL OR NEW.decision_authority_version IS NOT NULL
 THEN RAISE EXCEPTION 'credit_request_must_start_pending' USING ERRCODE='23514';END IF;
 IF auth.uid() IS NULL OR NEW.requester_id IS DISTINCT FROM auth.uid()
 THEN RAISE EXCEPTION 'credit_request_requester_identity_required' USING ERRCODE='42501';END IF;
 IF NEW.requested_amount IS NULL OR NEW.requested_amount::text IN('NaN','Infinity','-Infinity')
   OR NEW.requested_amount<=0 OR NEW.requested_amount<>round(NEW.requested_amount,2)
 THEN RAISE EXCEPTION 'credit_request_amount_must_be_positive_cents' USING ERRCODE='22023';END IF;
 IF (SELECT count(*) FROM public.agents a WHERE a.user_id=NEW.requester_id AND a.club_id=NEW.club_id)<>1
 THEN RAISE EXCEPTION 'credit_request_agent_scope_missing_or_ambiguous' USING ERRCODE='23514';END IF;
 IF NEW.approver_id IS NULL OR NEW.approver_id=NEW.requester_id
   OR NOT EXISTS(SELECT 1 FROM public.profiles p WHERE p.id=NEW.approver_id)
   OR NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=NEW.club_id AND
     (c.owner_id=NEW.approver_id OR EXISTS(SELECT 1 FROM public.club_members m
       WHERE m.club_id=NEW.club_id AND m.user_id=NEW.approver_id
         AND m.role IN('owner','co_owner','admin') AND m.status IN('active','approved'))))
 THEN RAISE EXCEPTION 'credit_request_approver_invalid' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.fn_guard_credit_request_creation() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER credit_request_creation_guard BEFORE INSERT ON public.credit_requests
 FOR EACH ROW EXECUTE FUNCTION public.fn_guard_credit_request_creation();

CREATE FUNCTION public.fn_guard_credit_request_decision() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $function$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status IS DISTINCT FROM 'pending' OR NEW.approved_amount IS NOT NULL OR NEW.reviewed_at IS NOT NULL
    OR NEW.reviewed_by IS NOT NULL OR NEW.reviewer_notes IS NOT NULL OR NEW.decision_authority_version IS NOT NULL
  THEN RAISE EXCEPTION 'credit_request_must_start_pending' USING ERRCODE='23514';END IF;
 ELSE
  IF current_user<>'postgres' OR auth.uid() IS NULL
   OR current_setting('app.credit_request_decision',true) IS DISTINCT FROM OLD.id::text||':'||auth.uid()::text
   OR OLD.status IS DISTINCT FROM 'pending' OR OLD.decision_authority_version IS NOT NULL
   OR NEW.decision_authority_version IS DISTINCT FROM 1 OR NEW.status NOT IN('approved','denied','cancelled')
   OR NEW.reviewed_by IS DISTINCT FROM auth.uid() OR NEW.reviewed_at IS NULL
   OR (to_jsonb(NEW)-ARRAY['status','approved_amount','reviewed_at','reviewed_by','reviewer_notes','decision_authority_version'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','approved_amount','reviewed_at','reviewed_by','reviewer_notes','decision_authority_version'])
  THEN RAISE EXCEPTION 'credit_request_requires_atomic_decision' USING ERRCODE='42501';END IF;
 END IF;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.fn_guard_credit_request_decision() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER credit_request_decision_guard BEFORE INSERT OR UPDATE ON public.credit_requests
 FOR EACH ROW EXECUTE FUNCTION public.fn_guard_credit_request_decision();

-- Every new request and decision inserts its notices through the existing
-- notification/outbox transaction. Missing or rewritten notices abort the
-- request/decision too. Replays do not update status or fire this trigger.
CREATE OR REPLACE FUNCTION public.fn_notify_credit_request() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $function$
DECLARE notification_id uuid;recipient uuid;recipients uuid[];
 notice_type text;notice_title text;notice_message text;notice_link text;
BEGIN
 IF TG_OP='INSERT' THEN
  recipients:=ARRAY[NEW.approver_id];notice_type:='credit_request';notice_title:='Credit Request';
  notice_message:=public.fn_notify_display_name(NEW.requester_id)||' requested '||round(NEW.requested_amount,2)::text||' chips credit';
  notice_link:='/credit-admin?club='||NEW.club_id::text;
 ELSIF TG_OP='UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
  IF NEW.status='approved' THEN
   recipients:=ARRAY[NEW.requester_id];notice_type:='credit_approved';notice_title:='Credit Line Updated';
   notice_message:='Your credit line is now '||round(NEW.approved_amount,2)::text||' chips';notice_link:='/clubs/'||NEW.club_id::text||'/agent-dashboard';
  ELSIF NEW.status='denied' THEN
   recipients:=ARRAY[NEW.requester_id];notice_type:='credit_denied';notice_title:='Credit Request Denied';
   notice_message:=COALESCE(NULLIF(btrim(NEW.reviewer_notes),''),'Your credit request was not approved');notice_link:='/clubs/'||NEW.club_id::text||'/agent-dashboard';
  ELSIF NEW.status='cancelled' THEN
   SELECT array_agg(DISTINCT id ORDER BY id) INTO recipients
    FROM unnest(ARRAY[NEW.requester_id,NEW.approver_id]) AS ids(id) WHERE id IS NOT NULL;
   notice_type:='credit_cancelled';notice_title:='Credit Request Cancelled';
   notice_message:='This credit request was cancelled.';
  END IF;
 END IF;
 FOREACH recipient IN ARRAY COALESCE(recipients,ARRAY[]::uuid[]) LOOP
  IF recipient IS NULL THEN RAISE EXCEPTION 'credit_request_notification_missing' USING ERRCODE='23514';END IF;
  IF notice_type='credit_cancelled' THEN
   notice_link:=CASE WHEN recipient=NEW.requester_id THEN '/clubs/'||NEW.club_id::text||'/agent-dashboard'
    ELSE '/credit-admin?club='||NEW.club_id::text END;
  END IF;
  INSERT INTO public.notifications(user_id,type,title,message,link,data)
  VALUES(recipient,notice_type,notice_title,notice_message,notice_link,
   jsonb_build_object('creditRequestId',NEW.id,'clubId',NEW.club_id)) RETURNING id INTO notification_id;
  IF notification_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.notifications n
    WHERE n.id=notification_id AND n.user_id=recipient AND n.type=notice_type
      AND n.title=notice_title AND n.message=notice_message AND n.link=notice_link
      AND n.data->>'creditRequestId'=NEW.id::text AND n.data->>'clubId'=NEW.club_id::text)
  THEN RAISE EXCEPTION 'credit_request_notification_missing' USING ERRCODE='23514';END IF;
 END LOOP;
 RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.fn_notify_credit_request() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_notify_credit_request() TO service_role;

CREATE FUNCTION public.fn_review_credit_request(p_request_id uuid,p_decision text,
 p_approved_amount numeric DEFAULT NULL,p_notes text DEFAULT NULL,p_expected_actor_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public SET statement_timeout='30s' AS $function$
DECLARE actor uuid:=auth.uid(); scope_id uuid; request public.credit_requests%ROWTYPE;
 agent_ids uuid[]; amount numeric; notes text:=NULLIF(btrim(p_notes),''); result jsonb; old_context text;
BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'credit_request_authentication_required' USING ERRCODE='42501';END IF;
 IF p_expected_actor_id IS NULL OR p_expected_actor_id IS DISTINCT FROM actor THEN
  RAISE EXCEPTION 'credit_request_actor_changed' USING ERRCODE='42501';END IF;
 IF p_request_id IS NULL OR p_decision IS NULL OR p_decision NOT IN('approved','denied','cancelled')
 THEN RAISE EXCEPTION 'credit_request_invalid_decision' USING ERRCODE='22023';END IF;
 IF p_decision<>'approved' AND p_approved_amount IS NOT NULL
 THEN RAISE EXCEPTION 'credit_request_unexpected_approved_amount' USING ERRCODE='22023';END IF;
 SELECT club_id INTO scope_id FROM public.credit_requests WHERE id=p_request_id;
 IF scope_id IS NULL THEN RAISE EXCEPTION 'credit_request_missing' USING ERRCODE='22023';END IF;
 -- Same order as the canonical admin/role writers. Never hold a request row
 -- while waiting for a club agreement held by a competing financial update.
 PERFORM pg_advisory_xact_lock(hashtextextended('agent-agreement:'||scope_id::text,0));
 SELECT * INTO request FROM public.credit_requests WHERE id=p_request_id AND club_id=scope_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'credit_request_scope_changed' USING ERRCODE='23514';END IF;
 IF p_decision='cancelled' THEN
  IF actor IS DISTINCT FROM request.requester_id THEN
   RAISE EXCEPTION 'credit_request_only_requester_can_cancel' USING ERRCODE='42501';END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=scope_id AND
    (c.owner_id=actor OR EXISTS(SELECT 1 FROM public.club_members m WHERE m.club_id=scope_id AND m.user_id=actor
       AND m.role IN('owner','co_owner','admin') AND m.status IN('active','approved'))))
  THEN RAISE EXCEPTION 'credit_request_manager_required' USING ERRCODE='42501';END IF;
 END IF;
 amount:=CASE WHEN p_decision='approved' THEN COALESCE(p_approved_amount,request.requested_amount) END;
 IF p_decision='approved' AND (amount IS NULL OR amount::text IN('NaN','Infinity','-Infinity')
   OR amount<=0 OR amount<>round(amount,2))
 THEN RAISE EXCEPTION 'credit_request_amount_must_be_positive_cents' USING ERRCODE='22023';END IF;
 -- The request row itself is the durable decision identity. A later limit
 -- change is never rolled back by a retry of this already-completed request.
 IF request.status IS DISTINCT FROM 'pending' THEN
  IF request.decision_authority_version IS DISTINCT FROM 1 THEN
   RAISE EXCEPTION 'credit_request_legacy_review_unverified' USING ERRCODE='23514';END IF;
  IF request.status=p_decision AND request.reviewed_by=actor AND request.reviewed_at IS NOT NULL
    AND request.approved_amount IS NOT DISTINCT FROM amount
    AND NULLIF(btrim(request.reviewer_notes),'') IS NOT DISTINCT FROM notes
  THEN RETURN jsonb_build_object('success',true,'replayed',true,'request',to_jsonb(request)||jsonb_build_object('requested_amount',request.requested_amount::text,'approved_amount',request.approved_amount::text));END IF;
  RAISE EXCEPTION 'credit_request_decision_conflict' USING ERRCODE='23514';
 END IF;
 IF p_decision='approved' THEN
  SELECT array_agg(a.id ORDER BY a.id) INTO agent_ids FROM public.agents a
   WHERE a.club_id=scope_id AND a.user_id=request.requester_id;
  IF cardinality(agent_ids) IS DISTINCT FROM 1 THEN
   RAISE EXCEPTION 'credit_request_agent_scope_missing_or_ambiguous' USING ERRCODE='23514';END IF;
  result:=public.fn_admin_update_agent(p_agent_id=>agent_ids[1],p_credit_limit=>amount,
   p_assigned_by=>actor,p_credit_reason=>COALESCE(notes,'Credit request approved: '||request.id::text));
  IF result->>'success' IS DISTINCT FROM 'true' OR result->>'agent_id' IS DISTINCT FROM agent_ids[1]::text
    OR result->>'club_id' IS DISTINCT FROM scope_id::text OR (result->>'credit_limit')::numeric IS DISTINCT FROM amount
  THEN RAISE EXCEPTION 'credit_request_credit_authority_refused' USING ERRCODE='23514',DETAIL=result::text;END IF;
 END IF;
 old_context:=current_setting('app.credit_request_decision',true);
 PERFORM set_config('app.credit_request_decision',request.id::text||':'||actor::text,true);
 UPDATE public.credit_requests SET status=p_decision,approved_amount=amount,reviewed_by=actor,
  reviewed_at=transaction_timestamp(),reviewer_notes=notes,decision_authority_version=1 WHERE id=request.id AND status='pending'
  RETURNING * INTO request;
 IF NOT FOUND THEN RAISE EXCEPTION 'credit_request_decision_lost' USING ERRCODE='23514';END IF;
 PERFORM set_config('app.credit_request_decision',COALESCE(old_context,''),true);
 RETURN jsonb_build_object('success',true,'replayed',false,'request',to_jsonb(request)||jsonb_build_object('requested_amount',request.requested_amount::text,'approved_amount',request.approved_amount::text));
END $function$;
REVOKE ALL ON FUNCTION public.fn_review_credit_request(uuid,text,numeric,text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_review_credit_request(uuid,text,numeric,text,uuid) TO authenticated,service_role;
INSERT INTO public.ca_money_rpc_registry(proname,status,notes)
 VALUES('fn_review_credit_request','approved','Authenticated club manager review or own-request cancellation. Club agreement lock and pending decision fence; approves through fn_admin_update_agent in the same transaction, with mandatory terminal notification. Exact request decision replay returns its saved result without resetting later credit limits. No chip transfer or invoice payment.')
ON CONFLICT(proname) DO UPDATE SET status=EXCLUDED.status,notes=EXCLUDED.notes;
DO $authority$ DECLARE role_name text; column_name text; BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_function_privilege(role_name,'public.fn_guard_credit_request_creation()','EXECUTE')
   OR has_function_privilege(role_name,'public.fn_guard_credit_request_decision()','EXECUTE')
  THEN RAISE EXCEPTION 'credit_request_private_guard_executable: %',role_name;END IF;
  IF has_table_privilege(role_name,'public.credit_requests','UPDATE,DELETE,TRUNCATE,TRIGGER') THEN
   RAISE EXCEPTION 'credit_request_direct_writer_remains: %',role_name;END IF;
  FOR column_name IN SELECT attname FROM pg_attribute WHERE attrelid='public.credit_requests'::regclass AND attnum>0 AND NOT attisdropped LOOP
   IF has_column_privilege(role_name,'public.credit_requests',column_name,'UPDATE') THEN
    RAISE EXCEPTION 'credit_request_column_writer_remains: %.%',role_name,column_name;END IF;
  END LOOP;
 END LOOP;
END $authority$;
COMMIT;
