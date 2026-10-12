-- 20261011193040_a_partly_opened_welcome_board_is_still_an_unused_welcome_boa.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (Create A Club residual A-2, 2026-10-11):
--
-- A new club owns a twelve-game welcome board (four heads-up SNGs and eight
-- 1-chip Spins). The engine does not open it in one go: its board pass opens a
-- few games per 30 s tick (TournamentRecurringService.ensureBoardOpen), so for
-- the first one to three minutes a brand-new club holds somewhere between one
-- and eleven of the twelve games.
--
-- Both welcome-package authorities identified the board only when it held
-- none of the games or all twelve:
--
--     count(*)=0 OR (count(*)=12 AND count(DISTINCT name)=12)
--
-- Anything in between read as "lineage ambiguous". So an owner who opened
-- Retire Club right after creating a club was told the club was not an unused
-- welcome club (fn_get_club_welcome_package_reset_impact answered
-- can_reset=false, reason package_economics_not_pristine, and the dialog
-- listed the half-open board as Active Tournaments), and
-- fn_unwind_unused_first_club_welcome_package refused with
-- WELCOME_PACKAGE_BOARD_LINEAGE_AMBIGUOUS. The same race failed the Create
-- Club production certificate (run 38151574882, 2026-10-11 15:33 UTC: the
-- "Exact Unused Welcome Package Verified" line never appeared).
--
-- The board's identity is its twelve exact names and shapes. What makes it
-- ambiguous is a name appearing twice (an owner-made look-alike), not a name
-- not having appeared yet. The rule is now:
--
--     count(*)=count(DISTINCT name)
--
-- Each candidate already joins one of the twelve exact (name, game, variant,
-- type, buy-in, fee, seats, stack) rows, so this admits 0..12 distinct
-- board games and still refuses any duplicate. Every other proof is
-- unchanged and still runs under the same locks: no seat, session, waitlist,
-- move, registration, hand, executing command, BBJ or Spin activity, and the
-- exact 100 BBJ / 200 Spin seeds. Retirement switches the Spin pool and the
-- club's games off (fn_spin_deactivate, spins_enabled=false), and the engine
-- only opens boards for activated owners, so a partly opened board stops
-- growing once it is unwound - exactly as the already-accepted empty board
-- does.
--
-- This migration changes no club, game, player, wallet, chip, receipt or
-- consent row. It rewrites two function bodies by exact-fragment
-- substitution (the pattern of 20261003035741), refuses unless the fragment
-- appears exactly once, proves the substitution is reversible to the byte,
-- re-reads both functions afterwards and requires every catalogue attribute
-- (owner, acl, config, secdef, volatility, parallel safety, leakproofness,
-- language, return type, kind) to be identical to what it found. Replay is a
-- no-op: a body already carrying the new rule is left alone.
--
-- Production read 2026-10-11 (md5 of pg_get_functiondef):
--   fn_get_club_welcome_package_reset_impact(uuid)
--     f541a63172f2f9f0c5524979ecb3715e -> 47be65af397b0328a7c4e0daf7bed68a
--   fn_unwind_unused_first_club_welcome_package(uuid,uuid)
--     129dc4c16a3b6ff9b587aef09796941e -> b56b2a0f35e0fd3aa178dbd12f72fa25
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

-- @live-proof: (SELECT bool_and(p.prosrc LIKE '%SELECT count(*)=count(DISTINCT name) FROM candidates%') AND bool_and(p.prosrc NOT LIKE '%count(*)=0 OR (count(*)=12 AND count(DISTINCT name)=12)%') FROM pg_proc p WHERE p.oid=ANY(ARRAY['public.fn_unwind_unused_first_club_welcome_package(uuid,uuid)'::regprocedure,'public.fn_get_club_welcome_package_reset_impact(uuid)'::regprocedure]))

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';

DO $partly_opened_board$
DECLARE
  v_proc regprocedure;
  v_before text;
  v_after text;
  v_reversed text;
  v_source text;
  v_metadata_before jsonb;
  v_metadata_after jsonb;
  v_old_hits integer;
  v_new_hits integer;
  v_old text := $old$SELECT count(*)=0 OR (count(*)=12 AND count(DISTINCT name)=12) FROM candidates$old$;
  v_new text := $new$SELECT count(*)=count(DISTINCT name) FROM candidates$new$;
