-- Dual delivery for exactly the existing member-record and club-roster private
-- invalidations. Paid delivery stays ON until an explicit owner cutover after
-- serving engine/client proof and the previous-client transition is resolved.
-- No gameplay, financial, storage-retention or other notification changes.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
DO $preimage$
BEGIN
 IF md5(pg_get_functiondef('public.fn_publish_member_record_topic(text,jsonb)'::regprocedure))<>'0c22180fc78b612bf07c087bcc013ff0'
 OR md5(pg_get_functiondef('public.fn_publish_club_roster(uuid)'::regprocedure))<>'0d14d98d8cb2447703fd4a59de6b443b' THEN
   RAISE EXCEPTION 'Private record transport preimage changed; qualify current definitions';
 END IF;
END $preimage$;
CREATE TABLE public.ca_private_record_transport_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 supabase_enabled boolean NOT NULL DEFAULT true,
 source_fingerprints jsonb NOT NULL DEFAULT '{}'::jsonb
);
ALTER TABLE public.ca_private_record_transport_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_private_record_transport_state FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO public.ca_private_record_transport_state(singleton) VALUES(true);
CREATE FUNCTION public.fn_dispatch_private_record_signal(p_topic text,p_payload jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE paid boolean;
BEGIN
 IF p_topic IS NULL OR NOT (
   p_topic ~ '^member-record:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   OR p_topic ~ '^club-roster:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 ) THEN RAISE EXCEPTION 'Invalid private record topic'; END IF;
 SELECT supabase_enabled INTO STRICT paid FROM public.ca_private_record_transport_state WHERE singleton;
 PERFORM pg_notify('ca_private_record_changes',jsonb_build_object('topic',p_topic,'event','record_changed')::text);
 IF paid THEN PERFORM realtime.send(p_payload,'record_changed',p_topic,true); END IF;
END $$;
REVOKE ALL ON FUNCTION public.fn_dispatch_private_record_signal(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
DO $patch$
DECLARE original text; old_call text; new_call text;
BEGIN
 SELECT pg_get_functiondef('public.fn_publish_member_record_topic(text,jsonb)'::regprocedure) INTO original;
 old_call:=$old$PERFORM realtime.send(p_payload,'record_changed',p_topic,true);$old$;
 new_call:=$new$PERFORM public.fn_dispatch_private_record_signal(p_topic,p_payload);$new$;
 IF (length(original)-length(replace(original,old_call,'')))/length(old_call)<>1 THEN RAISE EXCEPTION 'Member topic dispatcher preimage changed'; END IF;
 EXECUTE replace(original,old_call,new_call);
 SELECT pg_get_functiondef('public.fn_publish_club_roster(uuid)'::regprocedure) INTO original;
 old_call:=$old$PERFORM realtime.send('{}'::jsonb,'record_changed','club-roster:'||target::text,true);$old$;
 new_call:=$new$PERFORM public.fn_dispatch_private_record_signal('club-roster:'||target::text,'{}'::jsonb);$new$;
 IF (length(original)-length(replace(original,old_call,'')))/length(old_call)<>1 THEN RAISE EXCEPTION 'Roster dispatcher preimage changed'; END IF;
 EXECUTE replace(original,old_call,new_call);
END $patch$;
-- Installation captures all connected definitions. The service capability read
-- refuses drift; it never enables or disables either transport.
UPDATE public.ca_private_record_transport_state
SET source_fingerprints=(SELECT jsonb_object_agg(signature,md5(pg_get_functiondef(signature::regprocedure)))
 FROM unnest(ARRAY['public.fn_dispatch_private_record_signal(text,jsonb)',
 'public.fn_publish_member_record_topic(text,jsonb)',
 'public.fn_publish_member_record_user(uuid)',
 'public.fn_publish_member_record_row()',
 'public.fn_publish_club_roster(uuid)']) signature)
WHERE singleton;
CREATE FUNCTION public.fn_private_record_transport_ready() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.ca_private_record_transport_state s WHERE s.singleton
 AND (SELECT count(*) FROM jsonb_each(s.source_fingerprints))=5
 AND NOT EXISTS(SELECT 1 FROM jsonb_each_text(s.source_fingerprints) e
  WHERE to_regprocedure(e.key) IS NULL OR md5(pg_get_functiondef(to_regprocedure(e.key))) IS DISTINCT FROM e.value))
$$;
REVOKE ALL ON FUNCTION public.fn_private_record_transport_ready() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_private_record_transport_ready() TO service_role;
COMMIT;
