-- 20261021234940_a_diamond_wallet_lock_never_blocks_a_foreign_key_check.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- A DIAMOND WALLET LOCK NEVER BLOCKS A FOREIGN KEY CHECK (2026-10-21)
--
-- What happened. Turbo Tuesday PKO (bc8e3d86, 351 entries) played its last
-- hand at 23:03:34 UTC and did not finish until 23:12:00: the engine's atomic
-- finish was refused eight times with 40P01. postgres_logs over 24 hours show
-- 164 deadlocks at fn_poker_diamond_release line 24, 6 at
-- fn_poker_diamond_reserve and 2 at add_diamonds_to_balance.
--
-- The cycle, read from postgres_logs 2026-10-21 23:10-23:12 UTC:
--   finish   fn_complete_tournament_terminal -> fn_settle_tournament_rake ->
--            fn_poker_diamond_tournament_close_custody, which releases each
--            entrant's custody: "PERFORM id FROM public.profiles WHERE id =
--            v_owner FOR UPDATE" for player after player in one transaction;
--   hand     fn_ca_commit_hand_submission -> ..._before_lease_generation
--            line 206 updates the same tournament_players row a second time
--            in its transaction, so PostgreSQL re-checks
--            fk_tournament_players_user_id_profiles: "SELECT 1 FROM ONLY
--            profiles x WHERE id = $1 FOR KEY SHARE OF x" (tuple (680,1) on
--            both sides of the logged cycle).
-- FOR UPDATE is the one row lock that refuses FOR KEY SHARE. The wallet doors
-- take it only to serialize writers of the wallet; none of them deletes a
-- profile or changes its id.
--
-- The fix: the three Diamond wallet doors lock the profile FOR NO KEY UPDATE.
-- Every other writer of the wallet (deduct, transfer, shop, top-up, UPDATE
-- profiles) takes FOR UPDATE, FOR NO KEY UPDATE or a row UPDATE, and each of
-- those still conflicts with it, so one wallet still moves one operation at a
-- time. A foreign-key check from a row that points at the profile no longer
-- waits, the hand commits, and the finish takes the next wallet. No amount,
-- journal, receipt or custody rule changes.
--
-- HOW: the pinned-preimage exact-substitution helper of 20261015094435 (live
-- md5 read on production 2026-10-21; postimages derived from the byte-exact
-- fixtures in scripts/ci/fixtures/diamond-wallet-locks). Owner, SECURITY
-- DEFINER, proconfig and grants must not move. The two watched doors declare
-- their redefinition in this transaction.
--
-- Regression: scripts/ci/test-a-diamond-wallet-lock-never-blocks-a-foreign-key-check.py
-- (native PostgreSQL 17, two sessions, production's exact function text), run
-- by .github/workflows/a-diamond-wallet-lock-never-blocks-a-foreign-key-check.yml.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_poker_diamond_release(uuid,uuid)'::regprocedure)) = 'f52d63d2163f3f85dfe1e72a1ef267e7' AND md5(pg_get_functiondef('public.fn_poker_diamond_reserve(uuid,text,uuid,text,numeric,uuid)'::regprocedure)) = '99fb5f4f483710c49e1a2ee8824b0992' AND md5(pg_get_functiondef('public.add_diamonds_to_balance(uuid,integer,text,text,text,uuid)'::regprocedure)) = '06177aba483ac900056a9b4d769e1870')

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

CREATE FUNCTION pg_temp.ca_lock_subst(p_sig text, p_before text, p_after text,
                                       p_old text[], p_new text[])
RETURNS void LANGUAGE plpgsql AS $h$
DECLARE
  v_def text; v_new text; v_n integer; i integer;
  v_acl text; v_owner text; v_secdef boolean; v_cfg text[];
BEGIN
  v_def := pg_get_functiondef(p_sig::regprocedure);
  IF md5(v_def) <> p_before THEN
    RAISE EXCEPTION '% is not the pinned text (md5 %)', p_sig, md5(v_def);
  END IF;
  IF array_length(p_old, 1) IS DISTINCT FROM array_length(p_new, 1) THEN
    RAISE EXCEPTION '%: anchors and replacements do not pair', p_sig;
  END IF;
  v_new := v_def;
  FOR i IN 1 .. array_length(p_old, 1) LOOP
    v_n := (length(v_new) - length(replace(v_new, p_old[i], ''))) / length(p_old[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '%: anchor % occurs % times, expected exactly 1', p_sig, i, v_n;
    END IF;
    v_new := replace(v_new, p_old[i], p_new[i]);
  END LOOP;
  IF md5(v_new) <> p_after THEN
    RAISE EXCEPTION '%: substituted text is not the derived postimage (md5 %)', p_sig, md5(v_new);
  END IF;

  SELECT p.proacl::text, pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig
    INTO v_acl, v_owner, v_secdef, v_cfg
    FROM pg_proc p WHERE p.oid = p_sig::regprocedure;

  EXECUTE v_new;

  IF md5(pg_get_functiondef(p_sig::regprocedure)) <> p_after THEN
    RAISE EXCEPTION '%: the replaced function does not read back as the postimage', p_sig;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = p_sig::regprocedure
                    AND p.proacl::text IS NOT DISTINCT FROM v_acl
                    AND pg_get_userbyid(p.proowner) = v_owner
                    AND p.prosecdef = v_secdef
                    AND p.proconfig IS NOT DISTINCT FROM v_cfg) THEN
    RAISE EXCEPTION '%: owner, security, settings or grants moved', p_sig;
  END IF;
END $h$;

SELECT pg_temp.ca_lock_subst(
  'public.fn_poker_diamond_release(uuid,uuid)',
  'd525cb1e20d6fb05e5b5e51497b127e7', 'f52d63d2163f3f85dfe1e72a1ef267e7',
  ARRAY[$o1$PERFORM id FROM public.profiles WHERE id = v_owner FOR UPDATE;$o1$],
  ARRAY[$n1$-- NO KEY UPDATE, not UPDATE (20261021234940): it still serializes every
  -- writer of this wallet (FOR UPDATE, NO KEY UPDATE and UPDATE all
  -- refuse it), and it no longer refuses the FOR KEY SHARE that a
  -- foreign-key check from a row pointing at this profile takes.
  PERFORM id FROM public.profiles WHERE id = v_owner FOR NO KEY UPDATE;$n1$]
);
SELECT public.fn_ca_declare_guard_redefinition('fn_poker_diamond_release', 'migration 20261021234940_a_diamond_wallet_lock_never_blocks_a_foreign_key_check');

SELECT pg_temp.ca_lock_subst(
  'public.fn_poker_diamond_reserve(uuid,text,uuid,text,numeric,uuid)',
  'cf2150429728d8d796711e9bdbb22f51', '99fb5f4f483710c49e1a2ee8824b0992',
  ARRAY[$o2$SELECT diamonds INTO v_wallet FROM public.profiles WHERE id=p_user_id FOR UPDATE;$o2$],
  ARRAY[$n2$-- NO KEY UPDATE, not UPDATE (20261021234940): it still serializes every
 -- writer of this wallet (FOR UPDATE, NO KEY UPDATE and UPDATE all
 -- refuse it), and it no longer refuses the FOR KEY SHARE that a
 -- foreign-key check from a row pointing at this profile takes.
 SELECT diamonds INTO v_wallet FROM public.profiles WHERE id=p_user_id FOR NO KEY UPDATE;$n2$]
);
SELECT public.fn_ca_declare_guard_redefinition('fn_poker_diamond_reserve', 'migration 20261021234940_a_diamond_wallet_lock_never_blocks_a_foreign_key_check');

SELECT pg_temp.ca_lock_subst(
  'public.add_diamonds_to_balance(uuid,integer,text,text,text,uuid)',
  '5d356b15727558df9c498dbb05a745d0', '06177aba483ac900056a9b4d769e1870',
  ARRAY[$o3$FROM public.profiles WHERE id = p_user_id FOR UPDATE;$o3$],
  ARRAY[$n3$FROM public.profiles WHERE id = p_user_id FOR NO KEY UPDATE;
    -- NO KEY UPDATE, not UPDATE (20261021234940): it still serializes every
    -- writer of this wallet (FOR UPDATE, NO KEY UPDATE and UPDATE all
    -- refuse it), and it no longer refuses the FOR KEY SHARE that a
    -- foreign-key check from a row pointing at this profile takes.$n3$]
);

COMMIT;
