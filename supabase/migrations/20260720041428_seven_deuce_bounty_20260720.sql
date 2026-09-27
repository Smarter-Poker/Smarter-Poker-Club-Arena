-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260720041428 "seven_deuce_bounty_20260720"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d4ddfbf301f0152236e986726e000259 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Seven-Deuce (7-2) bounty game — per-table config + audit log (2026-07-20)

ALTER TABLE public.tables
  ADD COLUMN IF NOT EXISTS seven_deuce_amount numeric NOT NULL DEFAULT 2;

COMMENT ON COLUMN public.tables.seven_deuce_amount IS
  '7-2 game: big-blind multiple each other dealt-in player pays a post-flop 7-2 winner. Default 2 BB.';

CREATE TABLE IF NOT EXISTS public.seven_deuce_bounties (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id          uuid NOT NULL,
  club_id           uuid,
  hand_number       integer,
  winner_user_id    uuid NOT NULL,
  total_collected   numeric NOT NULL DEFAULT 0,
  per_player_amount numeric NOT NULL DEFAULT 0,
  payers            jsonb   NOT NULL DEFAULT '[]'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_seven_deuce_bounties_table
  ON public.seven_deuce_bounties(table_id);
CREATE INDEX IF NOT EXISTS idx_seven_deuce_bounties_club
  ON public.seven_deuce_bounties(club_id);
CREATE INDEX IF NOT EXISTS idx_seven_deuce_bounties_winner
  ON public.seven_deuce_bounties(winner_user_id);

ALTER TABLE public.seven_deuce_bounties ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS seven_deuce_bounties_select ON public.seven_deuce_bounties;
CREATE POLICY seven_deuce_bounties_select ON public.seven_deuce_bounties
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.club_members cm
      WHERE cm.club_id = seven_deuce_bounties.club_id
        AND cm.user_id = auth.uid()
    )
  );

COMMENT ON TABLE public.seven_deuce_bounties IS
  '7-2 game bounty collections — player-to-player table-stack transfers when a player wins a post-flop pot holding any 7 and any 2. Added 2026-07-20.';
