-- Reconstruct the Daily Missions objects that existed in production but were
-- never recorded in migration history. Later migrations evolve these objects;
-- this file only supplies the foundation they already assume exists.

CREATE TABLE IF NOT EXISTS public.daily_challenge_catalog (
  id text PRIMARY KEY,
  challenge_type text NOT NULL,
  requirement integer NOT NULL CHECK (requirement > 0),
  diamond_reward integer NOT NULL DEFAULT 0 CHECK (diamond_reward >= 0),
  tier text NOT NULL DEFAULT 'daily' CHECK (tier IN ('daily', 'weekly', 'monthly')),
  chip_reward numeric NOT NULL DEFAULT 0 CHECK (chip_reward >= 0),
  name text NOT NULL,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The 20260820d migration certifies its progress function against this legacy
-- contract before the specific catalog replaces it on 20260821.
INSERT INTO public.daily_challenge_catalog (
  id, challenge_type, requirement, diamond_reward, tier, chip_reward, name, description
) VALUES (
  'hands_50', 'hands_played', 50, 10, 'daily', 0, 'Hands Fifty', 'Play 50 Hands Today'
) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.challenge_streak_state (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  freezes_available integer NOT NULL DEFAULT 0 CHECK (freezes_available BETWEEN 0 AND 3),
  freezes_used integer NOT NULL DEFAULT 0 CHECK (freezes_used >= 0),
  freezes_earned integer NOT NULL DEFAULT 0 CHECK (freezes_earned >= 0),
  frozen_dates text[] NOT NULL DEFAULT ARRAY[]::text[],
  last_earned_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.challenge_streak_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.challenge_streak_state FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.challenge_streak_state TO service_role;

DROP POLICY IF EXISTS "user reads own streak state" ON public.challenge_streak_state;
CREATE POLICY "user reads own streak state"
  ON public.challenge_streak_state FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE OR REPLACE FUNCTION public.assign_user_challenges(
  p_assigned_date text,
  p_challenge_ids text[]
)
RETURNS SETOF public.user_daily_challenges
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_id text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF p_assigned_date !~ '^(\d{4}-\d{2}-\d{2}|W\d{4}-\d{2}-\d{2}|M\d{4}-\d{2})$' THEN
    RAISE EXCEPTION 'Invalid period key %', p_assigned_date;
  END IF;
  IF cardinality(p_challenge_ids) NOT BETWEEN 1 AND 8 THEN
    RAISE EXCEPTION 'Between 1 and 8 challenges per period';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_daily_challenges
    WHERE user_id = v_uid AND assigned_date = p_assigned_date
  ) THEN
    FOREACH v_id IN ARRAY p_challenge_ids LOOP
      IF NOT EXISTS (SELECT 1 FROM public.daily_challenge_catalog WHERE id = v_id) THEN
        RAISE EXCEPTION 'Unknown challenge %', v_id;
      END IF;
      INSERT INTO public.user_daily_challenges (
        user_id, challenge_id, assigned_date, progress, completed
      ) VALUES (v_uid, v_id, p_assigned_date, 0, false)
      ON CONFLICT (user_id, challenge_id, assigned_date) DO NOTHING;
    END LOOP;
  END IF;

  RETURN QUERY
  SELECT * FROM public.user_daily_challenges
  WHERE user_id = v_uid AND assigned_date = p_assigned_date;
END;
$function$;

REVOKE ALL ON FUNCTION public.assign_user_challenges(text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_user_challenges(text, text[]) TO authenticated, service_role;
