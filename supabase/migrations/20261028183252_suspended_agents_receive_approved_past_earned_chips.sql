-- Existing approved past-earned corrections retain their original wallet despite suspension.
-- @live-proof: md5(pg_get_functiondef('public.fn_ca_settle_approved_agent_adjustment(uuid,uuid,jsonb)'::regprocedure))='6eec29205765cd38ca9e0f6f9bfb8ed5'
-- Approved past-earned chips may credit an existing suspended agent wallet.
-- Suspension, role, access, original paid receipts and frozen-wallet refusal remain unchanged.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $change$
DECLARE d text; m jsonb; after_d text;
 old_predicate text := $old$g.status IS DISTINCT FROM 'active'$old$;
 new_predicate text := $new$(g.status IS NULL OR g.status NOT IN('active','suspended'))$new$;
BEGIN
 SELECT pg_get_functiondef(p.oid),to_jsonb(p)-'prosrc' INTO STRICT d,m FROM pg_proc p
 WHERE p.oid='public.fn_ca_settle_approved_agent_adjustment(uuid,uuid,jsonb)'::regprocedure;
 IF md5(d)<>'1edc12539a8b79db0614bf0470a3cf23' THEN RAISE EXCEPTION 'suspended_earned_adjustment_preimage_changed'; END IF;
 IF (length(d)-length(replace(d,old_predicate,'')))/length(old_predicate)<>1
 THEN RAISE EXCEPTION 'suspended_earned_adjustment_predicate_ambiguous'; END IF;
 after_d:=replace(d,old_predicate,new_predicate);
 EXECUTE after_d;
 IF md5(pg_get_functiondef('public.fn_ca_settle_approved_agent_adjustment(uuid,uuid,jsonb)'::regprocedure))<>md5(after_d)
 OR (SELECT to_jsonb(p)-'prosrc'FROM pg_proc p WHERE p.oid='public.fn_ca_settle_approved_agent_adjustment(uuid,uuid,jsonb)'::regprocedure)IS DISTINCT FROM m
 THEN RAISE EXCEPTION 'suspended_earned_adjustment_postimage_or_metadata_changed'; END IF;
END $change$;
COMMIT;
