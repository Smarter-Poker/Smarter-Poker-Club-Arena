-- 20260921094352_a_published_ante_never_exceeds_its_big_blind.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
/*
 * ===========================================================================
 *  A PUBLISHED ANTE NEVER EXCEEDS ITS BIG BLIND
 *  2026-09-21
 * ===========================================================================
 *
 * THE SOURCE SIDE OF A REPAIR THAT ONLY LANDED DOWNSTREAM. Yesterday's
 * 20260920190537_the_overflow_ante_keeps_its_authored_share_of_the_big_blind
 * fixed fn_resolve_tournament_blinds, whose mtt_overflow branch applied
 * LEAST(...,10000000) to the small blind, the big blind and the ante
 * INDEPENDENTLY and so let a deep overflow saturate all three to the same
 * number. Resolution now holds the ante to the anchor row's authored
 * ante:bigBlind proportion.
 *
 * fn_publish_tournament_blind_level is the companion at the other end: it is
 * the authority that WRITES a level onto tournaments.blind_level_state and
 * every live row in public.tables. Its validation block checks the shape of
 * every argument it is given -
 *
 *   p_small_blind  not null, >= 0, <= 10000000
 *   p_big_blind    not null, >  0, <= 10000000
 *   p_small_blind  <= p_big_blind          <- the ONE relational check
 *   p_ante         not null, >= 0, <= 10000000
 *
 * - and has no opinion whatever about the ante's relationship to the big
 * blind. Measured against production on 2026-09-21, ante = 500 against
 * big blind = 200 passes this block and is stopped only by the lease fence:
 *
 *   fn_publish_tournament_blind_level(..., 100, 200, 500)
 *     -> 42501 TOURNAMENT_MANAGER_FENCED       (validation ACCEPTED it)
 *   fn_publish_tournament_blind_level(..., 300, 200, 0)
 *     -> 22023 Invalid tournament blind transition   (sb > bb is refused)
 *
 * So the small blind has a relational guard and the ante does not, and a
 * caller holding a valid lease can still author a level nobody can play.
 * Resolution clamping the ante afterwards does not close this: the publisher
 * takes its numbers from the manager, not from the resolver, and
 * server/src/tournament/blindEscalation.ts carries the SAME independent
 * ceiling in TypeScript (enforcePlayableBlindLevel repairs the small blind
 * against the big blind and clamps the ante on its own at MAX_BLIND_VALUE).
 *
 * WHAT CORRECT MEANS HERE, FROM THE DATA AND NOT FROM A POKER RULE. Read off
 * production on 2026-09-21:
 *
 *   AUTHORED   21 distinct tournaments.blind_structure values, 370 levels.
 *              ante > bigBlind: 0.  ante = bigBlind: 60.  max ratio 1.0000.
 *   COMMANDER  commander_tournaments + commander_tournament_templates,
 *              2,176 levels.  ante > bigBlind: 0.  max ratio 0.2000.
 *   PUBLISHED  tournaments.blind_level_state, 37,286 rows.
 *              ante > big_blind: 0.  ante = big_blind: 412.  max ratio 1.0000.
 *   TABLES     273,161 rows.  ante > big_blind: 0.
 *              ante = big_blind: 6,097 (279 of them on live rows). max 1.0000.
 *
 * The maximum ante:bigBlind ratio anywhere in this estate - authored,
 * published or dealt - is EXACTLY 1.0, and nothing has ever exceeded it.
 *
 * THE CEILING IS ONE BIG BLIND, NOT LESS. Two of the 21 structures are
 * genuine big blind antes and author ante = bigBlind on 30 of their 32
 * levels:
 *
 *   978824ab   32 levels, 2 with no ante, 30 at ante = bigBlind
 *   4f8ff2b0   32 levels, 2 with no ante, 30 at ante = bigBlind
 *
 * and server/src/engine/AnteMath.ts makes `ante >= bigBlind` the engine's
 * TYPE TEST for them: at or above the big blind the structure authored a
 * TOTAL posted once, below it the ante is per-player. Refusing ante = bigBlind
 * would refuse those two formats outright. Every other structure in
 * production tops out at 0.15 or 0.125 of the big blind, so there is no
 * ante-only or button-ante format here that needs headroom above one big
 * blind - and by AnteMath.ts's own definition there could not be one, since a
 * big blind ante IS one big blind.
 *
 * THE RULE. p_ante > p_big_blind is refused. Nothing else changes: ante =
 * big_blind (a big blind ante), every per-player ante below it, and an ante
 * of zero are all accepted exactly as they are today, so no structure that
 * exists can stop publishing. This is the same class of check as the
 * p_small_blind > p_big_blind line already in the block, given the same
 * ERRCODE 22023, and stated as its own guard so that a refusal names the rule
 * it broke instead of pointing at eight unrelated bounds.
 *
 * The fencing, the admission barrier, the settlement lane, the lease read,
 * the replay branch, the tables update, the receipt verification and the
 * returned key set are all left exactly as they are.
 *
 * NOT IN SCOPE. fn_resolve_tournament_blinds is finished and is not touched.
 * The 279 live public.tables rows that still carry ante = big_blind are the
 * downstream residue of the resolver defect, they are legal under this rule,
 * and they correct themselves as the engine republishes.
 */
