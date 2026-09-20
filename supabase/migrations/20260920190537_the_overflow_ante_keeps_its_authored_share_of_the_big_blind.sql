-- 20260920190537_the_overflow_ante_keeps_its_authored_share_of_the_big_blind.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
/*
 * ===========================================================================
 *  THE OVERFLOW ANTE KEEPS ITS AUTHORED SHARE OF THE BIG BLIND
 *  2026-09-20
 * ===========================================================================
 *
 * WHAT IS LIVE RIGHT NOW. Two RUNNING events are dealing an ante equal to
 * their big blind:
 *
 *   tables.id 2c621856-e728-4e8b-bf08-4c56746a8649   sb 43875  bb 87750  ante 87750
 *   tables.id 9f30d335-8262-4872-8926-3ddf1fefe75c   sb 24375  bb 48750  ante 48750
 *
 * Both are far past the end of their ladders (level 162 of a 40-level
 * structure, level 126 of a 30-level one) and both authored their final level
 * with ante = 0.125 x bigBlind:
 *
 *   5558f378 level 40   sb 2000000  bb 4000000  ante 500000   -> 0.125
 *   70cd09f8 level 30   sb 40000    bb 80000    ante 10000    -> 0.125
 *
 * WHY. fn_resolve_tournament_blinds's mtt_overflow branch is ratio-preserving
 * by construction: small blind, big blind and ante are each the anchor level's
 * value times ONE shared growth factor, and the chip clamp below them rescales
 * all three by ONE shared scale. The only step that is not shared is the hard
 * ceiling:
 *
 *   v_sb   := LEAST(<anchor sb>   * v_factor, 10000000);
 *   v_bb   := LEAST(<anchor bb>   * v_factor, 10000000);
 *   v_ante := LEAST(<anchor ante> * v_factor, 10000000);
 *
 * Applied to three related numbers independently, it saturates them to the
 * same 10,000,000 and the relationship between them is gone. The chip clamp
 * then faithfully preserves the equality it inherited.
 *
 * THIS WAS ALREADY DIAGNOSED AND HALF-REPAIRED. The 2026-09-09 migration
 * 20260909223919_ca_a_capped_blind_level_is_still_a_blind_level.sql wrote,
 * in this function's own source, that "a ceiling shared by three related
 * numbers destroys the relationship between them" - and then repaired only
 * the small blind (v_sb := GREATEST(1, floor(v_bb / 2))). The ante got a
 * non-negativity check and nothing else, so SB = BB was fixed and ante = BB
 * was left dealing.
 *
 * WHAT CORRECT MEANS HERE, FROM THE DATA AND NOT FROM A POKER RULE.
 *
 *  1. Across all 21 distinct blind_structure values in production and all 370
 *     authored levels in them, ante > bigBlind occurs ZERO times. The maximum
 *     authored ante:bigBlind ratio is exactly 1.0.
 *
 *  2. server/src/engine/AnteMath.ts (2026-08-30, written after a live
 *     incident) makes ante >= bigBlind the engine's TYPE TEST: "nobody
 *     charges every player a FULL big blind as an ante on top of the blinds.
 *     So `ante >= bigBlind` means the structure authored a total, and
 *     anything below it is per-player." An overflow that lifts a per-player
 *     structure's ante to its big blind therefore does not merely overcharge
 *     it, it silently RECLASSIFIES the ante for both the engine and the
 *     Harrington-M the horse brain derives from the same orbit cost.
 *
 *  3. Two production structures (4f8ff2b0, 978824ab - the "2 tournaments"
 *     AnteMath.ts counts as authoring a total) DO author ante = bigBlind on
 *     every level. For them ante = bigBlind past the ladder is CORRECT, so
 *     the rule cannot be "ante must be below the big blind". It has to be
 *     the authored PROPORTION.
 *
 * THE RULE. In the mtt_overflow branch the ante may never exceed the anchor
 * level's authored ante:bigBlind proportion applied to the level's resolved
 * big blind. It is a CEILING: it only ever lowers an ante, never raises one,
 * so no level can come out of here more expensive than it does today. The
 * proportion itself is clamped to 1, which is a no-op for every structure in
 * production (see 1) and a backstop for anything authored later.
 *
 * The anchor row, the growth factor, the 40-step exponent cap, the
 * 10,000,000 ceiling, the total_chips/20 chip clamp, the small blind's
 * bb/2 repair and the returned key set are all left exactly as they are.
 * Authored, in-structure levels return from the persisted branch long before
 * any of this and are untouched by construction.
 */
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- The pre-image this repair was written against, pinned exactly: definition,
-- owner, ACL, search_path and security mode. Anything else and we stop.
DO $pin$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = to_regprocedure('public.fn_resolve_tournament_blinds(text,integer,text,text,numeric)')
       AND md5(pg_get_functiondef(oid)) = '8545c67dc20be918ada9027d88f46312'
       AND md5(prosrc) = '4f83c09a69eecc766a1f3984feeb9823'
       AND proowner = 'postgres'::regrole
       AND proconfig = ARRAY['search_path=public, pg_temp']
       AND proacl::text = '{postgres=X/postgres}'
       AND prosecdef
       AND provolatile = 'v'
  ) THEN
    RAISE EXCEPTION 'BLIND_OVERFLOW_ANTE_PREIMAGE_CHANGED'
      USING ERRCODE = '55000';
  END IF;
