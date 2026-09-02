ALTER TABLE public.user_table_settings
DROP COLUMN IF EXISTS button_color,
ADD COLUMN IF NOT EXISTS blue_buttons_enabled BOOLEAN NOT NULL DEFAULT FALSE;
