-- ═══════════════════════════════════════════════════════════════════════════
--  A SATELLITE SEAT CLOSES WHEN EVERY OTHER DOOR CLOSES
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `fn_award_satellite_seat` is the only writer on this platform that decides
-- "is late registration still open?" differently from everybody else, and it
-- decides it one whole level too late while inserting money into a prize pool
-- that may already have been sized.
--
-- ── DEFECT 1: THE OFF-BY-ONE ───────────────────────────────────────────────
--
--     v_cap := COALESCE(NULLIF(v_t.late_reg_levels,0), NULLIF(v_t.rebuy_levels,0), 0);
--     IF v_cap <= 0 OR COALESCE(v_t.current_level, 0) > v_cap THEN  -- closed
--
-- `tournaments.current_level` is a ZERO-BASED INDEX into `blind_structure`.
-- TournamentManagerBase indexes the array with it directly, and
-- `TournamentInfoPanel.tsx` states the rule in as many words: "indices 0..N-1
-- are the N advertised levels". So a cap of N is open at indices 0..N-1 and
-- closed at index N. Every other consumer closes on `>=`:
--
--   fn_register_for_tournament        current_level >= late_reg_levels
--   process_tournament_rebuy (both)   v_level >= v_cap
--   TournamentManagerBase.isLateRegClosed   currentLevel >= cap
--   TournamentManagerBase:4268 / :4374      currentLevel >= cap
--   TournamentInfoPanel.tsx:216             current_level >= lateRegCap
--   TournamentDetails.tsx                   currentLevel >= lateRegLevels
--
-- This one uses `>`, so a 12-level late-reg event that has refused every
-- direct buy-in since index 12 still sells a satellite seat at index 12.
--
-- ── DEFECT 2: THE FINALIZED POOL IS NEVER READ ─────────────────────────────
--
-- `fn_register_for_tournament` will not seat anybody once
-- `prize_pool_finalized` is true, and `isLateRegClosed()` returns true the
-- moment the flag is set regardless of level. That flag is the single
-- platform-wide statement of "the pool has stopped moving": it is what the
-- payout ladder is sized against. This function never selects the column,
-- let alone reads it.
--
-- What it does when it fires late is not cosmetic. It INSERTs a
-- tournament_players row, adds `buy_in_amount` to a FINALIZED `prize_pool`,
-- adds `buy_in_fee` to `total_rake`, writes a `rake_records` row, and books a
-- `tournament_payouts` row — money arriving after the payouts were sized, in
-- an event whose ladder no longer expects it.
--
-- ── HOW BIG IS IT RIGHT NOW ────────────────────────────────────────────────
--
-- Measured against production 2026-08-31 (SELECT-only):
--
--   * 66 tournaments are RUNNING. For 53 of them the guard in this function
--     says OPEN and the platform's own rule says CLOSED — all 53 because the
--     prize pool is already finalized. (0 are open on the off-by-one alone at
--     this instant; that one is a single-level window per event, so it is
--     narrow in a snapshot and permanent in aggregate.)
--   * 12 live satellites carry a `satellite_target_id`, so the path is armed.
--
-- No money has moved wrongly yet. All 23 seat awards this function has ever
-- made went to one target, and every one of them landed BEFORE that target's
-- `started_at` — i.e. while it was still ANNOUNCED/REGISTERING, where both the
-- old guard and the new one agree. The exposure is entirely forward-looking,
-- and it only became reachable at all on 2026-08-30 when
-- `20260830203500` first let a RUNNING target through.
--
-- ── WHAT CHANGES ───────────────────────────────────────────────────────────
--
--   1. `> v_cap` becomes `>= v_cap`.
--   2. `prize_pool_finalized` joins the SELECT ... INTO, and a finalized pool
--      refuses the seat with reason `target_pool_finalized`.
--
-- The return SHAPE is unchanged. `TournamentManager.processSatelliteAwards`
-- is the only caller; it tests `ok === false` and then regex-matches the
-- reason against /duplicate|unique|already_registered/i. Both refusals miss
-- that regex, so both land in the existing "registration failed for a real
-- reason" branch and the winner is paid the ticket value in cash under the
-- stable place key. A distinct reason string only makes the log honest about
-- WHICH door was shut.
--
-- `server/src/tournament/satelliteTargetOpen.ts` — the gate the engine
-- consults before it ever calls this function — is corrected identically in
-- the same commit, because the whole point of that file is that the two agree.
--
-- ── WHY A TEXTUAL REWRITE AND NOT A FULL CREATE OR REPLACE ─────────────────
--
-- The same reason as `20260831_tournament_fee_is_keyed_on_seats_not_on_the_word_sng.sql`:
-- this is a ~150-line money path that has taken four separate fixes in the
-- last two days, and the files on disk no longer carry everything that is
-- live. So this migration READS the live definition, rewrites exactly three
-- substrings, refuses to proceed unless it finds each one exactly once, and
-- asserts afterwards that the new text is in and the old text is gone. If the
-- function has moved underneath it, it aborts loudly rather than replacing
-- something it did not read. `pg_get_functiondef` reproduces the parameter
-- DEFAULTs verbatim, so the CREATE OR REPLACE cannot trip 42P13.

