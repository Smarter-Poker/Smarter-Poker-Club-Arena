-- 20260312009_friend_challenges.sql
-- Friend challenge system for social engagement

BEGIN;

CREATE TABLE IF NOT EXISTS friend_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenger_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  challengee_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  challenge_type TEXT NOT NULL,
  target_value INT NOT NULL DEFAULT 0,
  challenger_progress INT NOT NULL DEFAULT 0,
  challengee_progress INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'completed', 'expired', 'declined')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_friend_challenges_challenger ON friend_challenges(challenger_id);
CREATE INDEX IF NOT EXISTS idx_friend_challenges_challengee ON friend_challenges(challengee_id);
CREATE INDEX IF NOT EXISTS idx_friend_challenges_status ON friend_challenges(status);

ALTER TABLE friend_challenges ENABLE ROW LEVEL SECURITY;

-- Users can read challenges they are part of
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users read own challenges' AND tablename = 'friend_challenges') THEN
    CREATE POLICY "Users read own challenges" ON friend_challenges FOR SELECT
      USING (auth.uid() = challenger_id OR auth.uid() = challengee_id);
  END IF;
END $$;

-- Users can create challenges where they are the challenger
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users create own challenges' AND tablename = 'friend_challenges') THEN
    CREATE POLICY "Users create own challenges" ON friend_challenges FOR INSERT
      WITH CHECK (auth.uid() = challenger_id);
  END IF;
END $$;

-- Users can update challenges they are part of (accept/decline)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users update own challenges' AND tablename = 'friend_challenges') THEN
    CREATE POLICY "Users update own challenges" ON friend_challenges FOR UPDATE
      USING (auth.uid() = challenger_id OR auth.uid() = challengee_id);
  END IF;
END $$;

COMMIT;
