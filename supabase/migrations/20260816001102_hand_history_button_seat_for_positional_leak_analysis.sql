-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260816001102 "hand_history_button_seat_for_positional_leak_analysis"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 7eabc94e2fb721eaafa64d6296f04919 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- hand_history.button_seat — the missing input for positional leak analysis
-- ═══════════════════════════════════════════════════════════════════════════
-- The personal assistant's leak detector can currently compute VPIP, PFR and
-- aggression, because those need only the action list. It cannot compute a
-- single POSITIONAL leak -- "you open far too wide from under the gun" is the
-- most common and most costly leak in low-stakes poker -- because nothing in
-- hand_history records where the button was. Seat numbers alone are useless:
-- seat 3 is UTG in one hand and the cutoff two hands later.
--
-- The engine has always known this (ServerTableEngineDealing sets
-- currentHandDealerSeat on every deal); it simply was never persisted.
--
-- smallint: seat numbers are 1..9.
ALTER TABLE public.hand_history
  ADD COLUMN IF NOT EXISTS button_seat smallint;

COMMENT ON COLUMN public.hand_history.button_seat IS
  'Dealer/button seat for this hand (1-9). Lets analysis derive each seat''s '
  'position (UTG/MP/CO/BTN/SB/BB) from players[].seat. Populated by the engine '
  'from currentHandDealerSeat at settlement. NULL for hands written before '
  '2026-08-16.';

COMMENT ON COLUMN public.hand_history.hole_cards IS
  'Showdown-revealed holdings only, keyed by user id: {"<uuid>": [{"rank","suit"}]}. '
  'Cards that were MUCKED are deliberately never stored -- everything in here was '
  'already shown face-up to the whole table, so a hand participant reading this '
  'column learns nothing they did not already see.';

