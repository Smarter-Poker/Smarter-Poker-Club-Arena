-- 20260910181625_the_daily_bonus_learns_to_forgive_boost_and_gamble.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- THE DAILY CLUB ARENA BONUS, PHASE 3: multipliers, mystery, shield.
--
-- Dan, 2026-09-07: rewards include "diamonds, throwables, rabbit hunts, other
-- different things, options, multipliers, etc." Phases 0-2 are live. This is
-- the plan's phase 3, built on the same rules as phase 1: one SECURITY DEFINER
-- function owns each move, every amount is derived from state the caller
-- cannot write, every value lands in a journal the reconcilers already watch.
--
--   Streak Shield     a tile (cycle day 4, and the day 14 / day 30 chests).
--                     Claimed, it is a feature_purchases credit
--                     (feature 'streak_shield', 30 days). When a day is opened
--                     after exactly one missed day and a shield is held, the
--                     shield is spent and the streak continues.
--   Lucky multiplier  a mystery tile, when claimed, rolls 1x-5x on the server
--                     and pays its rolled prize times the roll. Never rolled in
--                     the browser; the claim reveals both.
--   Mission Boost     a tile on cycle day 7: 24 hours of 2x diamonds on Daily
--                     Missions. Stored in player_boosts. When missions pay,
--                     the EXTRA is paid through award_diamonds_v2 under the
--                     action 'daily_bonus_boost', so it sits inside the
--                     player's daily and monthly caps and files under the
--                     club_arena_daily engine like every other bonus diamond.
--
-- Nothing here mints a chip. 1 diamond = 1 cent.
-- ═══════════════════════════════════════════════════════════════════════════

-- ORDER OF WORK. Two constraints here take a SHARE ROW EXCLUSIVE lock on a
-- table the engine writes every hand: player_boosts.user_id REFERENCES
-- profiles, and ca_daily_bonus_days.shield_consumed_id REFERENCES
-- feature_purchases. A foreign key holds that lock until COMMIT (production
-- DDL policy, rule 7), so those two statements run LAST and the lock is held
-- for milliseconds, not for the whole migration. lock_timeout means a busy
-- table refuses us instead of queueing every writer behind us; if refused,
-- apply ONCE more after :03, never in a loop.

BEGIN;

SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '90s';

-- ── 1. player_boosts ────────────────────────────────────────────────────────
-- Created first because the functions below declare variables of its row type
-- (plpgsql resolves those at CREATE FUNCTION). Its foreign key to profiles is
-- added in section 1b, the last statement of the transaction.
CREATE TABLE IF NOT EXISTS public.player_boosts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL,  -- FOREIGN KEY added in section 1b, at the end
  kind             text NOT NULL CHECK (kind IN ('mission_diamonds')),
  factor           numeric(4,2) NOT NULL CHECK (factor > 1.00 AND factor <= 5.00),
  starts_at        timestamptz NOT NULL DEFAULT now(),
  ends_at          timestamptz NOT NULL,
  source           text NOT NULL DEFAULT 'daily_bonus' CHECK (source IN ('daily_bonus', 'admin')),
  claim_id         uuid REFERENCES public.ca_daily_bonus_claims(id),
  applications     integer NOT NULL DEFAULT 0,
  applied_diamonds integer NOT NULL DEFAULT 0,
  last_applied_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT player_boosts_window CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS player_boosts_user_live_idx ON public.player_boosts (user_id, ends_at DESC);
ALTER TABLE public.player_boosts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS player_boosts_owner_reads ON public.player_boosts;
CREATE POLICY player_boosts_owner_reads ON public.player_boosts FOR SELECT USING (auth.uid() = user_id);
REVOKE ALL ON public.player_boosts FROM anon, authenticated;
GRANT SELECT ON public.player_boosts TO authenticated;
COMMENT ON TABLE public.player_boosts IS 'Timed reward multipliers a player holds (Daily Club Arena Bonus phase 3). Written only by the bonus claim; read by fn_ca_daily_bonus_boost_extra when Daily Missions pay.';