--
-- HOW A READER SEES THIS IS LIVE. This migration creates no persistent
-- object: it reads public.fn_publish_tournament_blind_level's own definition,
-- patches one unique text anchor in it and EXECUTEs the result, so nothing
-- new appears in any catalogue and scripts/ci/check-migrations-are-live.mjs
-- has nothing to look up. The guard is therefore stated as its own proof.
-- @live-proof: (SELECT position('IF p_ante>p_big_blind THEN' in p.prosrc) > 0 FROM pg_proc p WHERE p.oid = to_regprocedure('public.fn_publish_tournament_blind_level(uuid,uuid,integer,integer,numeric,numeric,numeric)'))
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- The pre-image this guard was written against, pinned exactly: definition,
-- body, owner, ACL, search_path, security mode and volatility. Anything else
-- and we stop rather than patch a function we did not read.
DO $pin$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = to_regprocedure('public.fn_publish_tournament_blind_level(uuid,uuid,integer,integer,numeric,numeric,numeric)')
       AND md5(pg_get_functiondef(oid)) = '6d88ca5594c72e7b6757e65d2972461a'
       AND md5(prosrc) = 'ea893550ec280993c522bb8dfb78fcd3'
       AND proowner = 'postgres'::regrole
       AND proconfig = ARRAY['search_path=public, pg_temp']
       AND proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND prosecdef
       AND provolatile = 'v'
  ) THEN
    RAISE EXCEPTION 'PUBLISHED_ANTE_CEILING_PREIMAGE_CHANGED'
      USING ERRCODE = '55000';
  END IF;
END $pin$;

