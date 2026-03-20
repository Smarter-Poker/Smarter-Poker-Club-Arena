-- ═══════════════════════════════════════════════════════════════════════════════
-- MARKETPLACE FULL BUILD-OUT (March 20, 2026)
-- Fixes marketplace_items (adds club_id), marketplace_purchases (adds club_id),
-- rewrites deduct_marketplace_chips RPC to use club_members.chip_balance,
-- and adds all missing RLS policies for admin management and purchases.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Add club_id column to marketplace_items
--    The code queries .eq('club_id', targetClub) but the column was missing.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS club_id UUID;
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS purchase_count INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_marketplace_items_club ON marketplace_items(club_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_items_active ON marketplace_items(club_id, is_active);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Add club_id column to marketplace_purchases
--    Enables scoped purchase queries per club.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE marketplace_purchases ADD COLUMN IF NOT EXISTS club_id UUID;

CREATE INDEX IF NOT EXISTS idx_marketplace_purchases_user ON marketplace_purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_purchases_item ON marketplace_purchases(item_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_purchases_club ON marketplace_purchases(club_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Fix deduct_marketplace_chips RPC
--    OLD: Deducted from player_wallets (wrong table)
--    NEW: Deducts from club_members.chip_balance (the balance shown on the page)
--         AND atomically inserts into marketplace_purchases
--         AND increments purchase_count on the item
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION deduct_marketplace_chips(
    p_club_id UUID,
    p_user_id UUID,
    p_amount NUMERIC,
    p_item_id UUID
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    -- 1. Deduct from club_members.chip_balance (the actual display balance)
    UPDATE club_members
    SET chip_balance = chip_balance - p_amount,
        updated_at = NOW()
    WHERE club_id = p_club_id
      AND user_id = p_user_id
      AND chip_balance >= p_amount;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Insufficient chip balance for marketplace purchase';
    END IF;

    -- 2. Record the purchase
    INSERT INTO marketplace_purchases (user_id, item_id, club_id, price_paid, created_at)
    VALUES (p_user_id, p_item_id, p_club_id, p_amount, NOW());

    -- 3. Increment purchase count on the item
    UPDATE marketplace_items
    SET purchase_count = COALESCE(purchase_count, 0) + 1,
        updated_at = NOW()
    WHERE id = p_item_id;

    -- 4. Log the transaction in chip_transactions for audit trail
    INSERT INTO chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes)
    VALUES (p_club_id, p_user_id, NULL, p_amount, 'marketplace_purchase',
            'Marketplace purchase: item ' || p_item_id::TEXT);
END;
$$;

GRANT EXECUTE ON FUNCTION deduct_marketplace_chips TO authenticated, anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RLS Policies for marketplace_items
--    SELECT: already exists (public read)
--    INSERT/UPDATE/DELETE: club owners and admins only
-- ─────────────────────────────────────────────────────────────────────────────

-- Drop existing narrow policies if they exist, then recreate
DO $$ BEGIN
    DROP POLICY IF EXISTS "marketplace_items_insert" ON marketplace_items;
    DROP POLICY IF EXISTS "marketplace_items_update" ON marketplace_items;
    DROP POLICY IF EXISTS "marketplace_items_delete" ON marketplace_items;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

CREATE POLICY "marketplace_items_insert" ON marketplace_items
    FOR INSERT WITH CHECK (
        club_id IN (
            SELECT club_id FROM club_members
            WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
        )
    );

CREATE POLICY "marketplace_items_update" ON marketplace_items
    FOR UPDATE USING (
        club_id IN (
            SELECT club_id FROM club_members
            WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
        )
    );

CREATE POLICY "marketplace_items_delete" ON marketplace_items
    FOR DELETE USING (
        club_id IN (
            SELECT club_id FROM club_members
            WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
        )
    );

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. RLS Policies for marketplace_purchases
--    SELECT: users see their own purchases (already exists as mp_sel)
--    INSERT: The RPC handles inserts via SECURITY DEFINER, but add policy
--            for direct inserts if needed
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
    DROP POLICY IF EXISTS "marketplace_purchases_insert" ON marketplace_purchases;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

CREATE POLICY "marketplace_purchases_insert" ON marketplace_purchases
    FOR INSERT WITH CHECK (user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Ensure marketplace_items is in realtime publication
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE marketplace_items;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE marketplace_purchases;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
