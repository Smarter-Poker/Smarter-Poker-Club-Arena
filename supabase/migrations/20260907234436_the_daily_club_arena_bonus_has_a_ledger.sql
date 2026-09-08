-- ===========================================================================
--  THE DAILY CLUB ARENA BONUS HAS A LEDGER
-- ===========================================================================
--
-- Phase 1 of the Daily Club Arena Bonus (Dan, 2026-09-07): a reward sheet
-- every player sees on entering Club Arena, one tile per reward, each tile
-- claimed by hand, PokerBros style, gone at midnight. Phase 0 (20260907232514)
-- dropped the chip ladder this replaces.
--
-- THE TWO RULES EVERYTHING BELOW OBEYS
--
--   1. Nothing ever earns chips, only diamonds (Dan, 2026-09-05). A tile pays
--      diamonds, or a consumable the player would otherwise buy with diamonds
--      (throwables, rabbit hunts, time bank). Never a chip.
--   2. 1 diamond = 1 cent, 1 chip = 1 dollar (Dan, 2026-09-07). Every amount
--      in the calendar is cents. A full free week at launch is 133 diamonds,
--      $1.33, before streak scaling; the VIP tile adds 10 cents a day.
--
-- WHAT THIS BUILDS
--
--   ca_daily_bonus_calendar   the ladder, as data. One row per (day, slot).
--                             cycle_day 1..7 repeats weekly; streak_day rows
--                             (14, 30) override a whole day when the streak
--                             lands on them. Players cannot read it: it is a
--                             payout table. History-tracked, like the missions
--                             catalog.
--   ca_daily_bonus_days       one row per (player, Chicago date): the streak
--                             on that day and a SNAPSHOT of the tiles offered,
--                             taken the first time the sheet is opened, so an
--                             operator editing the calendar at noon changes
--                             tomorrow and never what a player was shown.
--                             The mystery roll is fixed here too.
--   ca_daily_bonus_claims     one row per claimed tile, append-only, with the
--                             request id (replay-safe) and exactly what was
--                             granted (the diamond journal row, the
--                             feature_purchases credit).
--   fn_ca_daily_bonus_status  the read side for the sheet.
--   fn_ca_daily_bonus_claim   the write side. One SECURITY DEFINER function
--                             owns the whole claim: authorization, the lock,
--                             replay, eligibility, the grant, the receipt.
--
-- HOW IT PAYS
--
--   Diamonds go through award_diamonds_v2 with action 'daily_bonus', which
--   already exists in that function (amount from metadata, clamped to 125 per
--   call, 3,750 per player per month) and had a zero-diamond placeholder in
--   the catalog waiting for exactly this. The reference id is
--   ca_daily_bonus:<user>:<date>:<slot>, which is how the earn ledger files
--   the row under its own budget line, club_arena_daily (60,000 diamonds a
--   month = $600), and how the hourly diamond snapshot explains it.
--
--   Consumables are rows in feature_purchases with cost 0, which is the table
--   fn_use_throwable_v2, fn_consume_rabbit_hunt_v2 and fn_consume_time_bank
--   already spend from before charging a diamond. A new `source` column
--   ('purchase' | 'daily_bonus') keeps granted credits out of revenue sums.
--   Credits expire seven days after the claim so they get thrown, hunted and
--   used at tables rather than hoarded.
--
--   The diamond tile scales with fn_get_streak_multiplier(streak): 1.0, then
--   1.2 at 3 days, 1.5 at 7, 1.8 at 14, 2.0 at 30. That is the ladder the
--   profile page already mirrors, so the number a player reads is the number
--   the sheet pays.
--
-- WHO MAY CLAIM
--
--   A signed-in profile that is not a horse, not a certification fixture and
--   not a cert account. Horses are simulated players; 1,000 of them claiming
--   would spend the budget line before breakfast.
--
-- DAY BOUNDARY
--
--   America/Chicago, the same day the diamonds standard uses. Tiles not
--   claimed by midnight are gone; the streak counts a day only if at least
--   one tile was claimed on it, and a gap resets it to 1. A streak shield is
--   phase 3.
--
-- One transaction, per the production DDL policy in CLAUDE.md section 2.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. feature_purchases learns where a credit came from
-- ---------------------------------------------------------------------------
ALTER TABLE public.feature_purchases
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'purchase';

