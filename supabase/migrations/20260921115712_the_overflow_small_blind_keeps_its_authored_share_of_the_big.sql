-- 20260921115712_the_overflow_small_blind_keeps_its_authored_share_of_the_big.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
/*
 * ===========================================================================
 *  THE OVERFLOW SMALL BLIND KEEPS ITS AUTHORED SHARE OF THE BIG BLIND
 *  2026-09-21
 * ===========================================================================
 *
 * THE THIRD SIBLING. fn_resolve_tournament_blinds's mtt_overflow branch grows
 * the anchor level's small blind, big blind and ante by ONE shared factor and
 * then applies a hard ceiling to each of the three INDEPENDENTLY:
 *
 *   v_sb   := LEAST(<anchor sb>   * v_factor, 10000000);
 *   v_bb   := LEAST(<anchor bb>   * v_factor, 10000000);
 *   v_ante := LEAST(<anchor ante> * v_factor, 10000000);
 *
 * Two of the three relationships that ceiling breaks have already been
 * repaired. 20260909223919_ca_a_capped_blind_level_is_still_a_blind_level
 * caught the FULLY saturated case, where every one of the three has reached
 * 10,000,000 and SB = BB. 20260920190537_the_overflow_ante_keeps_its_authored
 * _share_of_the_big_blind held the ante to its authored ante:bigBlind
 * proportion. This migration is the small blind's turn.
 *
 * THE BAND THE 2026-09-09 REPAIR CANNOT SEE. That repair fires only on
 * `v_sb >= v_bb`. Between the level where the BIG blind first reaches the
 * ceiling and the level where the SMALL blind reaches it too, the big blind is
 * pinned at 10,000,000 while the small blind is still growing underneath it.
 * SB < BB the whole way, so nothing fires, and the authored 1:2 converges on
 * 1:1 one level at a time. Measured against production on 2026-09-21, calling
 * the live function with an authored anchor of sb 2,000,000 / bb 4,000,000:
 *
 *   level 4   sb 4,740,740.74   bb  9,481,481.48   ratio 0.5000   capped false
 *   level 5   sb 6,320,987.65   bb 10,000,000      ratio 0.6321   capped false
 *   level 6   sb 8,427,983.54   bb 10,000,000      ratio 0.8428   capped false
 *   level 7   sb 5,000,000      bb 10,000,000      ratio 0.5000   capped TRUE
 *
 * Levels 5 and 6 are the defect. The small blind is 26% and 69% larger than
 * the level the structure authored, the level is silently reported as
 * `blind_capped: false`, and the distortion ends only when the small blind
 * saturates too and the 2026-09-09 repair finally sees SB = BB.
 *
 * WHAT IS IN THE BAND IN PRODUCTION, 2026-09-21. Across 37,293 published
 * tournaments.blind_level_state rows, 12,371 sit past the end of their
 * authored ladder. Of those, 5,298 carry a small blind above the share the
 * structure authored for it:
 *
 *   4,770  SB = BB exactly (ratio 1.0000)      - the saturated case
 *     528  authored share < ratio < 1.0000     - THE BAND
 *            428 at ratio 0.5000-0.5051
 *             52 at ratio 0.6973
 *             48 at ratio 0.9762
 *
 * 0 of the 24,922 in-structure published levels drift at all, which is the
 * control: the persisted branch returns what was authored and only the
 * overflow branch distorts. Every one of the 21 distinct blind structures in
 * production authors sb:bb = 0.5000 exactly - there is ONE authored ratio on
 * this platform - so a small blind at 0.9762 of its big blind is not a
 * structure choice, it is this ceiling.
 *
 * THE RULE, and it is the ante's rule with `ante` reading `small blind`. In
 * the mtt_overflow branch the small blind may never exceed the anchor level's
 * authored smallBlind:bigBlind proportion applied to the level's resolved big
 * blind. It is a CEILING and never a floor: it only ever LOWERS a small blind,
 * so no level leaves here more expensive than it does today. An anchor that
 * authors sb >= bb is left to the 2026-09-09 repair above, which has already
 * put the small blind at half the big blind; this ceiling declines to raise
 * it back.
 *
 * The anchor row, the growth factor, the 40-step exponent cap, the 10,000,000
 * ceiling, the total_chips/20 chip clamp, the 2026-09-09 SB < BB repair, the
 * 2026-09-20 ante ceiling and the returned key set are all left exactly as
 * they are. Authored, in-structure levels return from the persisted branch
 * long before any of this and are untouched by construction. Spin events
 * return from their own branch earlier still.
 */