-- ── 3. the calendar learns two kinds ───────────────────────────────────────
ALTER TABLE public.ca_daily_bonus_calendar DROP CONSTRAINT IF EXISTS ca_daily_bonus_calendar_kind_check;
ALTER TABLE public.ca_daily_bonus_calendar DROP CONSTRAINT IF EXISTS ca_daily_bonus_calendar_kind_shape;
ALTER TABLE public.ca_daily_bonus_calendar
  ADD CONSTRAINT ca_daily_bonus_calendar_kind_check
    CHECK (kind = ANY (ARRAY['diamonds','throwables','rabbit_hunts','time_bank','mystery','shield','boost'])),
  ADD CONSTRAINT ca_daily_bonus_calendar_kind_shape CHECK (
       (kind = 'diamonds' AND diamonds > 0 AND quantity = 0)
    OR (kind = ANY (ARRAY['throwables','rabbit_hunts','time_bank']) AND quantity > 0 AND diamonds = 0)
    OR (kind = 'mystery' AND quantity = 0 AND diamonds = 0)
    OR (kind = 'shield' AND quantity > 0 AND diamonds = 0)          -- quantity = missed days it covers
    OR (kind = 'boost'  AND quantity > 0 AND diamonds = 0));        -- quantity = hours of 2x

INSERT INTO public.ca_daily_bonus_calendar (cycle_day, streak_day, slot, kind, quantity, diamonds, vip_only, label, active)
SELECT v.* FROM (VALUES
  (4,    NULL::int, 3, 'shield', 1,  0, false, 'Streak Shield', true),
  (7,    NULL::int, 4, 'boost',  24, 0, false, 'Mission Boost', true),
  (NULL::int, 14,   4, 'shield', 1,  0, false, 'Streak Shield', true),
  (NULL::int, 30,   6, 'shield', 1,  0, false, 'Streak Shield', true)
) AS v(cycle_day, streak_day, slot, kind, quantity, diamonds, vip_only, label, active)
WHERE NOT EXISTS (
  SELECT 1 FROM public.ca_daily_bonus_calendar c
   WHERE c.kind = v.kind AND c.slot = v.slot
     AND c.cycle_day IS NOT DISTINCT FROM v.cycle_day
     AND c.streak_day IS NOT DISTINCT FROM v.streak_day);

-- ── 4. the boost's own catalog key ─────────────────────────────────────────
-- Its amount comes from metadata like daily_bonus's does (the award function
-- branch below); the catalog row carries the limits: it counts toward the
-- 110/150 daily cap, and a player cannot be paid a boost extra more than 24
-- times a day. max_per_day is per action, not per boost.
INSERT INTO public.diamond_reward_catalog (action_key, diamonds, max_per_day, counts_toward_daily_cap, lifetime, category, active)
VALUES ('daily_bonus_boost', 0, 24, true, false, 'daily', true)
ON CONFLICT (action_key) DO UPDATE
  SET max_per_day = EXCLUDED.max_per_day, counts_toward_daily_cap = true, category = 'daily', active = true;

-- ── 5. award_diamonds_v2: the boost extra rides the daily_bonus branch ─────
-- A surgical patch of the live definition: one anchor, asserted unique, so
-- nothing else in the 30 KB function can drift.
DO $patch$
DECLARE
  v_def    text := pg_get_functiondef('public.award_diamonds_v2(uuid,text,text,text,jsonb)'::regprocedure);
  v_needle text := E'    ELSIF p_action_key = ''daily_bonus'' THEN\n';
  v_repl   text := E'    ELSIF p_action_key IN (''daily_bonus'', ''daily_bonus_boost'') THEN\n';
BEGIN
  IF (length(v_def) - length(replace(v_def, v_needle, ''))) / length(v_needle) <> 1 THEN
    RAISE EXCEPTION 'award_diamonds_v2: expected exactly one daily_bonus branch anchor, found %',
      (length(v_def) - length(replace(v_def, v_needle, ''))) / length(v_needle);
  END IF;
  EXECUTE replace(v_def, v_needle, v_repl);
END $patch$;

