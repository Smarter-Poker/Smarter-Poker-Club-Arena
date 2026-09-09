-- 20260909211100_the_daily_bonus_pops_up_once_a_day_on_every_device.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE DAILY BONUS POPS UP ONCE A DAY, ON EVERY DEVICE.
-- (Dan, 2026-09-09: "ITS NOT SUPPOSED TO COME BACK, JUST ONE POP UP PER DAY,
--  NOT EVERYTIME YOU OPEN IT")
--
-- The "seen" mark for the entry popup lived in the browser's localStorage,
-- written when the sheet was CLOSED. Two holes against one-popup-per-day:
-- a tab closed with the sheet still open never wrote the mark, so the next
-- open showed it again; and the mark was per device, so a phone in the
-- morning and a desktop at lunch each showed it.
--
-- The mark now lives on the player's day row. `sheet_shown_at` is set the
-- first time the sheet is put in front of the player on that Chicago day,
-- from any device (the entry popup or the /bonuses page, both call
-- fn_ca_daily_bonus_mark_shown), and fn_ca_daily_bonus_status reports
-- `shown_today` so the popup never raises twice. The browser keeps its local
-- mark as a fallback for the moment the write is in flight.
--
-- No money moves. One transaction.

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE public.ca_daily_bonus_days
  ADD COLUMN IF NOT EXISTS sheet_shown_at timestamptz;

COMMENT ON COLUMN public.ca_daily_bonus_days.sheet_shown_at IS
  'First time the Daily Club Arena Bonus sheet was put in front of the player on this day, from any device. The entry popup raises only while this is NULL (one popup per day).';

-- ---------------------------------------------------------------------------
-- 1. The mark. Idempotent; the first show wins.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_mark_shown()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_day   public.ca_daily_bonus_days;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_ca_daily_bonus_mark_shown requires an authenticated caller' USING ERRCODE = '28000';
  END IF;
  IF public.fn_ca_daily_bonus_eligibility(v_uid) <> 'ok' THEN
    RETURN jsonb_build_object('success', false, 'reason', public.fn_ca_daily_bonus_eligibility(v_uid));
  END IF;
  v_day := public.fn_ca_daily_bonus_open_day(v_uid, v_today);
  UPDATE public.ca_daily_bonus_days
     SET sheet_shown_at = COALESCE(sheet_shown_at, now())
   WHERE user_id = v_uid AND bonus_date = v_today
  RETURNING * INTO v_day;
  RETURN jsonb_build_object('success', true, 'today', v_today, 'shown_at', v_day.sheet_shown_at);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_daily_bonus_mark_shown() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_daily_bonus_mark_shown() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The read side reports it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid        uuid := auth.uid();
  v_elig       text;
  v_today      date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_reset_at   timestamptz := ((now() AT TIME ZONE 'America/Chicago')::date + 1)::timestamp AT TIME ZONE 'America/Chicago';
  v_day        public.ca_daily_bonus_days;
  v_is_vip     boolean := false;
  v_caps       jsonb;
  v_tiles      jsonb;
  v_week       jsonb;
  v_next       jsonb;
  v_next_streak integer;
  v_next_cycle  integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_ca_daily_bonus_status requires an authenticated caller' USING ERRCODE = '28000';
  END IF;

  v_elig := public.fn_ca_daily_bonus_eligibility(v_uid);
  IF v_elig <> 'ok' THEN
    RETURN jsonb_build_object('eligible', false, 'reason', v_elig, 'today', v_today,
                              'reset_at', v_reset_at,
                              'seconds_to_reset', GREATEST(0, floor(extract(epoch FROM (v_reset_at - now())))::integer),
                              'shown_today', false,
                              'tiles', '[]'::jsonb);
  END IF;

  SELECT COALESCE(p.is_vip, false)
         AND (p.vip_tier = 'lifetime' OR p.vip_expires_at IS NULL OR p.vip_expires_at > now())
    INTO v_is_vip
    FROM public.profiles p WHERE p.id = v_uid;

  v_day  := public.fn_ca_daily_bonus_open_day(v_uid, v_today);
  v_caps := public.fn_ca_daily_bonus_caps(v_uid, v_is_vip);

  -- Today's tiles with their claim state. The mystery result stays hidden
  -- until it is claimed; the claim reveals it. A diamond tile the daily cap
  -- would trim is flagged so the sheet can say so before the tap.
  SELECT COALESCE(jsonb_agg(
           (t - 'mystery') || jsonb_build_object(
             'claimed', cl.id IS NOT NULL,
             'claimed_at', cl.created_at,
             'granted', cl.granted,
             'locked', (t->>'vip_only')::boolean AND NOT v_is_vip,
             'capped', cl.id IS NULL AND t->>'kind' = 'diamonds'
                       AND (t->>'diamonds')::int > (v_caps->>'daily_remaining')::int
           ) ORDER BY (t->>'slot')::int), '[]'::jsonb)
    INTO v_tiles
    FROM jsonb_array_elements(v_day.tiles) t
    LEFT JOIN public.ca_daily_bonus_claims cl
      ON cl.user_id = v_uid AND cl.bonus_date = v_today AND cl.slot = (t->>'slot')::int;

  -- The week strip. Today's entry comes from the snapshot the day was opened
  -- with, so a chest day (streak 14, 30) reads as the chest and not as the
  -- cycle-day rows it replaced. Every other day is the calendar's cycle row
  -- at the streak that day would carry.
  SELECT jsonb_agg(jsonb_build_object(
           'day', d,
           'streak', v_day.streak - v_day.cycle_day + d,
           'diamonds', CASE WHEN d = v_day.cycle_day THEN
                         (SELECT (t->>'diamonds')::int FROM jsonb_array_elements(v_day.tiles) t
                           WHERE t->>'kind' = 'diamonds' AND NOT (t->>'vip_only')::boolean
                           ORDER BY (t->>'slot')::int LIMIT 1)
                       ELSE
                         (SELECT LEAST(125, round(c.diamonds * public.fn_get_streak_multiplier(GREATEST(1, v_day.streak - v_day.cycle_day + d)))::integer)
                            FROM public.ca_daily_bonus_calendar c
                           WHERE c.active AND c.cycle_day = d AND c.kind = 'diamonds' AND NOT c.vip_only
                           ORDER BY c.slot LIMIT 1)
                       END,
           'extras', CASE WHEN d = v_day.cycle_day THEN
                         (SELECT string_agg(t->>'label', ', ' ORDER BY (t->>'slot')::int)
                            FROM jsonb_array_elements(v_day.tiles) t
                           WHERE t->>'kind' <> 'diamonds')
                       ELSE
                         (SELECT string_agg(c.label, ', ' ORDER BY c.slot)
                            FROM public.ca_daily_bonus_calendar c
                           WHERE c.active AND c.cycle_day = d AND c.kind <> 'diamonds')
                       END,
           'chest', d = v_day.cycle_day AND v_day.streak_day IS NOT NULL,
           'state', CASE WHEN d < v_day.cycle_day THEN 'done'
                         WHEN d = v_day.cycle_day THEN 'today'
                         ELSE 'upcoming' END
         ) ORDER BY d)
    INTO v_week
    FROM generate_series(1, 7) d;

  v_next_streak := v_day.streak + 1;
  v_next_cycle  := ((v_next_streak - 1) % 7) + 1;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'kind', c.kind, 'label', c.label, 'vip_only', c.vip_only, 'quantity', c.quantity,
           'diamonds', CASE WHEN c.kind = 'diamonds'
                            THEN LEAST(125, round(c.diamonds * public.fn_get_streak_multiplier(v_next_streak))::integer)
                            ELSE 0 END
         ) ORDER BY c.slot), '[]'::jsonb)
    INTO v_next
    FROM public.ca_daily_bonus_calendar c
   WHERE c.active
     AND ((EXISTS (SELECT 1 FROM public.ca_daily_bonus_calendar s WHERE s.active AND s.streak_day = v_next_streak)
             AND c.streak_day = v_next_streak)
       OR (NOT EXISTS (SELECT 1 FROM public.ca_daily_bonus_calendar s WHERE s.active AND s.streak_day = v_next_streak)
             AND c.cycle_day = v_next_cycle));

  RETURN jsonb_build_object(
    'eligible', true,
    'today', v_today,
    'reset_at', v_reset_at,
    'seconds_to_reset', GREATEST(0, floor(extract(epoch FROM (v_reset_at - now())))::integer),
    'streak', v_day.streak,
    'cycle_day', v_day.cycle_day,
    'streak_day', v_day.streak_day,
    'multiplier', public.fn_get_streak_multiplier(v_day.streak),
    'is_vip', v_is_vip,
    'claimed_today', v_day.first_claimed_at IS NOT NULL,
    'shown_today', v_day.sheet_shown_at IS NOT NULL,
    'unclaimed', (SELECT count(*) FROM jsonb_array_elements(v_tiles) x
                   WHERE NOT (x->>'claimed')::boolean AND NOT (x->>'locked')::boolean),
    'tiles', v_tiles,
    'week', v_week,
    'tomorrow', v_next,
    'caps', v_caps,
    'cents_per_diamond', 1
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_daily_bonus_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_daily_bonus_status() TO authenticated, service_role;

INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
VALUES ('fn_ca_daily_bonus_mark_shown', 'approved',
   'Marks today''s Daily Club Arena Bonus sheet as shown to the player (one popup per day, any device). Moves no value.')
ON CONFLICT (proname) DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'ca_daily_bonus_days' AND column_name = 'sheet_shown_at') THEN
    RAISE EXCEPTION 'sheet_shown_at is missing';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE proname = 'fn_ca_daily_bonus_status') NOT LIKE '%shown_today%' THEN
    RAISE EXCEPTION 'status does not report shown_today';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                  WHERE p.proname = 'fn_ca_daily_bonus_mark_shown' AND a.grantee = 'authenticated'::regrole) THEN
    RAISE EXCEPTION 'players cannot mark their own sheet shown';
  END IF;
  IF (SELECT public.fn_ca_mint_supply('diamonds'))
     <> (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) + public.fn_ca_diamond_offledger_float() THEN
    RAISE EXCEPTION 'players + float <> register after a change that moves no money';
  END IF;
END $$;

COMMIT;