DO $mig$
DECLARE
  v_src text;

  -- 1. carry prize_pool_finalized out of the locked row
  v_old_sel text := $old1$         late_reg_levels, rebuy_levels
    INTO v_t$old1$;
  v_new_sel text := $new1$         late_reg_levels, rebuy_levels, prize_pool_finalized
    INTO v_t$new1$;

  -- 2. the off-by-one
  v_old_cmp text := $old2$IF v_cap <= 0 OR COALESCE(v_t.current_level, 0) > v_cap THEN$old2$;
  v_new_cmp text := $new2$IF v_cap <= 0 OR COALESCE(v_t.current_level, 0) >= v_cap THEN$new2$;

  -- 3. the finalized pool, checked for every status, immediately before the
  --    room check and after the status gate
  v_old_room text := $old3$  IF v_t.max_players IS NOT NULL$old3$;
  v_new_room text := $new3$  -- A FINALIZED POOL IS A CLOSED DOOR (2026-08-31). fn_register_for_tournament
  -- refuses on this flag and isLateRegClosed() returns true on it regardless of
  -- level; it is the platform's single statement that the pool has stopped
  -- moving, and the payout ladder is sized against it. Adding a buy-in after it
  -- is set pays a ladder that was built without that buy-in.
  IF COALESCE(v_t.prize_pool_finalized, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'target_pool_finalized');
  END IF;

  IF v_t.max_players IS NOT NULL$new3$;

BEGIN
  SELECT pg_get_functiondef(p.oid)
    INTO v_src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'fn_award_satellite_seat'
     AND pg_get_function_identity_arguments(p.oid)
         = 'p_satellite_id uuid, p_target_id uuid, p_user_id uuid, p_username text, p_position integer';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'the five-argument fn_award_satellite_seat was not found - nothing to rewrite';
  END IF;

  IF (length(v_src) - length(replace(v_src, v_old_sel, ''))) / length(v_old_sel) <> 1
     OR (length(v_src) - length(replace(v_src, v_old_cmp, ''))) / length(v_old_cmp) <> 1
     OR (length(v_src) - length(replace(v_src, v_old_room, ''))) / length(v_old_room) <> 1 THEN
    RAISE EXCEPTION
      'fn_award_satellite_seat does not contain all three anchors exactly once; it has changed since this migration was written. Re-read the live definition before rewriting it.';
  END IF;

  v_src := replace(v_src, v_old_sel, v_new_sel);
  v_src := replace(v_src, v_old_cmp, v_new_cmp);
  v_src := replace(v_src, v_old_room, v_new_room);

  EXECUTE v_src;
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
     AND p.proname = 'fn_award_satellite_seat'
     AND pg_get_function_identity_arguments(p.oid)
         = 'p_satellite_id uuid, p_target_id uuid, p_user_id uuid, p_username text, p_position integer';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'the five-argument fn_award_satellite_seat vanished during the rewrite';
  END IF;

  IF v_src NOT LIKE '%COALESCE(v_t.current_level, 0) >= v_cap%' THEN
    RAISE EXCEPTION 'the level guard is not >= after the rewrite';
  END IF;

  IF v_src LIKE '%COALESCE(v_t.current_level, 0) > v_cap%' THEN
    RAISE EXCEPTION 'the off-by-one level guard survived the rewrite';
  END IF;

  IF v_src NOT LIKE '%prize_pool_finalized%'
     OR v_src NOT LIKE '%target_pool_finalized%' THEN
    RAISE EXCEPTION 'the finalized-pool guard is not present after the rewrite';
  END IF;

  -- The parts that must NOT have moved: the money, the dedupe evidence, and
  -- the payout record.
  IF v_src NOT LIKE '%held_from_this_satellite%'
     OR v_src NOT LIKE '%source_satellite_id%'
     OR v_src NOT LIKE '%satellite_seat%' THEN
    RAISE EXCEPTION 'the rewrite lost part of the function it was only meant to re-gate';
  END IF;
END
$verify$;

-- Ownership is unchanged by CREATE OR REPLACE, but restate the grant so a
-- reader of this file does not have to go looking: service_role only.
REVOKE ALL ON FUNCTION public.fn_award_satellite_seat(uuid, uuid, uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_award_satellite_seat(uuid, uuid, uuid, text, integer) TO service_role;

-- ROLLBACK
-- Re-run this migration with the three old/new pairs swapped and the
-- assertions inverted. It is a symmetric substring rewrite with the same
-- exactly-once guards in both directions. Rolling back re-opens a seat sale
-- into a finalized prize pool, so do it only to escape a worse failure.
