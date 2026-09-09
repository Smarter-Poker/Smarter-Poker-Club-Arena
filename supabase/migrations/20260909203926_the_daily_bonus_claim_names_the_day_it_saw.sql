-- 20260909203926_the_daily_bonus_claim_names_the_day_it_saw.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE DAILY BONUS CLAIM NAMES THE DAY IT SAW, AND THE WEEK STRIP TELLS THE
-- TRUTH ON A CHEST DAY.
-- (Dan, 2026-09-09: "full audit, enhancement and upgrade of the daily bonus
--  functionality for repeated visits daily to the club arena ... fix ANY AND
--  ALL BUGS, GAPS, STUBS, ERRORS, REGRESSIONS OR WIRING ISSUES")
--
-- TWO DEFECTS, BOTH FOUND BY READING THE LIVE FUNCTIONS AGAINST THE SHEET.
--
-- 1. A CLAIM ACROSS MIDNIGHT PAID A TILE THE PLAYER NEVER SAW.
--
--    The browser sends only a slot number. The server resolves "today" for
--    itself, so a sheet opened at 23:59 and tapped at 00:00 claimed slot N
--    of the NEW day: a different tile, at a different amount, on a streak
--    that may just have reset to 1. The sheet then reported the old tile as
--    claimed. Nothing was minted twice and nothing was lost, but the player
--    was paid for a thing they did not tap, which is the one thing a
--    hand-claimed sheet must never do.
--
--    The claim now takes the day the sheet showed (`p_bonus_date`). When it
--    is not the server's today the claim is refused with `day_rolled_over`
--    and the server's today, nothing is opened and nothing is paid, and the
--    sheet re-reads and shows the new day. The parameter defaults to NULL so
--    the horse engine's three-argument call and any client already in a
--    player's browser keep resolving to this one body.
--
--    ONE BODY, NOT TWO (20260908134818): the signature changes by DROP and
--    CREATE inside this transaction, never by a second overload.
--
-- 2. THE WEEK STRIP DESCRIBED THE WRONG DAY ON A CHEST DAY.
--
--    On streak 14 and 30 the whole day is replaced by the chest rows, but the
--    week strip in fn_ca_daily_bonus_status was built from the cycle-day rows
--    only, so on exactly the two days that matter most the strip said "+75"
--    (day 7 at 1.5x) over tiles that paid the chest. Today's entry now reads
--    from the rows the day was actually opened with.
--
-- ALSO: the claim's metadata carried `streak`, which award_diamonds_v2
-- overwrites with NULL for every action but daily_login. It now travels as
-- `bonus_streak` so the diamond journal keeps it.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

-- ---------------------------------------------------------------------------
-- 1. The claim names the day it saw.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.fn_ca_daily_bonus_claim(integer, uuid, uuid);

CREATE FUNCTION public.fn_ca_daily_bonus_claim(
  p_slot integer,
  p_request_id uuid,
  p_user_id uuid DEFAULT NULL,
  p_bonus_date date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_elig       text;
  v_today      date := (now() AT TIME ZONE 'America/Chicago')::date;
  v_day        public.ca_daily_bonus_days;
  v_is_vip     boolean := false;
  v_tile       jsonb;
  v_kind       text;
  v_qty        integer;
  v_diamonds   integer;
  v_feature    text;
  v_existing   public.ca_daily_bonus_claims;
  v_award      jsonb;
  v_credit_id  uuid;
  v_journal_id uuid;
  v_balance    integer;
  v_granted    jsonb;
  v_result     jsonb;
  v_ref        text;
BEGIN
  -- A BROWSER SPEAKS FOR ITSELF AND FOR NOBODY ELSE.
  IF v_uid IS NOT NULL AND p_user_id IS NOT NULL AND p_user_id <> v_uid THEN
    RAISE EXCEPTION 'Cannot claim a daily bonus for another player' USING ERRCODE = '42501';
  END IF;
  -- THE HORSE'S INPUT DEVICE (CLAUDE.md 10.5). A horse has no session, so the engine names the
  -- player it is acting for. Only the engine may: fn_caller_is_engine is false for any browser.
  IF v_uid IS NULL AND public.fn_caller_is_engine() THEN
    v_uid := p_user_id;
  END IF;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_ca_daily_bonus_claim requires an authenticated caller' USING ERRCODE = '28000';
  END IF;
  IF p_request_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'request_id_required');
  END IF;
  IF p_slot IS NULL OR p_slot < 1 OR p_slot > 6 THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_such_tile');
  END IF;

  v_elig := public.fn_ca_daily_bonus_eligibility(v_uid);
  IF v_elig <> 'ok' THEN
    RETURN jsonb_build_object('success', false, 'reason', v_elig);
  END IF;

  -- One claim at a time per player. Every path below runs under this lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('ca_daily_bonus:' || v_uid::text, 0));

  -- Replay: the same request id returns the stored result and pays nothing.
  SELECT * INTO v_existing FROM public.ca_daily_bonus_claims
   WHERE user_id = v_uid AND request_id = p_request_id;
  IF FOUND THEN
    RETURN v_existing.result || jsonb_build_object('idempotent', true);
  END IF;

  -- The sheet names the day it showed. A tap that arrives after Chicago
  -- midnight is refused rather than paid against a day the player never saw;
  -- the sheet re-reads and shows today.
  IF p_bonus_date IS NOT NULL AND p_bonus_date <> v_today THEN
    RETURN jsonb_build_object('success', false, 'reason', 'day_rolled_over',
                              'today', v_today, 'requested', p_bonus_date);
  END IF;

  v_day := public.fn_ca_daily_bonus_open_day(v_uid, v_today);

  SELECT t INTO v_tile FROM jsonb_array_elements(v_day.tiles) t WHERE (t->>'slot')::int = p_slot;
  IF v_tile IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'no_such_tile');
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_daily_bonus_claims
              WHERE user_id = v_uid AND bonus_date = v_today AND slot = p_slot) THEN
    RETURN jsonb_build_object('success', false, 'reason', 'already_claimed');
  END IF;

  SELECT COALESCE(p.is_vip, false)
         AND (p.vip_tier = 'lifetime' OR p.vip_expires_at IS NULL OR p.vip_expires_at > now())
    INTO v_is_vip
    FROM public.profiles p WHERE p.id = v_uid;
  IF (v_tile->>'vip_only')::boolean AND NOT v_is_vip THEN
    RETURN jsonb_build_object('success', false, 'reason', 'vip_only');
  END IF;

  -- Resolve what the tile pays. A mystery tile pays what was rolled when the
  -- day opened.
  v_kind     := v_tile->>'kind';
  v_qty      := COALESCE((v_tile->>'quantity')::int, 0);
  v_diamonds := COALESCE((v_tile->>'diamonds')::int, 0);
  IF v_kind = 'mystery' THEN
    v_kind     := v_tile->'mystery'->>'kind';
    v_qty      := COALESCE((v_tile->'mystery'->>'quantity')::int, 0);
    v_diamonds := COALESCE((v_tile->'mystery'->>'diamonds')::int, 0);
  END IF;

  v_ref := 'ca_daily_bonus:' || v_uid::text || ':' || v_today::text || ':' || p_slot::text;

  IF v_kind = 'diamonds' THEN
    IF v_diamonds <= 0 THEN
      RETURN jsonb_build_object('success', false, 'reason', 'nothing_to_pay');
    END IF;
    v_award := public.award_diamonds_v2(
      v_uid, 'daily_bonus', v_ref, NULL,
      jsonb_build_object(
        '_source', 'fn_ca_daily_bonus_claim',
        'bonus_diamonds', v_diamonds,
        'bonus_streak', v_day.streak,
        'cycle_day', v_day.cycle_day,
        'slot', p_slot,
        'vip_tile', (v_tile->>'vip_only')::boolean,
        'mystery', v_tile->>'kind' = 'mystery'
      ));
    IF NOT COALESCE((v_award->>'success')::boolean, false) THEN
      -- award_diamonds_v2 writes nothing on refusal, so the tile stays
      -- claimable and the player sees the ledger's own reason.
      RETURN jsonb_build_object('success', false, 'reason', COALESCE(v_award->>'reason', 'award_refused'),
                                'detail', v_award);
    END IF;
    SELECT t.id INTO v_journal_id FROM public.diamond_transactions t
     WHERE t.user_id = v_uid AND t.reference_id = v_ref
     ORDER BY t.created_at DESC LIMIT 1;
    v_balance := (v_award->>'balance_after')::integer;
    v_granted := jsonb_build_object('kind', 'diamonds', 'diamonds', (v_award->>'awarded')::integer,
                                    'quantity', 0, 'diamond_transaction_id', v_journal_id,
                                    'balance_after', v_balance);

  ELSIF v_kind IN ('throwables', 'rabbit_hunts', 'time_bank') THEN
    IF v_qty <= 0 THEN
      RETURN jsonb_build_object('success', false, 'reason', 'nothing_to_pay');
    END IF;
    v_feature := CASE v_kind WHEN 'throwables' THEN 'throwable'
                             WHEN 'rabbit_hunts' THEN 'rabbit_hunt'
                             ELSE 'time_bank_seconds' END;
    INSERT INTO public.feature_purchases (user_id, feature, cost, usage_type, uses_remaining, expires_at, source)
    VALUES (v_uid, v_feature, 0, 'per_use', v_qty, now() + interval '7 days', 'daily_bonus')
    RETURNING id INTO v_credit_id;
    SELECT p.diamonds INTO v_balance FROM public.profiles p WHERE p.id = v_uid;
    v_granted := jsonb_build_object('kind', v_kind, 'feature', v_feature, 'quantity', v_qty, 'diamonds', 0,
                                    'feature_purchase_id', v_credit_id,
                                    'expires_at', now() + interval '7 days',
                                    'balance_after', v_balance);
  ELSE
    RAISE EXCEPTION 'fn_ca_daily_bonus_claim: unsupported tile kind %', v_kind USING ERRCODE = '22023';
  END IF;

  v_result := jsonb_build_object(
    'success', true,
    'idempotent', false,
    'slot', p_slot,
    'bonus_date', v_today,
    'tile', v_tile - 'mystery',
    'revealed', CASE WHEN v_tile->>'kind' = 'mystery' THEN v_tile->'mystery' ELSE NULL END,
    'granted', v_granted,
    'streak', v_day.streak,
    'first_claim_of_day', v_day.first_claimed_at IS NULL
  );

  INSERT INTO public.ca_daily_bonus_claims (user_id, bonus_date, slot, request_id, tile, granted, result)
  VALUES (v_uid, v_today, p_slot, p_request_id, v_tile, v_granted, v_result);

  UPDATE public.ca_daily_bonus_days
     SET first_claimed_at = COALESCE(first_claimed_at, now())
   WHERE user_id = v_uid AND bonus_date = v_today;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_ca_daily_bonus_claim(integer, uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_daily_bonus_claim(integer, uuid, uuid, date) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_ca_daily_bonus_claim(integer, uuid, uuid, date) IS
  'Claims one daily-bonus tile. p_user_id is the horse''s input device (CLAUDE.md 10.5): only the engine may name a player, a browser speaks for its own session and passing another id is refused. p_bonus_date is the day the sheet showed: a claim that arrives after Chicago midnight is refused with day_rolled_over rather than paid against a tile the player never saw.';

-- ---------------------------------------------------------------------------
-- 2. The week strip reads today's entry from the rows the day opened with.
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

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_n integer; v_body text;
BEGIN
  -- exactly one body, so two cannot drift
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_daily_bonus_claim';
  IF v_n <> 1 THEN RAISE EXCEPTION '% overloads of the daily bonus claim exist; two bodies drift', v_n; END IF;

  SELECT prosrc INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_daily_bonus_claim';

  -- the day check sits before anything is opened or paid
  IF position('day_rolled_over' IN v_body) = 0
     OR position('day_rolled_over' IN v_body) > position('fn_ca_daily_bonus_open_day' IN v_body) THEN
    RAISE EXCEPTION 'the day check must run before the day is opened';
  END IF;
  -- every rule the horse migration pinned survives
  IF v_body NOT LIKE '%IF v_uid IS NULL AND public.fn_caller_is_engine() THEN%'
     OR v_body NOT LIKE '%Cannot claim a daily bonus for another player%'
     OR v_body NOT LIKE '%requires an authenticated caller%'
     OR v_body NOT LIKE '%already_claimed%' OR v_body NOT LIKE '%vip_only%'
     OR v_body NOT LIKE '%fn_ca_daily_bonus_eligibility%' OR v_body NOT LIKE '%idempotent%'
     OR v_body NOT LIKE '%award_diamonds_v2%' THEN
    RAISE EXCEPTION 'a rule of the daily bonus was lost in the rewrite';
  END IF;
  -- the browser call shape (two named args) and the engine shape (three) still resolve
  IF to_regprocedure('public.fn_ca_daily_bonus_claim(integer, uuid, uuid, date)') IS NULL THEN
    RAISE EXCEPTION 'the new signature does not exist';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                  WHERE p.proname = 'fn_ca_daily_bonus_claim' AND a.grantee = 'authenticated'::regrole) THEN
    RAISE EXCEPTION 'players can no longer claim their own daily bonus';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                  WHERE p.proname = 'fn_ca_daily_bonus_status' AND a.grantee = 'authenticated'::regrole) THEN
    RAISE EXCEPTION 'players can no longer read their own daily bonus';
  END IF;

  IF (SELECT public.fn_ca_mint_supply('diamonds'))
     <> (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) + public.fn_ca_diamond_offledger_float() THEN
    RAISE EXCEPTION 'players + float <> register after a change that moves no money';
  END IF;
END $$;

INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
VALUES ('fn_ca_daily_bonus_claim', 'approved',
   'Daily Club Arena Bonus claim. Diamonds via award_diamonds_v2 (daily_bonus, ref ca_daily_bonus:*), consumables as feature_purchases source=daily_bonus at cost 0. Never chips. Refuses a tap that names a day other than today (day_rolled_over).')
ON CONFLICT (proname) DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes;

COMMIT;
