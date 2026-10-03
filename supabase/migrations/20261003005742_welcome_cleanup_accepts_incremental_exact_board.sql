-- 20261003005742_welcome_cleanup_accepts_incremental_exact_board
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-03 00:57:42 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
-- Say what was wrong, what this changes, and what you measured. A
-- migration whose header is its own filename is the next agent's mystery.
--
-- The live Spin/SNG board controller deliberately materializes a new club's
-- twelve owner-board events incrementally.  It spends a bounded per-pass
-- budget, so an interrupted reserved Create Club certificate can own any
-- pristine unique prefix from one through eleven events.  Migration
-- 20261002205511 accidentally copied the post-reset graph's atomic 0-or-12
-- rule into the three pre-reset cleanup helpers.  Residual cleanup therefore
-- refused a legitimate incremental board before it could inspect its exact
-- tables, origins, leases, activity, or custody.
--
-- Restore only the original State-A unique-subset rule in the lease, origin,
-- and board-game helpers: every matched row must have a distinct allowlisted
-- name and there may be no more than twelve.  All reserved-identity, exact
-- shape, table/origin, activity, protocol-v2, stale-lease, F06-custody,
-- unknown-tournament, delete-permit, and 100,000-chip retirement guards stay
-- intact.  The post-reset State-B helper remains strictly 0-or-12 because its
-- board mutation is atomic.  No club, game, player, wallet, or chip row is
-- changed by this migration.
--
-- @live-proof: (SELECT count(*)=3 AND bool_and(p.prosrc LIKE '%cardinality(v_board_tournaments)<>v_expected_count%') AND bool_and(p.prosrc LIKE '%cardinality(v_board_tournaments)>12%') FROM pg_proc p WHERE p.oid=ANY(ARRAY['public.fn_ca_prepare_unused_welcome_certification_board_leases(uuid)'::regprocedure,'public.fn_ca_prepare_unused_welcome_certification_board_origins(uuid)'::regprocedure,'public.fn_ca_prepare_unused_welcome_certification_board_games(uuid)'::regprocedure]))

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';

DO $rewrite$
DECLARE
  v_proc regprocedure;
  v_before text;
  v_after text;
  v_source text;
  v_old text := $old$IF cardinality(v_board_tournaments) NOT IN (0,12)
     OR v_expected_count IS DISTINCT FROM cardinality(v_board_tournaments)$old$;
  v_new text := $new$IF cardinality(v_board_tournaments)<>v_expected_count
     OR cardinality(v_board_tournaments)>12$new$;
  v_preimage_md5 text;
  v_postimage_md5 text;
  v_old_hits integer;
  v_new_hits integer;
BEGIN
  FOREACH v_proc IN ARRAY ARRAY[
    'public.fn_ca_prepare_unused_welcome_certification_board_leases(uuid)'::regprocedure,
    'public.fn_ca_prepare_unused_welcome_certification_board_origins(uuid)'::regprocedure,
    'public.fn_ca_prepare_unused_welcome_certification_board_games(uuid)'::regprocedure
  ] LOOP
    IF v_proc='public.fn_ca_prepare_unused_welcome_certification_board_games(uuid)'::regprocedure THEN
      v_preimage_md5:='542740725160fef5e9996f126cf5f341';
      v_postimage_md5:='fe40eec4c3842bf12a571479ce819360';
    ELSIF v_proc='public.fn_ca_prepare_unused_welcome_certification_board_leases(uuid)'::regprocedure THEN
      v_preimage_md5:='d93c02d438442e6300259df977e7142f';
      v_postimage_md5:='6c50d99991bdb58cc6ffb92b8b3b7de1';
    ELSE
      v_preimage_md5:='2c0961c59fd19edb20825696da0b8514';
      v_postimage_md5:='ca0adbbe2bc007887a924da455dcad13';
    END IF;

    SELECT p.prosrc INTO STRICT v_source FROM pg_proc p WHERE p.oid=v_proc;
    v_before:=pg_get_functiondef(v_proc);
    v_old_hits:=(length(v_before)-length(replace(v_before,v_old,'')))/length(v_old);
    v_new_hits:=(length(v_before)-length(replace(v_before,v_new,'')))/length(v_new);

    IF md5(v_source)=v_preimage_md5 AND v_old_hits=1 AND v_new_hits=0 THEN
      v_after:=replace(v_before,v_old,v_new);
      IF replace(v_after,v_new,v_old) IS DISTINCT FROM v_before
         OR (length(v_after)-length(replace(v_after,v_new,'')))/length(v_new)<>1 THEN
        RAISE EXCEPTION 'INCREMENTAL_BOARD_STATE_A_ROUNDTRIP_REFUSED: %',v_proc;
      END IF;
      EXECUTE v_after;
    ELSIF NOT (
      md5(v_source)=v_postimage_md5 AND v_old_hits=0 AND v_new_hits=1
    ) THEN
      RAISE EXCEPTION 'INCREMENTAL_BOARD_STATE_A_SOURCE_DIGEST_REFUSED: % % old % new %',
        v_proc,md5(v_source),v_old_hits,v_new_hits;
    END IF;
  END LOOP;
END
$rewrite$;

DO $assert$
DECLARE
  v_proc regprocedure;
  v_source text;
  v_postimage_md5 text;
  v_post_reset text;