-- ── 5b. the profile guard admits the boost extra ───────────────────────────
-- fn_guard_profile_privileged_columns whitelists money RPCs by name on the
-- call stack. Through Daily Missions the stack already carries
-- claim_daily_challenges; the boost extra is admitted in its own right so an
-- engine or operator path can pay it too. One anchor, asserted unique.
DO $patch$
DECLARE
  v_def    text := pg_get_functiondef('public.fn_guard_profile_privileged_columns()'::regprocedure);
  v_needle text := E'     OR v_stack ~ ''function (public[.])?fn_ca_daily_bonus_claim[(]''\n';
  v_repl   text := E'     OR v_stack ~ ''function (public[.])?fn_ca_daily_bonus_claim[(]''\n'
                || E'     OR v_stack ~ ''function (public[.])?fn_ca_daily_bonus_boost_extra[(]''\n';
BEGIN
  IF position('fn_ca_daily_bonus_boost_extra' IN v_def) > 0 THEN
    RETURN;   -- already admitted
  END IF;
  IF (length(v_def) - length(replace(v_def, v_needle, ''))) / length(v_needle) <> 1 THEN
    RAISE EXCEPTION 'profile guard: expected exactly one fn_ca_daily_bonus_claim anchor';
  END IF;
  EXECUTE replace(v_def, v_needle, v_repl);
END $patch$;

-- ── 6. the rolls, as functions, so a simulation calls the real thing ───────
CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_roll_mystery()
RETURNS jsonb LANGUAGE plpgsql VOLATILE
SET search_path = public, pg_temp AS $$
DECLARE v_roll numeric := random();
BEGIN
  -- Weights, in cents of expected value: 10 (40%), 25 (25%), 5 throwables
  -- (15%), 3 rabbit hunts (10%), 50 (7%), 100 (3%) = 22.9 cents expected.
  RETURN CASE
    WHEN v_roll < 0.40 THEN jsonb_build_object('kind', 'diamonds',     'diamonds', 10,  'quantity', 0)
    WHEN v_roll < 0.65 THEN jsonb_build_object('kind', 'diamonds',     'diamonds', 25,  'quantity', 0)
    WHEN v_roll < 0.80 THEN jsonb_build_object('kind', 'throwables',   'diamonds', 0,   'quantity', 5)
    WHEN v_roll < 0.90 THEN jsonb_build_object('kind', 'rabbit_hunts', 'diamonds', 0,   'quantity', 3)
    WHEN v_roll < 0.97 THEN jsonb_build_object('kind', 'diamonds',     'diamonds', 50,  'quantity', 0)
    ELSE                    jsonb_build_object('kind', 'diamonds',     'diamonds', 100, 'quantity', 0)
  END;
END $$;

CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_roll_lucky()
RETURNS integer LANGUAGE plpgsql VOLATILE
SET search_path = public, pg_temp AS $$
DECLARE v_roll numeric := random();
BEGIN
  -- The lucky multiplier on a mystery tile: 1x 55%, 2x 25%, 3x 12%, 4x 5%,
  -- 5x 3%. Expected 1.61x. It multiplies the rolled prize, and the diamond
  -- engine's 125-per-claim ceiling still applies on top.
  RETURN CASE
    WHEN v_roll < 0.55 THEN 1
    WHEN v_roll < 0.80 THEN 2
    WHEN v_roll < 0.92 THEN 3
    WHEN v_roll < 0.97 THEN 4
    ELSE 5
  END;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_daily_bonus_roll_mystery() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_ca_daily_bonus_roll_lucky() FROM PUBLIC, anon, authenticated;

-- ── 7. open_day: a held shield covers one missed day ───────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_open_day(p_user_id uuid, p_today date)
 RETURNS ca_daily_bonus_days
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row        public.ca_daily_bonus_days;
  v_yesterday  public.ca_daily_bonus_days;
  v_last       public.ca_daily_bonus_days;
  v_shield     public.feature_purchases;
  v_streak     integer;
  v_cycle_day  integer;
  v_streak_day integer;
  v_tiles      jsonb;
  v_mystery    jsonb;
  v_protected  boolean := false;
  v_shield_id  uuid := NULL;