END $pin$;

DO $mig$
DECLARE
  v_src text;
  v_new text;
  -- Three new locals, appended to the existing declaration block.
  v_decl_anchor text := $a$  v_capped boolean := false;$a$;
  v_decl_patch  text := $a$  v_capped boolean := false;
  v_anchor_bb numeric;
  v_anchor_ante numeric;
  v_ante_ceiling numeric;$a$;
  -- The overflow branch's exit, as the 2026-09-09 repair left it.
  v_exit_anchor text := $a$  IF v_ante IS NULL OR v_ante < 0 THEN
    v_ante := 0;
  END IF;

  RETURN jsonb_build_object(
    'small_blind',v_sb,'big_blind',v_bb,'ante',v_ante,
    'level_index',v_index,'source','mtt_overflow',
    'overflow_ratio',v_ratio,'blind_capped',v_capped
  );$a$;
  v_exit_patch text := $a$  IF v_ante IS NULL OR v_ante < 0 THEN
    v_ante := 0;
  END IF;

  /* THE ANTE KEEPS ITS AUTHORED SHARE OF THE BIG BLIND (2026-09-20). The
     2026-09-09 repair above restored SB < BB after the two ceilings, but the
     ante left here still carrying whatever the 10,000,000 ceiling had
     saturated it to - on a deep overflow, the big blind itself. Two RUNNING
     events were dealing ante = BB on 2026-09-20.

     The ante's authored relationship to the big blind lives on the same
     anchor row this branch already grew SB and BB from, so read it there and
     hold the ante to it. This is a CEILING and never a floor: it can only
     lower an ante, so no level becomes more expensive than it is today. A
     structure that authors ante = BB (a big blind ante; AnteMath.ts counts
     two of them) has a proportion of 1 and is unchanged. A structure with no
     ante never reaches here with one. */
  v_anchor_bb := COALESCE(
    CASE WHEN COALESCE(v_last->>'bigBlind','') ~ '^[0-9]+([.][0-9]+)?$'
         THEN (v_last->>'bigBlind')::numeric END,
    CASE WHEN COALESCE(v_last->>'big_blind','') ~ '^[0-9]+([.][0-9]+)?$'
         THEN (v_last->>'big_blind')::numeric END,
    0
  );
  v_anchor_ante := COALESCE(
    CASE WHEN COALESCE(v_last->>'ante','') ~ '^[0-9]+([.][0-9]+)?$'
         THEN (v_last->>'ante')::numeric END,
    0
  );
  IF v_ante > 0 THEN
    IF v_anchor_bb > 0 AND v_anchor_ante >= v_anchor_bb THEN
      -- A big blind ante authors ante = bigBlind. AnteMath.ts reads
      -- `ante >= bigBlind` as "this structure authored a TOTAL"; rounding the
      -- ante a fraction of a chip below a fractional big blind would flip that
      -- test and charge the table ante x seats instead. Hold it at the big
      -- blind exactly.
      v_ante_ceiling := v_bb;
    ELSIF v_anchor_bb > 0 AND v_anchor_ante > 0 THEN
      -- Multiply before dividing: the proportion itself is never materialised,
      -- so an anchor like 200000/1500000 stays exact instead of losing its
      -- last digit to a rounded quotient.
      v_ante_ceiling := v_bb * v_anchor_ante / v_anchor_bb;
    ELSE
      v_ante_ceiling := v_bb;
    END IF;
    -- Compared unrounded, assigned rounded: a level already sitting at its
    -- authored proportion is left alone rather than shaved by the floor.
    IF v_ante > v_ante_ceiling THEN
      v_ante := GREATEST(1, floor(v_ante_ceiling));
      v_capped := true;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'small_blind',v_sb,'big_blind',v_bb,'ante',v_ante,
    'level_index',v_index,'source','mtt_overflow',
    'overflow_ratio',v_ratio,'blind_capped',v_capped
  );$a$;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_src
    FROM pg_proc
   WHERE oid = to_regprocedure('public.fn_resolve_tournament_blinds(text,integer,text,text,numeric)');

  -- Both anchors must appear exactly once, or the shape this was written
  -- against has moved and a blind replace would land somewhere else.
  IF (length(v_src) - length(replace(v_src, v_decl_anchor, ''))) / length(v_decl_anchor) <> 1 THEN
    RAISE EXCEPTION 'BLIND_OVERFLOW_ANTE_DECLARE_ANCHOR_NOT_UNIQUE' USING ERRCODE = '55000';
  END IF;
  IF (length(v_src) - length(replace(v_src, v_exit_anchor, ''))) / length(v_exit_anchor) <> 1 THEN
    RAISE EXCEPTION 'BLIND_OVERFLOW_ANTE_EXIT_ANCHOR_NOT_UNIQUE' USING ERRCODE = '55000';
  END IF;
  IF position(v_exit_patch IN v_src) > 0 THEN
    RAISE EXCEPTION 'BLIND_OVERFLOW_ANTE_ALREADY_PRESENT' USING ERRCODE = '55000';
  END IF;

  v_new := replace(replace(v_src, v_decl_anchor, v_decl_patch), v_exit_anchor, v_exit_patch);
  IF v_new = v_src THEN
    RAISE EXCEPTION 'BLIND_OVERFLOW_ANTE_REPLACEMENT_MADE_NO_CHANGE' USING ERRCODE = '55000';
  END IF;

  EXECUTE v_new;
