-- ═══════════════════════════════════════════════════════════════════════════════
-- Q3 Social, Messaging & Discovery — Phase 11-13 SQL Migration
-- ═══════════════════════════════════════════════════════════════════════════════
-- Run this against your Supabase project:
--   supabase db reset  (if dev)
--   or paste into SQL Editor in Supabase Dashboard
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── Phase 11: Message Edit / Delete ────────────────────────────────────────

ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_edited BOOLEAN DEFAULT FALSE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN DEFAULT FALSE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_forwarded BOOLEAN DEFAULT FALSE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_message_id UUID DEFAULT NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_type TEXT DEFAULT 'message';

-- ─── Phase 11: Granular Read Receipts ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS message_read_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_mrr_message ON message_read_receipts(message_id);
CREATE INDEX IF NOT EXISTS idx_mrr_user ON message_read_receipts(user_id);

-- ─── Phase 11: Hidden Messages (soft-delete for non-sender) ────────────────

CREATE TABLE IF NOT EXISTS hidden_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  hidden_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_hm_user ON hidden_messages(user_id);

-- ─── Phase 12: Club Announcement Channel Fields ────────────────────────────

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'direct';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS club_id UUID DEFAULT NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS created_by UUID DEFAULT NULL;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_read_only BOOLEAN DEFAULT FALSE;

-- ─── Phase 12: Invite Tracking ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id UUID NOT NULL,
  inviter_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  invitee_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  invitee_email TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_invites_club ON invites(club_id);
CREATE INDEX IF NOT EXISTS idx_invites_inviter ON invites(inviter_id);
CREATE INDEX IF NOT EXISTS idx_invites_status ON invites(status);

-- ─── Phase 12: Scheduled Messages ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL,
  sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  send_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sched_conv ON scheduled_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_sched_status ON scheduled_messages(status, send_at);

-- ─── RLS Policies ──────────────────────────────────────────────────────────

-- message_read_receipts: users can read/write their own
ALTER TABLE message_read_receipts ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can insert own read receipts') THEN
    CREATE POLICY "Users can insert own read receipts"
      ON message_read_receipts FOR INSERT TO authenticated
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can read receipts for their messages') THEN
    CREATE POLICY "Users can read receipts for their messages"
      ON message_read_receipts FOR SELECT TO authenticated
      USING (true);
  END IF;
END $$;

-- hidden_messages: users can manage their own
ALTER TABLE hidden_messages ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can manage own hidden messages') THEN
    CREATE POLICY "Users can manage own hidden messages"
      ON hidden_messages FOR ALL TO authenticated
      USING (auth.uid() = user_id)
      WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;

-- invites: members can view, inviters can create
ALTER TABLE invites ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Authenticated users can view invites') THEN
    CREATE POLICY "Authenticated users can view invites"
      ON invites FOR SELECT TO authenticated
      USING (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Authenticated users can create invites') THEN
    CREATE POLICY "Authenticated users can create invites"
      ON invites FOR INSERT TO authenticated
      WITH CHECK (auth.uid() = inviter_id);
  END IF;
END $$;

-- scheduled_messages: users can manage their own
ALTER TABLE scheduled_messages ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can manage own scheduled messages') THEN
    CREATE POLICY "Users can manage own scheduled messages"
      ON scheduled_messages FOR ALL TO authenticated
      USING (auth.uid() = sender_id)
      WITH CHECK (auth.uid() = sender_id);
  END IF;
END $$;