BEGIN
  SELECT * INTO v_row FROM public.ca_daily_bonus_days
   WHERE user_id = p_user_id AND bonus_date = p_today;
  IF FOUND THEN RETURN v_row; END IF;

  -- The streak advances only across consecutive CLAIMED days. An opened but
  -- unclaimed yesterday is a gap, exactly like a day never opened.
  SELECT * INTO v_yesterday FROM public.ca_daily_bonus_days
   WHERE user_id = p_user_id AND bonus_date = p_today - 1;
  IF FOUND AND v_yesterday.first_claimed_at IS NOT NULL THEN
    v_streak := v_yesterday.streak + 1;
  ELSE
    -- PHASE 3, THE SHIELD. Exactly one missed day, and a shield in hand: the
    -- shield is spent here, at the moment the gap would have reset the
    -- streak, and the streak carries on from the last claimed day. Two missed
    -- days are a reset; a shield covers one day, never a holiday.
    SELECT * INTO v_last FROM public.ca_daily_bonus_days
     WHERE user_id = p_user_id AND bonus_date < p_today AND first_claimed_at IS NOT NULL
     ORDER BY bonus_date DESC LIMIT 1;
    IF FOUND AND v_last.bonus_date = p_today - 2 THEN
      SELECT * INTO v_shield FROM public.feature_purchases f
       WHERE f.user_id = p_user_id AND f.feature = 'streak_shield'
         AND f.uses_remaining > 0 AND (f.expires_at IS NULL OR f.expires_at > now())
       ORDER BY f.expires_at NULLS LAST, f.created_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED;
      IF FOUND THEN
        UPDATE public.feature_purchases SET uses_remaining = uses_remaining - 1 WHERE id = v_shield.id;
        v_streak    := v_last.streak + 1;
        v_protected := true;
        v_shield_id := v_shield.id;
      END IF;
    END IF;
    IF NOT v_protected THEN
      v_streak := 1;
    END IF;
  END IF;

  v_cycle_day := ((v_streak - 1) % 7) + 1;
  SELECT c.streak_day INTO v_streak_day
    FROM public.ca_daily_bonus_calendar c
   WHERE c.streak_day = v_streak AND c.active
   LIMIT 1;

  -- The mystery roll is decided when the day opens and stored with the
  -- snapshot, so a claim reveals it rather than rolling it. The lucky
  -- multiplier on top of it is rolled at the claim (phase 3).
  v_mystery := public.fn_ca_daily_bonus_roll_mystery();

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'slot', c.slot,
           'kind', c.kind,
           'label', c.label,
           'vip_only', c.vip_only,
           'quantity', c.quantity,
           'base_diamonds', c.diamonds,
           -- The diamond tile scales with the platform streak ladder. Clamped
           -- to award_diamonds_v2's 125-per-call ceiling so the sheet never
           -- shows a number the ledger would trim.
           'diamonds', CASE WHEN c.kind = 'diamonds'
                            THEN LEAST(125, round(c.diamonds * public.fn_get_streak_multiplier(v_streak))::integer)
                            ELSE 0 END,
           'mystery', CASE WHEN c.kind = 'mystery' THEN v_mystery ELSE NULL END
         ) ORDER BY c.slot), '[]'::jsonb)
    INTO v_tiles
    FROM public.ca_daily_bonus_calendar c
   WHERE c.active
     AND ((v_streak_day IS NOT NULL AND c.streak_day = v_streak_day)
       OR (v_streak_day IS NULL AND c.cycle_day = v_cycle_day));

  IF v_tiles = '[]'::jsonb THEN
    RAISE EXCEPTION 'fn_ca_daily_bonus_open_day: no calendar rows for streak % (cycle day %)', v_streak, v_cycle_day
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.ca_daily_bonus_days (user_id, bonus_date, streak, cycle_day, streak_day, tiles, streak_protected, shield_consumed_id)
  VALUES (p_user_id, p_today, v_streak, v_cycle_day, v_streak_day, v_tiles, v_protected, v_shield_id)
  ON CONFLICT (user_id, bonus_date) DO NOTHING;

  SELECT * INTO v_row FROM public.ca_daily_bonus_days
   WHERE user_id = p_user_id AND bonus_date = p_today;
  RETURN v_row;
END;
$function$;

