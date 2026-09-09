-- 20260909212512_the_daily_bonus_keeps_its_own_books.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- THE DAILY BONUS KEEPS ITS OWN BOOKS.
-- (Dan, 2026-09-09, phase 1 of the daily bonus build-out after the audit;
--  docs/changelog/2026-09-09-daily-bonus-phase-1-integrity.md)
--
-- Four things the audit found the feature could not answer about itself:
--
--   1. HOW OFTEN ARE PLAYERS TURNED AWAY? A refused diamond claim (daily_cap,
--      action_limit, a freeze, day_rolled_over) returned its reason and wrote
--      nothing. ca_daily_bonus_refusals now keeps one row per refusal, so the
--      cap question (a non-VIP's 110 shared with daily_login) is measured
--      rather than argued.
--   2. WHO CLAIMED FROM WHERE? Five accounts on one phone were five bonuses
--      and nothing could see it. Every claim now records claimed_from: the
--      browser's install id (sent by the client), and the user agent and IP
--      class the server reads from the request itself, which a client cannot
--      forge. Purely for velocity and audit; the IP is stored as a class
--      (/24 or /48), never whole.
--   3. A VELOCITY RULE. Three or more accounts claiming from one install id
--      in a day, or six from one IP class, file a financial_alerts warning,
--      once per device per day, inline in the claim. No cron.
--   4. A BUDGET ANOMALY RULE. When today's bonus diamonds exceed the 95th
--      percentile of the previous 14 days (and at least seven days exist),
--      one financial_alerts warning per day. Read from
--      diamond_user_daily_awards, which is small; no scan of the journal.
--
-- Also: the club_arena_daily economy lines. The 2026-10 budget row was NULL
-- (the earn ledger seeds a new month from the latest prior row, which was
-- that NULL), and ca_diamond_engine_spend held no rows for the four bonus
-- journals paid before the ruling-21 trigger rewrite. Both repaired.
--
-- The claim gains p_client jsonb DEFAULT NULL. ONE BODY, by DROP and CREATE
-- (20260908134818); the browser's three-argument call and the engine's
-- still resolve. No money moves. One transaction.

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

-- ---------------------------------------------------------------------------
-- 1. Refusals, and where a claim came from
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ca_daily_bonus_refusals (
  id            bigserial PRIMARY KEY,
  user_id       uuid    NOT NULL,
  bonus_date    date    NOT NULL,
  slot          integer,
  reason        text    NOT NULL,
  detail        jsonb,
  claimed_from  jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ca_daily_bonus_refusals_date_idx ON public.ca_daily_bonus_refusals (bonus_date, reason);
CREATE INDEX IF NOT EXISTS ca_daily_bonus_refusals_user_idx ON public.ca_daily_bonus_refusals (user_id, bonus_date);
ALTER TABLE public.ca_daily_bonus_refusals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ca_daily_bonus_refusals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.ca_daily_bonus_refusals TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.ca_daily_bonus_refusals_id_seq TO service_role;
COMMENT ON TABLE public.ca_daily_bonus_refusals IS
  'One row per refused Daily Club Arena Bonus claim (daily_cap, action_limit, vip_only, day_rolled_over, ...). Written by fn_ca_daily_bonus_claim; append-only. The measure of how often players are turned away.';

DROP TRIGGER IF EXISTS trg_ca_daily_bonus_refusals_append_only ON public.ca_daily_bonus_refusals;
CREATE TRIGGER trg_ca_daily_bonus_refusals_append_only
  BEFORE UPDATE OR DELETE ON public.ca_daily_bonus_refusals
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_daily_bonus_claims_append_only();

ALTER TABLE public.ca_daily_bonus_claims
  ADD COLUMN IF NOT EXISTS claimed_from jsonb;
COMMENT ON COLUMN public.ca_daily_bonus_claims.claimed_from IS
  'Where the claim came from: device_id (the browser install id the client sent), platform, ua and ip_class (read by the server from the request). For velocity rules and audit; never a whole IP.';
CREATE INDEX IF NOT EXISTS ca_daily_bonus_claims_device_idx
  ON public.ca_daily_bonus_claims (bonus_date, (claimed_from->>'device_id'));
CREATE INDEX IF NOT EXISTS ca_daily_bonus_claims_ip_idx
  ON public.ca_daily_bonus_claims (bonus_date, (claimed_from->>'ip_class'));

-- What the server can say about the request, plus what the client offered.
CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_claimed_from(p_client jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_headers  jsonb;
  v_ip       text;
  v_ip_class text;
  v_device   text;
  v_platform text;
BEGIN
  BEGIN
    v_headers := NULLIF(current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN others THEN
    v_headers := NULL;
  END;
  v_ip := split_part(COALESCE(v_headers->>'x-forwarded-for', v_headers->>'cf-connecting-ip', ''), ',', 1);
  v_ip := btrim(v_ip);
  IF v_ip ~ '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$' THEN
    v_ip_class := regexp_replace(v_ip, '\.\d{1,3}$', '.x');
  ELSIF position(':' IN v_ip) > 0 THEN
    v_ip_class := array_to_string((string_to_array(v_ip, ':'))[1:3], ':') || '::x';
  ELSE
    v_ip_class := NULL;
  END IF;
  v_device   := left(regexp_replace(COALESCE(p_client->>'device_id', ''), '[^A-Za-z0-9_.:-]', '', 'g'), 64);
  v_platform := left(regexp_replace(COALESCE(p_client->>'platform', ''), '[^A-Za-z0-9_.:-]', '', 'g'), 32);
  RETURN jsonb_strip_nulls(jsonb_build_object(
    'device_id', NULLIF(v_device, ''),
    'platform',  NULLIF(v_platform, ''),
    'ua',        left(v_headers->>'user-agent', 200),
    'ip_class',  v_ip_class
  ));
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_daily_bonus_claimed_from(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_daily_bonus_claimed_from(jsonb) TO service_role;

-- The refusal writer: records and returns the refusal the claim hands back.
CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_refuse(
  p_user_id uuid, p_today date, p_slot integer, p_reason text, p_detail jsonb, p_claimed_from jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO public.ca_daily_bonus_refusals (user_id, bonus_date, slot, reason, detail, claimed_from)
  VALUES (p_user_id, p_today, p_slot, p_reason, p_detail, p_claimed_from);
  RETURN jsonb_strip_nulls(jsonb_build_object('success', false, 'reason', p_reason, 'detail', p_detail));
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_daily_bonus_refuse(uuid, date, integer, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_daily_bonus_refuse(uuid, date, integer, text, jsonb, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. The two rules, inline, once per day each
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_velocity_check(p_today date, p_claimed_from jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_device_users CONSTANT integer := 3;
  c_ip_users     CONSTANT integer := 6;
  v_device text := p_claimed_from->>'device_id';
  v_ip     text := p_claimed_from->>'ip_class';
  v_n      integer;
BEGIN
  IF v_device IS NOT NULL THEN
    SELECT count(DISTINCT user_id) INTO v_n FROM public.ca_daily_bonus_claims
     WHERE bonus_date = p_today AND claimed_from->>'device_id' = v_device;
    IF v_n >= c_device_users AND NOT EXISTS (
         SELECT 1 FROM public.financial_alerts a
          WHERE a.source = 'fn_ca_daily_bonus_claim.device_velocity'
            AND a.context->>'device_id' = v_device AND a.context->>'bonus_date' = p_today::text) THEN
      INSERT INTO public.financial_alerts (severity, source, message, context)
      VALUES ('warning', 'fn_ca_daily_bonus_claim.device_velocity',
              format('%s accounts claimed the daily bonus from one device today', v_n),
              jsonb_build_object('device_id', v_device, 'bonus_date', p_today, 'accounts', v_n,
                                 'users', (SELECT jsonb_agg(DISTINCT user_id) FROM public.ca_daily_bonus_claims
                                            WHERE bonus_date = p_today AND claimed_from->>'device_id' = v_device)));
    END IF;
  END IF;
  IF v_ip IS NOT NULL THEN
    SELECT count(DISTINCT user_id) INTO v_n FROM public.ca_daily_bonus_claims
     WHERE bonus_date = p_today AND claimed_from->>'ip_class' = v_ip;
    IF v_n >= c_ip_users AND NOT EXISTS (
         SELECT 1 FROM public.financial_alerts a
          WHERE a.source = 'fn_ca_daily_bonus_claim.ip_velocity'
            AND a.context->>'ip_class' = v_ip AND a.context->>'bonus_date' = p_today::text) THEN
      INSERT INTO public.financial_alerts (severity, source, message, context)
      VALUES ('warning', 'fn_ca_daily_bonus_claim.ip_velocity',
              format('%s accounts claimed the daily bonus from one network today', v_n),
              jsonb_build_object('ip_class', v_ip, 'bonus_date', p_today, 'accounts', v_n));
    END IF;
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_daily_bonus_velocity_check(date, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_daily_bonus_velocity_check(date, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_daily_bonus_budget_check(p_today date)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_today_total bigint;
  v_p95         numeric;
  v_days        integer;
BEGIN
  SELECT COALESCE(sum(awarded), 0) INTO v_today_total
    FROM public.diamond_user_daily_awards WHERE engine = 'club_arena_daily' AND day = p_today;
  SELECT count(*), percentile_cont(0.95) WITHIN GROUP (ORDER BY t.total)
    INTO v_days, v_p95
    FROM (SELECT day, sum(awarded) AS total FROM public.diamond_user_daily_awards
           WHERE engine = 'club_arena_daily' AND day >= p_today - 14 AND day < p_today
           GROUP BY day) t;
  -- Fewer than seven days is not a baseline; a quiet Tuesday is not an incident.
  IF v_days < 7 OR v_p95 IS NULL OR v_today_total <= v_p95 THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM public.financial_alerts a
              WHERE a.source = 'fn_ca_daily_bonus_claim.budget_anomaly'
                AND a.context->>'bonus_date' = p_today::text) THEN
    RETURN;
  END IF;
  INSERT INTO public.financial_alerts (severity, source, message, context)
  VALUES ('warning', 'fn_ca_daily_bonus_claim.budget_anomaly',
          format('daily bonus paid %s diamonds today, above the 14-day p95 of %s', v_today_total, round(v_p95)),
          jsonb_build_object('bonus_date', p_today, 'today', v_today_total, 'p95', round(v_p95, 1), 'days', v_days));
END;
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_daily_bonus_budget_check(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_daily_bonus_budget_check(date) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. The claim records refusals and origins, and runs the two rules
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.fn_ca_daily_bonus_claim(integer, uuid, uuid, date);

CREATE FUNCTION public.fn_ca_daily_bonus_claim(
  p_slot integer,
  p_request_id uuid,
  p_user_id uuid DEFAULT NULL,
  p_bonus_date date DEFAULT NULL,
  p_client jsonb DEFAULT NULL
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
  v_from       jsonb;
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
        'mystery', v_tile->>'kind' = 'mystery'
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
                                    'balance_after', v_balance);

  ELSIF v_kind IN ('throwables', 'rabbit_hunts', 'time_bank') THEN
    IF v_qty <= 0 THEN
      RETURN public.fn_ca_daily_bonus_refuse(v_uid, v_today, p_slot, 'nothing_to_pay', NULL, v_from);
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

  INSERT INTO public.ca_daily_bonus_claims (user_id, bonus_date, slot, request_id, tile, granted, result, claimed_from)
  VALUES (v_uid, v_today, p_slot, p_request_id, v_tile, v_granted, v_result, v_from);

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
$$;

REVOKE ALL ON FUNCTION public.fn_ca_daily_bonus_claim(integer, uuid, uuid, date, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_daily_bonus_claim(integer, uuid, uuid, date, jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_ca_daily_bonus_claim(integer, uuid, uuid, date, jsonb) IS
  'Claims one daily-bonus tile. p_user_id is the horse''s input device (CLAUDE.md 10.5): only the engine may name a player. p_bonus_date is the day the sheet showed (day_rolled_over otherwise). p_client is what the browser knows about itself (device_id, platform); the server adds ua and ip_class. Every refusal is a ca_daily_bonus_refusals row; every claim records claimed_from and runs the device/IP velocity rule and the budget anomaly rule.';

-- ---------------------------------------------------------------------------
-- 4. The economy lines
-- ---------------------------------------------------------------------------
UPDATE public.diamond_reward_budgets b
   SET budget_diamonds = (SELECT p.budget_diamonds FROM public.diamond_reward_budgets p
                           WHERE p.engine = 'club_arena_daily' AND p.budget_diamonds IS NOT NULL
                           ORDER BY p.period DESC LIMIT 1),
       updated_at = now()
 WHERE b.engine = 'club_arena_daily' AND b.budget_diamonds IS NULL;

INSERT INTO public.ca_diamond_engine_spend (period, engine, user_id, amount, journal_id, at)
SELECT to_char(t.created_at AT TIME ZONE 'America/Chicago', 'YYYY-MM'), 'club_arena_daily',
       t.user_id, t.amount, t.id, t.created_at
  FROM public.diamond_transactions t
 WHERE t.reference_id LIKE 'ca_daily_bonus:%' AND t.amount > 0
   AND NOT EXISTS (SELECT 1 FROM public.ca_diamond_engine_spend s WHERE s.journal_id = t.id)
ON CONFLICT (journal_id) DO NOTHING;

INSERT INTO public.ca_money_rpc_registry (proname, status, notes)
VALUES
  ('fn_ca_daily_bonus_claim', 'approved',
   'Daily Club Arena Bonus claim. Diamonds via award_diamonds_v2 (daily_bonus, ref ca_daily_bonus:*), consumables as feature_purchases source=daily_bonus at cost 0. Never chips. Refuses day_rolled_over; records refusals and claimed_from; runs velocity and budget rules.'),
  ('fn_ca_daily_bonus_refuse', 'approved', 'Internal: records a refused daily bonus claim. Moves no value.'),
  ('fn_ca_daily_bonus_velocity_check', 'approved', 'Internal: files a financial_alerts warning when many accounts claim from one device or network. Moves no value.'),
  ('fn_ca_daily_bonus_budget_check', 'approved', 'Internal: files a financial_alerts warning when a day''s bonus diamonds exceed the 14-day p95. Moves no value.')
ON CONFLICT (proname) DO UPDATE SET status = EXCLUDED.status, notes = EXCLUDED.notes;

-- ---------------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_n integer; v_body text;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_daily_bonus_claim';
  IF v_n <> 1 THEN RAISE EXCEPTION '% overloads of the daily bonus claim exist; two bodies drift', v_n; END IF;
  SELECT prosrc INTO v_body FROM pg_proc WHERE proname = 'fn_ca_daily_bonus_claim';
  IF v_body NOT LIKE '%IF v_uid IS NULL AND public.fn_caller_is_engine() THEN%'
     OR v_body NOT LIKE '%Cannot claim a daily bonus for another player%'
     OR v_body NOT LIKE '%requires an authenticated caller%'
     OR v_body NOT LIKE '%already_claimed%' OR v_body NOT LIKE '%vip_only%'
     OR v_body NOT LIKE '%day_rolled_over%'
     OR v_body NOT LIKE '%fn_ca_daily_bonus_eligibility%' OR v_body NOT LIKE '%idempotent%'
     OR v_body NOT LIKE '%award_diamonds_v2%' THEN
    RAISE EXCEPTION 'a rule of the daily bonus was lost in the rewrite';
  END IF;
  IF position('day_rolled_over' IN v_body) > position('fn_ca_daily_bonus_open_day' IN v_body) THEN
    RAISE EXCEPTION 'the day check must run before the day is opened';
  END IF;
  -- every refusal path is recorded: no bare refusal object survives
  IF v_body LIKE '%jsonb_build_object(''success'', false%' THEN
    RAISE EXCEPTION 'a refusal path bypasses fn_ca_daily_bonus_refuse';
  END IF;
  IF to_regprocedure('public.fn_ca_daily_bonus_claim(integer, uuid, uuid, date, jsonb)') IS NULL THEN
    RAISE EXCEPTION 'the new signature does not exist';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                  WHERE p.proname = 'fn_ca_daily_bonus_claim' AND a.grantee = 'authenticated'::regrole) THEN
    RAISE EXCEPTION 'players can no longer claim their own daily bonus';
  END IF;
  IF EXISTS (SELECT 1 FROM public.diamond_reward_budgets WHERE engine = 'club_arena_daily' AND budget_diamonds IS NULL) THEN
    RAISE EXCEPTION 'a club_arena_daily budget line is still NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM public.diamond_transactions t
              WHERE t.reference_id LIKE 'ca_daily_bonus:%' AND t.amount > 0
                AND NOT EXISTS (SELECT 1 FROM public.ca_diamond_engine_spend s WHERE s.journal_id = t.id)) THEN
    RAISE EXCEPTION 'a daily bonus journal row has no engine spend row';
  END IF;
  IF (SELECT public.fn_ca_mint_supply('diamonds'))
     <> (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) + public.fn_ca_diamond_offledger_float() THEN
    RAISE EXCEPTION 'players + float <> register after a change that moves no money';
  END IF;
END $$;

COMMIT;
