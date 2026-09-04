-- FREE BUY TOURNAMENTS - Dan 2026-09-04. Applied to production via Supabase
-- MCP as `free_buy_tournaments`. This file is the auditable copy.
--
-- NOTE: `free_buy` here is a MARKER for the 5-a-day scheduled Free Buy events.
-- It does not replace fn_is_free_buy_event / zz_freerolls_are_free_buy
-- (Dan 2026-09-02, PR #2846), which already declares that ANY 0-buy-in MTT is
-- a Free Buy. See docs/changelog/2026-09-04-free-buy-law-conflict.md.
BEGIN;
ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS free_buy boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS addon_from_start boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.tournaments.free_buy IS
  'Scheduled Free Buy event marker (the 5-a-day board).';
COMMENT ON COLUMN public.tournaments.addon_from_start IS
  'Open the add-on window when the event STARTS rather than for 60s after late reg. Dan 2026-09-04: add on at sit-down AND at the break - one window, one add-on.';
ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS tournaments_free_buy_entry_is_free;
ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_free_buy_entry_is_free
  CHECK (NOT free_buy OR (COALESCE(buy_in_amount,0)=0 AND COALESCE(buy_in_fee,0)=0));
COMMIT;
