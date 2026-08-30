-- ─────────────────────────────────────────────────────────────────────────────
-- CASH ENTRY STATE MUST SURVIVE AN ENGINE RESTART (Dan 2026-08-29/30)
--
-- `waitingForBB`, `postBBWhenClear`, `postingBBToEnter` and `pendingPostToEnter`
-- are Set<string> fields on the engine process. Nothing persists them. Every
-- push touching `server/**` auto-deploys Hetzner (auto-deploy-hetzner.yml), and
-- the engine also recycles on lease changes, killForRestart and the watchdog.
--
-- WHAT THAT COSTS TODAY, and it is worse than "the prompt comes back":
--
--   1. The dealing loop's first-iteration block adds EVERY seated player to
--      `knownPlayerIds` AND to `dealtInUserIds` — deliberately, so that
--      "a new player never gets the button" survives a deploy for the people
--      who were genuinely playing before it. But a player who was being HELD
--      is swept up by the same line. After a restart they are:
--        - no longer in waitingForBB, so they are dealt in on the next hand,
--        - having paid nothing, which is the free hand Dan reversed on
--          2026-08-26 ("no free hands or coming in behind the blinds"),
--        - and a button-eligible veteran, so they can take the button on
--          what is really their first hand.
--      Three separate house rules, all switched off by a deploy.
--
--   2. A standing agreement to post (postBBWhenClear, added 2026-08-29) is
--      lost, so the player is asked again — which is the exact report that
--      set was written to fix, arriving through a different door.
--
-- THE SHAPE OF THE FIX. `table_seats` already carries the rest of a seat's
-- session state across restarts for exactly these reasons — `is_sitting_out`
-- (2026-08-25) and `sit_out_at` (2026-08-28) were both added after the same
-- class of bug, where the engine wrote a fact and never read it back. Entry
-- state belongs beside them: it is per-seat, it dies with the seat, and
-- `loadSeatedPlayers` is already the boot-time read.
--
--   entry_hold          NULL     in the rotation, owes nothing
--                       'waiting' held out until the big blind reaches them
--                       'posting' post accepted, billed a live BB on the next deal
--   entry_post_agreed   the player has ALREADY tapped Post Big Blind and is
--                       held only by the seat they are in (the one the small
--                       blind or the button is about to reach). Replayed by the
--                       dealing loop until the seat clears. Never a licence to
--                       post from either seat.
--
-- Deliberately two columns rather than a third `entry_hold` value: the
-- agreement is orthogonal to the hold. A player can be 'waiting' with or
-- without having answered, and collapsing them would lose that.
--
-- ROLLBACK:
--   ALTER TABLE public.table_seats
--     DROP COLUMN IF EXISTS entry_hold,
--     DROP COLUMN IF EXISTS entry_post_agreed;
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.table_seats
  ADD COLUMN IF NOT EXISTS entry_hold text,
  ADD COLUMN IF NOT EXISTS entry_post_agreed boolean NOT NULL DEFAULT false;

ALTER TABLE public.table_seats
  DROP CONSTRAINT IF EXISTS table_seats_entry_hold_check;

ALTER TABLE public.table_seats
  ADD CONSTRAINT table_seats_entry_hold_check
  CHECK (entry_hold IS NULL OR entry_hold IN ('waiting', 'posting'));

COMMENT ON COLUMN public.table_seats.entry_hold IS
  'Cash entry hold, so it survives an engine restart. NULL = in the rotation. ''waiting'' = held until the big blind reaches this seat. ''posting'' = post accepted, owes one live big blind on the next deal. Read back by loadSeatedPlayers and restored by restoreEntryHoldsFromSeats(). Added 2026-08-30.';

COMMENT ON COLUMN public.table_seats.entry_post_agreed IS
  'The player has already tapped Post Big Blind and is held only by their seat (the one the small blind or the button is about to reach). The dealing loop replays the agreement until the seat clears. NOT a licence to post from either seat: both hold-outs are re-checked on every replay. Added 2026-08-30.';

-- Post-apply assertions. A migration that silently did nothing is the failure
-- mode this repo has been bitten by most (a column the code believes in and
-- the database has never heard of fails 42703 into a catch block).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'table_seats'
       AND column_name = 'entry_hold'
  ) THEN
    RAISE EXCEPTION 'post-apply failed: table_seats.entry_hold is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'table_seats'
       AND column_name = 'entry_post_agreed'
  ) THEN
    RAISE EXCEPTION 'post-apply failed: table_seats.entry_post_agreed is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.table_seats'::regclass
       AND conname = 'table_seats_entry_hold_check'
  ) THEN
    RAISE EXCEPTION 'post-apply failed: the entry_hold value check did not take';
  END IF;
END $$;