END $mig$;

-- CREATE OR REPLACE keeps owner, ACL, search_path, volatility and security
-- mode; assert that rather than trusting it, and prove the repaired
-- behaviour on the two live structures before this transaction commits.
DO $post$
DECLARE
  -- 5558f378 tail: the anchor row of tables.id 2c621856..., ante 0.125 x bb.
  v_deep text := '[{"ante":300000,"level":39,"bigBlind":3000000,"smallBlind":1500000},'
              || '{"ante":500000,"level":40,"bigBlind":4000000,"smallBlind":2000000}]';
  -- 70cd09f8 tail: the anchor row of tables.id 9f30d335..., ante 0.125 x bb.
  v_mid  text := '[{"ante":8000,"level":29,"bigBlind":60000,"smallBlind":30000},'
              || '{"ante":10000,"level":30,"bigBlind":80000,"smallBlind":40000}]';
  -- 4f8ff2b0 / 978824ab tail: a genuine big blind ante, proportion 1.
  v_bba  text := '[{"ante":100000,"level":31,"bigBlind":100000,"smallBlind":50000},'
              || '{"ante":120000,"level":32,"bigBlind":120000,"smallBlind":60000}]';
  -- A structure with no ante at all must still come back with none.
  v_none text := '[{"ante":0,"level":11,"bigBlind":300,"smallBlind":150},'
              || '{"ante":0,"level":12,"bigBlind":400,"smallBlind":200}]';
  r jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = to_regprocedure('public.fn_resolve_tournament_blinds(text,integer,text,text,numeric)')
       AND proowner = 'postgres'::regrole
       AND proconfig = ARRAY['search_path=public, pg_temp']
       AND proacl::text = '{postgres=X/postgres}'
       AND prosecdef
       AND provolatile = 'v'
  ) THEN
    RAISE EXCEPTION 'BLIND_OVERFLOW_ANTE_POSTIMAGE_ATTRIBUTES_MOVED' USING ERRCODE = '55000';
  END IF;

  -- An authored, in-structure level is the persisted branch and never the
  -- overflow branch. It must be returned exactly as written.
  r := public.fn_resolve_tournament_blinds(v_deep, 1, 'freezeout', 'MTT', 1755000);
  IF r->>'source' <> 'persisted' OR (r->>'small_blind')::numeric <> 2000000
     OR (r->>'big_blind')::numeric <> 4000000 OR (r->>'ante')::numeric <> 500000
     OR (r->>'blind_capped')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'BLIND_OVERFLOW_ANTE_CHANGED_AN_AUTHORED_LEVEL: %', r USING ERRCODE = '55000';
  END IF;

  -- tables.id 2c621856-e728-4e8b-bf08-4c56746a8649, live on 2026-09-20.
  -- 1,755,000 durable chips, level 162. Was sb 43875 bb 87750 ante 87750.
  r := public.fn_resolve_tournament_blinds(v_deep, 162, 'freezeout', 'MTT', 1755000);
  IF (r->>'small_blind')::numeric <> 43875 OR (r->>'big_blind')::numeric <> 87750
     OR (r->>'ante')::numeric <> 10968 THEN
    RAISE EXCEPTION 'BLIND_OVERFLOW_ANTE_DEEP_CASE_WRONG: %', r USING ERRCODE = '55000';
  END IF;

  -- tables.id 9f30d335-8262-4872-8926-3ddf1fefe75c, live on 2026-09-20.
  -- 975,000 durable chips, level 126. Was sb 24375 bb 48750 ante 48750.
  r := public.fn_resolve_tournament_blinds(v_mid, 126, 'freezeout', 'MTT', 975000);
  IF (r->>'small_blind')::numeric <> 24375 OR (r->>'big_blind')::numeric <> 48750
     OR (r->>'ante')::numeric <> 6093 THEN
    RAISE EXCEPTION 'BLIND_OVERFLOW_ANTE_MID_CASE_WRONG: %', r USING ERRCODE = '55000';
  END IF;

  -- The small blind stays exactly half the big blind, and the big blind
  -- stays on the documented total_chips/20 ceiling.
  IF (r->>'small_blind')::numeric <> floor((r->>'big_blind')::numeric / 2)
     OR (r->>'big_blind')::numeric <> floor(975000::numeric / 20) THEN
    RAISE EXCEPTION 'BLIND_OVERFLOW_ANTE_DISTURBED_THE_BLINDS: %', r USING ERRCODE = '55000';
  END IF;

  -- A structure that authors a big blind ante keeps ante = big blind.
  r := public.fn_resolve_tournament_blinds(v_bba, 200, 'freezeout', 'MTT', 975000);
  IF (r->>'ante')::numeric <> (r->>'big_blind')::numeric THEN
    RAISE EXCEPTION 'BLIND_OVERFLOW_ANTE_BROKE_A_BIG_BLIND_ANTE: %', r USING ERRCODE = '55000';
  END IF;

  -- A structure with no ante still resolves to no ante.
  r := public.fn_resolve_tournament_blinds(v_none, 200, 'freezeout', 'MTT', 975000);
  IF (r->>'ante')::numeric <> 0 THEN
    RAISE EXCEPTION 'BLIND_OVERFLOW_ANTE_INVENTED_AN_ANTE: %', r USING ERRCODE = '55000';
  END IF;
END $post$;

COMMIT;
