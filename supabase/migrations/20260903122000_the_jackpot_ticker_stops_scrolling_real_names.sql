-- ============================================================================
-- THE JACKPOT TICKER STOPS SCROLLING REAL NAMES
--
-- Dan, 2026-09-02: "THE CLUB ARENA SHOULD ALWAYS 100% OF THE TIME USE THE
-- POKER ALIAS AND NOT THE REAL NAME, THE REAL NAME IS USED IN THE WORLD HUB."
--
-- bbj_winners.winner_display_name / loser_display_name are SNAPSHOTS, written
-- once by bbj_atomic_payout_v2 and read forever by BBJTicker, which scrolls
-- across the table for every player in the club. That writer resolved the name
-- as COALESCE(display_name, username, 'Player') - display_name FIRST, and
-- display_name is an exact copy of full_name on 264 of 1,308 profiles.
--
-- Measured before this ran: 24 of 29 jackpot hits were scrolling a real name,
-- on both sides of the hit.
--
-- NOT A BUG, checked before touching it: the function assigns v_winner_name
-- from p_loser_user_id and v_loser_name from p_winner_user_id, which reads
-- like a swap. It is deliberate and consistent - in a bad beat jackpot the
-- player who LOST the hand is the one who WINS the jackpot (50% share), and
-- every insert in the function follows the same inversion (bbj_payouts,
-- bbj_pools.last_winner_id, bbj_winners). Left exactly as it is.
--
-- WHY THESE SNAPSHOTS ARE CORRECTED AND TOURNAMENT HISTORY WAS NOT
-- 20260903120500 deliberately left COMPLETED tournaments alone: a finished
-- result sheet is a settled record. This is different. The ticker is a LIVE
-- public surface that keeps re-displaying these 29 rows, and the columns being
-- changed are display snapshots, not money. Every payout figure
-- (winner_payout, loser_payout, table_share_payout, total_payout,
-- pool_amount_at_hit) is untouched.
--
-- GENERATED REWRITE, same technique and same reason as 20260903121500: this is
-- a money function, and the round-trip assertion proves the name expression
-- was the only edit.
--
-- ROLLBACK: apply the inverse replacement - it is written out verbatim in the
-- assertion below.
-- ============================================================================

BEGIN;

DO $mig$
DECLARE
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_old
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
   WHERE p.proname = 'bbj_atomic_payout_v2';

  IF v_old IS NULL THEN
    RAISE EXCEPTION 'bbj_atomic_payout_v2 not found';
  END IF;

  v_new := replace(
    v_old,
    $q$COALESCE(NULLIF(display_name,''), NULLIF(username,''), 'Player')$q$,
    'public.fn_arena_name(alias, username, display_name, first_name, last_name, full_name)'
  );

  IF v_new = v_old THEN
    RAISE EXCEPTION 'the name expression in bbj_atomic_payout_v2 has changed shape - review it by hand';
  END IF;

  -- Only the name expression moved.
  IF replace(
       v_new,
       'public.fn_arena_name(alias, username, display_name, first_name, last_name, full_name)',
       $q$COALESCE(NULLIF(display_name,''), NULLIF(username,''), 'Player')$q$
     ) IS DISTINCT FROM v_old THEN
    RAISE EXCEPTION 'rewrite of bbj_atomic_payout_v2 changed something other than the name expression';
  END IF;

  EXECUTE v_new;
END
$mig$;

-- The 29 snapshots already written. Names only; every payout column is left
-- exactly as it was.
UPDATE public.bbj_winners w
   SET winner_display_name = public.fn_player_display_name(w.winner_id)
 WHERE w.winner_id IS NOT NULL
   AND w.winner_display_name IS DISTINCT FROM public.fn_player_display_name(w.winner_id);

UPDATE public.bbj_winners w
   SET loser_display_name = public.fn_player_display_name(w.loser_id)
 WHERE w.loser_id IS NOT NULL
   AND w.loser_display_name IS DISTINCT FROM public.fn_player_display_name(w.loser_id);

DO $$
DECLARE v_left integer;
BEGIN
  SELECT count(*) INTO v_left
    FROM public.bbj_winners w
   WHERE EXISTS (SELECT 1 FROM public.profiles p
                  WHERE p.id = w.winner_id
                    AND nullif(btrim(p.full_name), '') IS NOT NULL
                    AND nullif(btrim(p.alias), '') IS NOT NULL
                    AND lower(w.winner_display_name) = lower(btrim(p.full_name)))
      OR EXISTS (SELECT 1 FROM public.profiles p
                  WHERE p.id = w.loser_id
                    AND nullif(btrim(p.full_name), '') IS NOT NULL
                    AND nullif(btrim(p.alias), '') IS NOT NULL
                    AND lower(w.loser_display_name) = lower(btrim(p.full_name)));
  IF v_left > 0 THEN
    RAISE EXCEPTION '% jackpot hits still scroll a real name', v_left;
  END IF;
END $$;

COMMIT;
