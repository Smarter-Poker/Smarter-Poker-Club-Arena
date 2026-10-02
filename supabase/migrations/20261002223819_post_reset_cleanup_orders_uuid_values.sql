-- 20261002223819_post_reset_cleanup_orders_uuid_values
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-02 22:38:19 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
-- Say what was wrong, what this changes, and what you measured. A
-- migration whose header is its own filename is the next agent's mystery.
--
-- PostgreSQL does not provide min(uuid) in the production catalog.  The
-- post-reset certification preparer used that aggregate only to select the
-- single reset operation after separately proving that every package item
-- carries the same operation.  Its first production execution therefore
-- failed with 42883 before it could inspect or retire any fixture.
--
-- Replace that one expression with the first UUID from a deterministic
-- ordered array.  The surrounding exact-count and equality guards remain
-- unchanged.  This is a guarded source rewrite of the private service-only
-- helper: it accepts exactly the known preimage or the exact postimage,
-- preserves SECURITY DEFINER ownership and grants, and changes no club,
-- game, player, wallet or chip row.
--
-- @live-proof: (SELECT p.prosrc LIKE '%(array_agg(reset_operation_id ORDER BY reset_operation_id))[1]%' AND p.prosrc NOT LIKE '%min(reset_operation_id)%' FROM pg_proc p WHERE p.oid='public.fn_ca_prepare_post_reset_welcome_certification_fixture(uuid)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';

DO $rewrite$
DECLARE
  v_proc constant regprocedure :=
    'public.fn_ca_prepare_post_reset_welcome_certification_fixture(uuid)'::regprocedure;
  v_before text;
  v_after text;
  v_source text;
  v_old constant text := 'SELECT min(reset_operation_id),';
  v_new constant text :=
    'SELECT (array_agg(reset_operation_id ORDER BY reset_operation_id))[1],';
  v_preimage_md5 constant text := '256fe1643b1043b83bb6e9372b3aefa0';
  v_postimage_md5 constant text := 'f3e2ae948cbf344220873311a7cc10aa';
  v_old_hits integer;
  v_new_hits integer;
BEGIN
  SELECT p.prosrc INTO STRICT v_source FROM pg_proc p WHERE p.oid=v_proc;
  IF md5(v_source) NOT IN (v_preimage_md5,v_postimage_md5) THEN
    RAISE EXCEPTION 'POST_RESET_UUID_ORDER_SOURCE_DIGEST_REFUSED: %',md5(v_source);
  END IF;
  v_before:=pg_get_functiondef(v_proc);
  v_old_hits:=(length(v_before)-length(replace(v_before,v_old,'')))/length(v_old);
  v_new_hits:=(length(v_before)-length(replace(v_before,v_new,'')))/length(v_new);

  IF v_old_hits=1 AND v_new_hits=0 THEN
    v_after:=replace(v_before,v_old,v_new);
    IF (length(v_after)-length(replace(v_after,v_new,'')))/length(v_new)<>1
       OR v_after LIKE '%min(reset_operation_id)%' THEN
      RAISE EXCEPTION 'POST_RESET_UUID_ORDER_SUBSTITUTION_REFUSED';
    END IF;
    EXECUTE v_after;
  ELSIF NOT (v_old_hits=0 AND v_new_hits=1) THEN
    RAISE EXCEPTION 'POST_RESET_UUID_ORDER_PREIMAGE_REFUSED: old %, new %',
      v_old_hits,v_new_hits;
  END IF;
END
$rewrite$;

DO $assert$
DECLARE
  v_proc constant regprocedure :=
    'public.fn_ca_prepare_post_reset_welcome_certification_fixture(uuid)'::regprocedure;
  v_source text;
BEGIN
  SELECT p.prosrc INTO v_source FROM pg_proc p WHERE p.oid=v_proc;
  IF md5(v_source)<>'f3e2ae948cbf344220873311a7cc10aa'
     OR v_source NOT LIKE '%(array_agg(reset_operation_id ORDER BY reset_operation_id))[1]%'
     OR v_source LIKE '%min(reset_operation_id)%'
     OR v_source NOT LIKE '%reset_operation_id IS DISTINCT FROM v_operation%'
     OR v_source NOT LIKE '%POST_RESET_CERTIFICATION_PACKAGE_LINEAGE_REFUSED%'
     OR NOT EXISTS(
       SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
        WHERE p.oid=v_proc
          AND p.prosecdef
          AND r.rolname='postgres'
          AND p.prolang=(SELECT l.oid FROM pg_language l WHERE l.lanname='plpgsql')
          AND p.prorettype='pg_catalog.jsonb'::regtype
          AND NOT p.proretset
          AND p.provolatile='v'
          AND p.prokind='f'
          AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     )
     OR EXISTS(
       SELECT 1
         FROM pg_proc p,
              LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
        WHERE p.oid=v_proc
          AND a.privilege_type='EXECUTE'
          AND a.grantee<>p.proowner
     )
     OR has_function_privilege('anon',v_proc,'EXECUTE')
     OR has_function_privilege('authenticated',v_proc,'EXECUTE')
     OR has_function_privilege('service_role',v_proc,'EXECUTE') THEN
    RAISE EXCEPTION 'POST_RESET_UUID_ORDER_POSTIMAGE_REFUSED';
  END IF;
END
$assert$;

COMMIT;
