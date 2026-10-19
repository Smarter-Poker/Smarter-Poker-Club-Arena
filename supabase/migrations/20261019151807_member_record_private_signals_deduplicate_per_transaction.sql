-- Private record_changed consumers re-read committed state and ignore payloads.
-- Repeated source changes in one transaction therefore require one invalidation
-- per existing private topic, including removed memberships and shared uplines.
-- No horse exclusion, data/financial change, delayed delivery or new timer.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
DO $preimage$
BEGIN
 IF md5(pg_get_functiondef('public.fn_publish_member_record_user(uuid)'::regprocedure))<>'04b2e4905473f4577d2e601fbb5ba4cc'
 OR md5(pg_get_functiondef('public.fn_publish_member_record_row()'::regprocedure))<>'6bda63ef4d87cf49cacf3de6cf7c8d59' THEN
   RAISE EXCEPTION 'Member signal source preimage changed; qualify current definitions';
 END IF;
END $preimage$;
CREATE FUNCTION public.fn_publish_member_record_topic(p_topic text,p_payload jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE sent jsonb:=coalesce(nullif(current_setting('ca.member_record_signaled_topics',true),''),'[]')::jsonb;
BEGIN
  IF p_topic IS NULL OR p_topic !~ '^member-record:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'Invalid member record topic';
  END IF;
  IF sent ? p_topic THEN RETURN; END IF;
  PERFORM realtime.send(p_payload,'record_changed',p_topic,true);
  -- Only a successful send consumes the topic. SET LOCAL and the message both
  -- roll back at a savepoint or transaction boundary; future commits send again.
  PERFORM set_config('ca.member_record_signaled_topics',(sent||to_jsonb(p_topic))::text,true);
END $$;
REVOKE ALL ON FUNCTION public.fn_publish_member_record_topic(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
DO $patch$
DECLARE original text; patched text; old_call text; new_call text;
BEGIN
 SELECT pg_get_functiondef('public.fn_publish_member_record_user(uuid)'::regprocedure) INTO original;
 old_call:=$old$PERFORM realtime.send(jsonb_build_object('user_id',p_user),
        'record_changed','member-record:'||target.club_id::text||':'||target.user_id::text,true);$old$;
 new_call:=$new$PERFORM public.fn_publish_member_record_topic(
        'member-record:'||target.club_id::text||':'||target.user_id::text,jsonb_build_object('user_id',p_user));$new$;
 IF (length(original)-length(replace(original,old_call,'')))/length(old_call)<>1 THEN
   RAISE EXCEPTION 'Member publisher send preimage changed';
 END IF;
 patched:=replace(original,old_call,new_call);
 EXECUTE patched;
 SELECT pg_get_functiondef('public.fn_publish_member_record_row()'::regprocedure) INTO original;
 old_call:=$old$PERFORM realtime.send('{}'::jsonb,'record_changed','member-record:'||(r->>'club_id')||':'||old_user::text,true);$old$;
 new_call:=$new$PERFORM public.fn_publish_member_record_topic('member-record:'||(r->>'club_id')||':'||old_user::text,'{}'::jsonb);$new$;
 IF (length(original)-length(replace(original,old_call,'')))/length(old_call)<>1 THEN
   RAISE EXCEPTION 'Removed membership send preimage changed';
 END IF;
 EXECUTE replace(original,old_call,new_call);
END $patch$;
COMMIT;