--
-- HOW A READER SEES THIS IS LIVE. This migration creates no persistent object:
-- it reads public.fn_resolve_tournament_blinds's own definition, patches two
-- unique text anchors in it and EXECUTEs the result, so nothing new appears in
-- any catalogue and scripts/ci/check-migrations-are-live.mjs has nothing to
-- look up. Both halves of the edit are therefore stated as their own proof -
-- the declaration the small blind ceiling needs, and the line that computes it.
-- @live-proof: (SELECT position('v_sb_ceiling numeric;' in p.prosrc) > 0 FROM pg_proc p WHERE p.oid = to_regprocedure('public.fn_resolve_tournament_blinds(text,integer,text,text,numeric)'))
-- @live-proof: (SELECT position('v_sb_ceiling := v_bb * v_anchor_sb / v_anchor_bb;' in p.prosrc) > 0 FROM pg_proc p WHERE p.oid = to_regprocedure('public.fn_resolve_tournament_blinds(text,integer,text,text,numeric)'))
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- The pre-image this repair was written against, pinned exactly: definition,
-- owner, ACL, search_path and security mode. Anything else and we stop.
DO $pin$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = to_regprocedure('public.fn_resolve_tournament_blinds(text,integer,text,text,numeric)')
       AND md5(pg_get_functiondef(oid)) = 'd757c59c5af645d176263c23c6b3af19'
       AND md5(prosrc) = '3e0dcf6bc533bbe203434d53a559ef91'
       AND proowner = 'postgres'::regrole
       AND proconfig = ARRAY['search_path=public, pg_temp']
       AND proacl::text = '{postgres=X/postgres}'
       AND prosecdef
       AND provolatile = 'v'
  ) THEN
    RAISE EXCEPTION 'BLIND_OVERFLOW_SMALL_BLIND_PREIMAGE_CHANGED'
      USING ERRCODE = '55000';
  END IF;
END $pin$;

