-- ═══════════════════════════════════════════════════════════════════════════
--  HAND HISTORY RECORDS WHO WON EACH RUN (2026-09-04) - applied to production
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan, hand #6145364 (PLO6, run it 3 times): "displayed results that weren't
-- accurate, awarded a pot to me that I shouldn't have had."
--
-- The ledger was right - he scooped all three boards by the cards - but the
-- RECORD could not show it. hand_history.winners is one aggregated entry per
-- player (the whole net pot, potIndex 0, and only BOARD 1's hand name), so a
-- three-run hand where the same player took Two Pair, then a Straight, then
-- Trips was written as "Two Pair, 3.96". A split was two totals with no board
-- on either. The per-run truth existed in engine memory
-- (currentHandWinnersByBoard, what the felt's run headers read off pot_win)
-- and was thrown away at the write.
--
-- One column, NULL on every single-board hand so the millions of ordinary
-- rows look exactly as they did. Amounts are the pre-rake board shares, as
-- the engine carries them; the paid totals stay in `winners`.

BEGIN;

SET LOCAL lock_timeout = '8s';

ALTER TABLE public.hand_history ADD COLUMN IF NOT EXISTS winners_by_board jsonb;

COMMENT ON COLUMN public.hand_history.winners_by_board IS
  'Multi-board hands only (run it twice/three times, double/triple-board bomb pots): [{board, userId, amount, handName}] - who won each board, with what, for what pre-rake share. NULL on single-board hands. The paid totals are in winners.';

COMMIT;
