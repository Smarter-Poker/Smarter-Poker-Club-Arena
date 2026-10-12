-- A null-safe composite comparison hid the hand primary key from the planner.
-- At140,250 retainedcapsules one original identity check scanned26,640blocks
-- in162.124ms; the additional indexable hand guard used4blocks in0.025ms.
-- Keep every original null-safe identity, digest and canonical stats predicate.
-- The hand key is NOTNULL by its existing primarykey, so this extra guard
-- narrows the access path without changing any qualification or financial rule.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='10s';
DO $guard$
DECLARE p pg_proc;
BEGIN
 SELECT * INTO p FROM pg_proc WHERE oid='smarter_private.horse_stats_basis_matches(uuid,uuid,bigint,jsonb)'::regprocedure;
 IF md5(pg_get_functiondef(p.oid)) IS DISTINCT FROM '757b1b1a84f7290a954ed46682c27ea5'
 OR p.proowner<>'postgres'::regrole OR NOT p.prosecdef OR p.provolatile<>'s'
 OR p.proacl::text IS DISTINCT FROM '{postgres=X/postgres}'
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, smarter_private']
 OR NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='smarter_private.horse_retained_stats_basis'::regclass AND attname='hand_id' AND attnotnull AND NOT attisdropped)
 OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='smarter_private.horse_retained_stats_basis'::regclass AND contype='p' AND pg_get_constraintdef(oid)='PRIMARY KEY (hand_id)')
 OR md5(pg_get_functiondef('smarter_private.horse_stats_basis_immutable()'::regprocedure)) IS DISTINCT FROM '2d8ba8c8729ca6c1fc9556a5d7df4ae1'
 THEN RAISE EXCEPTION 'HORSE_STATS_INDEXABLE_ORIGINAL_PROOF_CHANGED' USING ERRCODE='55000'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION smarter_private.horse_stats_basis_matches(p_hand uuid,p_table uuid,p_number bigint,p_stats jsonb)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $function$
 SELECT EXISTS(SELECT 1 FROM smarter_private.horse_retained_stats_basis b
  WHERE b.hand_id=p_hand
  AND (b.hand_id,b.table_id,b.hand_number) IS NOT DISTINCT FROM (p_hand,p_table,p_number)
  AND b.original_stats_sha256=encode(extensions.digest(convert_to(COALESCE(p_stats,'null'::jsonb)::text,'UTF8'),'sha256'),'hex')
  AND b.compact_stats IS NOT DISTINCT FROM smarter_private.horse_compact_stats_basis(p_stats))
$function$;
REVOKE ALL ON FUNCTION smarter_private.horse_stats_basis_matches(uuid,uuid,bigint,jsonb) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
