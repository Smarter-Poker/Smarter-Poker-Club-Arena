-- ═══════════════════════════════════════════════════════════════════════════════
-- SECURITY FIX: Restrict INSERT on user_daily_challenges to own user_id
--
-- Previous policy: WITH CHECK (true) — allowed ANY authenticated user to insert
-- rows for ANY user_id, enabling fake challenge completion injection.
-- New policy: WITH CHECK (auth.uid() = user_id) — users can only insert
-- challenges for themselves.
--
-- NOTE: The increment_challenge_progress and claim_daily_challenge RPCs use
-- SECURITY DEFINER, so they bypass RLS and are unaffected by this change.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Drop the old permissive INSERT policy
DROP POLICY IF EXISTS "Service can insert challenges" ON user_daily_challenges;

-- Create the secure INSERT policy
CREATE POLICY "Users can insert own challenges" ON user_daily_challenges
    FOR INSERT WITH CHECK (auth.uid() = user_id);
