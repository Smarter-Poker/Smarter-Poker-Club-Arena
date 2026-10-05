-- 20261005184659_the_champion_s_own_bounty_head_is_labelled_as_his_own.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- At the end of a bounty event fn_finalize_bounty_pool pays the champion the
-- bounty pool nobody claimed (bounty_pool minus every 'bounty' ledger row).
-- Nobody can knock the champion out, so that residual always contains the
-- champion's OWN head - and on an ordinary event it is nothing else. The
-- wallet nevertheless labelled it "Unclaimed bounty pool awarded to champion",
-- which reads to the player as somebody else's money (mystery bounty audit,
-- 455ec7ee, defect 7).
--
-- The label now says what the money is, read from the champion's own head
-- (tournament_players.current_bounty, before this function zeroes it):
--
--   residual <= own head    'Tournament champion: own bounty head returned'
--   residual  > own head    'Tournament champion: own bounty head returned with
--                            unclaimed bounty pool'
--   no own head on the row  'Unclaimed bounty pool awarded to champion' (as before)
--
-- LABEL ONLY. The amount, the obligation (kind 'bounty_residual', cumulative
-- per user), the ledger category and every guard are byte for byte unchanged:
-- p_description is passed straight through fn_settle_tournament_obligation as
-- the receipt text and decides nothing. The legacy unfunded branch already
-- reads 'Tournament champion: own bounty head collected' and is untouched.
--
-- An asserted substitution: the live text is pinned by md5, the replaced
-- clause must occur exactly once, and the reverse substitution must reproduce
-- the pinned text, or the whole transaction aborts.
--
-- PINNED LIVE md5(pg_get_functiondef('public.fn_finalize_bounty_pool(uuid,uuid)')):
--   96417e3cbe35661ced11437cbbb18613   (read 2026-10-05)
--
-- @live-proof: (SELECT position('own bounty head returned' in pg_get_functiondef('public.fn_finalize_bounty_pool(uuid,uuid)'::regprocedure)) > 0)
--
-- NOT APPLIED by the authoring agent. Apply once, outside the :50-:03 UTC
-- break window, as one transaction.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $m$
DECLARE
  v_oid oid := 'public.fn_finalize_bounty_pool(uuid,uuid)'::regprocedure;
  v_def text;
  v_old text;
  v_new text;
  v_n integer;
BEGIN
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '96417e3cbe35661ced11437cbbb18613' THEN
    RAISE EXCEPTION 'fn_finalize_bounty_pool is not the pinned text (md5 %)', md5(v_def);
  END IF;

  v_old := E'      round(v_prior + v_residual, 2), ''fn_finalize_bounty_pool'',\n'
        || E'      ''Unclaimed bounty pool awarded to champion'');';
  v_new := E'      round(v_prior + v_residual, 2), ''fn_finalize_bounty_pool'',\n'
        || E'      -- 20261005184659: the champion''s own head is labelled as his own.\n'
        || E'      (SELECT CASE\n'
        || E'                WHEN COALESCE(own.head, 0) <= 0\n'
        || E'                  THEN ''Unclaimed bounty pool awarded to champion''\n'
        || E'                WHEN v_residual <= own.head\n'
        || E'                  THEN ''Tournament champion: own bounty head returned''\n'
        || E'                ELSE ''Tournament champion: own bounty head returned with unclaimed bounty pool''\n'
        || E'              END\n'
        || E'         FROM (SELECT (SELECT NULLIF(tp.current_bounty, 0)\n'
        || E'                         FROM public.tournament_players tp\n'
        || E'                        WHERE tp.tournament_id = p_tournament_id\n'
        || E'                          AND tp.user_id = p_winner_user_id) AS head) own));';

  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'fn_finalize_bounty_pool: the residual label clause occurs % times, expected 1', v_n;
  END IF;

  EXECUTE replace(v_def, v_old, v_new);

  IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> '96417e3cbe35661ced11437cbbb18613' THEN
    RAISE EXCEPTION 'fn_finalize_bounty_pool: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

COMMIT;
