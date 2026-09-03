-- ═══════════════════════════════════════════════════════════════════════════════
-- Q3 SOCIAL FEATURES — SQL MIGRATION
-- Phase 10-15: All New Tables, Columns, Functions, and RLS Policies
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. MESSAGES TABLE: Add edit/pin/type columns (Phase 11)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_edited BOOLEAN DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_type TEXT DEFAULT 'message';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. CONVERSATIONS TABLE: Add announcement channel support (Phase 12)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_read_only BOOLEAN DEFAULT false;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'direct';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS club_id UUID REFERENCES clubs(id);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. PROFILES TABLE: Add status fields (Phase 10)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS current_table TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS status_text TEXT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. MESSAGE READ RECEIPTS TABLE (Phase 11)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS message_read_receipts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(message_id, user_id)
);

-- RLS
ALTER TABLE message_read_receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can insert own read receipts" ON message_read_receipts
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can view read receipts for their conversations" ON message_read_receipts
  FOR SELECT USING (true);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_read_receipts_message ON message_read_receipts(message_id);
CREATE INDEX IF NOT EXISTS idx_read_receipts_user ON message_read_receipts(user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. PLAYER KUDOS TABLE (Phase 14)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS player_kudos (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  from_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  to_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('good_opponent', 'great_player', 'fun_table', 'fair_play')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Prevent duplicate kudos of same type from same user to same user within 24h
  UNIQUE(from_user_id, to_user_id, type)
);

-- RLS
ALTER TABLE player_kudos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can send kudos" ON player_kudos
  FOR INSERT WITH CHECK (auth.uid() = from_user_id AND from_user_id != to_user_id);

CREATE POLICY "Anyone can view kudos" ON player_kudos
  FOR SELECT USING (true);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_kudos_to_user ON player_kudos(to_user_id);
CREATE INDEX IF NOT EXISTS idx_kudos_from_user ON player_kudos(from_user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. PLAYER STORIES TABLE (Phase 14)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS player_stories (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  image_url TEXT,
  view_count INTEGER DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE player_stories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can create own stories" ON player_stories
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own stories" ON player_stories
  FOR DELETE USING (auth.uid() = user_id);

CREATE POLICY "Anyone can view non-expired stories" ON player_stories
  FOR SELECT USING (expires_at > now());

-- Index
CREATE INDEX IF NOT EXISTS idx_stories_user ON player_stories(user_id);
CREATE INDEX IF NOT EXISTS idx_stories_expires ON player_stories(expires_at);

-- RPC: Increment story view count
CREATE OR REPLACE FUNCTION increment_story_view(story_id UUID)
RETURNS void AS $$
BEGIN
  UPDATE player_stories
  SET view_count = view_count + 1
  WHERE id = story_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. CLUB JOIN REQUESTS TABLE (Phase 14)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS club_join_requests (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(club_id, user_id)
);

-- RLS
ALTER TABLE club_join_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can create join requests" ON club_join_requests
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can view own join requests" ON club_join_requests
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Club admins can view all requests for their clubs" ON club_join_requests
  FOR SELECT USING (
    club_id IN (
      SELECT club_id FROM club_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin', 'manager')
    )
  );

CREATE POLICY "Club admins can update request status" ON club_join_requests
  FOR UPDATE USING (
    club_id IN (
      SELECT club_id FROM club_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin', 'manager')
    )
  );

-- Indexes
CREATE INDEX IF NOT EXISTS idx_join_requests_club ON club_join_requests(club_id);
CREATE INDEX IF NOT EXISTS idx_join_requests_user ON club_join_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_join_requests_status ON club_join_requests(status);

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. INVITES TABLE: Ensure exists for invite analytics (Phase 12)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invites (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  inviter_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  invitee_email TEXT,
  invitee_user_id UUID REFERENCES auth.users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ
);

ALTER TABLE invites ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Club admins can view invites" ON invites
  FOR SELECT USING (
    inviter_id = auth.uid() OR
    club_id IN (
      SELECT club_id FROM club_members
      WHERE user_id = auth.uid() AND role IN ('owner', 'admin', 'manager')
    )
  );

CREATE POLICY "Users can create invites" ON invites
  FOR INSERT WITH CHECK (auth.uid() = inviter_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. CLUBS TABLE: Add tags and rating columns (Phase 10)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS tags TEXT[] DEFAULT '{}';
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS average_rating DECIMAL(3,2) DEFAULT 0;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS game_type TEXT DEFAULT 'Texas Holdem';

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. Realtime publication for new tables
-- ─────────────────────────────────────────────────────────────────────────────
-- Enable realtime for new tables (safe to re-run)
DO $$
BEGIN
  -- player_kudos
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'player_kudos'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE player_kudos;
  END IF;

  -- player_stories
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'player_stories'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE player_stories;
  END IF;

  -- message_read_receipts
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'message_read_receipts'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE message_read_receipts;
  END IF;

  -- club_join_requests
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'club_join_requests'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE club_join_requests;
  END IF;
END;
$$;