BEGIN
  FOREACH v_proc IN ARRAY ARRAY[
    'public.fn_ca_prepare_unused_welcome_certification_board_leases(uuid)'::regprocedure,
    'public.fn_ca_prepare_unused_welcome_certification_board_origins(uuid)'::regprocedure,
    'public.fn_ca_prepare_unused_welcome_certification_board_games(uuid)'::regprocedure
  ] LOOP
    SELECT p.prosrc INTO v_source FROM pg_proc p WHERE p.oid=v_proc;
    IF v_proc='public.fn_ca_prepare_unused_welcome_certification_board_games(uuid)'::regprocedure THEN
      v_postimage_md5:='fe40eec4c3842bf12a571479ce819360';
    ELSIF v_proc='public.fn_ca_prepare_unused_welcome_certification_board_leases(uuid)'::regprocedure THEN
      v_postimage_md5:='6c50d99991bdb58cc6ffb92b8b3b7de1';
    ELSE
      v_postimage_md5:='ca0adbbe2bc007887a924da455dcad13';
    END IF;
    IF md5(v_source)<>v_postimage_md5
       OR v_source NOT LIKE '%cardinality(v_board_tournaments)<>v_expected_count%'
       OR v_source NOT LIKE '%cardinality(v_board_tournaments)>12%'
       OR v_source LIKE '%cardinality(v_board_tournaments) NOT IN (0,12)%'
       OR v_source NOT LIKE '%WELCOME_CERTIFICATION_FIXTURE_IDENTITY_REFUSED%'
       OR v_source NOT LIKE '%current_players=0%'
       OR NOT EXISTS(
         SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
          WHERE p.oid=v_proc AND p.prosecdef AND r.rolname='postgres'
            AND p.prolang=(SELECT l.oid FROM pg_language l WHERE l.lanname='plpgsql')
            AND p.prorettype='jsonb'::regtype AND NOT p.proretset
            AND p.provolatile='v' AND NOT p.proleakproof AND p.proparallel='u'
            AND p.prokind='f'
            AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
       )
       OR EXISTS(
         SELECT 1 FROM aclexplode(COALESCE(
           (SELECT p.proacl FROM pg_proc p WHERE p.oid=v_proc),
           acldefault('f',(SELECT p.proowner FROM pg_proc p WHERE p.oid=v_proc))
         )) a
          WHERE a.privilege_type='EXECUTE'
            AND a.grantee<>(SELECT p.proowner FROM pg_proc p WHERE p.oid=v_proc)
       )
       OR has_function_privilege('anon',v_proc,'EXECUTE')
       OR has_function_privilege('authenticated',v_proc,'EXECUTE')
       OR has_function_privilege('service_role',v_proc,'EXECUTE') THEN
      RAISE EXCEPTION 'INCREMENTAL_BOARD_STATE_A_POSTIMAGE_REFUSED: %',v_proc;
    END IF;
  END LOOP;

  SELECT p.prosrc INTO v_post_reset
    FROM pg_proc p
   WHERE p.oid='public.fn_ca_prepare_post_reset_welcome_certification_fixture(uuid)'::regprocedure;
  IF v_post_reset NOT LIKE '%cardinality(v_board_tournaments) NOT IN(0,12)%'
     OR v_post_reset NOT LIKE '%v_expected_count IS DISTINCT FROM cardinality(v_board_tournaments)%'
     OR v_post_reset LIKE '%cardinality(v_board_tournaments)<>v_expected_count%' THEN
    RAISE EXCEPTION 'INCREMENTAL_BOARD_STATE_B_CONTRACT_REFUSED';
  END IF;

  IF (SELECT p.prosrc FROM pg_proc p
       WHERE p.oid='public.fn_ca_prepare_unused_welcome_certification_board_leases(uuid)'::regprocedure)
       NOT LIKE '%l.acquired_at>=v_cutoff OR l.heartbeat_at>=v_cutoff%'
     OR (SELECT p.prosrc FROM pg_proc p
       WHERE p.oid='public.fn_ca_prepare_unused_welcome_certification_board_leases(uuid)'::regprocedure)
       NOT LIKE '%smarter_private.f06_lease_has_pending_custody%'
     OR (SELECT p.prosrc FROM pg_proc p
       WHERE p.oid='public.fn_ca_prepare_unused_welcome_certification_board_origins(uuid)'::regprocedure)
       NOT LIKE '%origin_kind IS DISTINCT FROM ''prelaunch''%'
     OR (SELECT p.prosrc FROM pg_proc p
       WHERE p.oid='public.fn_ca_prepare_unused_welcome_certification_board_games(uuid)'::regprocedure)
       NOT LIKE '%WELCOME_CERTIFICATION_BOARD_FIXTURE_HAS_ACTIVITY%'
     OR (SELECT p.prosrc FROM pg_proc p
       WHERE p.oid='public.fn_ca_prepare_unused_welcome_certification_board_games(uuid)'::regprocedure)
       NOT LIKE '%ca_welcome_certification_table_delete_permits%' THEN
    RAISE EXCEPTION 'INCREMENTAL_BOARD_STATE_A_SAFETY_GUARD_REFUSED';
  END IF;
END
$assert$;

COMMIT;
