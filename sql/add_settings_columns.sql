-- ═══════════════════════════════════════════════════════════════════════════════
-- ADD SETTINGS COLUMNS TO PROFILES TABLE
-- Fixes BUG-04/BUG-05: Settings persistence across page refreshes
-- These columns back the Hamburger Menu toggle switches
-- ═══════════════════════════════════════════════════════════════════════════════

-- Add columns if they don't already exist (safe to re-run)
DO $$
BEGIN
  -- Sounds toggle (default: true = enabled)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'sounds_enabled'
  ) THEN
    ALTER TABLE public.profiles ADD COLUMN sounds_enabled boolean DEFAULT true;
  END IF;

  -- Vibrations toggle (default: true = enabled)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'vibrations_enabled'
  ) THEN
    ALTER TABLE public.profiles ADD COLUMN vibrations_enabled boolean DEFAULT true;
  END IF;

  -- Show Stack in BBs toggle (default: false = show chips)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'show_stack_bb'
  ) THEN
    ALTER TABLE public.profiles ADD COLUMN show_stack_bb boolean DEFAULT false;
  END IF;
END
$$;
