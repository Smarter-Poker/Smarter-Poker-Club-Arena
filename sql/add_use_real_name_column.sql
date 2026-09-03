-- ═══════════════════════════════════════════════════════════════════════════════
-- Migration: Add use_real_name column to profiles table
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Purpose: The Identity & Avatar system allows users to toggle between showing
-- their real name (display_name) or poker alias (username) at the table.
-- This column persists that preference in Supabase alongside localStorage.
--
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- ═══════════════════════════════════════════════════════════════════════════════

-- Add the column if it doesn't already exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'profiles'
      AND column_name = 'use_real_name'
  ) THEN
    ALTER TABLE public.profiles ADD COLUMN use_real_name BOOLEAN DEFAULT false;
    COMMENT ON COLUMN public.profiles.use_real_name IS 'When true, display real name (display_name) instead of poker alias (username) at the table';
  END IF;
END
$$;
