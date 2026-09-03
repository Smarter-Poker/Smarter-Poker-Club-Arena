-- ============================================================================
-- AUDIT M18 — the daily login bonus is broken four ways and holds two latent
--             money bugs. Rebuild it server-authoritatively.
-- ============================================================================
--
-- Found while fixing M17. `BonusService.claimDailyBonus` calls
-- `claim_daily_bonus(p_user_id, p_amount DEFAULT 100)` and then calls
-- `awardReward` itself. Against production:
--
--   1. GRANT. claim_daily_bonus is SECURITY INVOKER, granted to postgres and
--      service_role only. Every browser call is 42501, so the feature has never
--      worked. Same root cause as M17.
--
--   2. CONTRACT. The function returns { success, error } or { success, amount }.
--      The client reads `claimResult?.claimed` and `claimResult.new_streak` —
--      neither field exists. Even with the grant fixed, `!claimResult?.claimed`
--      would throw "Daily bonus already claimed today" on a successful claim,
--      and `(undefined - 1) % 7` would index DAILY_REWARDS with NaN.
--
--   3. TABLES. The function reads and writes `profiles.last_login_date`. The UI
--      reads `user_bonuses.daily_streak` / `.last_daily_claim`. Two different
--      tables: the displayed streak could never advance, whatever the function
--      did. `user_bonuses` currently holds 0 rows and nothing writes it.
--
--   4. DOUBLE CREDIT (latent). The function credits internally via
--      credit_player_wallet AND the client then calls awardReward. If both legs
--      were ever unblocked, every daily bonus would pay twice — once at the
--      function's p_amount default, once at the client's DAILY_REWARDS value.
--
--   5. MINT (latent). p_amount is a caller-supplied parameter. Granting the
--      existing function to `authenticated` — the obvious "fix" — would let any
--      player claim an arbitrary amount once a day.
--
-- THE SHAPE OF THE FIX
-- One SECURITY DEFINER function, no amount parameter, that owns the whole
-- transaction: streak arithmetic, the claim stamp, and exactly one credit. The
-- amount is looked up from a config table the caller cannot write. This is the
-- same rule M17 establishes — a DEFINER money function must derive its amount
-- from authoritative state and enforce its own authorization — applied to a
-- second feature.
--
-- The reward schedule moves into the database on purpose. It lived only in a
-- client constant (`DAILY_REWARDS` in BonusService.ts), which is how the
-- client's idea of the payout and the function's `p_amount DEFAULT 100` drifted
-- apart in the first place. There is now one source of truth, and the function
-- returns the amount it actually paid so the UI never has to guess.
--
-- `claim_daily_bonus` is deliberately left in place and untouched: it is still
-- reachable by service_role, and removing it is a separate decision from making
-- the player-facing path work. It should be retired once nothing calls it.
-- ============================================================================

-- 1. The reward schedule. No RLS policies and no grants to anon/authenticated:
--    a player must not be able to read-modify their own payout table. The
--    DEFINER functions below read it as the owner.
CREATE TABLE IF NOT EXISTS public.daily_bonus_rewards (
  day          integer PRIMARY KEY CHECK (day BETWEEN 1 AND 7),
  reward       numeric NOT NULL CHECK (reward > 0),
  reward_type  text    NOT NULL CHECK (reward_type IN ('chips', 'vip_points')),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.daily_bonus_rewards ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.daily_bonus_rewards FROM PUBLIC;
REVOKE ALL ON TABLE public.daily_bonus_rewards FROM anon;
REVOKE ALL ON TABLE public.daily_bonus_rewards FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.daily_bonus_rewards TO service_role;

COMMENT ON TABLE public.daily_bonus_rewards IS
  'AUDIT M18: the 7-day daily-login reward schedule. Single source of truth, '
  'previously a client-side constant. Intentionally unreadable and unwritable '
  'by anon/authenticated - it is a payout table, and fn_claim_daily_bonus reads '
  'it as the definer.';

-- Seeded to match the DAILY_REWARDS constant that was in BonusService.ts, so
-- this migration changes no payout amounts - only where they are decided.
INSERT INTO public.daily_bonus_rewards (day, reward, reward_type) VALUES
  (1,  100, 'chips'),
  (2,  150, 'chips'),
  (3,  200, 'chips'),
  (4,  300, 'chips'),
  (5,  500, 'chips'),
  (6,  200, 'vip_points'),
  (7, 1000, 'chips')
ON CONFLICT (day) DO NOTHING;

-- 2. The claim.
CREATE OR REPLACE FUNCTION public.fn_claim_daily_bonus()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid       uuid := auth.uid();
  v_row       public.user_bonuses%ROWTYPE;
  v_today     date := (now() AT TIME ZONE 'UTC')::date;
  v_last_day  date;
  v_streak    integer;
  v_day       integer;
  v_reward    numeric;
  v_type      text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_claim_daily_bonus requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;

  -- Ensure a row exists, then lock it. Doing this in two steps rather than an
  -- upsert keeps the FOR UPDATE lock on the path every caller takes, so two
  -- concurrent claims serialise here rather than racing the streak arithmetic.
  INSERT INTO public.user_bonuses (user_id, daily_streak, updated_at)
  VALUES (v_uid, 0, now())
  ON CONFLICT (user_id) DO NOTHING;

  SELECT * INTO v_row
  FROM public.user_bonuses
  WHERE user_id = v_uid
  FOR UPDATE;

  v_last_day := (v_row.last_daily_claim AT TIME ZONE 'UTC')::date;

  -- One claim per UTC day. This is the only concurrency guard that matters:
  -- the second of two simultaneous claims blocks on the lock above, then reads
  -- the stamp the first one wrote.
  IF v_last_day IS NOT NULL AND v_last_day >= v_today THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'already_claimed_today', 'streak', v_row.daily_streak);
  END IF;

  -- The streak advances only across consecutive days; any gap resets it to 1.
  -- Note this is a RESET, not a decrement: a player who misses a day starts the
  -- 7-day ladder again, which is what the UI's day-1..day-7 rendering implies.
  IF v_last_day IS NOT NULL AND v_last_day = v_today - 1 THEN
    v_streak := v_row.daily_streak + 1;
  ELSE
    v_streak := 1;
  END IF;

  v_day := ((v_streak - 1) % 7) + 1;

  SELECT reward, reward_type INTO v_reward, v_type
  FROM public.daily_bonus_rewards WHERE day = v_day;

  IF NOT FOUND THEN
    -- A missing schedule row is a deployment fault, not a player outcome. Raise
    -- so the claim rolls back and the day can still be claimed once it is fixed.
    RAISE EXCEPTION 'fn_claim_daily_bonus: no reward configured for day %', v_day
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.user_bonuses
     SET daily_streak = v_streak, last_daily_claim = now(), updated_at = now()
   WHERE user_id = v_uid;

  IF v_type = 'chips' THEN
    -- Delegate to the canonical credit primitive. public.wallets carries the
    -- Phase 4.1.6a trigger guard (guard_wallet_balance_write), which rejects
    -- balance mutations whose call stack does not name a whitelisted money RPC,
    -- so a hand-rolled UPDATE here would fail 42501 - and reimplementing the
    -- credit would fork a money path in any case.
    --
    -- The idempotency key is (user, UTC day), so a retry of the same day's
    -- claim can never pay twice even if this transaction is replayed.
    IF NOT public.atomic_credit_wallet_and_log(
         v_uid,
         v_reward,
         'bonus',
         'Daily login bonus - day ' || v_day::text,
         NULL,
         NULL,
         NULL,
         'daily_bonus:' || v_uid::text || ':' || v_today::text
       ) THEN
      RAISE EXCEPTION 'fn_claim_daily_bonus: credit failed for user %', v_uid
        USING ERRCODE = '25000';
    END IF;

  ELSIF v_type = 'vip_points' THEN
    PERFORM public.add_vip_points(v_uid, v_reward::integer);

  ELSE
    RAISE EXCEPTION 'fn_claim_daily_bonus: unsupported reward_type %', v_type
      USING ERRCODE = '22023';
  END IF;

  -- Returns everything the UI needs, so the client never recomputes the payout.
  RETURN jsonb_build_object(
    'ok', true,
    'day', v_day,
    'streak', v_streak,
    'amount', v_reward,
    'reward_type', v_type
  );
