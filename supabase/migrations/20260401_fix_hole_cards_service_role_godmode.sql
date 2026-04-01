-- ═══════════════════════════════════════════════════════════════════════════════
-- ♠ FIX 227 — Drop Residual God-Mode RLS Policy on table_hole_cards
-- ═══════════════════════════════════════════════════════════════════════════════
-- VULNERABILITY: 20260329_create_table_hole_cards.sql created a policy
-- "Service role manages hole cards" with FOR ALL USING (true) WITH CHECK (true).
--
-- This is equivalent to the "hole_cards_all" policy that FIX-141 removed.
-- Since PostgreSQL OR's permissive policies, ANY authenticated user can SELECT
-- ALL players' hole cards through this policy — defeating the secure
-- "Users can read own hole cards" policy (auth.uid() = user_id).
--
-- The service_role in Supabase BYPASSES RLS entirely, so it doesn't need an
-- explicit policy. This policy is both unnecessary and dangerous.
--
-- FIX: Drop the "Service role manages hole cards" policy entirely.
-- The correct policies from FIX-141 remain:
--   - SELECT: auth.uid() = user_id (users read own cards only)
--   - INSERT: WITH CHECK (false) (clients can't insert; service_role bypasses RLS)
--   - UPDATE: USING (false) (blocked for authenticated users)
--   - DELETE: USING (false) (blocked for authenticated users)
-- ═══════════════════════════════════════════════════════════════════════════════

-- Drop the god-mode policy
DROP POLICY IF EXISTS "Service role manages hole cards" ON public.table_hole_cards;

-- Verify defense-in-depth: ensure the correct SELECT policy exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'table_hole_cards'
        AND policyname = 'Users can read own hole cards'
    ) THEN
        CREATE POLICY "Users can read own hole cards"
        ON public.table_hole_cards FOR SELECT TO authenticated
        USING (auth.uid() = user_id);
    END IF;
END
$$;