DO $mig$
DECLARE
  v_src text;
  v_new text;
  -- Two new locals, appended to the declaration block the ante repair left.
  v_decl_anchor text := $a$  v_ante_ceiling numeric;$a$;
  v_decl_patch  text := $a$  v_ante_ceiling numeric;
  v_anchor_sb numeric;
  v_sb_ceiling numeric;$a$;
  -- The 2026-09-09 SB < BB repair, exactly as it stands.
  v_exit_anchor text := $a$  IF v_sb IS NULL OR v_sb >= v_bb THEN
    v_sb := GREATEST(1, floor(v_bb / 2));
    v_capped := true;
  END IF;$a$;
  v_exit_patch text := $a$  IF v_sb IS NULL OR v_sb >= v_bb THEN
    v_sb := GREATEST(1, floor(v_bb / 2));
    v_capped := true;
  END IF;

  /* THE SMALL BLIND KEEPS ITS AUTHORED SHARE OF THE BIG BLIND (2026-09-21).
     The repair immediately above fires only on SB >= BB, which is the END of
     the distortion and not the whole of it. Between the level where the big
     blind reaches the 10,000,000 ceiling and the level where the small blind
     reaches it too, the big blind is pinned and the small blind is still
     growing underneath it: SB < BB throughout, nothing fires, and an authored
     1:2 walks up through 0.63 and 0.84 towards 1:1 while reporting
     blind_capped false. 528 published levels were sitting in that band on
     2026-09-21, 48 of them at 0.9762 of their big blind.

     The small blind's authored relationship to the big blind lives on the same
     anchor row this branch already grew both of them from, so read it there
     and hold the small blind to it - the ante ceiling below does exactly this
     with ante:bigBlind. This is a CEILING and never a floor: it can only lower
     a small blind, so no level becomes more expensive than it is today. An
     anchor authoring sb >= bb is left alone, because the repair above has
     already put the small blind at half the big blind and raising it back is
     not this ceiling's job. */
  v_anchor_sb := COALESCE(
    CASE WHEN COALESCE(v_last->>'smallBlind','') ~ '^[0-9]+([.][0-9]+)?$'
         THEN (v_last->>'smallBlind')::numeric END,
    CASE WHEN COALESCE(v_last->>'small_blind','') ~ '^[0-9]+([.][0-9]+)?$'
         THEN (v_last->>'small_blind')::numeric END,
    0
  );
  v_anchor_bb := COALESCE(
    CASE WHEN COALESCE(v_last->>'bigBlind','') ~ '^[0-9]+([.][0-9]+)?$'
         THEN (v_last->>'bigBlind')::numeric END,
    CASE WHEN COALESCE(v_last->>'big_blind','') ~ '^[0-9]+([.][0-9]+)?$'
         THEN (v_last->>'big_blind')::numeric END,
    0
  );
  IF v_sb > 0 AND v_anchor_bb > 0 AND v_anchor_sb > 0
     AND v_anchor_sb < v_anchor_bb THEN
    -- Multiply before dividing: the proportion itself is never materialised,
    -- so an anchor like 1500000/4000000 stays exact instead of losing its last
    -- digit to a rounded quotient.
    v_sb_ceiling := v_bb * v_anchor_sb / v_anchor_bb;
    -- Compared unrounded, assigned rounded: a level already sitting at its
    -- authored proportion is left alone rather than shaved by the floor.
    IF v_sb > v_sb_ceiling THEN
      v_sb := GREATEST(1, floor(v_sb_ceiling));
      v_capped := true;
    END IF;
  END IF;$a$;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_src
    FROM pg_proc
   WHERE oid = to_regprocedure('public.fn_resolve_tournament_blinds(text,integer,text,text,numeric)');

  -- Both anchors must appear exactly once, or the shape this was written
  -- against has moved and a blind replace would land somewhere else.
  IF (length(v_src) - length(replace(v_src, v_decl_anchor, ''))) / length(v_decl_anchor) <> 1 THEN
    RAISE EXCEPTION 'BLIND_OVERFLOW_SMALL_BLIND_DECLARE_ANCHOR_NOT_UNIQUE' USING ERRCODE = '55000';
  END IF;
  IF (length(v_src) - length(replace(v_src, v_exit_anchor, ''))) / length(v_exit_anchor) <> 1 THEN
    RAISE EXCEPTION 'BLIND_OVERFLOW_SMALL_BLIND_EXIT_ANCHOR_NOT_UNIQUE' USING ERRCODE = '55000';
  END IF;
  IF position(v_exit_patch IN v_src) > 0 THEN
    RAISE EXCEPTION 'BLIND_OVERFLOW_SMALL_BLIND_ALREADY_PRESENT' USING ERRCODE = '55000';
  END IF;

  v_new := replace(replace(v_src, v_decl_anchor, v_decl_patch), v_exit_anchor, v_exit_patch);
  IF v_new = v_src THEN
    RAISE EXCEPTION 'BLIND_OVERFLOW_SMALL_BLIND_REPLACEMENT_MADE_NO_CHANGE' USING ERRCODE = '55000';
  END IF;

  EXECUTE v_new;
END $mig$;

