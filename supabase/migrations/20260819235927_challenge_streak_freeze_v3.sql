-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819235927 "challenge_streak_freeze_v3"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e0f23fa090f9c5730a84c943d1ce53ef of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- CHALLENGE STREAK FREEZE ("streak insurance")                        Tier 2
-- ============================================================================
-- A streak that resets to zero the first day someone is ill, travelling or just
-- busy is a punishment mechanic: the player who cared most loses the most, and
-- the usual reaction is to stop trying rather than start over.
--
--   * Freezes are EARNED, not bought -- one per 7 days of streak, capped at 3.
--   * A freeze covers exactly ONE missed day, and only once the player has a
--     streak worth protecting (>= 3 days). A two-day gap always breaks.
--   * The covered day COUNTS toward the streak. The streak is the length of the
--     unbroken chain, which is what "your streak was protected" means to the
--     person reading it; reporting a lower number after a save reads as the
--     protection not having worked.
--   * Consumption is recorded per DATE, so a day can never be covered twice and
--     repeated reads are idempotent.
--
-- The streak stays DERIVED from user_daily_challenges; this table records only
-- the exceptions, so there is no second source of truth to drift.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.challenge_streak_state (
  user_id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  freezes_available  INTEGER NOT NULL DEFAULT 0 CHECK (freezes_available >= 0),
  freezes_earned     INTEGER NOT NULL DEFAULT 0,
  freezes_used       INTEGER NOT NULL DEFAULT 0,
  frozen_dates       TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  last_earned_at     TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.challenge_streak_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user reads own streak state" ON public.challenge_streak_state;
CREATE POLICY "user reads own streak state" ON public.challenge_streak_state
  FOR SELECT USING (user_id = auth.uid());

-- Freezes are currency. A client that can UPDATE this table mints infinite
-- streak protection, so all writes go through the SECURITY DEFINER function.
REVOKE INSERT, UPDATE, DELETE ON public.challenge_streak_state FROM authenticated, anon;

CREATE OR REPLACE FUNCTION public.get_challenge_streak(p_user_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid          uuid;
  v_today        date := (now() AT TIME ZONE 'utc')::date;
  v_state        public.challenge_streak_state%ROWTYPE;
  v_days         date[];
  v_streak       int := 0;
  v_cursor       date;
  v_i            int;
  v_used_freeze  boolean := false;
  v_frozen_on    date;
  v_earn         int;
  MAX_FREEZES    constant int := 3;
  EARN_EVERY     constant int := 7;
  MIN_TO_PROTECT constant int := 3;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN v_uid := p_user_id; END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  INSERT INTO public.challenge_streak_state (user_id) VALUES (v_uid)
    ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO v_state FROM public.challenge_streak_state WHERE user_id = v_uid;

  -- Distinct DAILY completion days, newest first. Weekly ('W...') and monthly
  -- ('M...') keys are not dates and must never enter the walk.
  SELECT COALESCE(array_agg(d ORDER BY d DESC), ARRAY[]::date[])
    INTO v_days
    FROM (
      SELECT DISTINCT assigned_date::date AS d
        FROM public.user_daily_challenges
       WHERE user_id = v_uid
         AND completed = true
         AND assigned_date ~ '^\d{4}-\d{2}-\d{2}$'
         AND assigned_date::date >= v_today - 400
    ) s;

  IF array_length(v_days, 1) IS NULL THEN
    RETURN jsonb_build_object('streak', 0, 'freezesAvailable', v_state.freezes_available,
      'usedFreeze', false, 'frozenDate', null, 'nextFreezeIn', EARN_EVERY);
  END IF;

  -- Anchor at today or yesterday: a streak is not "broken" mid-day.
  IF v_days[1] = v_today THEN
    v_cursor := v_today;
  ELSIF v_days[1] = v_today - 1 THEN
    v_cursor := v_today - 1;
  ELSE
    RETURN jsonb_build_object('streak', 0, 'freezesAvailable', v_state.freezes_available,
      'usedFreeze', false, 'frozenDate', null, 'nextFreezeIn', EARN_EVERY);
  END IF;

  v_i := 1;
  LOOP
    IF v_i > array_length(v_days, 1) THEN EXIT; END IF;

    IF v_days[v_i] = v_cursor THEN
      v_streak := v_streak + 1;
      v_cursor := v_cursor - 1;
      v_i := v_i + 1;
    ELSIF NOT v_used_freeze
          AND v_streak >= MIN_TO_PROTECT
          AND v_days[v_i] = v_cursor - 1
          AND (v_state.freezes_available > 0 OR v_cursor::text = ANY(v_state.frozen_dates))
    THEN
      -- Exactly one missing day and protection is available (or this day was
      -- already covered on an earlier call, which keeps repeat reads idempotent).
      IF NOT (v_cursor::text = ANY(v_state.frozen_dates)) THEN
        UPDATE public.challenge_streak_state
           SET freezes_available = freezes_available - 1,
               freezes_used = freezes_used + 1,
               frozen_dates = array_append(frozen_dates, v_cursor::text),
               updated_at = now()
         WHERE user_id = v_uid
        RETURNING * INTO v_state;
      END IF;
      v_used_freeze := true;
      v_frozen_on := v_cursor;
      v_streak := v_streak + 1;   -- the covered day counts: the chain held
      v_cursor := v_cursor - 1;
    ELSE
      EXIT;
    END IF;
  END LOOP;

  -- Earn one freeze per EARN_EVERY days of streak, capped.
  v_earn := LEAST(v_streak / EARN_EVERY, MAX_FREEZES) - v_state.freezes_earned;
  IF v_earn > 0 THEN
    UPDATE public.challenge_streak_state
       SET freezes_available = LEAST(freezes_available + v_earn, MAX_FREEZES),
           freezes_earned = freezes_earned + v_earn,
           last_earned_at = now(), updated_at = now()
     WHERE user_id = v_uid
    RETURNING * INTO v_state;
  END IF;

  RETURN jsonb_build_object(
    'streak', v_streak,
    'freezesAvailable', v_state.freezes_available,
    'usedFreeze', v_used_freeze,
    'frozenDate', v_frozen_on,
    'nextFreezeIn', CASE WHEN v_state.freezes_available >= MAX_FREEZES
                         THEN NULL ELSE EARN_EVERY - (v_streak % EARN_EVERY) END
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.get_challenge_streak(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_challenge_streak(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- POST-APPLY ASSERTIONS
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_uid uuid; v_res jsonb; v_today date := (now() AT TIME ZONE 'utc')::date;
  v_keys text[];
BEGIN
  SELECT id INTO v_uid FROM public.profiles ORDER BY created_at LIMIT 1;
  IF v_uid IS NULL THEN RETURN; END IF;

  v_keys := ARRAY[v_today::text,(v_today-1)::text,(v_today-2)::text,
                  (v_today-3)::text,(v_today-4)::text,(v_today-5)::text];
  DELETE FROM public.user_daily_challenges
   WHERE user_id = v_uid AND challenge_id='hands_10' AND assigned_date = ANY(v_keys);
  DELETE FROM public.challenge_streak_state WHERE user_id = v_uid;

  -- Six consecutive days -> streak 6, nothing spent.
  INSERT INTO public.user_daily_challenges (user_id, challenge_id, assigned_date, progress, completed)
  SELECT v_uid,'hands_10',k,10,true FROM unnest(v_keys) k;
  v_res := public.get_challenge_streak(v_uid);
  IF (v_res->>'streak')::int <> 6 THEN RAISE EXCEPTION 'expected 6, got %', v_res; END IF;
  IF (v_res->>'usedFreeze')::boolean THEN RAISE EXCEPTION 'freeze spent with no gap: %', v_res; END IF;

  -- Hole 4 days back. The run before the gap is 3 (meets MIN_TO_PROTECT) but
  -- with nothing banked the streak must stop at 3.
  DELETE FROM public.user_daily_challenges
   WHERE user_id = v_uid AND assigned_date = (v_today-3)::text;
  UPDATE public.challenge_streak_state SET freezes_available = 0, freezes_earned = 0 WHERE user_id = v_uid;
  v_res := public.get_challenge_streak(v_uid);
  IF (v_res->>'streak')::int <> 3 THEN RAISE EXCEPTION 'expected 3 unprotected, got %', v_res; END IF;

  -- Bank one freeze: gap bridged, covered day counts, walk continues to -4/-5.
  UPDATE public.challenge_streak_state SET freezes_available = 1 WHERE user_id = v_uid;
  v_res := public.get_challenge_streak(v_uid);
  IF NOT (v_res->>'usedFreeze')::boolean THEN RAISE EXCEPTION 'freeze not spent: %', v_res; END IF;
  IF (v_res->>'streak')::int <> 6 THEN RAISE EXCEPTION 'expected bridged 6, got %', v_res; END IF;
  IF (v_res->>'frozenDate') IS NULL THEN RAISE EXCEPTION 'frozenDate not reported: %', v_res; END IF;

  -- Idempotent: a second read must not spend another freeze or change the number.
  v_res := public.get_challenge_streak(v_uid);
  IF (SELECT freezes_available FROM public.challenge_streak_state WHERE user_id=v_uid) <> 0 THEN
    RAISE EXCEPTION 'second call spent another freeze';
  END IF;
  IF (v_res->>'streak')::int <> 6 THEN RAISE EXCEPTION 'streak unstable across calls: %', v_res; END IF;

  -- A TWO-day gap must always break, however many freezes are banked.
  DELETE FROM public.user_daily_challenges
   WHERE user_id = v_uid AND assigned_date = (v_today-4)::text;
  UPDATE public.challenge_streak_state
     SET freezes_available = 3, frozen_dates = ARRAY[]::text[] WHERE user_id = v_uid;
  v_res := public.get_challenge_streak(v_uid);
  IF (v_res->>'streak')::int <> 3 THEN
    RAISE EXCEPTION 'two-day gap should break at 3, got %', v_res;
  END IF;

  DELETE FROM public.user_daily_challenges
   WHERE user_id = v_uid AND challenge_id='hands_10' AND assigned_date = ANY(v_keys);
  DELETE FROM public.challenge_streak_state WHERE user_id = v_uid;
END $$;

-- ROLLBACK
-- DROP FUNCTION IF EXISTS public.get_challenge_streak(uuid);
-- DROP TABLE IF EXISTS public.challenge_streak_state;
