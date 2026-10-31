-- The installed compactor rejects a transition unless actual stored savings
-- exceed certificate bytes plus its existing 4096-byte overhead reserve.
-- An original stored request of at most4096 bytes cannot possibly qualify.
-- Reject that impossible case before semantic reads or any doomed INSERT/UPDATE;
-- do not use the detoasted PL/pgSQL row value to measure physical storage.
-- No eligibility, retention, net-benefit, replay or financial rule changes.
-- @live-proof: (SELECT position('IF old_bytes<=4096 THEN CONTINUE; END IF;' IN pg_get_functiondef('smarter_private.compact_superseded_horse_actions(uuid[])'::regprocedure))>0)
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $patch$
DECLARE source text; metadata jsonb; actual jsonb;
 size_read text:='  SELECT pg_column_size(request) INTO old_bytes FROM smarter_private.hand_submissions WHERE submission_id=s.submission_id;';
 eligibility text:='  IF smarter_private.superseded_horse_actions_eligible(s.submission_id) IS DISTINCT FROM true THEN CONTINUE; END IF;';
BEGIN
 SELECT pg_get_functiondef(p.oid),jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'secdef',prosecdef,'volatility',provolatile)
 INTO source,metadata FROM pg_proc p WHERE p.oid='smarter_private.compact_superseded_horse_actions(uuid[])'::regprocedure;
 IF md5(source) IS DISTINCT FROM 'a4098dcde967f64c98ea73ad706726ea' THEN
  RAISE EXCEPTION 'SUPERSEDED_COMPACTION_PREFLIGHT_PREIMAGE_CHANGED'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid='smarter_private.compact_superseded_horse_actions(uuid[])'::regprocedure
  AND (pg_get_userbyid(proowner)<>'postgres' OR NOT prosecdef
   OR has_function_privilege('anon',p.oid,'execute') OR has_function_privilege('authenticated',p.oid,'execute')
   OR has_function_privilege('service_role',p.oid,'execute')
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner OR a.privilege_type<>'EXECUTE'))) THEN
  RAISE EXCEPTION 'SUPERSEDED_COMPACTION_PREFLIGHT_AUTHORITY_CHANGED'; END IF;
 IF (length(source)-length(replace(source,size_read,'')))/length(size_read)<>1
 OR (length(source)-length(replace(source,eligibility,'')))/length(eligibility)<>1 THEN
  RAISE EXCEPTION 'SUPERSEDED_COMPACTION_PREFLIGHT_ANCHOR_CHANGED'; END IF;
 source:=replace(source,size_read||chr(10),'');
 source:=replace(source,eligibility,size_read||chr(10)||
  '  -- Existing physical overhead alone exceeds every possible saving here.'||chr(10)||
  '  IF old_bytes<=4096 THEN CONTINUE; END IF;'||chr(10)||eligibility);
 EXECUTE source;
 SELECT jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'secdef',prosecdef,'volatility',provolatile)
 INTO actual FROM pg_proc p WHERE p.oid='smarter_private.compact_superseded_horse_actions(uuid[])'::regprocedure;
 IF actual IS DISTINCT FROM metadata THEN
  RAISE EXCEPTION 'SUPERSEDED_COMPACTION_PREFLIGHT_AUTHORITY_CHANGED'; END IF;
END $patch$;
COMMIT;
