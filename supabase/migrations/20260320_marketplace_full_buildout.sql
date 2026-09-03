-- ═══════════════════════════════════════════════════════════════════════════════
-- MARKETPLACE FULL BUILD-OUT (March 20, 2026)
-- Creates marketplace tables + RPC + RLS from scratch for production.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. marketplace_items — Store item catalog
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketplace_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    club_id UUID,
    name TEXT NOT NULL,
    description TEXT,
    category TEXT DEFAULT 'General',
    price NUMERIC(18,4) NOT NULL DEFAULT 0,
    currency TEXT DEFAULT 'chips' CHECK (currency IN ('diamonds', 'chips')),
    image_url TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    stock INTEGER DEFAULT -1,
    purchase_count INTEGER DEFAULT 0,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ensure columns exist (idempotent for existing tables)
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS club_id UUID;
ALTER TABLE marketplace_items ADD COLUMN IF NOT EXISTS purchase_count INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_marketplace_items_category ON marketplace_items(category);
CREATE INDEX IF NOT EXISTS idx_marketplace_items_club ON marketplace_items(club_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_items_active ON marketplace_items(club_id, is_active);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. marketplace_purchases — User purchase records
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS marketplace_purchases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    item_id UUID,
    club_id UUID,
    price_paid NUMERIC(18,4) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ensure columns exist (idempotent)
ALTER TABLE marketplace_purchases ADD COLUMN IF NOT EXISTS club_id UUID;

CREATE INDEX IF NOT EXISTS idx_marketplace_purchases_user ON marketplace_purchases(user_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_purchases_item ON marketplace_purchases(item_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_purchases_club ON marketplace_purchases(club_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. RLS
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE marketplace_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketplace_purchases ENABLE ROW LEVEL SECURITY;

-- marketplace_items: public read
DO $$ BEGIN
    DROP POLICY IF EXISTS "marketplace_items_select" ON marketplace_items;
EXCEPTION WHEN OTHERS THEN NULL; END $$;
CREATE POLICY "marketplace_items_select" ON marketplace_items FOR SELECT USING (true);

-- marketplace_items: admin insert/update/delete
DO $$ BEGIN
    DROP POLICY IF EXISTS "marketplace_items_insert" ON marketplace_items;
    DROP POLICY IF EXISTS "marketplace_items_update" ON marketplace_items;
    DROP POLICY IF EXISTS "marketplace_items_delete" ON marketplace_items;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

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

-- marketplace_purchases: user sees own purchases
DO $$ BEGIN
    DROP POLICY IF EXISTS "mp_sel" ON marketplace_purchases;
    DROP POLICY IF EXISTS "marketplace_purchases_select" ON marketplace_purchases;
    DROP POLICY IF EXISTS "marketplace_purchases_insert" ON marketplace_purchases;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

CREATE POLICY "marketplace_purchases_select" ON marketplace_purchases
    FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "marketplace_purchases_insert" ON marketplace_purchases
    FOR INSERT WITH CHECK (user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. deduct_marketplace_chips RPC
--    Atomically: deduct from club_members.chip_balance + insert purchase + increment count
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
    -- 1. Deduct from club_members.chip_balance
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

    -- 4. Audit trail
    INSERT INTO chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes)
    VALUES (p_club_id, p_user_id, NULL, p_amount, 'marketplace_purchase',
            'Marketplace purchase: item ' || p_item_id::TEXT);
END;
$$;

GRANT EXECUTE ON FUNCTION deduct_marketplace_chips TO authenticated, anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Realtime publication
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