-- ── 8. the claim: shield and boost tiles, and the lucky roll on a mystery ──
CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_claim(p_slot integer, p_request_id uuid, p_user_id uuid DEFAULT NULL::uuid, p_bonus_date date DEFAULT NULL::date, p_client jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_from       jsonb;
  v_lucky      integer := NULL;
  v_boost_id   uuid;
  v_boost_ends timestamptz;
  v_claim_id   uuid := gen_random_uuid();
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
  v_from := public.fn_ca_daily_bonus_claimed_from(p_client);
  IF p_request_id IS NULL THEN
    RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'request_id_required', NULL, v_from);
  END IF;
  IF p_slot IS NULL OR p_slot < 1 OR p_slot > 6 THEN
    RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'no_such_tile', NULL, v_from);
  END IF;

  v_elig := public.fn_ca_daily_bonus_eligibility(v_uid);
  IF v_elig <> 'ok' THEN
    RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, v_elig, NULL, v_from);
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
    RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'day_rolled_over',
             jsonb_build_object('today', v_today, 'requested', p_bonus_date), v_from)
           || jsonb_build_object('today', v_today, 'requested', p_bonus_date);
  END IF;

  v_day := public.fn_ca_daily_bonus_open_day(v_uid, v_today);

  SELECT t INTO v_tile FROM jsonb_array_elements(v_day.tiles) t WHERE (t->>'slot')::int = p_slot;
  IF v_tile IS NULL THEN
    RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'no_such_tile', NULL, v_from);
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_daily_bonus_claims
              WHERE user_id = v_uid AND bonus_date = v_today AND slot = p_slot) THEN
    RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'already_claimed', NULL, v_from);
  END IF;

  SELECT COALESCE(p.is_vip, false)
         AND (p.vip_tier = 'lifetime' OR p.vip_expires_at IS NULL OR p.vip_expires_at > now())
    INTO v_is_vip
    FROM public.profiles p WHERE p.id = v_uid;
  IF (v_tile->>'vip_only')::boolean AND NOT v_is_vip THEN
    RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'vip_only', NULL, v_from);
  END IF;

  -- Resolve what the tile pays. A mystery tile pays what was rolled when the
  -- day opened, times a lucky multiplier rolled right here, on the server,
  -- at the moment of the tap (phase 3). The browser learns both together.
  v_kind     := v_tile->>'kind';
  v_qty      := COALESCE((v_tile->>'quantity')::int, 0);
  v_diamonds := COALESCE((v_tile->>'diamonds')::int, 0);
  IF v_kind = 'mystery' THEN
    v_kind     := v_tile->'mystery'->>'kind';
    v_qty      := COALESCE((v_tile->'mystery'->>'quantity')::int, 0);
    v_diamonds := COALESCE((v_tile->'mystery'->>'diamonds')::int, 0);
    v_lucky    := public.fn_ca_daily_bonus_roll_lucky();
    v_qty      := v_qty * v_lucky;
    v_diamonds := LEAST(125, v_diamonds * v_lucky);
  END IF;

  v_ref := 'ca_daily_bonus:' || v_uid::text || ':' || v_today::text || ':' || p_slot::text;

  IF v_kind = 'diamonds' THEN
    IF v_diamonds <= 0 THEN
      RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'nothing_to_pay', NULL, v_from);
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
        'mystery', v_tile->>'kind' = 'mystery',
        'lucky', v_lucky
      ));
    IF NOT COALESCE((v_award->>'success')::boolean, false) THEN
      -- award_diamonds_v2 writes nothing on refusal, so the tile stays
      -- claimable and the player sees the ledger's own reason.
      RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot,
               COALESCE(v_award->>'reason', 'award_refused'), v_award, v_from);
    END IF;
    SELECT t.id INTO v_journal_id FROM public.diamond_transactions t
     WHERE t.user_id = v_uid AND t.reference_id = v_ref
     ORDER BY t.created_at DESC LIMIT 1;
    v_balance := (v_award->>'balance_after')::integer;
    v_granted := jsonb_build_object('kind', 'diamonds', 'diamonds', (v_award->>'awarded')::integer,
                                    'quantity', 0, 'diamond_transaction_id', v_journal_id,
                                    'balance_after', v_balance, 'lucky', v_lucky);

  ELSIF v_kind IN ('throwables', 'rabbit_hunts', 'time_bank', 'shield') THEN
    IF v_qty <= 0 THEN
      RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'nothing_to_pay', NULL, v_from);
    END IF;
    v_feature := CASE v_kind WHEN 'throwables'   THEN 'throwable'
                             WHEN 'rabbit_hunts' THEN 'rabbit_hunt'
                             WHEN 'shield'       THEN 'streak_shield'
                             ELSE 'time_bank_seconds' END;
    -- A shield keeps for a month; everything else is spent at a table within a week.
    INSERT INTO public.feature_purchases (user_id, feature, cost, usage_type, uses_remaining, expires_at, source)
    VALUES (v_uid, v_feature, 0, 'per_use', v_qty,
            now() + CASE WHEN v_kind = 'shield' THEN interval '30 days' ELSE interval '7 days' END,
            'daily_bonus')
    RETURNING id INTO v_credit_id;
    SELECT p.diamonds INTO v_balance FROM public.profiles p WHERE p.id = v_uid;
    v_granted := jsonb_build_object('kind', v_kind, 'feature', v_feature, 'quantity', v_qty, 'diamonds', 0,
                                    'feature_purchase_id', v_credit_id,
                                    'expires_at', now() + CASE WHEN v_kind = 'shield' THEN interval '30 days' ELSE interval '7 days' END,
                                    'balance_after', v_balance, 'lucky', v_lucky);

  ELSIF v_kind = 'boost' THEN
    -- 2x diamonds on Daily Missions for the tile's hours. One live boost per
    -- player: a second claim while one runs extends nothing and pays nothing.
    IF v_qty <= 0 THEN
      RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'nothing_to_pay', NULL, v_from);
    END IF;
    IF EXISTS (SELECT 1 FROM public.player_boosts b
                WHERE b.user_id = v_uid AND b.kind = 'mission_diamonds' AND b.ends_at > now()) THEN
      RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'boost_already_live', NULL, v_from);
    END IF;
    v_boost_ends := now() + make_interval(hours => v_qty);
    v_boost_id   := gen_random_uuid();          -- written after the claim row it references
    SELECT p.diamonds INTO v_balance FROM public.profiles p WHERE p.id = v_uid;
    v_granted := jsonb_build_object('kind', 'boost', 'factor', 2.00, 'hours', v_qty, 'quantity', v_qty, 'diamonds', 0,
                                    'boost_id', v_boost_id, 'ends_at', v_boost_ends,
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
    'revealed', CASE WHEN v_tile->>'kind' = 'mystery'
                     THEN (v_tile->'mystery') || jsonb_build_object('lucky', v_lucky, 'quantity', v_qty, 'diamonds', v_diamonds)
                     ELSE NULL END,
    'granted', v_granted,
    'streak', v_day.streak,
    'first_claim_of_day', v_day.first_claimed_at IS NULL
  );

  INSERT INTO public.ca_daily_bonus_claims (id, user_id, bonus_date, slot, request_id, tile, granted, result, claimed_from)
  VALUES (v_claim_id, v_uid, v_today, p_slot, p_request_id, v_tile, v_granted, v_result, v_from);

  IF v_kind = 'boost' THEN
    INSERT INTO public.player_boosts (id, user_id, kind, factor, starts_at, ends_at, source, claim_id)
    VALUES (v_boost_id, v_uid, 'mission_diamonds', 2.00, now(), v_boost_ends, 'daily_bonus', v_claim_id);
  END IF;

  UPDATE public.ca_daily_bonus_days
     SET first_claimed_at = COALESCE(first_claimed_at, now())
   WHERE user_id = v_uid AND bonus_date = v_today;

  -- The two rules. Neither can refuse; both file once per day.
  PERFORM public.fn_ca_daily_bonus_velocity_check(v_today, v_from);
  IF v_kind = 'diamonds' THEN
    PERFORM public.fn_ca_daily_bonus_budget_check(v_today);
  END IF;

  RETURN v_result;
