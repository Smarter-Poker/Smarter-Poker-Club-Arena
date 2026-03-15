-- ═══════════════════════════════════════════════════════════════════════════════
-- FIX BUG #37: Add missing columns to special_bonuses table
-- ═══════════════════════════════════════════════════════════════════════════════
-- BonusService expects: name, reward_type, condition, progress, target
-- Schema has: title, bonus_type (both correct for their purpose)
-- We add: name (alias for title), reward_type, condition, progress, target
-- ═══════════════════════════════════════════════════════════════════════════════

-- Add the columns the BonusService requires
ALTER TABLE special_bonuses ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE special_bonuses ADD COLUMN IF NOT EXISTS reward_type TEXT DEFAULT 'chips';
ALTER TABLE special_bonuses ADD COLUMN IF NOT EXISTS condition TEXT;
ALTER TABLE special_bonuses ADD COLUMN IF NOT EXISTS progress INTEGER DEFAULT 0;
ALTER TABLE special_bonuses ADD COLUMN IF NOT EXISTS target INTEGER DEFAULT 1;

-- Backfill name from title where name is null
UPDATE special_bonuses SET name = title WHERE name IS NULL AND title IS NOT NULL;