ALTER TABLE public.feature_purchases DROP CONSTRAINT IF EXISTS feature_purchases_source_check;
ALTER TABLE public.feature_purchases
  ADD CONSTRAINT feature_purchases_source_check
  CHECK (source IN ('purchase', 'daily_bonus', 'promo_vault', 'shop', 'admin'));

COMMENT ON COLUMN public.feature_purchases.source IS
  'Where the credit came from. purchase = paid in diamonds (cost > 0); '
  'daily_bonus = granted by fn_ca_daily_bonus_claim at cost 0. Revenue reports '
  'must filter on source, not on cost.';

CREATE INDEX IF NOT EXISTS feature_purchases_source_idx
  ON public.feature_purchases (source, created_at DESC);

-- ---------------------------------------------------------------------------
-- 2. The calendar (a payout table: no player may read it)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ca_daily_bonus_calendar (
  id           bigserial PRIMARY KEY,
  cycle_day    integer CHECK (cycle_day BETWEEN 1 AND 7),
  streak_day   integer CHECK (streak_day >= 8),
  slot         integer NOT NULL CHECK (slot BETWEEN 1 AND 6),
  kind         text    NOT NULL CHECK (kind IN ('diamonds', 'throwables', 'rabbit_hunts', 'time_bank', 'mystery')),
  quantity     integer NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  diamonds     integer NOT NULL DEFAULT 0 CHECK (diamonds BETWEEN 0 AND 125),
  vip_only     boolean NOT NULL DEFAULT false,
  label        text    NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ca_daily_bonus_calendar_one_axis CHECK ((cycle_day IS NULL) <> (streak_day IS NULL)),
  CONSTRAINT ca_daily_bonus_calendar_kind_shape CHECK (
    (kind = 'diamonds'  AND diamonds > 0 AND quantity = 0) OR
    (kind IN ('throwables', 'rabbit_hunts', 'time_bank') AND quantity > 0 AND diamonds = 0) OR
    (kind = 'mystery'   AND quantity = 0 AND diamonds = 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ca_daily_bonus_calendar_cycle_slot
  ON public.ca_daily_bonus_calendar (cycle_day, slot) WHERE cycle_day IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ca_daily_bonus_calendar_streak_slot
  ON public.ca_daily_bonus_calendar (streak_day, slot) WHERE streak_day IS NOT NULL;

ALTER TABLE public.ca_daily_bonus_calendar ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_daily_bonus_calendar FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ca_daily_bonus_calendar TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.ca_daily_bonus_calendar_id_seq TO service_role;

COMMENT ON TABLE public.ca_daily_bonus_calendar IS
  'The Daily Club Arena Bonus ladder. cycle_day rows repeat weekly; a '
  'streak_day row set replaces the whole day when a streak lands on it. '
  'diamonds are cents (1 diamond = 1 cent). Unreadable by players: '
  'fn_ca_daily_bonus_status projects it, fn_ca_daily_bonus_claim pays it. '
  'Amounts are Dan''s to set; edit the rows, never the functions.';

CREATE TABLE IF NOT EXISTS public.ca_daily_bonus_calendar_history (
  id          bigserial PRIMARY KEY,
  op          text NOT NULL,
  old_row     jsonb,
  new_row     jsonb,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  db_role     text NOT NULL DEFAULT current_user
);
ALTER TABLE public.ca_daily_bonus_calendar_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_daily_bonus_calendar_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.ca_daily_bonus_calendar_history TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_calendar_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO public.ca_daily_bonus_calendar_history (op, old_row, new_row)
  VALUES (TG_OP,
          CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END,
          CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_daily_bonus_calendar_history() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_ca_daily_bonus_calendar_history ON public.ca_daily_bonus_calendar;
CREATE TRIGGER trg_ca_daily_bonus_calendar_history
  BEFORE INSERT OR UPDATE OR DELETE ON public.ca_daily_bonus_calendar
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_daily_bonus_calendar_history();

-- The launch ladder. Diamonds are cents. THESE NUMBERS ARE DAN'S (CLAUDE.md
-- 10.9): gathered here so a change is a data edit.
INSERT INTO public.ca_daily_bonus_calendar (cycle_day, streak_day, slot, kind, quantity, diamonds, vip_only, label) VALUES
  (1, NULL, 1, 'diamonds',     0,   5, false, 'Diamonds'),
  (1, NULL, 2, 'throwables',   2,   0, false, 'Throwables'),
  (1, NULL, 5, 'diamonds',     0,  10, true,  'VIP Bonus'),
  (2, NULL, 1, 'diamonds',     0,   8, false, 'Diamonds'),
  (2, NULL, 2, 'rabbit_hunts', 1,   0, false, 'Rabbit Hunt'),
  (2, NULL, 5, 'diamonds',     0,  10, true,  'VIP Bonus'),
  (3, NULL, 1, 'diamonds',     0,  10, false, 'Diamonds'),
  (3, NULL, 2, 'throwables',   3,   0, false, 'Throwables'),
  (3, NULL, 3, 'time_bank',    3,   0, false, 'Time Bank'),
  (3, NULL, 5, 'diamonds',     0,  10, true,  'VIP Bonus'),
  (4, NULL, 1, 'diamonds',     0,  15, false, 'Diamonds'),
  (4, NULL, 2, 'rabbit_hunts', 2,   0, false, 'Rabbit Hunts'),
  (4, NULL, 5, 'diamonds',     0,  10, true,  'VIP Bonus'),
  (5, NULL, 1, 'diamonds',     0,  20, false, 'Diamonds'),
  (5, NULL, 2, 'throwables',   5,   0, false, 'Throwables'),
  (5, NULL, 3, 'rabbit_hunts', 2,   0, false, 'Rabbit Hunts'),
  (5, NULL, 5, 'diamonds',     0,  10, true,  'VIP Bonus'),
  (6, NULL, 1, 'diamonds',     0,  25, false, 'Diamonds'),
  (6, NULL, 2, 'mystery',      0,   0, false, 'Mystery Tile'),
  (6, NULL, 5, 'diamonds',     0,  10, true,  'VIP Bonus'),
  (7, NULL, 1, 'diamonds',     0,  50, false, 'Diamonds'),
  (7, NULL, 2, 'rabbit_hunts', 5,   0, false, 'Rabbit Hunts'),
  (7, NULL, 3, 'throwables',   5,   0, false, 'Throwables'),
  (7, NULL, 5, 'diamonds',     0,  10, true,  'VIP Bonus'),
  -- Chest days: the whole day is replaced when the streak lands here.
  (NULL, 14, 1, 'diamonds',     0,  60, false, 'Two Week Chest'),
  (NULL, 14, 2, 'mystery',      0,   0, false, 'Mystery Tile'),
  (NULL, 14, 3, 'rabbit_hunts', 5,   0, false, 'Rabbit Hunts'),
  (NULL, 14, 5, 'diamonds',     0,  10, true,  'VIP Bonus'),
  (NULL, 30, 1, 'diamonds',     0,  60, false, 'Thirty Day Chest'),
  (NULL, 30, 2, 'mystery',      0,   0, false, 'Mystery Tile'),
  (NULL, 30, 3, 'rabbit_hunts', 10,  0, false, 'Rabbit Hunts'),
  (NULL, 30, 4, 'throwables',   10,  0, false, 'Throwables'),
  (NULL, 30, 5, 'diamonds',     0,  10, true,  'VIP Bonus');

-- ---------------------------------------------------------------------------
-- 3. Days and claims
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ca_daily_bonus_days (
  user_id          uuid    NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  bonus_date       date    NOT NULL,
  streak           integer NOT NULL CHECK (streak >= 1),
  cycle_day        integer NOT NULL CHECK (cycle_day BETWEEN 1 AND 7),
  streak_day       integer,
  tiles            jsonb   NOT NULL,
  opened_at        timestamptz NOT NULL DEFAULT now(),
  first_claimed_at timestamptz,
  PRIMARY KEY (user_id, bonus_date)
);
CREATE INDEX IF NOT EXISTS ca_daily_bonus_days_date_idx ON public.ca_daily_bonus_days (bonus_date);
ALTER TABLE public.ca_daily_bonus_days ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_daily_bonus_days FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.ca_daily_bonus_days TO service_role;

COMMENT ON TABLE public.ca_daily_bonus_days IS
  'One row per player per Chicago date, written the first time the sheet is '
  'opened: the streak that day, and the tiles offered as a snapshot of the '
  'calendar (with the mystery roll already decided). first_claimed_at is what '
  'makes the day count toward the streak. Read through fn_ca_daily_bonus_status.';

CREATE TABLE IF NOT EXISTS public.ca_daily_bonus_claims (
  id            uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid    NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  bonus_date    date    NOT NULL,
  slot          integer NOT NULL,
  request_id    uuid    NOT NULL,
  tile          jsonb   NOT NULL,
  granted       jsonb   NOT NULL,
  result        jsonb   NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, bonus_date, slot),
  UNIQUE (user_id, request_id),
  FOREIGN KEY (user_id, bonus_date) REFERENCES public.ca_daily_bonus_days (user_id, bonus_date) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ca_daily_bonus_claims_date_idx ON public.ca_daily_bonus_claims (bonus_date, created_at);
ALTER TABLE public.ca_daily_bonus_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_daily_bonus_claims FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.ca_daily_bonus_claims TO service_role;

COMMENT ON TABLE public.ca_daily_bonus_claims IS
  'Append-only. One row per claimed tile: the request id (a replay returns '
  'the stored result and pays nothing), the tile as offered, and what was '
  'granted (diamond journal id or feature_purchases credit id).';

CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_claims_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION 'ca_daily_bonus_claims is append-only (% refused)', TG_OP
    USING ERRCODE = '55000';
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_daily_bonus_claims_append_only() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_ca_daily_bonus_claims_append_only ON public.ca_daily_bonus_claims;
CREATE TRIGGER trg_ca_daily_bonus_claims_append_only
  BEFORE UPDATE OR DELETE ON public.ca_daily_bonus_claims
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_daily_bonus_claims_append_only();

-- ---------------------------------------------------------------------------
-- 4. The diamond side: catalog row, budget line, engine classification
-- ---------------------------------------------------------------------------
-- award_diamonds_v2 already carries a 'daily_bonus' branch: amount from
-- metadata.bonus_diamonds, clamped to 125 per call and 3,750 per player per
-- month. The catalog row was a 0-diamond placeholder at max_per_day 1. A day
-- can now pay up to three diamond tiles (ladder, VIP, mystery), and the bonus
-- is a fixed budgeted grant that does not eat into the 110/150 mission cap.
UPDATE public.diamond_reward_catalog
   SET diamonds = 0,
       max_per_day = 4,
       counts_toward_daily_cap = false,
       lifetime = false,
       category = 'daily',
       active = true,
       updated_at = now()
 WHERE action_key = 'daily_bonus';

INSERT INTO public.diamond_reward_catalog (action_key, diamonds, max_per_day, counts_toward_daily_cap, lifetime, category, active)
SELECT 'daily_bonus', 0, 4, false, false, 'daily', true
 WHERE NOT EXISTS (SELECT 1 FROM public.diamond_reward_catalog WHERE action_key = 'daily_bonus');

INSERT INTO public.diamond_reward_budgets (period, engine, budget_diamonds, spent_diamonds, updated_at)
VALUES ('2026-09', 'club_arena_daily', 60000, 0, now()),
       ('2026-10', 'club_arena_daily', 60000, 0, now())
ON CONFLICT (period, engine) DO UPDATE SET budget_diamonds = EXCLUDED.budget_diamonds, updated_at = now();

-- The earn ledger files a journal row under an engine by its reference id
-- prefix. ca_daily_bonus:<user>:<date>:<slot> gets its own line.
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_engine_of(p_type text, p_transaction_type text, p_source text, p_description text, p_reference_id text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT CASE
        WHEN starts_with(p_reference_id, 'ca_daily_bonus:')   THEN 'club_arena_daily'
        WHEN starts_with(p_reference_id, 'trivia_tourn_')     THEN 'trivia_tournaments'
        WHEN starts_with(p_reference_id, 'trivia_session_')   THEN 'trivia'
        WHEN starts_with(p_reference_id, 'trivia_wheel_')     THEN 'trivia'
        WHEN starts_with(p_reference_id, 'challenge_claim')   THEN 'daily_challenges'
        WHEN starts_with(p_reference_id, 'daily_mission_milestones:') THEN 'daily_missions'
        WHEN starts_with(p_reference_id, 'daily-missions-historical-multiplier:') THEN 'daily_missions'
        WHEN starts_with(p_reference_id, 'daily_mission_')    THEN 'daily_missions'
        WHEN starts_with(p_reference_id, 'streak_milestone_') THEN 'share_streak'
        WHEN starts_with(p_reference_id, 'streak_')           THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'signup:')           THEN 'signup'
        WHEN starts_with(p_reference_id, 'easter_egg_')       THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'video_favorite_')   THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'vip_stipend_')      THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'hotd_')             THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'progress_')         THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'customization-cert-fund') THEN 'cert_fixture'
        WHEN p_source = 'complete_daily_challenge' THEN 'memory_game'
        WHEN p_source = 'handle_new_user'          THEN 'signup'
        WHEN p_source = 'union'                    THEN 'union_grant'
        WHEN p_source = 'the_mint'                 THEN 'mint'
        WHEN COALESCE(p_transaction_type, p_type) IN (
                'referral_bonus', 'referral_bonus_reversal', 'referral_qualified',
                'referral_referee', 'referral_vip_conversion')             THEN 'referrals'
        WHEN COALESCE(p_transaction_type, p_type) = 'signup_bonus'         THEN 'signup'
        WHEN COALESCE(p_transaction_type, p_type) = 'union_grant'          THEN 'union_grant'
        WHEN COALESCE(p_transaction_type, p_type) IN (
                'pvp_refund', 'pvp_win', 'pvp_tie_refund', 'trivia_run',
                'trivia_daily_bonus', 'daily_trivia', 'trivia_reward',
                'trivia_prize_wheel', 'endless_reward', 'survival_reward',
                'mixed_reward', 'time_attack_reward', 'trivia_double_win')  THEN 'trivia'
        WHEN COALESCE(p_transaction_type, p_type) IN (
                'tournament_prize', 'tournament_entry_refund',
                'tournament_cancel_refund')                                THEN 'trivia_tournaments'
        WHEN COALESCE(p_transaction_type, p_type) IN ('daily_challenge_claim') THEN 'daily_challenges'
        WHEN COALESCE(p_transaction_type, p_type) IN ('daily_mission_milestone', 'daily_mission_reward') THEN 'daily_missions'
        WHEN COALESCE(p_transaction_type, p_type) = 'streak_reward'        THEN 'share_streak'
        WHEN COALESCE(p_transaction_type, p_type) IN (
                'daily_login', 'easter_egg', 'training_reward',
                'video_favorite', 'vip_stipend')                           THEN 'catalog_v2'
        WHEN COALESCE(p_transaction_type, p_type) IN ('credit', 'earn', 'bonus') THEN 'legacy_credit'
        WHEN p_description LIKE 'Diamond Rewards v2:%'                      THEN 'catalog_v2'
        ELSE 'other'
    END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Eligibility, in one place
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_eligibility(p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_is_horse boolean;
BEGIN
  IF p_user_id IS NULL THEN RETURN 'unauthenticated'; END IF;
  SELECT COALESCE(p.is_horse, false) INTO v_is_horse FROM public.profiles p WHERE p.id = p_user_id;
  IF NOT FOUND THEN RETURN 'no_profile'; END IF;
  IF v_is_horse THEN RETURN 'horse'; END IF;
  IF public.fn_ca_is_cert_account(p_user_id) OR public.fn_ca_is_fixture_account(p_user_id) THEN
    RETURN 'fixture';
  END IF;
  RETURN 'ok';
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_daily_bonus_eligibility(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_daily_bonus_eligibility(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 6. Opening a day: the streak and the tile snapshot
-- ---------------------------------------------------------------------------
-- Internal. Not granted to any browser role; the two RPCs below call it.
CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_open_day(p_user_id uuid, p_today date)
RETURNS public.ca_daily_bonus_days
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_row        public.ca_daily_bonus_days;
  v_yesterday  public.ca_daily_bonus_days;
  v_streak     integer;
  v_cycle_day  integer;
  v_streak_day integer;
  v_tiles      jsonb;
  v_roll       numeric;
  v_mystery    jsonb;
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
    v_streak := 1;
  END IF;

  v_cycle_day := ((v_streak - 1) % 7) + 1;
  SELECT c.streak_day INTO v_streak_day
    FROM public.ca_daily_bonus_calendar c
   WHERE c.streak_day = v_streak AND c.active
   LIMIT 1;

  -- The mystery roll is decided when the day opens and stored with the
  -- snapshot, so a claim reveals it rather than rolling it. Weights, in
  -- cents of expected value: 10 (40%), 25 (25%), 5 throwables (15%),
  -- 3 rabbit hunts (10%), 50 (7%), 100 (3%) = 22.9 cents expected.
  v_roll := random();
  v_mystery := CASE
    WHEN v_roll < 0.40 THEN jsonb_build_object('kind', 'diamonds',     'diamonds', 10,  'quantity', 0)
    WHEN v_roll < 0.65 THEN jsonb_build_object('kind', 'diamonds',     'diamonds', 25,  'quantity', 0)
    WHEN v_roll < 0.80 THEN jsonb_build_object('kind', 'throwables',   'diamonds', 0,   'quantity', 5)
    WHEN v_roll < 0.90 THEN jsonb_build_object('kind', 'rabbit_hunts', 'diamonds', 0,   'quantity', 3)
    WHEN v_roll < 0.97 THEN jsonb_build_object('kind', 'diamonds',     'diamonds', 50,  'quantity', 0)
    ELSE                    jsonb_build_object('kind', 'diamonds',     'diamonds', 100, 'quantity', 0)
  END;

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

  INSERT INTO public.ca_daily_bonus_days (user_id, bonus_date, streak, cycle_day, streak_day, tiles)
  VALUES (p_user_id, p_today, v_streak, v_cycle_day, v_streak_day, v_tiles)
  ON CONFLICT (user_id, bonus_date) DO NOTHING;

  SELECT * INTO v_row FROM public.ca_daily_bonus_days
   WHERE user_id = p_user_id AND bonus_date = p_today;
  RETURN v_row;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_daily_bonus_open_day(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_daily_bonus_open_day(uuid, date) TO service_role;

-- ---------------------------------------------------------------------------
-- 7. The read side
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

  v_day := public.fn_ca_daily_bonus_open_day(v_uid, v_today);

  -- Today's tiles with their claim state. The mystery result stays hidden
  -- until it is claimed; the claim reveals it.
  SELECT COALESCE(jsonb_agg(
           (t - 'mystery') || jsonb_build_object(
             'claimed', cl.id IS NOT NULL,
             'claimed_at', cl.created_at,
             'granted', cl.granted,
             'locked', (t->>'vip_only')::boolean AND NOT v_is_vip
           ) ORDER BY (t->>'slot')::int), '[]'::jsonb)
    INTO v_tiles
    FROM jsonb_array_elements(v_day.tiles) t
    LEFT JOIN public.ca_daily_bonus_claims cl
      ON cl.user_id = v_uid AND cl.bonus_date = v_today AND cl.slot = (t->>'slot')::int;

  -- The week strip: the seven days of the cycle this streak is in, each with
  -- the diamond tile it pays at the streak it would have.
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

  -- Tomorrow's preview assumes today gets claimed.
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
    'cents_per_diamond', 1
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_daily_bonus_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_daily_bonus_status() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. The write side
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_claim(p_slot integer, p_request_id uuid)
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
BEGIN
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
        'streak', v_day.streak,
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
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_daily_bonus_claim(integer, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_daily_bonus_claim(integer, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. The drift scan knows the new writers
-- ---------------------------------------------------------------------------
INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
VALUES
  ('fn_ca_daily_bonus_claim', 'approved',
   'Daily Club Arena Bonus claim. Diamonds via award_diamonds_v2 (daily_bonus, ref ca_daily_bonus:*), consumables as feature_purchases source=daily_bonus at cost 0. Never chips.'),
  ('fn_ca_daily_bonus_open_day', 'approved',
   'Internal: opens a player''s bonus day (streak + tile snapshot). Moves no value.'),
  ('fn_ca_daily_bonus_status', 'approved',
   'Read side of the Daily Club Arena Bonus. Moves no value.')
ON CONFLICT (proname) DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes;

COMMIT;
