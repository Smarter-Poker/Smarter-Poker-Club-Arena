-- ═══════════════════════════════════════════════════════════════════════════
--  ONE CHEST PER ELIMINATION, NOT ONE PER PLAYER
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan's Mystery Bounty spec, section 8, verbatim:
--
--   "Number Of Mystery Bounty Draws = Players Remaining At Mystery Bounty
--    Activation - 1 ... Every remaining player except the eventual tournament
--    winner will eventually be eliminated. Do not generate an unused bounty
--    for the eventual winner."
--
-- The first build generated one chest per SURVIVOR and settled the leftover to
-- the champion as a "residual". That is a different game: 150 players got 150
-- chests, the published ladder held one more prize than the event could ever
-- award, and the champion collected a chest nobody had knocked them out of.
--
-- THE OFF-BY-ONE THIS FIXES IN SQL. `p_players_remaining` was doing two jobs
-- that have now diverged:
--
--   1. it was compared against jsonb_array_length(p_chests)  -- a CHEST count
--   2. it was stored into tournaments.mystery_bounty_activated_players
--                                                            -- a PLAYER count
--
-- With the engine now sending N-1 chests, leaving job 1 alone would have made
-- every seed fail, and leaving job 2 alone would have recorded "activated at
-- 149 players" for a 150-player field - which is the exact line the audit
-- trail prints in section 60. So the parameter now means what it is named:
-- players remaining. The chest count is derived from it.
--
-- Patched by string replacement against pg_get_functiondef rather than
-- restated in full, the same technique 20260823310000 uses, so every other
-- line of a 200-line money function stays byte-identical.

DO $migrate$
DECLARE
  v_def text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'fn_mystery_bounty_seed'
     AND pg_get_function_identity_arguments(p.oid) = 'p_tournament_id uuid, p_players_remaining integer, p_chests jsonb';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'fn_mystery_bounty_seed(uuid,integer,jsonb) not found - refusing to guess';
  END IF;

  -- The count check: chests must be one FEWER than the players standing.
  v_new := replace(
    v_def,
    'IF jsonb_array_length(p_chests) <> GREATEST(p_players_remaining, 0) THEN',
    'IF jsonb_array_length(p_chests) <> GREATEST(p_players_remaining - 1, 0) THEN'
  );

  IF v_new = v_def THEN
    RAISE EXCEPTION 'chest-count check not found in fn_mystery_bounty_seed - refusing to patch blind';
  END IF;

  EXECUTE v_new;
END
$migrate$;

-- Proof, in the same transaction as the patch: the new text is present and the
-- old text is gone. A migration that silently no-ops is worse than one that
-- fails, because the engine would then reject every seed at runtime instead.
DO $verify$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_mystery_bounty_seed';

  IF position('GREATEST(p_players_remaining - 1, 0)' IN v_def) = 0 THEN
    RAISE EXCEPTION 'patch did not take: chest count is not players-minus-one';
  END IF;
  IF position('mystery_bounty_activated_players = p_players_remaining' IN v_def) = 0 THEN
    RAISE EXCEPTION 'activated_players must still record the PLAYER count';
  END IF;
END
$verify$;
