-- ═══════════════════════════════════════════════════════════════════════════════
-- Q3 Social Hardening: FK Constraints, Indexes, and RLS
-- ═══════════════════════════════════════════════════════════════════════════════
-- Low-risk schema improvements:
-- 1. Add FK constraints to friendships table (prevents orphan records)
-- 2. Add missing index on friendships(friend_id) for bidirectional queries
-- 3. Enable RLS on direct_messages table
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1. Friendships FK Constraints ──
-- Prevents orphaned friendship records when users are deleted
DO $$ BEGIN
  ALTER TABLE friendships
    ADD CONSTRAINT fk_friendships_user_id
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE friendships
    ADD CONSTRAINT fk_friendships_friend_id
    FOREIGN KEY (friend_id) REFERENCES auth.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 2. Missing Index: friendships(friend_id) ──
-- Enables efficient bidirectional friendship lookups
-- (idx_friendships_user already covers user_id direction)
CREATE INDEX IF NOT EXISTS idx_friendships_friend ON friendships(friend_id);

-- ── 3. Direct Messages RLS ──
-- Prevents unauthorized access to legacy direct_messages table
ALTER TABLE direct_messages ENABLE ROW LEVEL SECURITY;

-- Users can only read DMs they sent or received
DO $$ BEGIN
  CREATE POLICY "Users can view own DMs"
    ON direct_messages FOR SELECT
    USING (auth.uid() = sender_id OR auth.uid() = recipient_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Users can send DMs (insert where they are the sender)
DO $$ BEGIN
  CREATE POLICY "Users can send DMs"
    ON direct_messages FOR INSERT
    WITH CHECK (auth.uid() = sender_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Users can mark their received DMs as read
DO $$ BEGIN
  CREATE POLICY "Users can update own received DMs"
    ON direct_messages FOR UPDATE
    USING (auth.uid() = recipient_id)
    WITH CHECK (auth.uid() = recipient_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Users can delete their own DMs (sent or received)
DO $$ BEGIN
  CREATE POLICY "Users can delete own DMs"
    ON direct_messages FOR DELETE
    USING (auth.uid() = sender_id OR auth.uid() = recipient_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
