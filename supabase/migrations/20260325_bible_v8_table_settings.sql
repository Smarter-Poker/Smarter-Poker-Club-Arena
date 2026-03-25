-- Bible V8 §2.2 Table Settings: Add missing configuration columns to tables
-- Migration: 20260325_bible_v8_table_settings.sql
-- These columns support server-authoritative engine configuration per-table.

-- Bible V8 §4.20: Run It Twice
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS run_it_twice_enabled BOOLEAN DEFAULT FALSE;

-- Bible V8 §4.19: Insurance
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS insurance_enabled BOOLEAN DEFAULT FALSE;

-- Bible V8 §4.21: Auto-muck losing hands at showdown
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS auto_muck_enabled BOOLEAN DEFAULT TRUE;

-- Bible V8 §4.21: Allow players to voluntarily show hand
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS show_hand_enabled BOOLEAN DEFAULT TRUE;

-- Bible V8 §6.3: Disconnect timeout in seconds
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS disconnect_timeout_seconds INTEGER DEFAULT 30;

-- Bible V8 §1.7.6: Auto sit-out after N consecutive timeouts
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS max_consecutive_timeouts INTEGER DEFAULT 3;

-- Bible V8 §1.7.4: Prefer check over fold on disconnect/timeout
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS prefer_check_over_fold BOOLEAN DEFAULT TRUE;

-- Bible V8 §6.2: Max time bank uses per session
ALTER TABLE public.tables ADD COLUMN IF NOT EXISTS time_bank_max_uses INTEGER DEFAULT 4;
