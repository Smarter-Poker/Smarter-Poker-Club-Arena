-- ═══════════════════════════════════════════════════════════════════════════════
--  FIX: Add UPDATE policy for rakeback_periods
--  BUG: RLS was enabled with SELECT-only policy. The claim flow's
--        .update({ status: 'paid' }) was silently rejected (0 rows affected),
--        allowing infinite re-claims since periods never actually changed status.
--  FIX: Allow authenticated users to update ONLY their own rakeback periods,
--        restricted to the 'status' column change from 'pending' to 'paid'.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Drop existing policy if any
DROP POLICY IF EXISTS rakeback_periods_update_own ON rakeback_periods;

-- Users can update their own rakeback periods (claim flow marks as 'paid')
CREATE POLICY rakeback_periods_update_own ON rakeback_periods
    FOR UPDATE TO authenticated
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

DO $$ BEGIN RAISE NOTICE '✅ rakeback_periods UPDATE policy added — infinite claim exploit blocked'; END $$;
