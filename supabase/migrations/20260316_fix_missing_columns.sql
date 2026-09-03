-- ═══════════════════════════════════════════════════════════════════════════════
-- Add missing `id` column to `club_members` table
-- The codebase expects ClubMember.id as the primary key, but the table
-- currently uses a composite key or lacks this column entirely.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Step 1: Add the id column if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'club_members'
      AND column_name = 'id'
  ) THEN
    ALTER TABLE public.club_members
      ADD COLUMN id uuid DEFAULT gen_random_uuid();

    -- Backfill existing rows with UUIDs
    UPDATE public.club_members SET id = gen_random_uuid() WHERE id IS NULL;

    -- Make it NOT NULL
    ALTER TABLE public.club_members ALTER COLUMN id SET NOT NULL;

    -- Add unique constraint (needed for .eq('id', ...) lookups)
    ALTER TABLE public.club_members ADD CONSTRAINT club_members_id_unique UNIQUE (id);

    RAISE NOTICE 'Added id column to club_members';
  ELSE
    RAISE NOTICE 'club_members.id already exists — no changes';
  END IF;
END $$;

-- Step 2: Add missing columns to profiles that HamburgerMenu.tsx queries
-- These are individual setting columns that some UI components expect
DO $$
BEGIN
  -- sounds_enabled
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'sounds_enabled'
  ) THEN
    ALTER TABLE public.profiles ADD COLUMN sounds_enabled boolean DEFAULT true;
    RAISE NOTICE 'Added sounds_enabled to profiles';
  END IF;

  -- vibrations_enabled
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'vibrations_enabled'
  ) THEN
    ALTER TABLE public.profiles ADD COLUMN vibrations_enabled boolean DEFAULT true;
    RAISE NOTICE 'Added vibrations_enabled to profiles';
  END IF;

  -- show_stack_bb
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'show_stack_bb'
  ) THEN
    ALTER TABLE public.profiles ADD COLUMN show_stack_bb boolean DEFAULT false;
    RAISE NOTICE 'Added show_stack_bb to profiles';
  END IF;

  -- is_vip
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'is_vip'
  ) THEN
    ALTER TABLE public.profiles ADD COLUMN is_vip boolean DEFAULT false;
    RAISE NOTICE 'Added is_vip to profiles';
  END IF;

  -- diamonds
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'diamonds'
  ) THEN
    ALTER TABLE public.profiles ADD COLUMN diamonds integer DEFAULT 0;
    RAISE NOTICE 'Added diamonds to profiles';
  END IF;
END $$;
