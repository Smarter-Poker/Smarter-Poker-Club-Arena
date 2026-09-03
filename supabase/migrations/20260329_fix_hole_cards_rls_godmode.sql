-- ═══════════════════════════════════════════════════════════════════════════════
-- ♠ FIX 141 — Drop God-Mode RLS Policy on table_hole_cards
-- ═══════════════════════════════════════════════════════════════════════════════
-- VULNERABILITY: Migration 20260314_phantom_table_remediation_v2.sql created
-- a permissive policy "hole_cards_all" ON table_hole_cards FOR ALL USING (true).
--
-- In PostgreSQL, multiple permissive policies are OR'd together. This means
-- EVERY authenticated user can read ALL players' hole cards, completely defeating
-- the secure per-user policy from 20260312_secure_hole_cards_fix.sql.
--
-- Supabase Realtime uses RLS for filtering, so with USING(true), every connected
-- client receives notifications for ALL players' cards — a god-mode vulnerability.
--
-- FIX: Drop the overly-permissive policy. The correct policies from
-- 20260312_secure_hole_cards_fix.sql remain in effect:
--   - SELECT: auth.uid() = user_id  (users can only read their own cards)
--   - INSERT: WITH CHECK (false)     (clients cannot insert; only service_role/RPC)
-- ═══════════════════════════════════════════════════════════════════════════════

-- Drop the god-mode policy
DROP POLICY IF EXISTS "hole_cards_all" ON public.table_hole_cards;

-- Verify the correct policies still exist (these are from 20260312)
-- If they were somehow dropped, re-create them as defense-in-depth
DO $$
BEGIN
    -- Check if the secure SELECT policy exists
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'table_hole_cards'
        AND policyname = 'Users can read own hole cards'
    ) THEN
        CREATE POLICY "Users can read own hole cards"
        ON public.table_hole_cards FOR SELECT TO authenticated
        USING (auth.uid() = user_id);
    END IF;

    -- Check if the INSERT block policy exists
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE tablename = 'table_hole_cards'
        AND policyname = 'Service role can insert hole cards'
    ) THEN
        CREATE POLICY "Service role can insert hole cards"
        ON public.table_hole_cards FOR INSERT TO authenticated
        WITH CHECK (false);
    END IF;
END
$$;

-- Also add explicit DELETE and UPDATE blocks for defense-in-depth
-- (users should never be able to modify or delete hole cards)
DROP POLICY IF EXISTS "block_hole_cards_update" ON public.table_hole_cards;
CREATE POLICY "block_hole_cards_update"
ON public.table_hole_cards FOR UPDATE TO authenticated
USING (false);

DROP POLICY IF EXISTS "block_hole_cards_delete" ON public.table_hole_cards;
CREATE POLICY "block_hole_cards_delete"
ON public.table_hole_cards FOR DELETE TO authenticated
USING (false);
