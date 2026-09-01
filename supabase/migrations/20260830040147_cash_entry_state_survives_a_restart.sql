-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830040147; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

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
