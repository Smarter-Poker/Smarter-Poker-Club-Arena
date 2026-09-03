-- Add arena_avatar_url to profiles
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS arena_avatar_url TEXT;

-- For users who haven't set an arena avatar, we backfill it with their social avatar to avoid everyone being blank on day 1
UPDATE public.profiles SET arena_avatar_url = avatar_url WHERE arena_avatar_url IS NULL AND avatar_url IS NOT NULL;