END;
$function$;

-- 3. The read side, so the UI stops deriving the schedule from a client
--    constant that can drift from what actually pays.
CREATE OR REPLACE FUNCTION public.fn_daily_bonus_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid      uuid := auth.uid();
  v_row      public.user_bonuses%ROWTYPE;
  v_today    date := (now() AT TIME ZONE 'UTC')::date;
  v_last_day date;
  v_streak   integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_daily_bonus_status requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;

  SELECT * INTO v_row FROM public.user_bonuses WHERE user_id = v_uid;

  v_streak   := COALESCE(v_row.daily_streak, 0);
  v_last_day := (v_row.last_daily_claim AT TIME ZONE 'UTC')::date;

  RETURN jsonb_build_object(
    'streak', v_streak,
    'last_claim', v_row.last_daily_claim,
    'can_claim', (v_last_day IS NULL OR v_last_day < v_today),
    -- The ladder position that WOULD be paid on the next successful claim,
    -- computed with the same reset rule as fn_claim_daily_bonus so the badge
    -- cannot disagree with the payout. Both live branches collapse to the same
    -- expression: claiming tomorrow after a claim today, and claiming now after
    -- a claim yesterday, both advance the streak by exactly one, and
    -- ((streak + 1) - 1) % 7 + 1 is (streak % 7) + 1. Only a gap resets to 1.
    'next_day', CASE
                  WHEN v_last_day IS NULL OR v_last_day < v_today - 1 THEN 1
                  ELSE (v_streak % 7) + 1
                END,
    'schedule', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'day', d.day, 'reward', d.reward, 'reward_type', d.reward_type)
             ORDER BY d.day), '[]'::jsonb)
      FROM public.daily_bonus_rewards d
    )
  );
END;
$function$;

-- Grants. `anon` is named explicitly: Supabase's ALTER DEFAULT PRIVILEGES grants
-- EXECUTE on new public functions to `anon` BY NAME, so revoking from PUBLIC
-- alone leaves it in place (the trap already hit in M7).
REVOKE ALL ON FUNCTION public.fn_claim_daily_bonus() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_claim_daily_bonus() FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_claim_daily_bonus() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_claim_daily_bonus() TO service_role;

REVOKE ALL ON FUNCTION public.fn_daily_bonus_status() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_daily_bonus_status() FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_daily_bonus_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_daily_bonus_status() TO service_role;

COMMENT ON FUNCTION public.fn_claim_daily_bonus() IS
  'AUDIT M18: claims one daily login bonus and pays it, atomically. Takes no '
  'amount parameter on purpose - the payout is read from daily_bonus_rewards, '
  'which the caller cannot write. Never add one.';

COMMENT ON FUNCTION public.fn_daily_bonus_status() IS
  'AUDIT M18: read-only daily-bonus state plus the live reward schedule, so the '
  'client never recomputes a payout it does not own.';
