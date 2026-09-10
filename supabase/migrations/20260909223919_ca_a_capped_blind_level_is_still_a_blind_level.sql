/*
 * ═══════════════════════════════════════════════════════════════════════════
 *  A CAPPED BLIND LEVEL IS STILL A BLIND LEVEL
 *  2026-09-09
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THIS IS WHY TWO EVENTS COULD NOT BE REPAIRED. `$100 Freeroll 12:00 PM` was
 * 29.6 hours into level 258 and `Turbo Tuesday PKO` 19.6 hours into level 183,
 * both far past the end of their ladders, in fn_resolve_tournament_blinds's
 * mtt_overflow branch. That branch clamps each of smallBlind, bigBlind and
 * ante to 10,000,000 INDEPENDENTLY:
 *
 *   v_sb := LEAST(<last sb> * v_factor, 10000000);
 *   v_bb := LEAST(<last bb> * v_factor, 10000000);
 *   v_ante := LEAST(<last ante> * v_factor, 10000000);
 *
 * v_factor is ratio ^ up to 40, so at ratio 1.6 it reaches ~1.3e8 and all
 * three hit the same ceiling. The chip cap then scales all three by one
 * factor, which preserves the equality it inherited. Both events came out
 * with small_blind = big_blind = ante (125,250 and 116,600).
 *
 * SB equal to BB is not a blind level. Two consequences, both live:
 *
 *   1. fn_ensure_late_registration_capacity refuses `v_sb>=v_bb` with
 *      "Tournament current blind level is invalid", so a RUNNING event past
 *      its ladder can NEVER be given another table. The balancer went on
 *      consolidating anyway: the freeroll finished with 62 active entrants,
 *      ONE open nine-seat table and 42 closed ones, and 32 players holding
 *      1,658,520 chips with nowhere to sit. The stranded-seat repair could
 *      not place them because there was no felt, and no felt could be built.
 *   2. The engine deals from this same function, so those tables were being
 *      dealt with a small blind equal to the big blind.
 *
 * The fix is the invariant, enforced after every clamp rather than trusted to
 * survive them: a big blind of at least 2, a small blind strictly below it,
 * and a non-negative ante. Applied at the overflow branch's exit, which is
 * the only place the clamps run.
 *
 * The 40-step factor cap and the 10,000,000 ceiling are left alone: they are
 * there to stop the numbers running away, and they do that correctly. What
 * they were missing is that a ceiling shared by three related numbers
 * destroys the relationship between them.
 */

DO $mig$
DECLARE
  v_src text;
  v_new text;
  v_anchor text := $a$  RETURN jsonb_build_object(
    'small_blind',v_sb,'big_blind',v_bb,'ante',v_ante,
    'level_index',v_index,'source','mtt_overflow',
    'overflow_ratio',v_ratio,'blind_capped',v_capped
  );$a$;
  v_patch text := $a$  /* A CAPPED LEVEL IS STILL A BLIND LEVEL (2026-09-09). Both ceilings above
     are applied to smallBlind, bigBlind and ante independently, so a deep
     overflow clamps all three to the same number and the level leaves here
     with SB = BB = ante. That is not a blind level: it makes
     fn_ensure_late_registration_capacity refuse the event a table for ever
     (v_sb>=v_bb), and the engine deals from this same answer. Enforce the
     invariant after the clamps instead of trusting it to survive them. */
  IF v_bb IS NULL OR v_bb < 2 THEN
    v_bb := 2;
    v_capped := true;
  END IF;
  IF v_sb IS NULL OR v_sb >= v_bb THEN
    v_sb := GREATEST(1, floor(v_bb / 2));
    v_capped := true;
  END IF;
  IF v_ante IS NULL OR v_ante < 0 THEN
    v_ante := 0;
  END IF;

  RETURN jsonb_build_object(
    'small_blind',v_sb,'big_blind',v_bb,'ante',v_ante,
    'level_index',v_index,'source','mtt_overflow',
    'overflow_ratio',v_ratio,'blind_capped',v_capped
  );$a$;
BEGIN
  SELECT pg_get_functiondef(oid) INTO v_src
    FROM pg_proc
   WHERE proname = 'fn_resolve_tournament_blinds' AND pronamespace = 'public'::regnamespace;
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_resolve_tournament_blinds not found';
  END IF;

  IF position(v_anchor IN v_src) = 0 THEN
    RAISE EXCEPTION 'the mtt_overflow return anchor has moved - refusing to patch blind';
  END IF;
  IF position(v_patch IN v_src) > 0 THEN
    RAISE EXCEPTION 'the blind-level invariant is already present';
  END IF;

  v_new := replace(v_src, v_anchor, v_patch);
  IF v_new = v_src THEN
    RAISE EXCEPTION 'replacement produced no change';
  END IF;

  EXECUTE v_new;
END
$mig$;

REVOKE ALL ON FUNCTION public.fn_resolve_tournament_blinds(text, integer, text, text, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_resolve_tournament_blinds(text, integer, text, text, numeric) FROM anon;
