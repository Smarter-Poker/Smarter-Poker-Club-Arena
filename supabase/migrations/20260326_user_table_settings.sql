-- ═══════════════════════════════════════════════════════════════════════════════
-- Bible V8 Chapter 11: User Table Settings & Theme Customization
-- Migration: 20260326_user_table_settings.sql
-- ═══════════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────────
-- §11.1: user_table_settings — Per-user UI/UX preferences (applies to ALL tables)
-- ───────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_table_settings (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,

  -- §11.1.1: 12 Required Toggle Settings
  highlight_active_players BOOLEAN NOT NULL DEFAULT TRUE,   -- Highlight currently-acting player's seat
  show_avatars             BOOLEAN NOT NULL DEFAULT TRUE,   -- Display player avatar images at seats
  show_badges              BOOLEAN NOT NULL DEFAULT FALSE,  -- Display VIP/achievement badges at seats
  cards_pre_sort           BOOLEAN NOT NULL DEFAULT TRUE,   -- Auto-sort hole cards by rank (high→low)
  gestures_enabled         BOOLEAN NOT NULL DEFAULT FALSE,  -- Enable swipe/drag gesture controls
  card_slide               BOOLEAN NOT NULL DEFAULT FALSE,  -- Enable card peek/slide reveal animation
  show_stack_in_bb         BOOLEAN NOT NULL DEFAULT FALSE,  -- Display stacks as BB count
  auto_time_bank           BOOLEAN NOT NULL DEFAULT FALSE,  -- Auto-activate time bank on primary timer expiry
  enhanced_view            BOOLEAN NOT NULL DEFAULT FALSE,  -- Enable enhanced visual effects/animations
  voice_message            BOOLEAN NOT NULL DEFAULT TRUE,   -- Enable voice chat at table
  text_message             BOOLEAN NOT NULL DEFAULT TRUE,   -- Enable text chat at table
  emoji_enabled            BOOLEAN NOT NULL DEFAULT TRUE,   -- Enable emoji reactions/throwables

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-update updated_at on changes
CREATE OR REPLACE FUNCTION update_user_table_settings_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_user_table_settings_updated ON public.user_table_settings;
CREATE TRIGGER trg_user_table_settings_updated
  BEFORE UPDATE ON public.user_table_settings
  FOR EACH ROW
  EXECUTE FUNCTION update_user_table_settings_timestamp();

-- RLS: Users can only read/write their own settings
ALTER TABLE public.user_table_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own table settings" ON public.user_table_settings;
CREATE POLICY "Users can read own table settings"
  ON public.user_table_settings FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own table settings" ON public.user_table_settings;
CREATE POLICY "Users can insert own table settings"
  ON public.user_table_settings FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own table settings" ON public.user_table_settings;
CREATE POLICY "Users can update own table settings"
  ON public.user_table_settings FOR UPDATE
  USING (auth.uid() = user_id);

-- ───────────────────────────────────────────────────────────────────────────────
-- §11.2: user_theme_settings — Per-user, per-game-type theme customization
-- ───────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_theme_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- §11.2.1: Game type this theme applies to
  -- 'ALL' = default fallback if no per-game-type override exists
  game_type TEXT NOT NULL DEFAULT 'ALL',

  -- §11.2.2: Theme category selections (each is an asset ID string)
  theme_id      TEXT NOT NULL DEFAULT 'default-dark',   -- Tab 1: Complete table appearance preset
  table_id      TEXT NOT NULL DEFAULT 'dark-felt',      -- Tab 2: Table felt/surface
  button_id     TEXT NOT NULL DEFAULT 'red-d-gear',     -- Tab 3: Dealer button style
  background_id TEXT NOT NULL DEFAULT 'diamond-pattern', -- Tab 4: Room/environment background
  cards_id      TEXT NOT NULL DEFAULT 'standard-red',   -- Tab 5: Card face design

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Unique constraint: one theme config per user per game type
  UNIQUE (user_id, game_type)
);

-- Auto-update updated_at on changes
CREATE OR REPLACE FUNCTION update_user_theme_settings_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_user_theme_settings_updated ON public.user_theme_settings;
CREATE TRIGGER trg_user_theme_settings_updated
  BEFORE UPDATE ON public.user_theme_settings
  FOR EACH ROW
  EXECUTE FUNCTION update_user_theme_settings_timestamp();

-- RLS: Users can only read/write their own theme settings
ALTER TABLE public.user_theme_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own theme settings" ON public.user_theme_settings;
CREATE POLICY "Users can read own theme settings"
  ON public.user_theme_settings FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own theme settings" ON public.user_theme_settings;
CREATE POLICY "Users can insert own theme settings"
  ON public.user_theme_settings FOR INSERT
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own theme settings" ON public.user_theme_settings;
CREATE POLICY "Users can update own theme settings"
  ON public.user_theme_settings FOR UPDATE
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own theme settings" ON public.user_theme_settings;
CREATE POLICY "Users can delete own theme settings"
  ON public.user_theme_settings FOR DELETE
  USING (auth.uid() = user_id);
