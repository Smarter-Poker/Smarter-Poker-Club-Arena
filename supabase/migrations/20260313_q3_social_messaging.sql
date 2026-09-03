-- ═══════════════════════════════════════════════════════════════════════════════
--  Q3: Social, Messaging & Discovery — SQL Migration
--  Tables + columns needed for Phase 8-9 features
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1. Add player status columns to profiles ──
-- These columns support the "Playing At" feature and custom status text
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS status_text TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS current_table TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS current_table_id UUID DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS is_online BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ DEFAULT NOW();

-- Index for fast friend status queries
CREATE INDEX IF NOT EXISTS idx_profiles_is_online ON profiles (is_online) WHERE is_online = TRUE;

-- ── 2. Scheduled Messages table ──
-- Supports club admin message scheduling (Phase 8-9)
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES auth.users(id),
  content TEXT NOT NULL,
  send_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled', 'failed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  sent_at TIMESTAMPTZ DEFAULT NULL
);

-- Index for cron job: find pending messages ready to send
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_pending
  ON scheduled_messages (send_at)
  WHERE status = 'pending';

-- RLS: Users can only see/manage their own scheduled messages  
ALTER TABLE scheduled_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own scheduled messages"
  ON scheduled_messages FOR SELECT
  USING (auth.uid() = sender_id);

CREATE POLICY "Users can insert scheduled messages"
  ON scheduled_messages FOR INSERT
  WITH CHECK (auth.uid() = sender_id);

CREATE POLICY "Users can cancel own scheduled messages"
  ON scheduled_messages FOR UPDATE
  USING (auth.uid() = sender_id)
  WITH CHECK (auth.uid() = sender_id AND status = 'cancelled');

-- ── 3. Add action_url column to notifications ──
-- Supports notification deep-linking (Phase 8)
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS action_url TEXT DEFAULT NULL;

-- ── 4. Ensure notifications has required columns ──
-- These should already exist, but ensure for safety
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- ── 5. Add error_message column and 'failed' status to scheduled_messages ──
ALTER TABLE scheduled_messages
  ADD COLUMN IF NOT EXISTS error_message TEXT DEFAULT NULL;

-- Index for listing by conversation
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_conversation
  ON scheduled_messages (conversation_id, status);

-- ── 6. Cron function: process_scheduled_messages ──
-- Call from pg_cron every minute: SELECT process_scheduled_messages();
CREATE OR REPLACE FUNCTION process_scheduled_messages()
RETURNS SETOF scheduled_messages
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  rec scheduled_messages%ROWTYPE;
BEGIN
  FOR rec IN
    SELECT * FROM scheduled_messages
    WHERE status = 'pending' AND send_at <= now()
    ORDER BY send_at ASC
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      -- Insert into messages table
      INSERT INTO messages (conversation_id, sender_id, content, metadata)
      VALUES (
        rec.conversation_id,
        rec.sender_id,
        rec.content,
        jsonb_build_object('type', 'scheduled', 'scheduled_id', rec.id::text)
      );

      -- Mark as sent
      UPDATE scheduled_messages
      SET status = 'sent', sent_at = now()
      WHERE id = rec.id;

      -- Update conversation timestamp
      UPDATE conversations
      SET updated_at = now()
      WHERE id = rec.conversation_id;

    EXCEPTION WHEN OTHERS THEN
      UPDATE scheduled_messages
      SET status = 'failed', error_message = SQLERRM
      WHERE id = rec.id;
    END;

    RETURN NEXT rec;
  END LOOP;
END;
$$;
