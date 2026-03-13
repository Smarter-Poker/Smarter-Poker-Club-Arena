-- ═══════════════════════════════════════════════════════════════════════════════
-- Q3 Phase 9: Scheduled Messages + Player Status + Notification Preferences
-- ═══════════════════════════════════════════════════════════════════════════════

-- Scheduled Messages (club admin announcements)
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  send_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled', 'failed')),
  created_at TIMESTAMPTZ DEFAULT now(),
  sent_at TIMESTAMPTZ
);

-- Indexes for cron job pickup and conversation listing
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_status_send_at
  ON scheduled_messages (status, send_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_conversation
  ON scheduled_messages (conversation_id);

-- RLS for scheduled_messages
ALTER TABLE scheduled_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own scheduled messages"
  ON scheduled_messages FOR ALL
  USING (auth.uid() = sender_id)
  WITH CHECK (auth.uid() = sender_id);

-- Player Status fields on profiles (if not already present)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'status_text') THEN
    ALTER TABLE profiles ADD COLUMN status_text TEXT DEFAULT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'current_table') THEN
    ALTER TABLE profiles ADD COLUMN current_table TEXT DEFAULT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'current_table_id') THEN
    ALTER TABLE profiles ADD COLUMN current_table_id UUID DEFAULT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'last_seen') THEN
    ALTER TABLE profiles ADD COLUMN last_seen TIMESTAMPTZ DEFAULT now();
  END IF;
END $$;

-- Conversation pinning (if not already present)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'conversations' AND column_name = 'is_pinned'
  ) THEN
    ALTER TABLE conversations ADD COLUMN is_pinned BOOLEAN DEFAULT false;
  END IF;
END $$;

-- Message forwarding flag (if not already present)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'messages' AND column_name = 'is_forwarded'
  ) THEN
    ALTER TABLE messages ADD COLUMN is_forwarded BOOLEAN DEFAULT false;
  END IF;
END $$;

-- Message metadata for contact cards, reactions, etc.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'messages' AND column_name = 'metadata'
  ) THEN
    ALTER TABLE messages ADD COLUMN metadata JSONB DEFAULT NULL;
  END IF;
END $$;
