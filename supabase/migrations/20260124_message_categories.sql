-- ═══════════════════════════════════════════════════════════════════════════════
-- 🏠 MESSAGE CATEGORIES — Separate Club Messages from Personal DMs
-- ═══════════════════════════════════════════════════════════════════════════════
-- Facebook Marketplace-style widget for Club Messages

-- Add category column to conversations table
ALTER TABLE conversations 
ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'personal';

-- Add constraint for valid categories
DO $$
BEGIN
    ALTER TABLE conversations 
    ADD CONSTRAINT conversations_category_check 
    CHECK (category IN ('personal', 'club'));
EXCEPTION WHEN duplicate_object THEN
    NULL;
END $$;

-- Add club_id reference for club conversations
ALTER TABLE conversations 
ADD COLUMN IF NOT EXISTS club_id UUID REFERENCES clubs(id) ON DELETE SET NULL;

-- Index for efficient filtering by category
CREATE INDEX IF NOT EXISTS idx_conversations_category ON conversations(category);
CREATE INDEX IF NOT EXISTS idx_conversations_club_id ON conversations(club_id);

-- Update existing club-related conversations (if any can be identified)
-- This is a placeholder - actual migration logic would depend on how club messages are currently stored
COMMENT ON COLUMN conversations.category IS 'Message category: personal (DMs) or club (club-scoped messages)';
COMMENT ON COLUMN conversations.club_id IS 'Reference to club for club-category conversations';
