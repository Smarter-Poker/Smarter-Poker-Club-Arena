-- 20261003001046_the_seed_return_lineage_matches_the_key_the_reversal_actuall.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY
--
-- Club Create Certification run 37080553539 refused a residual fixture club with
-- POST_RESET_CERTIFICATION_SEED_RETURN_LINEAGE_REFUSED. Eight predicates stand in
-- that block and exactly one of them fails, for both stranded clubs. Read from
-- rows, not guessed:
--
--   pool row exact            1 of 1   ok
--   spin_reserve_ledger rows  4 of 4   ok
--   seed / activation         1 / 1    ok
--   seed_return / deactivation 1 / 1   ok
--   bbj_promo_sweep receipt   1 of 1   ok
--   chip_ledger reversal leg  0 of 1   REFUSED
--
-- The reversal leg exists and is correct. What does not match is the key the
-- preparer looks it up by. The live row on 32caee5b-d303-49c0-a7d5-b196b536d631
-- (and on 94d9ac6e-0989-44bd-8083-1cbb0ca76566) is
--
--   from_type         spin_reserve
--   from_entity_id    the club's spin_bonus_pools row
--   to_type           club_treasury
--   to_entity_id      the club
--   amount            200.00
--   category          reversal
--   idempotency_key   spin-deactivation-seed-return:<club>:200.00
--
-- and 20261002210559 asks for
--
--   l.idempotency_key='spin-deactivation-seed-return:'||p_club_id::text||':200'
--
-- The writer builds that key from a numeric, and numeric 200 renders as "200.00",
-- so the two strings have never been equal and this predicate has never once
-- passed. It is the same class of defect as the min(uuid) in the same function:
-- a type's text form assumed rather than read.
--
-- THE FIX DOES NOT SWAP ONE LITERAL FOR ANOTHER. Hard-coding ':200.00' would
-- break again the next time the writer's scale or type changes, which is how
-- this got here. The predicate now says what it means: the key must name this
-- club, and the amount inside it must BE 200, compared as a number.
--
--   l.idempotency_key LIKE 'spin-deactivation-seed-return:'||p_club_id::text||':%'
--   AND split_part(l.idempotency_key,':',3)::numeric=200
--
-- The key has exactly three colon-separated parts and a uuid contains no colon,
-- so part 3 is the amount. Nothing else in the predicate moves: from_type,
-- from_entity_id, to_type, to_entity_id, amount, category and the required count
-- of one are unchanged, so the admission is exactly as strict as it was meant to
-- be and no weaker.
--
-- GUARDED REWRITE, in the idiom 20261002223819 and 20261002231724 established on
-- this same function: assert the exact preimage, substitute once, assert the
-- postimage, and abort if the source has moved under us. Three agents have
-- edited this routine today; a blind CREATE OR REPLACE would discard whichever
-- of their changes landed last. It touches no club, player, game, wallet or
-- chip row, and the helper stays revoked from every role.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
--
-- @live-proof: (SELECT p.prosrc LIKE '%split_part(l.idempotency_key,'':'',3)::numeric=200%' AND p.prosrc NOT LIKE '%||'':200''%' FROM pg_proc p WHERE p.oid='public.fn_ca_prepare_post_reset_welcome_certification_fixture(uuid)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';

DO $rewrite$
DECLARE
  v_proc constant regprocedure :=
    'public.fn_ca_prepare_post_reset_welcome_certification_fixture(uuid)'::regprocedure;
  v_old constant text :=
    'AND l.idempotency_key=''spin-deactivation-seed-return:''||p_club_id::text||'':200''';
  v_new constant text :=
    'AND l.idempotency_key LIKE ''spin-deactivation-seed-return:''||p_club_id::text||'':%''' ||
    E'\n           AND split_part(l.idempotency_key,'':'',3)::numeric=200';
  -- The source as 20261002231724 left it. Any other digest means a fourth agent
  -- edited the routine after 00:10Z on 2026-10-03, and this migration must be
  -- rewritten against what they left rather than applied over it.
  v_preimage_md5 constant text := 'd784a67061328a136e0ec6da61c1973e';
  v_source text;
  v_before text;
  v_after text;
  v_old_hits integer;
  v_new_hits integer;
BEGIN
  SELECT p.prosrc INTO STRICT v_source FROM pg_proc p WHERE p.oid=v_proc;
  v_before:=pg_get_functiondef(v_proc);
  v_old_hits:=(length(v_before)-length(replace(v_before,v_old,'')))/length(v_old);
  v_new_hits:=(length(v_before)-length(replace(v_before,v_new,'')))/length(v_new);

  IF v_old_hits=1 AND v_new_hits=0 THEN
    IF md5(v_source)<>v_preimage_md5 THEN
      RAISE EXCEPTION 'SEED_RETURN_KEY_SOURCE_DIGEST_REFUSED: %',md5(v_source);
    END IF;
    v_after:=replace(v_before,v_old,v_new);
    IF (length(v_after)-length(replace(v_after,v_new,'')))/length(v_new)<>1
       OR position(v_old in v_after)>0
       OR v_after NOT LIKE '%POST_RESET_CERTIFICATION_SEED_RETURN_LINEAGE_REFUSED%'
       OR v_after NOT LIKE '%l.from_type=''spin_reserve'' AND l.to_type=''club_treasury''%'
       OR v_after NOT LIKE '%l.amount=200 AND l.category=''reversal''%'
       OR v_after NOT LIKE '%cardinality(v_board_tournaments) NOT IN(0,12)%'
       OR v_after NOT LIKE '%(array_agg(reset_operation_id ORDER BY reset_operation_id))[1]%'
       OR v_after NOT LIKE '%i.reset_operation_id IS DISTINCT FROM v_operation%'
       OR v_after NOT LIKE '%POST_RESET_CERTIFICATION_TABLE_DELETE_PERMIT_NOT_CONSUMED%' THEN
      RAISE EXCEPTION 'SEED_RETURN_KEY_SUBSTITUTION_REFUSED';
    END IF;
    EXECUTE v_after;
  ELSIF NOT (v_old_hits=0 AND v_new_hits=1) THEN
    RAISE EXCEPTION 'SEED_RETURN_KEY_PREIMAGE_REFUSED: old %, new %',
      v_old_hits,v_new_hits;
  END IF;
END
$rewrite$;

-- The preparer stays private even from service_role: only
-- fn_ca_retire_welcome_certification_club may reach it, as 20261002210559 left it.
REVOKE ALL ON FUNCTION public.fn_ca_prepare_post_reset_welcome_certification_fixture(uuid)
  FROM PUBLIC,anon,authenticated,service_role;

DO $assert$
DECLARE
  v_proc constant regprocedure :=
    'public.fn_ca_prepare_post_reset_welcome_certification_fixture(uuid)'::regprocedure;
  v_source text;
BEGIN
  SELECT p.prosrc INTO v_source FROM pg_proc p WHERE p.oid=v_proc;
  IF v_source NOT LIKE '%split_part(l.idempotency_key,'':'',3)::numeric=200%'
     OR v_source LIKE '%||'':200''%'
     OR v_source NOT LIKE '%POST_RESET_CERTIFICATION_SEED_RETURN_LINEAGE_REFUSED%'
     OR v_source NOT LIKE '%cardinality(v_board_tournaments) NOT IN(0,12)%'
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
     OR has_function_privilege('anon',v_proc,'EXECUTE')
     OR has_function_privilege('authenticated',v_proc,'EXECUTE')
     OR has_function_privilege('service_role',v_proc,'EXECUTE') THEN
    RAISE EXCEPTION 'SEED_RETURN_KEY_POSTIMAGE_REFUSED';
  END IF;
END
$assert$;

COMMIT;
