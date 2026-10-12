-- Retention's 20-second budget is checked between iterations. A 5,000-hand
-- iteration took 58 seconds with qualified original-payload erasure. Bound
-- each iteration to 250 while preserving the same candidate guards, accounting
-- proofs, original budget and the existing ten-minute retention authority.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';
DO $bound$
DECLARE target oid:='public.sp_prune_hand_history(integer)'::regprocedure;
 source text; metadata jsonb; actual jsonb; anchor text:=E'       LIMIT p_batch\n';
BEGIN
 SELECT pg_get_functiondef(p.oid),jsonb_build_object('owner',p.proowner,'acl',p.proacl,'secdef',p.prosecdef,'settings',p.proconfig)
 INTO source,metadata FROM pg_proc p WHERE p.oid=target;
 IF md5(source) IS DISTINCT FROM '5f055bddbc9a5c2f57f9d677c2b71679' THEN
  RAISE EXCEPTION 'HORSE_RETENTION_BATCH_SOURCE_CHANGED_OR_ALREADY_INSTALLED' USING ERRCODE='55000'; END IF;
 IF (length(source)-length(replace(source,anchor,'')))/length(anchor)<>1 THEN
  RAISE EXCEPTION 'HORSE_RETENTION_BATCH_ANCHOR_CHANGED' USING ERRCODE='55000'; END IF;
 EXECUTE replace(source,anchor,E'       LIMIT LEAST(GREATEST(p_batch,1),250)\n');
 SELECT jsonb_build_object('owner',p.proowner,'acl',p.proacl,'secdef',p.prosecdef,'settings',p.proconfig)
 INTO actual FROM pg_proc p WHERE p.oid=target;
 IF actual IS DISTINCT FROM metadata THEN
  RAISE EXCEPTION 'HORSE_RETENTION_BATCH_AUTHORITY_CHANGED' USING ERRCODE='55000'; END IF;
END $bound$;
COMMIT;
