-- Unchanged private-record source rows do not require a fresh invalidation.
-- PostgreSQL UPDATE OF fires when a column is named, even if its value is the
-- same. Suppress only identical complete OLD/NEW rows; retain every real field
-- change, INSERT, DELETE, old/new membership scope and existing topic dedup.
-- Paid Realtime and gateway state are unchanged. No financial or source row is
-- updated. Install once from protected main after native PostgreSQL proof.
-- @live-proof: (SELECT position('IF TG_OP=''UPDATE'' AND to_jsonb(OLD) IS NOT DISTINCT FROM to_jsonb(NEW) THEN' IN pg_get_functiondef('public.fn_publish_member_record_row()'::regprocedure))>0 AND public.fn_private_record_transport_ready())
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $install$
DECLARE
 target oid:='public.fn_publish_member_record_row()'::regprocedure;
 signature constant text:='public.fn_publish_member_record_row()';
 preimage constant text:='9c508011d3e04af5b43137d46cc58901';
 anchor constant text:=E'BEGIN\n  IF TG_OP<>''INSERT'' THEN\n';
 original text; patched text; metadata jsonb; actual jsonb;
 prior_state jsonb; final_state jsonb;
BEGIN
 SELECT pg_get_functiondef(p.oid),jsonb_build_object('owner',p.proowner,'acl',p.proacl,
   'security_definer',p.prosecdef,'settings',p.proconfig)
 INTO original,metadata FROM pg_catalog.pg_proc p WHERE p.oid=target;
 IF md5(original) IS DISTINCT FROM preimage THEN
  RAISE EXCEPTION 'PRIVATE_RECORD_NOOP_PREIMAGE_CHANGED_OR_REPLAY' USING ERRCODE='55000';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid=target
   AND p.proowner='postgres'::regrole AND p.proacl::text='{postgres=X/postgres}'
   AND p.prosecdef AND p.proconfig=ARRAY['search_path=public, pg_temp']) THEN
  RAISE EXCEPTION 'PRIVATE_RECORD_NOOP_AUTHORITY_CHANGED' USING ERRCODE='55000';
 END IF;
 SELECT to_jsonb(s) INTO prior_state FROM public.ca_private_record_transport_state s
 WHERE s.singleton FOR UPDATE;
 IF prior_state IS NULL OR prior_state#>>ARRAY['source_fingerprints',signature] IS DISTINCT FROM preimage
   OR NOT public.fn_private_record_transport_ready() THEN
  RAISE EXCEPTION 'PRIVATE_RECORD_NOOP_TRANSPORT_PREIMAGE_CHANGED' USING ERRCODE='55000';
 END IF;
 IF (length(original)-length(replace(original,anchor,'')))/length(anchor)<>1 THEN
  RAISE EXCEPTION 'PRIVATE_RECORD_NOOP_ANCHOR_CHANGED' USING ERRCODE='55000';
 END IF;
 patched:=replace(original,anchor,E'BEGIN\n  -- UPDATE OF names a source column; only an actual row change needs delivery.\n  IF TG_OP=''UPDATE'' AND to_jsonb(OLD) IS NOT DISTINCT FROM to_jsonb(NEW) THEN\n    RETURN NULL;\n  END IF;\n  IF TG_OP<>''INSERT'' THEN\n');
 EXECUTE patched;
 SELECT jsonb_build_object('owner',p.proowner,'acl',p.proacl,
   'security_definer',p.prosecdef,'settings',p.proconfig)
 INTO actual FROM pg_catalog.pg_proc p WHERE p.oid=target;
 IF actual IS DISTINCT FROM metadata OR pg_get_functiondef(target) IS DISTINCT FROM patched THEN
  RAISE EXCEPTION 'PRIVATE_RECORD_NOOP_POSTIMAGE_CHANGED' USING ERRCODE='55000';
 END IF;
 -- Advance exactly this source binding in the same transaction as its body.
 -- Every other fingerprint, including listener/dispatcher, remains untouched.
 UPDATE public.ca_private_record_transport_state
 SET source_fingerprints=jsonb_set(source_fingerprints,ARRAY[signature],to_jsonb(md5(patched)),false)
 WHERE singleton AND source_fingerprints->>signature=preimage;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'PRIVATE_RECORD_NOOP_TRANSPORT_PREIMAGE_CHANGED' USING ERRCODE='55000';
 END IF;
 SELECT to_jsonb(s) INTO final_state FROM public.ca_private_record_transport_state s WHERE s.singleton;
 IF (final_state-'source_fingerprints') IS DISTINCT FROM (prior_state-'source_fingerprints')
   OR ((final_state->'source_fingerprints')-signature) IS DISTINCT FROM ((prior_state->'source_fingerprints')-signature)
   OR final_state#>>ARRAY['source_fingerprints',signature] IS DISTINCT FROM md5(patched)
   OR NOT public.fn_private_record_transport_ready() THEN
  RAISE EXCEPTION 'PRIVATE_RECORD_NOOP_TRANSPORT_POSTIMAGE_CHANGED' USING ERRCODE='55000';
 END IF;
END $install$;
COMMIT;
