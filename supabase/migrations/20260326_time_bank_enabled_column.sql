-- FIX 123: Add time_bank_enabled column to tables
-- Bible V8 §6.2: Table-level toggle for time bank auto-activation
-- When FALSE, time banks will NOT auto-activate on timeout (player gets folded immediately).
-- Players can still manually activate time banks via the /timebank endpoint.
-- Default: TRUE (time banks auto-activate when available)

ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS time_bank_enabled BOOLEAN DEFAULT TRUE;
