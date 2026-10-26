-- 20261026174430_reserved_spectator_fixture_leaves_its_zero_custody_membershi.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

-- A reserved post-deploy actor retained a suspended zero-custody player
-- membership in the union house fixture. The cleanup recognized only admin,
-- although the certificate legitimately prepares spectator/player membership.
-- Admit that role only in this exact existing fixture scope. All identity,
-- financial history, balance/hold/credit, upline, seat, owner, agent, freeze,
-- ACL and transaction checks stay unchanged. No production rows change here.
-- @live-proof: md5(pg_get_functiondef('public.cleanup_reserved_certification_account(uuid)'::regprocedure)) = 'c26eff38698d666a151ef188ef68b00d'
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';
DO $patch$
DECLARE
 v_target regprocedure := 'public.cleanup_reserved_certification_account(uuid)'::regprocedure;
 v_old text := pg_get_functiondef(v_target);
 v_new text;
 v_meta jsonb;
BEGIN
 IF md5(v_old) IS DISTINCT FROM 'b3354b7c9a3854dd8cd743701b3b0696' THEN
  RAISE EXCEPTION 'SPECTATOR_CERTIFICATION_PREIMAGE_CHANGED';
 END IF;
 IF NOT EXISTS (SELECT FROM pg_proc WHERE oid=v_target AND proowner='postgres'::regrole AND prosecdef)
    OR has_function_privilege('anon',v_target,'EXECUTE')
    OR has_function_privilege('authenticated',v_target,'EXECUTE')
    OR NOT has_function_privilege('service_role',v_target,'EXECUTE') THEN
  RAISE EXCEPTION 'SPECTATOR_CERTIFICATION_AUTHORITY_CHANGED';
 END IF;
 SELECT jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig) INTO v_meta FROM pg_proc WHERE oid=v_target;
 v_new := v_old;
 v_new := replace(v_new, $old$(club_id = 'fade0000-0000-0000-0000-000000000001'::uuid AND role = 'admin')$old$, $new$(club_id = 'fade0000-0000-0000-0000-000000000001'::uuid AND role IN ('admin','player'))$new$);
 v_new := replace(v_new, $old$OR role IS DISTINCT FROM 'admin' OR COALESCE(chip_balance, 0) <> 0$old$, $new$OR NOT (role = 'admin' OR (club_id = 'fade0000-0000-0000-0000-000000000001'::uuid AND role = 'player')) IS TRUE OR COALESCE(chip_balance, 0) <> 0$new$);
 v_new := replace(v_new, $old$AND role = 'admin' AND COALESCE(chip_balance, 0) = 0$old$, $new$AND (role = 'admin' OR (club_id = 'fade0000-0000-0000-0000-000000000001'::uuid AND role = 'player')) AND COALESCE(chip_balance, 0) = 0$new$);
 IF md5(v_new) IS DISTINCT FROM 'c26eff38698d666a151ef188ef68b00d' THEN
  RAISE EXCEPTION 'SPECTATOR_CERTIFICATION_POSTIMAGE_CHANGED';
 END IF;
 EXECUTE v_new;
 IF md5(pg_get_functiondef(v_target)) IS DISTINCT FROM 'c26eff38698d666a151ef188ef68b00d'
    OR (SELECT jsonb_build_object('owner',proowner,'acl',proacl,'config',proconfig) FROM pg_proc WHERE oid=v_target) IS DISTINCT FROM v_meta THEN
  RAISE EXCEPTION 'SPECTATOR_CERTIFICATION_READBACK_CHANGED';
 END IF;
END $patch$;
COMMIT;
