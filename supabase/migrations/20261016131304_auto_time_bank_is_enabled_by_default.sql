-- New accounts and settings rows start with automatic use of owned time banks.
-- Existing explicit preferences are retained; the toggle now reaches the engine.
-- @live-proof: EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'user_table_settings' AND column_name = 'auto_time_bank' AND column_default = 'true')
BEGIN;
SET LOCAL lock_timeout = '3s';
ALTER TABLE public.user_table_settings ALTER COLUMN auto_time_bank SET DEFAULT true;
COMMIT;