END;
$function$;

-- ── 9. the boost pays its extra when Daily Missions pay ────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_boost_extra(p_user_id uuid, p_base integer, p_reference text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_boost  public.player_boosts;
  v_extra  integer;
  v_award  jsonb;
BEGIN
  -- Internal: EXECUTE is revoked from anon and authenticated, so only another
  -- definer (the Daily Missions claim, after it has paid the base) can reach
  -- it. The base amount is that caller's own figure; a browser never names it.
  IF p_user_id IS NULL OR COALESCE(p_base, 0) <= 0 THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_boost FROM public.player_boosts b
   WHERE b.user_id = p_user_id AND b.kind = 'mission_diamonds'
     AND b.starts_at <= now() AND b.ends_at > now()
   ORDER BY b.factor DESC, b.ends_at DESC
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v_extra := round(p_base * (v_boost.factor - 1.00))::integer;
  IF v_extra <= 0 THEN
    RETURN jsonb_build_object('boost_id', v_boost.id, 'factor', v_boost.factor, 'base', p_base,
                              'extra', 0, 'awarded', 0, 'ends_at', v_boost.ends_at);
  END IF;
  -- The extra goes through the diamond engine under its own action so it
  -- counts toward the player's 110/150 daily cap and 3,300/4,500 monthly
  -- cap, and files under club_arena_daily. award_diamonds_v2 writes nothing
  -- when it refuses, so a capped player simply gets no extra.
  v_award := public.award_diamonds_v2(
    p_user_id, 'daily_bonus_boost',
    'ca_daily_bonus:boost:' || p_user_id::text || ':' || COALESCE(p_reference, gen_random_uuid()::text),
    NULL,
    jsonb_build_object('_source', 'fn_ca_daily_bonus_boost_extra',
                       'bonus_diamonds', LEAST(125, v_extra),
                       'boost_id', v_boost.id, 'boost_factor', v_boost.factor,
                       'base', p_base, 'reference', p_reference));
  UPDATE public.player_boosts
     SET applications = applications + 1,
         applied_diamonds = applied_diamonds + COALESCE((v_award->>'awarded')::int, 0),
         last_applied_at = now()
   WHERE id = v_boost.id;
  RETURN jsonb_build_object(
    'boost_id', v_boost.id, 'factor', v_boost.factor, 'base', p_base,
    'extra', LEAST(125, v_extra),
    'awarded', COALESCE((v_award->>'awarded')::int, 0),
    'success', COALESCE((v_award->>'success')::boolean, false),
    'reason', v_award->>'reason',
    'capped', COALESCE((v_award->>'capped')::boolean, false),
    'balance_after', (v_award->>'balance_after')::int,
    'ends_at', v_boost.ends_at);
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_daily_bonus_boost_extra(uuid, integer, text) FROM PUBLIC, anon, authenticated;

-- ── 10. Daily Missions: three anchored lines, so the boost is paid there ──
DO $patch$
DECLARE
  v_def text := pg_get_functiondef('public.claim_daily_challenges_serialized_body(uuid,uuid[],uuid)'::regprocedure);
  v_a1  text := E'  VAULT_PAGE_SIZE constant integer := 100;\nBEGIN\n';
  v_r1  text := E'  v_boost jsonb := NULL;\n  VAULT_PAGE_SIZE constant integer := 100;\nBEGIN\n';
  v_a2  text := E'        ''promo_budget:daily_challenges'', ''earned''\n      );\n    END IF;\n  END IF;\n';
  v_r2  text := E'        ''promo_budget:daily_challenges'', ''earned''\n      );\n\n'
             || E'      -- DAILY CLUB ARENA BONUS, PHASE 3: a live Mission Boost pays its extra\n'
             || E'      -- through the diamond engine, inside the player''s daily and monthly caps.\n'
             || E'      v_boost := public.fn_ca_daily_bonus_boost_extra(v_uid, v_diamonds,\n'
             || E'                   ''challenge_claim_batch:'' || p_request_id::text);\n'
             || E'      IF COALESCE((v_boost->>''awarded'')::int, 0) > 0 THEN\n'
             || E'        v_diamond_balance := COALESCE((v_boost->>''balance_after'')::int, v_diamond_balance);\n'
             || E'      END IF;\n    END IF;\n  END IF;\n';
  v_a3  text := E'    ''diamondBalance'', COALESCE(v_diamond_balance, 0),\n';
  v_r3  text := E'    ''diamondBalance'', COALESCE(v_diamond_balance, 0),\n    ''boost'', v_boost,\n';
BEGIN
  IF (length(v_def) - length(replace(v_def, v_a1, ''))) / length(v_a1) <> 1 THEN RAISE EXCEPTION 'missions patch: anchor 1'; END IF;
  IF (length(v_def) - length(replace(v_def, v_a2, ''))) / length(v_a2) <> 1 THEN RAISE EXCEPTION 'missions patch: anchor 2'; END IF;
  IF (length(v_def) - length(replace(v_def, v_a3, ''))) / length(v_a3) <> 1 THEN RAISE EXCEPTION 'missions patch: anchor 3'; END IF;
  IF position('fn_ca_daily_bonus_boost_extra' in v_def) > 0 THEN RAISE EXCEPTION 'missions patch: already applied'; END IF;
  v_def := replace(v_def, v_a1, v_r1);
  v_def := replace(v_def, v_a2, v_r2);
  v_def := replace(v_def, v_a3, v_r3);
  EXECUTE v_def;
END $patch$;

-- ── 11. the read side reports the shield, the boost and a protected day ────
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
  v_shield     jsonb;
  v_boost      jsonb;
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
             'revealed', CASE WHEN cl.id IS NOT NULL THEN cl.result->'revealed' ELSE NULL END,
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

  -- PHASE 3. What the player holds: shields (unspent, unexpired credits) and
  -- a live Mission Boost, and whether a shield saved today's streak.
  SELECT jsonb_build_object(
           'held', COALESCE(sum(f.uses_remaining), 0),
           'expires_at', min(f.expires_at))
    INTO v_shield
    FROM public.feature_purchases f
   WHERE f.user_id = v_uid AND f.feature = 'streak_shield'
     AND f.uses_remaining > 0 AND (f.expires_at IS NULL OR f.expires_at > now());
  SELECT jsonb_build_object(
           'active', true, 'factor', b.factor, 'kind', b.kind,
           'ends_at', b.ends_at,
           'seconds_left', GREATEST(0, floor(extract(epoch FROM (b.ends_at - now())))::integer),
           'applied_diamonds', b.applied_diamonds)
    INTO v_boost
    FROM public.player_boosts b
   WHERE b.user_id = v_uid AND b.kind = 'mission_diamonds' AND b.starts_at <= now() AND b.ends_at > now()
   ORDER BY b.ends_at DESC LIMIT 1;

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
    'cents_per_diamond', 1,
    'shield', COALESCE(v_shield, jsonb_build_object('held', 0, 'expires_at', NULL)),
    'streak_protected', COALESCE(v_day.streak_protected, false),
    'boost', COALESCE(v_boost, jsonb_build_object('active', false))
  );
