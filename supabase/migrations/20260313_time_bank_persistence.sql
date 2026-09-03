-- ═══════════════════════════════════════════════════════════════════════════════
-- TIME BANK PERSISTENCE - Added for Phase M Bug Hunt
-- ═══════════════════════════════════════════════════════════════════════════════

DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'table_seats' AND column_name = 'time_bank_remaining') THEN
        ALTER TABLE table_seats ADD COLUMN time_bank_remaining INTEGER DEFAULT 30;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'table_seats' AND column_name = 'time_bank_uses_remaining') THEN
        ALTER TABLE table_seats ADD COLUMN time_bank_uses_remaining INTEGER DEFAULT 4;
    END IF;
END $$;
