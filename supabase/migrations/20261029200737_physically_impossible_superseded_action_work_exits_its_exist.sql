-- The existing compactor cannot save its unchanged 4096-byte physical
-- overhead from a stored request that occupies at most4096 bytes. Retrying
-- such immutable originals daily only rewrites derived queue bookkeeping.
-- Remove that queue item in its original progress transaction after locking
-- the source with SKIP LOCKED. Never delete or rewrite original evidence.
-- @live-proof: (SELECT position('pg_column_size(s.request)<=4096 FOR UPDATE SKIP LOCKED' IN pg_get_functiondef('smarter_private.progress_superseded_action_retention()'::regprocedure))>0)
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
DO $patch$
DECLARE source text; metadata jsonb; actual jsonb;
 anchor text:='  OR EXISTS(SELECT 1 FROM smarter_private.hand_submissions s WHERE s.submission_id=r.submission_id';
BEGIN
 IF md5(pg_get_functiondef('smarter_private.progress_superseded_action_retention()'::regprocedure))<>'2a74e92dec6d4eafcbd22ff38126fb35'
 OR md5(pg_get_functiondef('smarter_private.compact_superseded_horse_actions(uuid[])'::regprocedure))<>'adbcd00830cb59a81147e2aaac46ea89'
 OR md5(pg_get_functiondef('smarter_private.hand_submission_immutable()'::regprocedure))<>'c42a516272a751ee99410ea7949d87a0' THEN
  RAISE EXCEPTION 'SUPERSEDED_QUEUE_PHYSICAL_EXIT_PREIMAGE_CHANGED'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid IN (
  'smarter_private.progress_superseded_action_retention()'::regprocedure,
  'smarter_private.compact_superseded_horse_actions(uuid[])'::regprocedure,
  'smarter_private.hand_submission_immutable()'::regprocedure)
  AND (pg_get_userbyid(p.proowner)<>'postgres' OR NOT p.prosecdef
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee<>p.proowner OR a.privilege_type<>'EXECUTE'))) THEN
  RAISE EXCEPTION 'SUPERSEDED_QUEUE_PHYSICAL_EXIT_AUTHORITY_CHANGED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='smarter_private.hand_submissions'::regclass
  AND tgname='hand_submission_immutable' AND tgfoid='smarter_private.hand_submission_immutable()'::regprocedure
  AND tgenabled IN ('O','A') AND tgtype=27 AND NOT tgisinternal)
 OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='smarter_private.hand_submissions'::regclass
  AND tgname='hand_submission_no_truncate' AND tgfoid='smarter_private.hand_submission_immutable()'::regprocedure
  AND tgenabled IN ('O','A') AND tgtype=34 AND NOT tgisinternal) THEN
  RAISE EXCEPTION 'SUPERSEDED_QUEUE_PHYSICAL_EXIT_IMMUTABILITY_CHANGED'; END IF;
 SELECT pg_get_functiondef(p.oid),jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'secdef',prosecdef,'volatility',provolatile)
 INTO source,metadata FROM pg_proc p WHERE p.oid='smarter_private.progress_superseded_action_retention()'::regprocedure;
 IF (length(source)-length(replace(source,anchor,'')))/length(anchor)<>1 THEN
  RAISE EXCEPTION 'SUPERSEDED_QUEUE_PHYSICAL_EXIT_ANCHOR_CHANGED'; END IF;
 source:=replace(source,anchor,
  '  -- This locked immutable request cannot repay the existing overhead.'||chr(10)||
  '  OR EXISTS(SELECT 1 FROM smarter_private.hand_submissions s WHERE s.submission_id=r.submission_id'||chr(10)||
  '   AND pg_column_size(s.request)<=4096 FOR UPDATE SKIP LOCKED)'||chr(10)||anchor);
 EXECUTE source;
 SELECT jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig,'secdef',prosecdef,'volatility',provolatile)
 INTO actual FROM pg_proc p WHERE p.oid='smarter_private.progress_superseded_action_retention()'::regprocedure;
 IF actual IS DISTINCT FROM metadata THEN
  RAISE EXCEPTION 'SUPERSEDED_QUEUE_PHYSICAL_EXIT_AUTHORITY_CHANGED'; END IF;
END $patch$;
COMMIT;