DO $mig$
DECLARE
  v_src text;
  v_new text;
  -- The tail of the existing validation block, exactly as 20260913200859
  -- wrote it and 20260913201306 left it.
  v_anchor text := $a$     OR p_ante IS NULL OR p_ante<0 OR p_ante>10000000 THEN
    RAISE EXCEPTION 'Invalid tournament blind transition' USING ERRCODE='22023';
  END IF;$a$;
  v_patch text := $a$     OR p_ante IS NULL OR p_ante<0 OR p_ante>10000000 THEN
    RAISE EXCEPTION 'Invalid tournament blind transition' USING ERRCODE='22023';
  END IF;

  /* A PUBLISHED ANTE NEVER EXCEEDS ITS BIG BLIND (2026-09-21). The block
     above bounds the ante on its own and relates only the small blind to the
     big blind, so ante = 500 against big blind = 200 reached the lease fence
     as a well-formed level. Across production - 370 authored levels in 21
     structures, 2,176 commander levels, 37,286 published blind_level_state
     rows and 273,161 tables rows - the ante:bigBlind ratio has NEVER exceeded
     1.0.

     The ceiling is one big blind and not less: two structures (978824ab,
     4f8ff2b0) are genuine big blind antes authoring ante = bigBlind on 30 of
     32 levels, and AnteMath.ts reads `ante >= bigBlind` as "this structure
     authored a TOTAL". Equality is legal and untouched; only a strictly
     larger ante is refused. Stated separately from the bounds above so the
     refusal names the rule that was broken. */
  IF p_ante>p_big_blind THEN
    RAISE EXCEPTION 'Invalid tournament blind transition: ante % exceeds big blind %',
      p_ante, p_big_blind USING ERRCODE='22023';
  END IF;$a$;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_src
    FROM pg_proc
   WHERE oid = to_regprocedure('public.fn_publish_tournament_blind_level(uuid,uuid,integer,integer,numeric,numeric,numeric)');

  -- The anchor must appear exactly once, or the shape this was written
  -- against has moved and a blind replace would land somewhere else.
  IF (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor) <> 1 THEN
    RAISE EXCEPTION 'PUBLISHED_ANTE_CEILING_ANCHOR_NOT_UNIQUE' USING ERRCODE = '55000';
  END IF;
  IF position(v_patch IN v_src) > 0 THEN
    RAISE EXCEPTION 'PUBLISHED_ANTE_CEILING_ALREADY_PRESENT' USING ERRCODE = '55000';
  END IF;

  v_new := replace(v_src, v_anchor, v_patch);
  IF v_new = v_src THEN
    RAISE EXCEPTION 'PUBLISHED_ANTE_CEILING_REPLACEMENT_MADE_NO_CHANGE' USING ERRCODE = '55000';
  END IF;

  EXECUTE v_new;
END $mig$;

