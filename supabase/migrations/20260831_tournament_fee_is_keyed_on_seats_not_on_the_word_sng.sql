-- ═══════════════════════════════════════════════════════════════════════════
--  THE TOURNAMENT FEE IS KEYED ON SEATS, NOT ON THE WORD "SNG"
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `src/utils/buyIn.ts` states the rule and explains why it is the rule:
--
--     "The rule is keyed on SEATS, not on the word 'SNG'. A two-handed game is
--      a duel whatever its label says, and a label is exactly the thing that
--      varies between six writers."
--
-- Five writers follow it, through `rakeRateFor`. `fn_create_tournament` does
-- not: its fee line reads
--
--     CASE WHEN COALESCE(p_config->>'type','mtt') = 'sng' THEN 0.05 ELSE 0.1 END
--
-- so it prices on the LABEL. The two disagree in both directions:
--
--   * a 6-max or 9-max Sit & Go is QUOTED 10% by CreateTournamentModal (which
--     asks rakeRateFor, which asks the seat count) and CHARGED 5% by this
--     function. The owner is shown one price and the row stores another.
--   * a two-handed game created under any label other than 'sng' — the duel
--     that `rakeRateFor` exists to catch — is charged the full 10% here.
--
-- Live evidence that the label rule is the outlier and not the seat rule:
-- every 6-max and 9-max Sit & Go in production carries a ~10% fee, because
-- they were all written by the OTHER writers. Nothing in production is priced
-- the way this function prices.
--
-- ── WHAT CHANGES, EXACTLY ──────────────────────────────────────────────────
--   heads-up (max_players 1-2)  5%   unchanged for every existing heads-up SNG
--   everything else            10%   was 5% for 6/9-max SNGs created HERE
--   spin                        0%   untouched (its own branch, further down)
--
-- No price a player currently pays moves. No 6-max or 9-max Sit & Go has been
-- created through this function since the rake-cap constraint landed on
-- 2026-08-21, and heads-up — 12,755 of the last fortnight's 13,489 Sit & Gos —
-- is 5% before and after. What moves is that the quote and the charge agree.
--
-- ── WHY A TEXTUAL REWRITE AND NOT A FULL CREATE OR REPLACE ─────────────────
-- The function is ~300 lines and every one of them is a money path. Re-emitting
-- it by hand to change one CASE expression risks a transcription error nobody
-- would catch in review. This migration rewrites exactly one substring, REFUSES
-- to proceed unless it finds that substring exactly once, and asserts
-- afterwards that the new expression is in place and the old one is gone. If
-- the function has changed underneath this migration it aborts loudly rather
-- than replacing something it did not read.
--
-- The expression is deliberately written against `p_config->>'maxPlayers'`
-- rather than the `v_max_players` variable: `v_fee` is computed BEFORE
-- `v_max_players` is assigned, and reordering a money function is a bigger
-- change than the one being made.

DO $mig$
DECLARE
  v_src      text;
  v_old_expr text := 'CASE WHEN COALESCE(p_config->>''type'', ''mtt'') = ''sng'' THEN 0.05 ELSE 0.1 END';
  v_new_expr text := 'CASE WHEN COALESCE((p_config->>''maxPlayers'')::int, 0) BETWEEN 1 AND 2 THEN 0.05 ELSE 0.1 END';
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'fn_create_tournament'
     AND pg_get_function_identity_arguments(p.oid) = 'p_club_id uuid, p_config jsonb';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'fn_create_tournament(uuid, jsonb) not found - nothing to rewrite';
  END IF;

  -- Exactly one occurrence, or we are not looking at the function we read.
  IF (length(v_src) - length(replace(v_src, v_old_expr, ''))) / length(v_old_expr) <> 1 THEN
    RAISE EXCEPTION
      'fn_create_tournament no longer contains the label-keyed fee expression exactly once; it has changed since this migration was written. Re-read it before rewriting.';
  END IF;

  EXECUTE replace(v_src, v_old_expr, v_new_expr);
END
$mig$;

-- ── POST-APPLY ASSERTIONS ──────────────────────────────────────────────────
DO $verify$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'fn_create_tournament'
     AND pg_get_function_identity_arguments(p.oid) = 'p_club_id uuid, p_config jsonb';

  IF v_src NOT LIKE '%BETWEEN 1 AND 2 THEN 0.05 ELSE 0.1 END%' THEN
    RAISE EXCEPTION 'the seat-keyed fee expression is not present after the rewrite';
  END IF;

  IF v_src LIKE '%= ''sng'' THEN 0.05%' THEN
    RAISE EXCEPTION 'the label-keyed fee expression survived the rewrite';
  END IF;
END
$verify$;

-- ROLLBACK
-- Re-run this migration with v_old_expr and v_new_expr swapped, and the two
-- assertions inverted. It is a symmetric one-substring rewrite with the same
-- guards in both directions.