-- CREATE OR REPLACE keeps owner, ACL, search_path, volatility and security
-- mode; assert that rather than trusting it, and prove the repaired behaviour
-- on the measured band before this transaction commits.
DO $post$
DECLARE
  -- The two-level anchor the band above was measured with: sb 2,000,000 /
  -- bb 4,000,000, an authored share of exactly 0.5.
  v_band text := '[{"ante":0,"level":1,"bigBlind":3000000,"smallBlind":1500000},'
              || '{"ante":0,"level":2,"bigBlind":4000000,"smallBlind":2000000}]';
  -- A structure that authors a THIRD, not a half. bb/2 would be wrong here and
  -- the authored proportion is the only thing that is right.
  v_third text := '[{"ante":0,"level":1,"bigBlind":3000000,"smallBlind":1000000},'
               || '{"ante":0,"level":2,"bigBlind":4000000,"smallBlind":1333333}]';
  -- 70cd09f8 tail: the anchor of the live event the ante repair was written
  -- for. Proves the ante ceiling and the chip clamp are both undisturbed.
  v_mid  text := '[{"ante":8000,"level":29,"bigBlind":60000,"smallBlind":30000},'
              || '{"ante":10000,"level":30,"bigBlind":80000,"smallBlind":40000}]';
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
    RAISE EXCEPTION 'BLIND_OVERFLOW_SMALL_BLIND_POSTIMAGE_ATTRIBUTES_MOVED' USING ERRCODE = '55000';
  END IF;

  -- An authored, in-structure level is the persisted branch and never the
  -- overflow branch. It must be returned exactly as written.
  r := public.fn_resolve_tournament_blinds(v_band, 1, 'freezeout', 'MTT', NULL);
  IF r->>'source' <> 'persisted' OR (r->>'small_blind')::numeric <> 2000000
     OR (r->>'big_blind')::numeric <> 4000000
     OR (r->>'blind_capped')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'BLIND_OVERFLOW_SMALL_BLIND_CHANGED_AN_AUTHORED_LEVEL: %', r USING ERRCODE = '55000';
  END IF;

  -- BELOW the ceiling nothing may move, and blind_capped must stay false.
  -- These are the three levels measured at 0.5000 before the repair.
  FOR r IN SELECT public.fn_resolve_tournament_blinds(v_band, i, 'freezeout', 'MTT', NULL)
             FROM generate_series(2,4) i
  LOOP
    IF (r->>'small_blind')::numeric * 2 <> (r->>'big_blind')::numeric
       OR (r->>'big_blind')::numeric >= 10000000
       OR (r->>'blind_capped')::boolean IS NOT FALSE THEN
      RAISE EXCEPTION 'BLIND_OVERFLOW_SMALL_BLIND_DISTURBED_AN_UNCAPPED_LEVEL: %', r USING ERRCODE = '55000';
    END IF;
  END LOOP;

  -- THE BAND. Level 5 was sb 6,320,987.65 against bb 10,000,000 (0.6321) and
  -- level 6 was sb 8,427,983.54 (0.8428), both reported uncapped.
  r := public.fn_resolve_tournament_blinds(v_band, 5, 'freezeout', 'MTT', NULL);
  IF (r->>'small_blind')::numeric <> 5000000 OR (r->>'big_blind')::numeric <> 10000000
     OR (r->>'blind_capped')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'BLIND_OVERFLOW_SMALL_BLIND_BAND_LEVEL_5_WRONG: %', r USING ERRCODE = '55000';
  END IF;
  r := public.fn_resolve_tournament_blinds(v_band, 6, 'freezeout', 'MTT', NULL);
  IF (r->>'small_blind')::numeric <> 5000000 OR (r->>'big_blind')::numeric <> 10000000
     OR (r->>'blind_capped')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'BLIND_OVERFLOW_SMALL_BLIND_BAND_LEVEL_6_WRONG: %', r USING ERRCODE = '55000';
  END IF;

  -- PAST the band, where both saturate, the 2026-09-09 repair already held
  -- the line. It must go on holding it.
  r := public.fn_resolve_tournament_blinds(v_band, 9, 'freezeout', 'MTT', NULL);
  IF (r->>'small_blind')::numeric <> 5000000 OR (r->>'big_blind')::numeric <> 10000000 THEN
    RAISE EXCEPTION 'BLIND_OVERFLOW_SMALL_BLIND_SATURATED_CASE_WRONG: %', r USING ERRCODE = '55000';
  END IF;

  -- A structure authoring a third keeps its third, not a half. This is the
  -- case bb/2 cannot answer.
  r := public.fn_resolve_tournament_blinds(v_third, 6, 'freezeout', 'MTT', NULL);
  IF (r->>'big_blind')::numeric <> 10000000
     OR (r->>'small_blind')::numeric <> floor(10000000::numeric * 1333333 / 4000000) THEN
    RAISE EXCEPTION 'BLIND_OVERFLOW_SMALL_BLIND_IGNORED_THE_AUTHORED_SHARE: %', r USING ERRCODE = '55000';
  END IF;

  -- The live event the ante repair was written for is unchanged in every one
  -- of its three numbers: sb 24,375 bb 48,750 ante 6,093 at 975,000 chips.
  r := public.fn_resolve_tournament_blinds(v_mid, 126, 'freezeout', 'MTT', 975000);
  IF (r->>'small_blind')::numeric <> 24375 OR (r->>'big_blind')::numeric <> 48750
     OR (r->>'ante')::numeric <> 6093 THEN
    RAISE EXCEPTION 'BLIND_OVERFLOW_SMALL_BLIND_DISTURBED_THE_ANTE_REPAIR: %', r USING ERRCODE = '55000';
  END IF;

  -- The chip clamp still lands the big blind on total_chips/20 and the small
  -- blind on exactly half of it.
  IF (r->>'big_blind')::numeric <> floor(975000::numeric / 20)
     OR (r->>'small_blind')::numeric <> floor((r->>'big_blind')::numeric / 2) THEN
    RAISE EXCEPTION 'BLIND_OVERFLOW_SMALL_BLIND_DISTURBED_THE_CHIP_CLAMP: %', r USING ERRCODE = '55000';
  END IF;
END $post$;

COMMIT;