-- CREATE OR REPLACE keeps owner, ACL, search_path, volatility and security
-- mode; assert that rather than trusting it, then prove the guard's exact
-- edge on the live function before this transaction commits.
--
-- Every probe below is answered before the function reaches its admission
-- barrier, its settlement lane or any UPDATE. The validation block runs
-- first, and a level that CLEARS it is stopped immediately afterwards by the
-- lease fence, because app.smarter_data_actor is not set in this migration.
-- So 22023 means "validation refused it" and 42501 means "validation accepted
-- it", and nothing is written either way.
DO $post$
DECLARE
  v_t uuid := '00000000-0000-0000-0000-000000000001';
  v_g uuid := '00000000-0000-0000-0000-000000000002';
  r text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = to_regprocedure('public.fn_publish_tournament_blind_level(uuid,uuid,integer,integer,numeric,numeric,numeric)')
       AND proowner = 'postgres'::regrole
       AND proconfig = ARRAY['search_path=public, pg_temp']
       AND proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND prosecdef
       AND provolatile = 'v'
  ) THEN
    RAISE EXCEPTION 'PUBLISHED_ANTE_CEILING_POSTIMAGE_ATTRIBUTES_MOVED' USING ERRCODE = '55000';
  END IF;

  -- AN ANTE ABOVE THE BIG BLIND IS REFUSED, and the refusal names this rule
  -- rather than the eight unrelated bounds it sits beside.
  BEGIN
    PERFORM public.fn_publish_tournament_blind_level(v_t,v_g,0,1,100,200,500);
    r := 'no-exception';
  EXCEPTION WHEN OTHERS THEN r := SQLSTATE||' '||SQLERRM;
  END;
  IF r NOT LIKE '22023 Invalid tournament blind transition: ante % exceeds big blind %' THEN
    RAISE EXCEPTION 'PUBLISHED_ANTE_CEILING_DID_NOT_REFUSE_ANTE_OVER_BB: %', r USING ERRCODE = '55000';
  END IF;

  -- The smallest possible violation is refused too: one chip over.
  BEGIN
    PERFORM public.fn_publish_tournament_blind_level(v_t,v_g,0,1,100,200,201);
    r := 'no-exception';
  EXCEPTION WHEN OTHERS THEN r := SQLSTATE||' '||SQLERRM;
  END;
  IF r NOT LIKE '22023 Invalid tournament blind transition: ante % exceeds big blind %' THEN
    RAISE EXCEPTION 'PUBLISHED_ANTE_CEILING_MISSED_THE_BOUNDARY: %', r USING ERRCODE = '55000';
  END IF;

  -- A GENUINE BIG BLIND ANTE IS STILL PUBLISHABLE. Structures 978824ab and
  -- 4f8ff2b0 author ante = bigBlind on 30 of their 32 levels, and AnteMath.ts
  -- types on `ante >= bigBlind`. Equality must clear validation and be
  -- stopped only by the fence.
  BEGIN
    PERFORM public.fn_publish_tournament_blind_level(v_t,v_g,0,1,100,200,200);
    r := 'no-exception';
  EXCEPTION WHEN OTHERS THEN r := SQLSTATE||' '||SQLERRM;
  END;
  IF r NOT LIKE '42501 TOURNAMENT_MANAGER_FENCED%' THEN
    RAISE EXCEPTION 'PUBLISHED_ANTE_CEILING_BROKE_A_BIG_BLIND_ANTE: %', r USING ERRCODE = '55000';
  END IF;

  -- A per-player ante at the estate's usual 0.125 x bb is untouched.
  BEGIN
    PERFORM public.fn_publish_tournament_blind_level(v_t,v_g,0,1,100,200,25);
    r := 'no-exception';
  EXCEPTION WHEN OTHERS THEN r := SQLSTATE||' '||SQLERRM;
  END;
  IF r NOT LIKE '42501 TOURNAMENT_MANAGER_FENCED%' THEN
    RAISE EXCEPTION 'PUBLISHED_ANTE_CEILING_REFUSED_A_PER_PLAYER_ANTE: %', r USING ERRCODE = '55000';
  END IF;

  -- A level with no ante at all is untouched.
  BEGIN
    PERFORM public.fn_publish_tournament_blind_level(v_t,v_g,0,1,100,200,0);
    r := 'no-exception';
  EXCEPTION WHEN OTHERS THEN r := SQLSTATE||' '||SQLERRM;
  END;
  IF r NOT LIKE '42501 TOURNAMENT_MANAGER_FENCED%' THEN
    RAISE EXCEPTION 'PUBLISHED_ANTE_CEILING_REFUSED_A_LEVEL_WITH_NO_ANTE: %', r USING ERRCODE = '55000';
  END IF;

  -- The overflow ceiling itself still resolves to a publishable level: at the
  -- 10,000,000 saturation point every one of sb, bb and ante is equal, which
  -- is exactly what blindEscalation.ts hands this function today. It must
  -- keep publishing.
  BEGIN
    PERFORM public.fn_publish_tournament_blind_level(v_t,v_g,0,1,10000000,10000000,10000000);
    r := 'no-exception';
  EXCEPTION WHEN OTHERS THEN r := SQLSTATE||' '||SQLERRM;
  END;
  IF r NOT LIKE '42501 TOURNAMENT_MANAGER_FENCED%' THEN
    RAISE EXCEPTION 'PUBLISHED_ANTE_CEILING_REFUSED_THE_SATURATED_LEVEL: %', r USING ERRCODE = '55000';
  END IF;

  -- The bounds that were already there still hold, with their own message:
  -- the small blind above the big blind, and an ante past 10,000,000.
  BEGIN
    PERFORM public.fn_publish_tournament_blind_level(v_t,v_g,0,1,300,200,0);
    r := 'no-exception';
  EXCEPTION WHEN OTHERS THEN r := SQLSTATE||' '||SQLERRM;
  END;
  IF r <> '22023 Invalid tournament blind transition' THEN
    RAISE EXCEPTION 'PUBLISHED_ANTE_CEILING_DISTURBED_THE_SMALL_BLIND_CHECK: %', r USING ERRCODE = '55000';
  END IF;
  BEGIN
    PERFORM public.fn_publish_tournament_blind_level(v_t,v_g,0,1,100,200,20000000);
    r := 'no-exception';
  EXCEPTION WHEN OTHERS THEN r := SQLSTATE||' '||SQLERRM;
  END;
  IF r <> '22023 Invalid tournament blind transition' THEN
    RAISE EXCEPTION 'PUBLISHED_ANTE_CEILING_DISTURBED_THE_ANTE_BOUND: %', r USING ERRCODE = '55000';
  END IF;
END $post$;

COMMIT;