BEGIN
  FOREACH v_proc IN ARRAY ARRAY[
    'public.fn_unwind_unused_first_club_welcome_package(uuid,uuid)'::regprocedure,
    'public.fn_get_club_welcome_package_reset_impact(uuid)'::regprocedure
  ] LOOP
    v_before := pg_get_functiondef(v_proc);
    SELECT jsonb_build_object('owner',p.proowner,'acl',p.proacl,'config',p.proconfig,
             'secdef',p.prosecdef,'volatile',p.provolatile,'parallel',p.proparallel,
             'leakproof',p.proleakproof,'language',p.prolang,'rettype',p.prorettype,
             'retset',p.proretset,'kind',p.prokind)
      INTO STRICT v_metadata_before
      FROM pg_proc p WHERE p.oid=v_proc;

    v_old_hits := (length(v_before)-length(replace(v_before,v_old,'')))/length(v_old);
    v_new_hits := (length(v_before)-length(replace(v_before,v_new,'')))/length(v_new);

    IF v_old_hits=1 AND v_new_hits=0 THEN
      v_after := replace(v_before,v_old,v_new);
      v_reversed := replace(v_after,v_new,v_old);
      IF v_reversed IS DISTINCT FROM v_before
         OR (length(v_after)-length(replace(v_after,v_new,'')))/length(v_new)<>1 THEN
        RAISE EXCEPTION 'PARTLY_OPENED_BOARD_ROUNDTRIP_REFUSED: %',v_proc;
      END IF;
      EXECUTE v_after;
    ELSIF NOT (v_old_hits=0 AND v_new_hits=1) THEN
      RAISE EXCEPTION 'PARTLY_OPENED_BOARD_PREIMAGE_REFUSED: % old % new %',
        v_proc,v_old_hits,v_new_hits;
    END IF;

    SELECT p.prosrc,
           jsonb_build_object('owner',p.proowner,'acl',p.proacl,'config',p.proconfig,
             'secdef',p.prosecdef,'volatile',p.provolatile,'parallel',p.proparallel,
             'leakproof',p.proleakproof,'language',p.prolang,'rettype',p.prorettype,
             'retset',p.proretset,'kind',p.prokind)
      INTO STRICT v_source,v_metadata_after
      FROM pg_proc p WHERE p.oid=v_proc;
    IF position(v_new in v_source)=0
       OR position(v_old in v_source)>0
       OR v_metadata_after IS DISTINCT FROM v_metadata_before THEN
      RAISE EXCEPTION 'PARTLY_OPENED_BOARD_POSTIMAGE_REFUSED: % metadata %',
        v_proc,v_metadata_after IS NOT DISTINCT FROM v_metadata_before;
    END IF;
  END LOOP;
END
$partly_opened_board$;

DO $assert_partly_opened_board$
DECLARE
  v_proc regprocedure;
  v_source text;
BEGIN
  FOREACH v_proc IN ARRAY ARRAY[
    'public.fn_unwind_unused_first_club_welcome_package(uuid,uuid)'::regprocedure,
    'public.fn_get_club_welcome_package_reset_impact(uuid)'::regprocedure
  ] LOOP
    SELECT p.prosrc INTO STRICT v_source FROM pg_proc p WHERE p.oid=v_proc;
    -- The new rule is in, the old one is gone, and nothing else in the
    -- board identity moved: the twelve exact shapes and the club scope.
    IF v_source NOT LIKE '%SELECT count(*)=count(DISTINCT name) FROM candidates%'
       OR v_source LIKE '%count(*)=0 OR (count(*)=12 AND count(DISTINCT name)=12)%'
       OR v_source NOT LIKE '%(''NLH Heads-Up 1'',''NLH'',''sng'',''SNG'',0.95::numeric,0.05::numeric,2,1000)%'
       OR v_source NOT LIKE '%(''1 Chip Deep Stack Spin PLO6'',''PLO6'',''spin'',''SPIN'',1::numeric,0::numeric,3,1000)%'
       OR v_source NOT LIKE '%WHERE t.club_id=p_club_id AND t.union_id IS NULL AND t.schedule_id IS NULL%' THEN
      RAISE EXCEPTION 'PARTLY_OPENED_BOARD_IDENTITY_REFUSED: %',v_proc;
    END IF;
  END LOOP;
  -- The unwind still takes the global settlement lane before it moves money.
  IF (SELECT p.prosrc FROM pg_proc p
       WHERE p.oid='public.fn_unwind_unused_first_club_welcome_package(uuid,uuid)'::regprocedure)
     NOT LIKE '%PERFORM public.fn_ca_lock_settlement_lane_global();%' THEN
    RAISE EXCEPTION 'PARTLY_OPENED_BOARD_LANE_REFUSED';
  END IF;
END
$assert_partly_opened_board$;

COMMIT;
