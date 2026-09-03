-- FIX 173: Add skip_animations column to user_table_settings
-- Bible V8 §10.3: "Skip animations option for speed players"
ALTER TABLE user_table_settings
  ADD COLUMN IF NOT EXISTS skip_animations BOOLEAN DEFAULT false;
