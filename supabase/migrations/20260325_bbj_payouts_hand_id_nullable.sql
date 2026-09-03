-- ═══════════════════════════════════════════════════════════════════════════════
-- BBJ PAYOUTS: Make hand_id nullable
-- ═══════════════════════════════════════════════════════════════════════════════
-- The server logs hands to `hand_history` table, not the legacy `hands` table.
-- BBJ payouts are recorded by ServerTableEngine which doesn't use the `hands`
-- table. Adding hand_number as an alternative reference.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Make hand_id nullable (was NOT NULL REFERENCES hands(id))
ALTER TABLE bbj_payouts ALTER COLUMN hand_id DROP NOT NULL;

-- Add hand_number + table_id columns for reference without FK
ALTER TABLE bbj_payouts ADD COLUMN IF NOT EXISTS hand_number INTEGER;
ALTER TABLE bbj_payouts ADD COLUMN IF NOT EXISTS table_id UUID REFERENCES tables(id);

-- Index for lookup by table
CREATE INDEX IF NOT EXISTS idx_bbj_payouts_table ON bbj_payouts(table_id);
