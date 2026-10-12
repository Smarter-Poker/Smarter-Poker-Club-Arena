-- 20261002231724_post_reset_cleanup_accepts_atomic_board_absence
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-02 23:17:24 UTC.
--
-- A welcome package reset serializes with the Spin/SNG board creator.  The
-- board is therefore either not materialized yet or present as its complete
-- twelve-game generation.  The post-reset certification cleanup incorrectly
-- required the latter.  A production certificate that reset before the first
-- board tick left a legitimate zero-board fixture that cleanup could not
-- retire, even though its reset receipt exactly named the empty board graph.
--
-- Admit only the two atomic shapes: zero or twelve exact board tournaments.
-- The existing distinct-slot equality still refuses duplicates and partial
-- generations; receipt equality, the all-tournaments closure, terminal-state
-- checks and every activity/FK/lease guard remain unchanged.  This guarded
-- rewrite accepts only the known UUID-ordering postimage or its own exact
-- postimage, preserves the service-only helper's catalog contract and changes
-- no club, player, game, wallet or chip row.
--
-- @live-proof: (SELECT p.prosrc LIKE '%cardinality(v_board_tournaments) NOT IN(0,12)%' AND p.prosrc LIKE '%v_expected_count IS DISTINCT FROM cardinality(v_board_tournaments)%' FROM pg_proc p WHERE p.oid='public.fn_ca_prepare_post_reset_welcome_certification_fixture(uuid)'::regprocedure)

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
    'IF cardinality(v_board_tournaments)<>12 OR v_expected_count<>12';
  v_new constant text :=
    E'IF cardinality(v_board_tournaments) NOT IN(0,12)\n     OR v_expected_count IS DISTINCT FROM cardinality(v_board_tournaments)';
  v_preimage_md5 constant text := 'f3e2ae948cbf344220873311a7cc10aa';
  v_postimage_md5 constant text := 'd784a67061328a136e0ec6da61c1973e';
  v_old_hits integer;
  v_new_hits integer;
BEGIN
  SELECT p.prosrc INTO STRICT v_source FROM pg_proc p WHERE p.oid=v_proc;
  IF md5(v_source) NOT IN (v_preimage_md5,v_postimage_md5) THEN
    RAISE EXCEPTION 'POST_RESET_ATOMIC_BOARD_SOURCE_DIGEST_REFUSED: %',md5(v_source);
  END IF;
  v_before:=pg_get_functiondef(v_proc);
  v_old_hits:=(length(v_before)-length(replace(v_before,v_old,'')))/length(v_old);
  v_new_hits:=(length(v_before)-length(replace(v_before,v_new,'')))/length(v_new);

  IF v_old_hits=1 AND v_new_hits=0 THEN
    v_after:=replace(v_before,v_old,v_new);
    IF (length(v_after)-length(replace(v_after,v_new,'')))/length(v_new)<>1
       OR v_after LIKE '%cardinality(v_board_tournaments)<>12 OR v_expected_count<>12%' THEN
      RAISE EXCEPTION 'POST_RESET_ATOMIC_BOARD_SUBSTITUTION_REFUSED';
    END IF;
    EXECUTE v_after;
  ELSIF NOT (v_old_hits=0 AND v_new_hits=1) THEN
    RAISE EXCEPTION 'POST_RESET_ATOMIC_BOARD_PREIMAGE_REFUSED: old %, new %',
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
  IF md5(v_source)<>'d784a67061328a136e0ec6da61c1973e'
     OR v_source NOT LIKE '%cardinality(v_board_tournaments) NOT IN(0,12)%'
     OR v_source NOT LIKE '%v_expected_count IS DISTINCT FROM cardinality(v_board_tournaments)%'
     OR v_source LIKE '%cardinality(v_board_tournaments)<>12 OR v_expected_count<>12%'
     OR v_source NOT LIKE '%v_receipt_tournaments IS DISTINCT FROM v_tournaments%'
     OR v_source NOT LIKE '%POST_RESET_CERTIFICATION_TOURNAMENT_GRAPH_REFUSED%'
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
    RAISE EXCEPTION 'POST_RESET_ATOMIC_BOARD_POSTIMAGE_REFUSED';
  END IF;
END
$assert$;

COMMIT;