END;
$function$;

-- ── 12. the money registry knows the new movers ────────────────────────────
INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
VALUES
  ('fn_ca_daily_bonus_boost_extra', 'approved',
   'Daily Club Arena Bonus phase 3. Internal (EXECUTE revoked from anon/authenticated). Pays a live Mission Boost''s extra through award_diamonds_v2 (daily_bonus_boost, ref ca_daily_bonus:boost:...) inside the player''s daily and monthly caps. Called by claim_daily_challenges_serialized_body.'),
  ('fn_ca_daily_bonus_roll_mystery', 'approved',
   'Internal: the mystery tile roll, as a function so a simulation calls the real thing. Moves no value.'),
  ('fn_ca_daily_bonus_roll_lucky', 'approved',
   'Internal: the lucky 1x-5x multiplier rolled at claim on a mystery tile. Moves no value.')
ON CONFLICT (proname) DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes;

-- ── 2. the day remembers when a shield saved it ────────────────────────────
ALTER TABLE public.ca_daily_bonus_days
  ADD COLUMN IF NOT EXISTS streak_protected boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shield_consumed_id uuid REFERENCES public.feature_purchases(id);

-- ── 1b. the foreign key to profiles, last ──────────────────────────────────
ALTER TABLE public.player_boosts
  ADD CONSTRAINT player_boosts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

COMMIT;
