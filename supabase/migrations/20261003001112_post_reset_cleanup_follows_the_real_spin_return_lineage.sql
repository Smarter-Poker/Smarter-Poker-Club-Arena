-- 20261003001112_post_reset_cleanup_follows_the_real_spin_return_lineage.sql
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-03 00:11:12 UTC.
--
-- The production Spin deactivation writer preserves the two-decimal scale of
-- the opening 200.00 seed when it records the idempotency key.  The private
-- post-reset certificate cleanup instead required the normalized text `200`.
-- Every other piece of the real return lineage was exact, but that display-
-- scale mismatch made cleanup refuse a legitimate reset fixture after the
-- financial reset had already completed.
--
-- Rewrite only that exact suffix to the writer's canonical `200.00`.  The
-- concrete Spin pool identity, transfer endpoints, amount, category, exactly-
-- once row count, four-row reserve journal, BBJ return, reset receipt and all
-- activity/graph guards remain unchanged.  This guarded source rewrite accepts
-- only the installed atomic-board postimage or its own exact postimage,
-- preserves the private service-only catalog contract and changes no club,
-- player, game, wallet or chip row.
--
-- @live-proof: (SELECT p.prosrc LIKE '%spin-deactivation-seed-return:%:200.00%' AND p.prosrc NOT LIKE '%spin-deactivation-seed-return:%:200''%' FROM pg_proc p WHERE p.oid='public.fn_ca_prepare_post_reset_welcome_certification_fixture(uuid)'::regprocedure)

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
  v_old constant text :=
    'AND l.idempotency_key=''spin-deactivation-seed-return:''||p_club_id::text||'':200'')<>1';
  v_new constant text :=
    'AND l.idempotency_key=''spin-deactivation-seed-return:''||p_club_id::text||'':200.00'')<>1';
  v_preimage_md5 constant text := 'd784a67061328a136e0ec6da61c1973e';
  v_postimage_md5 constant text := '8ea4b2b5f9a80c4b8abbc620bd989c19';
  v_old_hits integer;
  v_new_hits integer;
BEGIN
  SELECT p.prosrc INTO STRICT v_source FROM pg_proc p WHERE p.oid=v_proc;
  IF md5(v_source) NOT IN (v_preimage_md5,v_postimage_md5) THEN
    RAISE EXCEPTION 'POST_RESET_SPIN_RETURN_SOURCE_DIGEST_REFUSED: %',md5(v_source);
  END IF;
  v_before:=pg_get_functiondef(v_proc);
  v_old_hits:=(length(v_before)-length(replace(v_before,v_old,'')))/length(v_old);
  v_new_hits:=(length(v_before)-length(replace(v_before,v_new,'')))/length(v_new);

  IF v_old_hits=1 AND v_new_hits=0 THEN
    v_after:=replace(v_before,v_old,v_new);
    IF (length(v_after)-length(replace(v_after,v_new,'')))/length(v_new)<>1
       OR v_after LIKE '%spin-deactivation-seed-return:''||p_club_id::text||'':200'')<>1%' THEN
      RAISE EXCEPTION 'POST_RESET_SPIN_RETURN_SUBSTITUTION_REFUSED';
    END IF;
    EXECUTE v_after;
  ELSIF NOT (v_old_hits=0 AND v_new_hits=1) THEN
    RAISE EXCEPTION 'POST_RESET_SPIN_RETURN_PREIMAGE_REFUSED: old %, new %',
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
  IF md5(v_source)<>'8ea4b2b5f9a80c4b8abbc620bd989c19'
     OR v_source NOT LIKE '%spin-deactivation-seed-return:''||p_club_id::text||'':200.00''%'
     OR v_source LIKE '%spin-deactivation-seed-return:''||p_club_id::text||'':200'')<>1%'
     OR v_source NOT LIKE '%ON s.id=l.from_entity_id WHERE s.club_id=p_club_id%'
     OR v_source NOT LIKE '%POST_RESET_CERTIFICATION_SEED_RETURN_LINEAGE_REFUSED%'
     OR NOT EXISTS(
       SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
        WHERE p.oid=v_proc
          AND p.prosecdef
          AND r.rolname='postgres'
          AND p.prolang=(SELECT l.oid FROM pg_language l WHERE l.lanname='plpgsql')
          AND p.prorettype='pg_catalog.jsonb'::regtype
          AND NOT p.proretset
          AND p.provolatile='v'
          AND NOT p.proleakproof
          AND p.proparallel='u'
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
    RAISE EXCEPTION 'POST_RESET_SPIN_RETURN_POSTIMAGE_REFUSED: %',md5(v_source);
  END IF;
END
$assert$;

COMMIT;
