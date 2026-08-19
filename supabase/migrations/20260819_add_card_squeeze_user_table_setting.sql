-- ════════════════════════════════════════════════════════════════════════════
-- 20260819_add_card_squeeze_user_table_setting.sql
-- Tier 2 (additive column, no data rewrite, no RLS change)
--
-- Card Squeeze (GG-style marquee feature, competitor-parity audit 2026-08-19):
-- when enabled, the hero's hole cards are dealt FACE DOWN and the player
-- drags upward to bend/peel them open — a quick tap bounces a hint of the
-- gesture. Off by default: existing players see zero change until they flip
-- the switch in Table Settings.
--
-- Consumer: src/hooks/useUserTableSettings.ts (interface + META + load map)
--           src/components/table/SeatSlot.tsx (gesture + flip faces)
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.user_table_settings
  ADD COLUMN IF NOT EXISTS card_squeeze boolean NOT NULL DEFAULT false;

-- Post-apply assertion: column exists with the right default.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_table_settings'
      AND column_name = 'card_squeeze'
  ) THEN
    RAISE EXCEPTION 'card_squeeze column missing after ALTER';
  END IF;
END $$;
