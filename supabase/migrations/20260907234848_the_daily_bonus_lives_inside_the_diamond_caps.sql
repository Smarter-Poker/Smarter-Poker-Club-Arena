-- ===========================================================================
--  THE DAILY BONUS LIVES INSIDE THE DIAMOND CAPS
-- ===========================================================================
--
-- Dan, 2026-09-07, on reading the first cut: "ONE USER SHOULD NOT BE ABLE TO
-- GET 60,000 DIAMONDS. YOU NEED TO FOLLOW THE DIAMOND GUIDELINES THAT EXIST
-- NOW FOR MAX AWARDED PER DAY + ANTI FARMING GUIDELINES AS WELL."
--
-- 60,000 was the platform-wide monthly budget LINE (every player together,
-- in diamond_reward_budgets), never a per-player number. But the first cut
-- did opt the bonus out of the per-player daily cap, and that was wrong: the
-- Diamond Accounting Standard (docs/DIAMOND-ACCOUNTING-STANDARD.md, D21) says
-- every earn engine sits inside the per-user per-day cap. This puts it there.
--
-- WHAT A PLAYER CAN ACTUALLY GET, after this migration:
--
--   per claim      at most 125 diamonds        (award_diamonds_v2 daily_bonus clamp)
--   per day        at most 110 free / 150 VIP  (the platform daily cap, shared
--                                               with missions and every other
--                                               earn; counts_toward_daily_cap)
--   per month      at most 3,300 free / 4,500 VIP across every earn engine,
--                  and at most 3,750 from the daily bonus family alone
--   from the ladder itself, a player who never misses a day and has the 2x
--   streak multiplier collects about 1,150 a month, plus 300 on the VIP tile
--   and roughly 90 from four mystery tiles: under 1,600 diamonds = $16.
--
-- ANTI-FARMING, what exists and applies (nothing new invented):
--
--   one tile set per profile per Chicago day        UNIQUE (user, date, slot)
--   one grant per (user, source, event)             diamond_transactions.reference_id
--                                                    ca_daily_bonus:<user>:<date>:<slot>
--   a retried request pays nothing                  UNIQUE (user, request_id) + stored result
--   one claim in flight per player                  advisory lock in fn_ca_daily_bonus_claim
--   the diamond issuance kill switch                ca_payout_freeze scope diamond_issuance,
--                                                    honoured inside award_diamonds_v2
--   certification fixtures never claim              fn_ca_is_cert_account / fn_ca_is_fixture_account
--   the engine budget line                          diamond_reward_budgets club_arena_daily,
--                                                    DR7 warning at 100 percent
--
-- HORSES: the first cut refused them. D22 of the standard (Dan, 2026-08-27,
-- binding) says a horse is a player on every diamond path, with the engine
-- supplying the click a human makes in a browser. Eligibility now follows
-- D22. Nothing changes in practice yet: the claim needs a player JWT and the
-- horse fleet runs under service_role, so a horse claims only once the fleet
-- gains a claimer, which is the fleet programme's call and Dan's budget call
-- (1,000 horses at ~20 diamonds a day is ~20,000 a month against a 60,000
-- line).
--
-- CHESTS: the two chest days paid 60 base, which at the 1.8x / 2x streak
-- multiplier alone exceeded a free player's 110 daily cap before the mystery
-- tile. They pay 40 (72 / 80 after the multiplier), so an ordinary day fits
-- inside the cap and only a lucky mystery roll on a chest day is trimmed by
-- the ledger, which the sheet shows honestly (granted < offered).

BEGIN;

UPDATE public.diamond_reward_catalog
   SET counts_toward_daily_cap = true, updated_at = now()
 WHERE action_key = 'daily_bonus';

UPDATE public.ca_daily_bonus_calendar
   SET diamonds = 40
 WHERE streak_day IN (14, 30) AND slot = 1 AND kind = 'diamonds';

CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_eligibility(p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_user_id IS NULL THEN RETURN 'unauthenticated'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user_id) THEN RETURN 'no_profile'; END IF;
  -- Horses are players (Diamond Accounting Standard D22). Fixtures are not.
  IF public.fn_ca_is_cert_account(p_user_id) OR public.fn_ca_is_fixture_account(p_user_id) THEN
    RETURN 'fixture';
  END IF;
  RETURN 'ok';
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_daily_bonus_eligibility(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_daily_bonus_eligibility(uuid) TO service_role;

-- The sheet tells the player where they stand against the caps, computed the
-- way award_diamonds_v2 computes it, so a diamond tile can say "daily cap
-- reached" before the claim rather than after.
CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_caps(p_user_id uuid, p_is_vip boolean)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_now         timestamptz := now();
  v_today       date := (v_now AT TIME ZONE 'America/Chicago')::date;
  v_day_start   timestamptz := v_today::timestamp AT TIME ZONE 'America/Chicago';
  v_day_end     timestamptz := (v_today + 1)::timestamp AT TIME ZONE 'America/Chicago';
  v_month_start timestamptz := date_trunc('month', v_today::timestamp) AT TIME ZONE 'America/Chicago';
  v_month_end   timestamptz := (date_trunc('month', v_today::timestamp) + interval '1 month') AT TIME ZONE 'America/Chicago';
  v_daily_cap   integer := CASE WHEN p_is_vip THEN 150 ELSE 110 END;
  v_monthly_cap integer := CASE WHEN p_is_vip THEN 4500 ELSE 3300 END;
  v_family_cap  integer := 3750;
  v_daily_used  integer;
  v_month_used  integer;
  v_family_used integer;
BEGIN
  SELECT COALESCE(SUM(t.amount), 0)::int INTO v_daily_used
    FROM public.diamond_transactions t
    JOIN public.diamond_reward_catalog c ON c.action_key = t.transaction_type
   WHERE t.user_id = p_user_id AND t.amount > 0 AND c.counts_toward_daily_cap
     AND t.created_at >= v_day_start AND t.created_at < v_day_end;
  SELECT COALESCE(SUM(t.amount), 0)::int INTO v_month_used
    FROM public.diamond_transactions t
    JOIN public.diamond_reward_catalog c ON c.action_key = t.transaction_type
   WHERE t.user_id = p_user_id AND t.amount > 0 AND c.counts_toward_daily_cap
     AND t.created_at >= v_month_start AND t.created_at < v_month_end;
  SELECT COALESCE(SUM(t.amount), 0)::int INTO v_family_used
    FROM public.diamond_transactions t
   WHERE t.user_id = p_user_id AND t.amount > 0 AND t.transaction_type = 'daily_bonus'
     AND t.created_at >= v_month_start AND t.created_at < v_month_end;
  RETURN jsonb_build_object(
    'daily_cap', v_daily_cap,
    'daily_used', v_daily_used,
    'daily_remaining', GREATEST(v_daily_cap - v_daily_used, 0),
    'monthly_cap', v_monthly_cap,
    'monthly_used', v_month_used,
    'monthly_remaining', GREATEST(v_monthly_cap - v_month_used, 0),
    'bonus_monthly_cap', v_family_cap,
    'bonus_monthly_used', v_family_used,
    'bonus_monthly_remaining', GREATEST(v_family_cap - v_family_used, 0),
    'frozen', EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = 'diamond_issuance' AND f.cleared_at IS NULL)
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_daily_bonus_caps(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_daily_bonus_caps(uuid, boolean) TO service_role;

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
                              'reset_at', v_reset_at, 'tiles', '[]'::jsonb);
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

  SELECT jsonb_agg(jsonb_build_object(
           'day', d,
           'streak', v_day.streak - v_day.cycle_day + d,
           'diamonds', (SELECT LEAST(125, round(c.diamonds * public.fn_get_streak_multiplier(GREATEST(1, v_day.streak - v_day.cycle_day + d)))::integer)
                          FROM public.ca_daily_bonus_calendar c
                         WHERE c.active AND c.cycle_day = d AND c.kind = 'diamonds' AND NOT c.vip_only
                         ORDER BY c.slot LIMIT 1),
           'extras', (SELECT string_agg(c.label, ', ' ORDER BY c.slot)
                        FROM public.ca_daily_bonus_calendar c
                       WHERE c.active AND c.cycle_day = d AND c.kind <> 'diamonds'),
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

COMMIT;
