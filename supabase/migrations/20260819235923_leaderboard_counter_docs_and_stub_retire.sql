-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819235923 "leaderboard_counter_docs_and_stub_retire"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3e9d138077c9ce49fea06c777b7ee45b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Documentation + stub retirement, so the next person does not wire the wrong
-- counter or trust a function that records nothing.

COMMENT ON COLUMN player_stats.hands_dealt IS
  'Seat-hands: incremented once per seated player per cash hand by the '
  'hand_history_fold_stats trigger. This is the TRUE hand count and the one the '
  'leaderboard uses. Verified 2026-08-19 at 100.0% of hand_history seat-hands.';

COMMENT ON COLUMN player_stats.hands_played IS
  'LEGACY / rakeback-owned. Maintained by RakebackSettlerService, which only '
  'walks RAKED hands and books per settled row, not per seat - measured at 13.4% '
  'of true seat-hands on 2026-08-18 (144,956 booked vs 1,083,942 dealt). Do NOT '
  'use for a hands leaderboard; use hands_dealt. Kept because rakeback accounting '
  'depends on it.';

COMMENT ON COLUMN player_stats.sum_big_blind IS
  'Sum of big_blind over every cash hand the player was dealt into. Denominator '
  'for bb/100 = 100 * (total_winnings - total_losses) / sum_big_blind.';

COMMENT ON COLUMN player_stats.total_winnings IS
  'Sum of pot amounts won, folded in by the hand_history_fold_stats trigger.';

COMMENT ON COLUMN player_stats.total_losses IS
  'Sum of chips contributed to pots, accumulated by promo_apply_playthrough '
  'which the engine calls once per contributing player per cash hand. '
  'Profit = total_winnings - total_losses is therefore exact net.';

-- The stub: it is named as though it records hand stats, and every argument
-- except p_user_id is discarded. It has misled at least one rebuild. Keep the
-- behaviour (the profiles counter is real and used elsewhere) but make the
-- signature honest and impossible to misread.
CREATE OR REPLACE FUNCTION public.update_player_hand_stats(
  p_user_id uuid,
  p_profit numeric DEFAULT 0,
  p_is_voluntary boolean DEFAULT false,
  p_is_preflop_raise boolean DEFAULT false,
  p_went_to_showdown boolean DEFAULT false,
  p_won_at_showdown boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  -- NAME IS MISLEADING - READ BEFORE USING (documented 2026-08-19).
  -- This function increments profiles.total_hands_played and NOTHING ELSE.
  -- p_profit, p_is_voluntary, p_is_preflop_raise, p_went_to_showdown and
  -- p_won_at_showdown are accepted for call-site compatibility and DISCARDED.
  -- It has never written player_stats. Believing otherwise is why every profit
  -- and ROI leaderboard read 0.00 until 2026-08-19.
  --
  -- Real stat sources:
  --   winnings / hands_dealt / sum_big_blind -> hand_history_fold_stats trigger
  --   losses (contributions)                 -> promo_apply_playthrough
  -- Do not add stat writes here; add them to the trigger, which sees every hand.
  UPDATE profiles
  SET total_hands_played = COALESCE(total_hands_played, 0) + 1,
      updated_at = now()
  WHERE id = p_user_id;
END; $function$;

COMMENT ON FUNCTION public.update_player_hand_stats(uuid, numeric, boolean, boolean, boolean, boolean) IS
  'Increments profiles.total_hands_played ONLY. All other arguments are '
  'discarded. Does not touch player_stats - see the trigger '
  'hand_history_fold_stats and promo_apply_playthrough for the real counters.';
