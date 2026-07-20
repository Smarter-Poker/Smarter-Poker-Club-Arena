-- ═══════════════════════════════════════════════════════════════════════════
-- Seven-Deuce (7-2) bounty game — per-table config + audit log
-- 2026-07-20
--
-- The 7-2 game: a player who WINS a pot holding any 7 and any 2 collects a
-- fixed bounty from every OTHER player dealt into that hand. Rules (Dan):
--   * The hand MUST have seen a flop to qualify (pre-flop fold wins pay nothing)
--   * Any 7 + any 2 qualifies
--   * Default bounty is 2 big blinds per paying player (configurable per table)
-- The bounty is a player-to-player table-stack transfer (zero-sum, chip
-- conserving), settled on cashout like every other table stack. NLH only —
-- the game is meaningless in PLO and short-deck has no deuces.
-- ═══════════════════════════════════════════════════════════════════════════

-- Bounty amount, expressed as a multiple of the table big blind.
-- (seven_deuce_enabled BOOLEAN already exists from migration 010.)
ALTER TABLE public.tables
  ADD COLUMN IF NOT EXISTS seven_deuce_amount numeric NOT NULL DEFAULT 2;

COMMENT ON COLUMN public.tables.seven_deuce_amount IS
  '7-2 game: big-blind multiple each other dealt-in player pays a post-flop 7-2 winner. Default 2 BB.';

-- Durable audit trail — one row per qualifying 7-2 win.
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

-- Members of the club can read their club's 7-2 bounty history. The engine
-- writes via the service role, which bypasses RLS.
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
