-- ============================================================================
-- PREREQUISITES FOR THE DIAMOND SCHEDULED-TOURNAMENT RUNNER
-- ============================================================================
-- PRIVATE ISOLATED FIXTURE ONLY. Loaded by run-diamond-scheduled-tournaments.py
-- after the concurrency fixture world, into a cluster that run creates, owns
-- and destroys. It installs, byte for byte as production held them on
-- 2026-10-06 (read-only pg_get_functiondef; every block pinned by md5 and
-- listed in diamond-scheduled-tournaments-prerequisites.manifest.json):
--   * the Diamond economics table and its readers, and the house earmark
--     ledger and its guard (20261005151918, 20261005152200, 20261006004756),
--     with the line (a) answers the guarantee doors read;
--   * the live bodies migration 20261007000010 substitutes into that the
--     older fixture captures do not already hold at production's md5.
-- The migration's own md5 pins then prove these are the bodies it edits.
-- ============================================================================
DO $guard$ BEGIN
  IF current_database() <> 'diamond_concurrency' OR inet_server_addr() IS NOT NULL THEN
    RAISE EXCEPTION 'isolated Diamond scheduled-tournament fixture only';
  END IF;
END $guard$;


-- The economics table, as production holds it (columns and the constraints
-- the doors under test rely on).
CREATE TABLE public.ca_diamond_economics (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           text        NOT NULL,
  scope          text        NOT NULL DEFAULT 'all',
  value          numeric     NULL,
  value_text     text        NULL,
  units          text        NOT NULL,
  approved_quote text        NOT NULL,
  basis          text        NOT NULL,
  approved_on    date        NOT NULL,
  recorded_by    text        NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ca_diamond_economics_has_exactly_one_value CHECK ((value IS NULL) <> (value_text IS NULL)),
  CONSTRAINT ca_diamond_economics_boolean_shape CHECK (units <> 'boolean' OR value_text IN ('yes','no')),
  CONSTRAINT ca_diamond_economics_choice_is_an_option CHECK (
    units <> 'choice' OR CASE name
      WHEN 'guarantee_covers'               THEN value_text IN ('prize_pool_only','prize_pool_and_bounties')
      WHEN 'guarantee_funding_moment'       THEN value_text IN ('set_aside_at_creation','checked_at_creation_paid_at_close')
      WHEN 'freeroll_rebuy_cost'            THEN value_text = 'none_offered'
      WHEN 'freeroll_addon_cost'            THEN value_text = 'none_offered'
      WHEN 'promo_entry_refund_destination' THEN value_text IN ('funding_account','unused_promotional_entry','player_wallet')
      WHEN 'horse_entry_funding'            THEN value_text IN ('own_balance','funding_account')
      WHEN 'cash_rake_rounding'             THEN value_text IN ('down','nearest','up')
      ELSE false
    END)
);
-- @@DOOR fn_ca_diamond_economics_units_of(p_name text)
-- @@PIN md5=83ab17bb45177bf70500bbab7ba9315b len=3924 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_economics_units_of(p_name text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE p_name
    -- Line (a)
    WHEN 'guarantee_overlay_account'              THEN 'account'
    WHEN 'guarantee_mint_may_issue'               THEN 'boolean'
    WHEN 'guarantee_mint_monthly_ceiling'         THEN 'diamonds_per_month'
    WHEN 'guarantee_max_per_event'                THEN 'diamonds_per_event'
    WHEN 'guarantee_max_outstanding'              THEN 'diamonds'
    WHEN 'guarantee_covers'                       THEN 'choice'
    WHEN 'guarantee_funding_moment'               THEN 'choice'
    WHEN 'guarantee_cap_refuses_creation'         THEN 'boolean'
    WHEN 'guarantee_authority'                    THEN 'role'
    WHEN 'freeroll_allowed'                       THEN 'boolean'
    WHEN 'freeroll_rebuy_cost'                    THEN 'choice'
    WHEN 'freeroll_addon_cost'                    THEN 'choice'
    WHEN 'promo_entry_allowed'                    THEN 'boolean'
    WHEN 'promo_entry_per_player_per_day'         THEN 'entries_per_player_per_day'
    WHEN 'promo_entry_per_event'                  THEN 'entries_per_event'
    WHEN 'promo_entry_monthly_diamonds'           THEN 'diamonds_per_month'
    WHEN 'promo_entry_refund_destination'         THEN 'choice'
    WHEN 'promo_entry_expiry_days'                THEN 'days'
    WHEN 'horse_entry_funding'                    THEN 'choice'
    WHEN 'horse_overlay_autofill'                 THEN 'boolean'
    WHEN 'horse_freeroll_autofill'                THEN 'boolean'
    -- Line (b)
    WHEN 'tournament_fee_percent'                 THEN 'percent'
    WHEN 'tournament_fee_percent_heads_up'        THEN 'percent'
    WHEN 'tournament_rebuy_fee_percent'           THEN 'percent'
    WHEN 'tournament_reentry_fee_percent'         THEN 'percent'
    WHEN 'tournament_addon_fee_percent'           THEN 'percent'
    WHEN 'tournament_fee_destination'             THEN 'account'
    WHEN 'cash_rake_enabled'                      THEN 'boolean'
    WHEN 'cash_rake_percent'                      THEN 'percent'
    WHEN 'cash_rake_cap'                          THEN 'diamonds_per_hand'
    WHEN 'cash_rake_percent_heads_up'             THEN 'percent'
    WHEN 'cash_rake_cap_heads_up'                 THEN 'diamonds_per_hand'
    WHEN 'cash_rake_percent_three_handed'         THEN 'percent'
    WHEN 'cash_rake_cap_three_handed'             THEN 'diamonds_per_hand'
    WHEN 'cash_rake_no_flop_no_drop'              THEN 'boolean'
    WHEN 'cash_rake_min_pot'                      THEN 'diamonds'
    WHEN 'cash_rake_rounding'                     THEN 'choice'
    WHEN 'cash_rake_destination'                  THEN 'account'
    WHEN 'rakeback_percent'                       THEN 'percent'
    WHEN 'rakeback_period'                        THEN 'period'
    WHEN 'rake_earns_vip_points'                  THEN 'boolean'
    WHEN 'bbj_enabled'                            THEN 'boolean'
    WHEN 'bbj_drop_per_hand'                      THEN 'diamonds_per_hand'
    WHEN 'bbj_qualifying_hand'                    THEN 'hand'
    WHEN 'bbj_excluded_games'                     THEN 'game_list'
    WHEN 'bbj_min_pot'                            THEN 'diamonds'
    WHEN 'bbj_min_dealt_in'                       THEN 'players'
    WHEN 'bbj_pool_split'                         THEN 'shares'
    WHEN 'bbj_hit_shares'                         THEN 'shares'
    WHEN 'bbj_seed'                               THEN 'diamonds'
    WHEN 'bbj_seed_account'                       THEN 'account'
    WHEN 'bbj_pool_ceiling'                       THEN 'diamonds'
    WHEN 'bbj_pool_ceiling_destination'           THEN 'account'
    WHEN 'bbj_withdrawal_destination'             THEN 'account'
    -- Line (c)
    WHEN 'chip_account_may_fund_a_diamond_format' THEN 'boolean'
  END
$function$;
ALTER FUNCTION public.fn_ca_diamond_economics_units_of(p_name text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_economics_units_of(p_name text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_economics_units_of(p_name text) TO service_role;
-- @@END fn_ca_diamond_economics_units_of(p_name text)

-- @@DOOR fn_ca_diamond_economics_append_only()
-- @@PIN md5=15ef51901919cb6a0e60c4c86060d3a9 len=313 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_economics_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION 'ca_diamond_economics is append-only: a changed answer is a new row, never an edit'
    USING ERRCODE = '42501';
END $function$;
ALTER FUNCTION public.fn_ca_diamond_economics_append_only() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_economics_append_only() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_economics_append_only() TO service_role;
-- @@END fn_ca_diamond_economics_append_only()

-- @@DOOR fn_ca_diamond_economic(p_name text, p_scope text)
-- @@PIN md5=dbf6c888e109b7970b05239bf636e619 len=1294 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_economic(p_name text, p_scope text DEFAULT 'all'::text)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_units text;
  v_value numeric;
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'diamond_economics_unset:<null>/%', COALESCE(p_scope,'<null>')
      USING ERRCODE = 'PDE01';
  END IF;
  v_units := public.fn_ca_diamond_economics_units_of(p_name);
  IF v_units IS NULL THEN
    RAISE EXCEPTION 'diamond_economics_unknown_name:%', p_name USING ERRCODE = 'PDE02';
  END IF;
  IF v_units IN ('boolean','account','choice','role','hand','game_list','shares','period') THEN
    RAISE EXCEPTION 'diamond_economics_not_a_number:% (units %, read it with fn_ca_diamond_economic_text)',
      p_name, v_units USING ERRCODE = 'PDE02';
  END IF;
  -- No fallback: the scope asked for is the scope read.
  SELECT e.value INTO v_value
    FROM public.ca_diamond_economics e
   WHERE e.name = p_name AND e.scope = COALESCE(p_scope,'all')
   ORDER BY e.recorded_at DESC, e.id DESC
   LIMIT 1;
  IF v_value IS NULL THEN
    RAISE EXCEPTION 'diamond_economics_unset:%/%', p_name, COALESCE(p_scope,'all')
      USING ERRCODE = 'PDE01';
  END IF;
  RETURN v_value;
END $function$;
ALTER FUNCTION public.fn_ca_diamond_economic(p_name text, p_scope text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_economic(p_name text, p_scope text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_economic(p_name text, p_scope text) TO service_role;
-- @@END fn_ca_diamond_economic(p_name text, p_scope text)

-- @@DOOR fn_ca_diamond_economic_text(p_name text, p_scope text)
-- @@PIN md5=fae313d042da5ac374be5b2169c14d01 len=1238 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_economic_text(p_name text, p_scope text DEFAULT 'all'::text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_units text;
  v_value text;
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'diamond_economics_unset:<null>/%', COALESCE(p_scope,'<null>')
      USING ERRCODE = 'PDE01';
  END IF;
  v_units := public.fn_ca_diamond_economics_units_of(p_name);
  IF v_units IS NULL THEN
    RAISE EXCEPTION 'diamond_economics_unknown_name:%', p_name USING ERRCODE = 'PDE02';
  END IF;
  IF v_units NOT IN ('boolean','account','choice','role','hand','game_list','shares','period') THEN
    RAISE EXCEPTION 'diamond_economics_not_a_word:% (units %, read it with fn_ca_diamond_economic)',
      p_name, v_units USING ERRCODE = 'PDE02';
  END IF;
  SELECT e.value_text INTO v_value
    FROM public.ca_diamond_economics e
   WHERE e.name = p_name AND e.scope = COALESCE(p_scope,'all')
   ORDER BY e.recorded_at DESC, e.id DESC
   LIMIT 1;
  IF v_value IS NULL THEN
    RAISE EXCEPTION 'diamond_economics_unset:%/%', p_name, COALESCE(p_scope,'all')
      USING ERRCODE = 'PDE01';
  END IF;
  RETURN v_value;
END $function$;
ALTER FUNCTION public.fn_ca_diamond_economic_text(p_name text, p_scope text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_economic_text(p_name text, p_scope text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_economic_text(p_name text, p_scope text) TO service_role;
-- @@END fn_ca_diamond_economic_text(p_name text, p_scope text)

-- @@DOOR fn_ca_diamond_economic_on(p_name text, p_scope text)
-- @@PIN md5=ac9ae10f2ae1f2551682d274391c3f1e len=280 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_economic_on(p_name text, p_scope text DEFAULT 'all'::text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT public.fn_ca_diamond_economic_text(p_name, p_scope) = 'yes'
$function$;
ALTER FUNCTION public.fn_ca_diamond_economic_on(p_name text, p_scope text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_economic_on(p_name text, p_scope text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_economic_on(p_name text, p_scope text) TO service_role;
-- @@END fn_ca_diamond_economic_on(p_name text, p_scope text)


ALTER TABLE public.ca_diamond_economics ADD CONSTRAINT ca_diamond_economics_units_match_name
  CHECK (units = public.fn_ca_diamond_economics_units_of(name));
CREATE TRIGGER trg_ca_diamond_economics_append_only BEFORE UPDATE OR DELETE ON public.ca_diamond_economics
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_diamond_economics_append_only();
-- The line (a) answers as production holds them (values exact; the quotes and
-- bases are shortened here, they are read by nobody).
INSERT INTO public.ca_diamond_economics (name, scope, value, value_text, units, approved_quote, basis, approved_on, recorded_by) VALUES
  ('guarantee_overlay_account','all',NULL,'ca_diamond_house','account','fixture copy of production id 1','fixture','2026-10-05','fixture'),
  ('guarantee_mint_may_issue','all',NULL,'yes','boolean','fixture copy of production id 2','fixture','2026-10-05','fixture'),
  ('guarantee_mint_monthly_ceiling','all',2000000,NULL,'diamonds_per_month','fixture copy of production id 3','fixture','2026-10-05','fixture'),
  ('guarantee_max_per_event','all',1000000,NULL,'diamonds_per_event','fixture copy of production id 4','fixture','2026-10-05','fixture'),
  ('guarantee_max_outstanding','all',2000000,NULL,'diamonds','fixture copy of production id 5','fixture','2026-10-05','fixture'),
  ('guarantee_covers','all',NULL,'prize_pool_only','choice','fixture copy of production id 6','fixture','2026-10-05','fixture'),
  ('guarantee_funding_moment','all',NULL,'set_aside_at_creation','choice','fixture copy of production id 7','fixture','2026-10-05','fixture'),
  ('guarantee_cap_refuses_creation','all',NULL,'yes','boolean','fixture copy of production id 8','fixture','2026-10-05','fixture'),
  ('guarantee_authority','all',NULL,'platform_admin','role','fixture copy of production id 9','fixture','2026-10-05','fixture'),
  ('freeroll_allowed','all',NULL,'yes','boolean','fixture copy of production id 10','fixture','2026-10-05','fixture'),
  ('freeroll_rebuy_cost','all',NULL,'none_offered','choice','fixture copy of production id 11','fixture','2026-10-05','fixture'),
  ('freeroll_addon_cost','all',NULL,'none_offered','choice','fixture copy of production id 12','fixture','2026-10-05','fixture'),
  ('promo_entry_allowed','all',NULL,'yes','boolean','fixture copy of production id 13','fixture','2026-10-05','fixture'),
  ('horse_entry_funding','all',NULL,'own_balance','choice','fixture copy of production id 19','fixture','2026-10-05','fixture');

-- The house earmark ledger, as 20261005152200 created it.
CREATE TABLE public.ca_diamond_house_earmarks (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  entry         text        NOT NULL CHECK (entry IN ('open','pay','release')),
  earmark_key   text        NOT NULL CHECK (btrim(earmark_key) <> ''),
  purpose       text        NOT NULL CHECK (purpose IN ('guarantee','promotional_entry','jackpot_seed')),
  amount        bigint      NOT NULL CHECK (amount > 0 AND amount = trunc(amount)),
  tournament_id uuid        NULL,
  holder_id     uuid        NULL,
  expires_at    timestamptz NULL,
  recorded_by   uuid        NULL,
  reason        text        NOT NULL CHECK (btrim(reason) <> ''),
  CONSTRAINT ca_diamond_house_earmarks_shape CHECK (
    CASE purpose
      WHEN 'guarantee'         THEN tournament_id IS NOT NULL AND holder_id IS NULL
      WHEN 'promotional_entry' THEN holder_id IS NOT NULL
      WHEN 'jackpot_seed'      THEN tournament_id IS NULL AND holder_id IS NULL
    END),
  CONSTRAINT ca_diamond_house_earmarks_expiry_shape CHECK (purpose = 'promotional_entry' OR expires_at IS NULL)
);
-- @@DOOR fn_ca_diamond_house_earmarks_append_only()
-- @@PIN md5=790baf3d6805a915ba783cf822627fb8 len=356 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_house_earmarks_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RAISE EXCEPTION 'ca_diamond_house_earmarks is append-only: a promise is closed by a pay or a release entry, never by editing the promise'
    USING ERRCODE = '42501';
END $function$;
ALTER FUNCTION public.fn_ca_diamond_house_earmarks_append_only() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_house_earmarks_append_only() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_house_earmarks_append_only() TO service_role;
-- @@END fn_ca_diamond_house_earmarks_append_only()

-- @@DOOR fn_ca_diamond_earmark_open(p_key text)
-- @@PIN md5=ca2f780d328b471f01daae5183a215ae len=344 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_earmark_open(p_key text)
 RETURNS bigint
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(SUM(CASE e.entry WHEN 'open' THEN e.amount ELSE -e.amount END), 0)::bigint
    FROM public.ca_diamond_house_earmarks e
   WHERE e.earmark_key = p_key
$function$;
ALTER FUNCTION public.fn_ca_diamond_earmark_open(p_key text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_earmark_open(p_key text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_earmark_open(p_key text) TO service_role;
-- @@END fn_ca_diamond_earmark_open(p_key text)

-- @@DOOR fn_ca_diamond_earmarks_open(p_purpose text)
-- @@PIN md5=0ad305f598bcb7a9e9054707f81199a1 len=389 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_earmarks_open(p_purpose text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(SUM(CASE e.entry WHEN 'open' THEN e.amount ELSE -e.amount END), 0)::bigint
    FROM public.ca_diamond_house_earmarks e
   WHERE p_purpose IS NULL OR e.purpose = p_purpose
$function$;
ALTER FUNCTION public.fn_ca_diamond_earmarks_open(p_purpose text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_earmarks_open(p_purpose text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_earmarks_open(p_purpose text) TO service_role;
-- @@END fn_ca_diamond_earmarks_open(p_purpose text)

-- @@DOOR fn_ca_diamond_house_available()
-- @@PIN md5=9ff2bf1983563ce706cfa786f5d0b73e len=301 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_house_available()
 RETURNS bigint
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT (SELECT h.balance FROM public.ca_diamond_house h WHERE h.id = 1)::bigint
       - public.fn_ca_diamond_earmarks_open(NULL)
$function$;
ALTER FUNCTION public.fn_ca_diamond_house_available() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_house_available() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_house_available() TO service_role;
-- @@END fn_ca_diamond_house_available()

-- @@DOOR fn_ca_diamond_earmark_guard()
-- @@PIN md5=706844d861f90e21e9c8602d239c1a8f len=5392 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_earmark_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_open_key  bigint;
  v_avail     bigint;
  v_month     bigint;
  v_n         bigint;
BEGIN
  -- Every entry locks the house row, as R1 and R4 require of anything that
  -- changes what the house is holding against. An earmark is not per-hand
  -- money, so one lock per promise is the right cost.
  PERFORM 1 FROM public.ca_diamond_house WHERE id = 1 FOR UPDATE;

  v_open_key := public.fn_ca_diamond_earmark_open(NEW.earmark_key);

  IF NEW.entry IN ('pay','release') THEN
    -- RULING 21 LIVES HERE. A promise being KEPT is never refused by a cap,
    -- by the house balance, or by anything else. The only thing checked is
    -- that the house does not pay out more than it promised, which is not a
    -- cap on a player but arithmetic on its own books.
    IF v_open_key <= 0 THEN
      RAISE EXCEPTION 'diamond_earmark_not_open:%', NEW.earmark_key USING ERRCODE = '23514';
    END IF;
    IF NEW.amount > v_open_key THEN
      RAISE EXCEPTION 'diamond_earmark_over_release:% promises % and this entry is %',
        NEW.earmark_key, v_open_key, NEW.amount USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  -- From here down: NEW.entry = 'open'.
  IF v_open_key > 0 THEN
    RAISE EXCEPTION 'diamond_earmark_already_open:% already promises %',
      NEW.earmark_key, v_open_key USING ERRCODE = '23514';
  END IF;

  -- A7, "set aside at creation": a promise the house cannot cover is not a
  -- promise. This is the check that replaces the chip club-treasury fallback,
  -- which has no Diamond counterpart.
  v_avail := public.fn_ca_diamond_house_available();
  IF NEW.amount > v_avail THEN
    RAISE EXCEPTION 'diamond_house_cannot_set_aside:% available, % asked for %',
      v_avail, NEW.purpose, NEW.amount USING ERRCODE = '23514';
  END IF;

  IF NEW.purpose = 'guarantee' THEN
    -- A4: the largest guarantee one event may advertise.
    IF NEW.amount > public.fn_ca_diamond_economic('guarantee_max_per_event') THEN
      RAISE EXCEPTION 'diamond_guarantee_over_per_event_cap:% exceeds %',
        NEW.amount, public.fn_ca_diamond_economic('guarantee_max_per_event')
        USING ERRCODE = '23514';
    END IF;
    -- A5: the most overlay the platform may owe at one time.
    IF public.fn_ca_diamond_earmarks_open('guarantee') + NEW.amount
         > public.fn_ca_diamond_economic('guarantee_max_outstanding') THEN
      RAISE EXCEPTION 'diamond_guarantee_over_outstanding_cap:% already promised, % asked, cap %',
        public.fn_ca_diamond_earmarks_open('guarantee'), NEW.amount,
        public.fn_ca_diamond_economic('guarantee_max_outstanding')
        USING ERRCODE = '23514';
    END IF;

  ELSIF NEW.purpose = 'promotional_entry' THEN
    -- A12: the product has to be open at all.
    IF NOT public.fn_ca_diamond_economic_on('promo_entry_allowed') THEN
      RAISE EXCEPTION 'diamond_promotional_entry_not_open' USING ERRCODE = '55000';
    END IF;
    -- A17: an entry carries its shelf life, and the ledger sets it rather
    -- than trusting a caller to.
    IF NEW.expires_at IS NULL THEN
      NEW.expires_at := NEW.at
        + (public.fn_ca_diamond_economic('promo_entry_expiry_days') || ' days')::interval;
    END IF;
    -- A13: entries one holder may be given in one calendar day. 10.5: a horse
    -- is counted here exactly as a human is, and no line below branches on
    -- horse status at all.
    SELECT count(*) INTO v_n FROM public.ca_diamond_house_earmarks e
     WHERE e.entry = 'open' AND e.purpose = 'promotional_entry'
       AND e.holder_id = NEW.holder_id
       AND e.at >= date_trunc('day', NEW.at) AND e.at < date_trunc('day', NEW.at) + interval '1 day';
    IF v_n + 1 > public.fn_ca_diamond_economic('promo_entry_per_player_per_day') THEN
      RAISE EXCEPTION 'diamond_promotional_entry_over_player_day_cap:% already today, cap %',
        v_n, public.fn_ca_diamond_economic('promo_entry_per_player_per_day')
        USING ERRCODE = '23514';
    END IF;
    -- A14: entries one event may admit.
    IF NEW.tournament_id IS NOT NULL THEN
      SELECT count(*) INTO v_n FROM public.ca_diamond_house_earmarks e
       WHERE e.entry = 'open' AND e.purpose = 'promotional_entry'
         AND e.tournament_id = NEW.tournament_id;
      IF v_n + 1 > public.fn_ca_diamond_economic('promo_entry_per_event') THEN
        RAISE EXCEPTION 'diamond_promotional_entry_over_event_cap:% already in this event, cap %',
          v_n, public.fn_ca_diamond_economic('promo_entry_per_event')
          USING ERRCODE = '23514';
      END IF;
    END IF;
    -- A15: what promotional entries may be worth in one calendar month.
    SELECT COALESCE(SUM(e.amount), 0) INTO v_month FROM public.ca_diamond_house_earmarks e
     WHERE e.entry = 'open' AND e.purpose = 'promotional_entry'
       AND e.at >= date_trunc('month', NEW.at)
       AND e.at <  date_trunc('month', NEW.at) + interval '1 month';
    IF v_month + NEW.amount > public.fn_ca_diamond_economic('promo_entry_monthly_diamonds') THEN
      RAISE EXCEPTION 'diamond_promotional_entry_over_monthly_cap:% issued this month, % asked, cap %',
        v_month, NEW.amount, public.fn_ca_diamond_economic('promo_entry_monthly_diamonds')
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END $function$;
ALTER FUNCTION public.fn_ca_diamond_earmark_guard() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_earmark_guard() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_earmark_guard() TO service_role;
-- @@END fn_ca_diamond_earmark_guard()


CREATE TRIGGER trg_ca_diamond_house_earmarks_append_only BEFORE UPDATE OR DELETE ON public.ca_diamond_house_earmarks
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_diamond_house_earmarks_append_only();
CREATE TRIGGER trg_ca_diamond_earmark_guard BEFORE INSERT ON public.ca_diamond_house_earmarks
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_diamond_earmark_guard();
-- The guard baseline columns fn_ca_declare_guard_redefinition writes, which
-- production carries since 2026-09-10 and the historical base predates.
ALTER TABLE public.ca_guard_defs ADD COLUMN IF NOT EXISTS declared_ref text,
  ADD COLUMN IF NOT EXISTS declared_at timestamptz;
-- The ticket columns the horse registration chain's ticket lookup reads,
-- which production carries and the historical base predates.
ALTER TABLE public.tournament_tickets
  ADD COLUMN IF NOT EXISTS source_tournament_id uuid,
  ADD COLUMN IF NOT EXISTS source_satellite_id uuid,
  ADD COLUMN IF NOT EXISTS source_refund_entitlement_id uuid,
  ADD COLUMN IF NOT EXISTS source_satellite_award_place integer,
  ADD COLUMN IF NOT EXISTS entry_prize numeric(15,2),
  ADD COLUMN IF NOT EXISTS entry_bounty numeric(15,2),
  ADD COLUMN IF NOT EXISTS entry_fee numeric(15,2);
-- The read-only shape the horse registration chain's ticket lookup plans
-- against (fn_ca_find_tournament_entry_ticket_for): production's columns of
-- these tables, added where the historical base predates them. Nothing writes
-- to them here; a planned column that does not exist is an error even when no
-- row is ever read.
CREATE TABLE IF NOT EXISTS public.chip_ledger ("id" uuid, "performed_by" uuid, "from_type" text, "from_entity_id" uuid, "from_label" text, "to_type" text, "to_entity_id" uuid, "to_label" text, "amount" numeric(15,2), "category" text, "description" text, "notes" text, "club_id" uuid, "union_id" uuid, "table_id" uuid, "hand_id" uuid, "tournament_id" uuid, "created_at" timestamp with time zone, "idempotency_key" text, "correlation_id" uuid, "causation_id" uuid, "settlement_id" text, "epoch_id" integer, "actor_service" text, "db_role" text, "pre_from_balance" numeric, "post_from_balance" numeric, "pre_to_balance" numeric, "post_to_balance" numeric, "status" text, "metadata" jsonb, "chain_seq" bigint, "prev_hash" text, "row_hash" text);
ALTER TABLE public.chip_ledger ADD COLUMN IF NOT EXISTS "id" uuid, ADD COLUMN IF NOT EXISTS "performed_by" uuid, ADD COLUMN IF NOT EXISTS "from_type" text, ADD COLUMN IF NOT EXISTS "from_entity_id" uuid, ADD COLUMN IF NOT EXISTS "from_label" text, ADD COLUMN IF NOT EXISTS "to_type" text, ADD COLUMN IF NOT EXISTS "to_entity_id" uuid, ADD COLUMN IF NOT EXISTS "to_label" text, ADD COLUMN IF NOT EXISTS "amount" numeric(15,2), ADD COLUMN IF NOT EXISTS "category" text, ADD COLUMN IF NOT EXISTS "description" text, ADD COLUMN IF NOT EXISTS "notes" text, ADD COLUMN IF NOT EXISTS "club_id" uuid, ADD COLUMN IF NOT EXISTS "union_id" uuid, ADD COLUMN IF NOT EXISTS "table_id" uuid, ADD COLUMN IF NOT EXISTS "hand_id" uuid, ADD COLUMN IF NOT EXISTS "tournament_id" uuid, ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone, ADD COLUMN IF NOT EXISTS "idempotency_key" text, ADD COLUMN IF NOT EXISTS "correlation_id" uuid, ADD COLUMN IF NOT EXISTS "causation_id" uuid, ADD COLUMN IF NOT EXISTS "settlement_id" text, ADD COLUMN IF NOT EXISTS "epoch_id" integer, ADD COLUMN IF NOT EXISTS "actor_service" text, ADD COLUMN IF NOT EXISTS "db_role" text, ADD COLUMN IF NOT EXISTS "pre_from_balance" numeric, ADD COLUMN IF NOT EXISTS "post_from_balance" numeric, ADD COLUMN IF NOT EXISTS "pre_to_balance" numeric, ADD COLUMN IF NOT EXISTS "post_to_balance" numeric, ADD COLUMN IF NOT EXISTS "status" text, ADD COLUMN IF NOT EXISTS "metadata" jsonb, ADD COLUMN IF NOT EXISTS "chain_seq" bigint, ADD COLUMN IF NOT EXISTS "prev_hash" text, ADD COLUMN IF NOT EXISTS "row_hash" text;
CREATE TABLE IF NOT EXISTS public.chip_transactions ("id" uuid, "club_id" uuid, "from_user_id" uuid, "to_user_id" uuid, "amount" numeric(14,2), "transaction_type" text, "notes" text, "related_cashout_id" uuid, "metadata" jsonb, "created_at" timestamp with time zone, "balance_after" numeric(14,2), "clawed_back" boolean, "reversible_until" timestamp with time zone, "is_reversed" boolean, "table_id" uuid);
ALTER TABLE public.chip_transactions ADD COLUMN IF NOT EXISTS "id" uuid, ADD COLUMN IF NOT EXISTS "club_id" uuid, ADD COLUMN IF NOT EXISTS "from_user_id" uuid, ADD COLUMN IF NOT EXISTS "to_user_id" uuid, ADD COLUMN IF NOT EXISTS "amount" numeric(14,2), ADD COLUMN IF NOT EXISTS "transaction_type" text, ADD COLUMN IF NOT EXISTS "notes" text, ADD COLUMN IF NOT EXISTS "related_cashout_id" uuid, ADD COLUMN IF NOT EXISTS "metadata" jsonb, ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone, ADD COLUMN IF NOT EXISTS "balance_after" numeric(14,2), ADD COLUMN IF NOT EXISTS "clawed_back" boolean, ADD COLUMN IF NOT EXISTS "reversible_until" timestamp with time zone, ADD COLUMN IF NOT EXISTS "is_reversed" boolean, ADD COLUMN IF NOT EXISTS "table_id" uuid;
CREATE TABLE IF NOT EXISTS public.tournament_payouts ("id" uuid, "tournament_id" uuid, "user_id" uuid, "position" integer, "amount" numeric(15,2), "source" text, "created_at" timestamp with time zone, "idempotency_key" text, "paid_at" timestamp with time zone, "tournament_type" text, "field_size" integer, "prize_pool" numeric, "payout_structure" jsonb, "recorded_by" text, "metadata" jsonb, "terminal_closed_at" timestamp with time zone);
ALTER TABLE public.tournament_payouts ADD COLUMN IF NOT EXISTS "id" uuid, ADD COLUMN IF NOT EXISTS "tournament_id" uuid, ADD COLUMN IF NOT EXISTS "user_id" uuid, ADD COLUMN IF NOT EXISTS "position" integer, ADD COLUMN IF NOT EXISTS "amount" numeric(15,2), ADD COLUMN IF NOT EXISTS "source" text, ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone, ADD COLUMN IF NOT EXISTS "idempotency_key" text, ADD COLUMN IF NOT EXISTS "paid_at" timestamp with time zone, ADD COLUMN IF NOT EXISTS "tournament_type" text, ADD COLUMN IF NOT EXISTS "field_size" integer, ADD COLUMN IF NOT EXISTS "prize_pool" numeric, ADD COLUMN IF NOT EXISTS "payout_structure" jsonb, ADD COLUMN IF NOT EXISTS "recorded_by" text, ADD COLUMN IF NOT EXISTS "metadata" jsonb, ADD COLUMN IF NOT EXISTS "terminal_closed_at" timestamp with time zone;
CREATE TABLE IF NOT EXISTS public.tournament_refund_entitlements ("id" uuid, "tournament_id" uuid, "user_id" uuid, "entitlement_kind" text, "charge_category" text, "refund_wallet_club_id" uuid, "gross" numeric(15,2), "refund_prize" numeric(15,2), "refund_bounty" numeric(15,2), "refund_fee" numeric(15,2), "source_ledger_id" uuid, "registration_id" uuid, "source_satellite_id" uuid, "source_award_place" integer, "source_ticket_id" uuid, "escrow_bucket" text, "evidence_kind" text, "created_at" timestamp with time zone);
ALTER TABLE public.tournament_refund_entitlements ADD COLUMN IF NOT EXISTS "id" uuid, ADD COLUMN IF NOT EXISTS "tournament_id" uuid, ADD COLUMN IF NOT EXISTS "user_id" uuid, ADD COLUMN IF NOT EXISTS "entitlement_kind" text, ADD COLUMN IF NOT EXISTS "charge_category" text, ADD COLUMN IF NOT EXISTS "refund_wallet_club_id" uuid, ADD COLUMN IF NOT EXISTS "gross" numeric(15,2), ADD COLUMN IF NOT EXISTS "refund_prize" numeric(15,2), ADD COLUMN IF NOT EXISTS "refund_bounty" numeric(15,2), ADD COLUMN IF NOT EXISTS "refund_fee" numeric(15,2), ADD COLUMN IF NOT EXISTS "source_ledger_id" uuid, ADD COLUMN IF NOT EXISTS "registration_id" uuid, ADD COLUMN IF NOT EXISTS "source_satellite_id" uuid, ADD COLUMN IF NOT EXISTS "source_award_place" integer, ADD COLUMN IF NOT EXISTS "source_ticket_id" uuid, ADD COLUMN IF NOT EXISTS "escrow_bucket" text, ADD COLUMN IF NOT EXISTS "evidence_kind" text, ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone;
CREATE TABLE IF NOT EXISTS public.tournament_refund_tranches ("wallet_transaction_id" uuid, "idempotency_key" text, "tournament_id" uuid, "obligation_id" uuid, "user_id" uuid, "source_wallet_club_id" uuid, "entitlement_id" uuid, "credit_ledger_id" uuid, "amount_paid_before" numeric(15,2), "amount_paid_now" numeric(15,2), "refund_prize" numeric(15,2), "refund_bounty" numeric(15,2), "refund_fee" numeric(15,2), "source" text, "description" text, "created_at" timestamp with time zone, "transaction_id" xid8);
ALTER TABLE public.tournament_refund_tranches ADD COLUMN IF NOT EXISTS "wallet_transaction_id" uuid, ADD COLUMN IF NOT EXISTS "idempotency_key" text, ADD COLUMN IF NOT EXISTS "tournament_id" uuid, ADD COLUMN IF NOT EXISTS "obligation_id" uuid, ADD COLUMN IF NOT EXISTS "user_id" uuid, ADD COLUMN IF NOT EXISTS "source_wallet_club_id" uuid, ADD COLUMN IF NOT EXISTS "entitlement_id" uuid, ADD COLUMN IF NOT EXISTS "credit_ledger_id" uuid, ADD COLUMN IF NOT EXISTS "amount_paid_before" numeric(15,2), ADD COLUMN IF NOT EXISTS "amount_paid_now" numeric(15,2), ADD COLUMN IF NOT EXISTS "refund_prize" numeric(15,2), ADD COLUMN IF NOT EXISTS "refund_bounty" numeric(15,2), ADD COLUMN IF NOT EXISTS "refund_fee" numeric(15,2), ADD COLUMN IF NOT EXISTS "source" text, ADD COLUMN IF NOT EXISTS "description" text, ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone, ADD COLUMN IF NOT EXISTS "transaction_id" xid8;
CREATE TABLE IF NOT EXISTS public.tournament_satellite_awards ("tournament_id" uuid, "place" integer, "user_id" uuid, "delivery_kind" text, "amount" numeric(15,2), "payout_id" uuid, "payout_source" text, "idempotency_key" text, "registration_id" uuid, "ticket_id" uuid, "obligation_id" uuid, "obligation_kind" text, "created_at" timestamp with time zone);
ALTER TABLE public.tournament_satellite_awards ADD COLUMN IF NOT EXISTS "tournament_id" uuid, ADD COLUMN IF NOT EXISTS "place" integer, ADD COLUMN IF NOT EXISTS "user_id" uuid, ADD COLUMN IF NOT EXISTS "delivery_kind" text, ADD COLUMN IF NOT EXISTS "amount" numeric(15,2), ADD COLUMN IF NOT EXISTS "payout_id" uuid, ADD COLUMN IF NOT EXISTS "payout_source" text, ADD COLUMN IF NOT EXISTS "idempotency_key" text, ADD COLUMN IF NOT EXISTS "registration_id" uuid, ADD COLUMN IF NOT EXISTS "ticket_id" uuid, ADD COLUMN IF NOT EXISTS "obligation_id" uuid, ADD COLUMN IF NOT EXISTS "obligation_kind" text, ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone;
CREATE TABLE IF NOT EXISTS public.tournament_satellite_settlements ("tournament_id" uuid, "target_id" uuid, "target_was_missing" boolean, "target_contract_version" bigint, "winner_id" uuid, "field_size" integer, "advertised_seats" integer, "pool" numeric(15,2), "target_buy_in" numeric(15,2), "target_fee" numeric(15,2), "ticket_cost" numeric(15,2), "ticket_award_count" integer, "seat_count" integer, "cash_ticket_count" integer, "entry_ticket_count" integer, "remainder" numeric(15,2), "bubble_user_id" uuid, "bubble_position" integer, "source_table_count" integer, "source_table_ids" uuid[], "source_seat_count" integer, "source_seat_ids" uuid[], "released_seat_count" integer, "released_seat_ids" uuid[], "source_closed_at" timestamp with time zone, "source_escrow_closed_at" timestamp with time zone, "source_escrow_close_note" text, "settled_at" timestamp with time zone, "receipt_version" integer, "qualifier_ids" uuid[]);
ALTER TABLE public.tournament_satellite_settlements ADD COLUMN IF NOT EXISTS "tournament_id" uuid, ADD COLUMN IF NOT EXISTS "target_id" uuid, ADD COLUMN IF NOT EXISTS "target_was_missing" boolean, ADD COLUMN IF NOT EXISTS "target_contract_version" bigint, ADD COLUMN IF NOT EXISTS "winner_id" uuid, ADD COLUMN IF NOT EXISTS "field_size" integer, ADD COLUMN IF NOT EXISTS "advertised_seats" integer, ADD COLUMN IF NOT EXISTS "pool" numeric(15,2), ADD COLUMN IF NOT EXISTS "target_buy_in" numeric(15,2), ADD COLUMN IF NOT EXISTS "target_fee" numeric(15,2), ADD COLUMN IF NOT EXISTS "ticket_cost" numeric(15,2), ADD COLUMN IF NOT EXISTS "ticket_award_count" integer, ADD COLUMN IF NOT EXISTS "seat_count" integer, ADD COLUMN IF NOT EXISTS "cash_ticket_count" integer, ADD COLUMN IF NOT EXISTS "entry_ticket_count" integer, ADD COLUMN IF NOT EXISTS "remainder" numeric(15,2), ADD COLUMN IF NOT EXISTS "bubble_user_id" uuid, ADD COLUMN IF NOT EXISTS "bubble_position" integer, ADD COLUMN IF NOT EXISTS "source_table_count" integer, ADD COLUMN IF NOT EXISTS "source_table_ids" uuid[], ADD COLUMN IF NOT EXISTS "source_seat_count" integer, ADD COLUMN IF NOT EXISTS "source_seat_ids" uuid[], ADD COLUMN IF NOT EXISTS "released_seat_count" integer, ADD COLUMN IF NOT EXISTS "released_seat_ids" uuid[], ADD COLUMN IF NOT EXISTS "source_closed_at" timestamp with time zone, ADD COLUMN IF NOT EXISTS "source_escrow_closed_at" timestamp with time zone, ADD COLUMN IF NOT EXISTS "source_escrow_close_note" text, ADD COLUMN IF NOT EXISTS "settled_at" timestamp with time zone, ADD COLUMN IF NOT EXISTS "receipt_version" integer, ADD COLUMN IF NOT EXISTS "qualifier_ids" uuid[];
-- @@DOOR fn_ca_guard_watchlist()
-- @@PIN md5=ab4f9d0e402186fff9b4af288e443609 len=3499 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_guard_watchlist()
 RETURNS text[]
 LANGUAGE sql
 STABLE
AS $function$
  SELECT ARRAY(
    SELECT DISTINCT x FROM unnest(ARRAY[
      'fn_ca_raise_drift_incident','fn_ca_incident_notify','fn_ca_incident_action',
      'fn_ca_incident_escalation_tick','fn_ca_incident_recipient_ids',
      'fn_ca_quick_reconcile','fn_ca_supply_snapshot','fn_ca_diamond_snapshot',
      'fn_ca_suspense_regression_check','fn_ca_settlement_correctness_check',
      'fn_ca_autoledger','fn_ca_autoledger_delete','fn_ca_chip_ledger_enrich',
      'fn_ca_journal_append_only','fn_ca_is_midway_scope',
      'fn_ca_negative_balance_watch','fn_ca_mint_velocity_watch',
      'fn_ca_cron_failure_watch','fn_ca_burnin_gate_tick','fn_ca_midway_burnin_gate',
      'fn_ca_epoch3_preflight','fn_ca_execute_epoch3_reset',
      'fn_club_members_ledger_writer','fn_ca_financial_alert_to_incident',
      'fn_ca_settlement_transition_guard','fn_ca_guard_defs_watch',
      'fn_ca_post_correction','fn_ca_repair_write_failure',
      -- The Diamond money doors (2026-09-12).
      'fn_poker_diamond_reserve','fn_poker_diamond_release',
      'fn_poker_diamond_cashout','fn_poker_diamond_settle_cash_hand',
      'fn_poker_diamond_buyin','fn_poker_diamond_top_up',
      'fn_poker_diamond_seat_keeps_custody','fn_poker_diamond_plain_cash_table',
      -- The unit rules (2026-09-12).
      'fn_ca_unit_floor_cents','fn_ca_tournament_unit_cents',
      'fn_ca_prize_ladder','fn_ca_recovery_fee_cents',
      -- The seat guards that know a tournament seat (2026-09-13).
      'fn_poker_guard_chip_seat','fn_poker_bind_diamond_seat',
      'fn_poker_diamond_entry_custody_is_the_entry',
      -- The Diamond tournament money doors (Phase 8, 2026-09-14): an entry
      -- into custody, an add to it, its refund, its unregistration and
      -- cancellation, the drain, the prize, the fee, the close, the shadow.
      'fn_poker_diamond_tournament_charge','fn_poker_diamond_tournament_custody_add',
      'fn_poker_diamond_tournament_refund','fn_poker_diamond_tournament_unregister',
      'fn_poker_diamond_tournament_cancel','fn_poker_diamond_tournament_drain',
      'fn_poker_diamond_tournament_pay','fn_poker_diamond_tournament_settle_fee',
      'fn_poker_diamond_tournament_close_custody','fn_poker_diamond_tournament_open_shadow',
      -- The two guards Phase 8 taught new names, and the two chip readers it
      -- routes by asset. The wallet guard is the one thing between a browser
      -- and profiles.diamonds.
      'fn_guard_profile_privileged_columns','fn_poker_guard_arena_structure',
      'fn_ca_escrow_can_pay','fn_ca_tournament_escrow',
      -- The Diamond satellite seat door (Phase 9, 2026-09-21): a satellite
      -- seat moved custody to custody, out of one prize bank into an entry.
      'fn_poker_diamond_tournament_seat_transfer',
      -- A balance never moves without its ledger row (2026-10-01): the tally,
      -- its two sides, the account key and the commit-time check.
      'fn_ca_ledger_tally_add','fn_ca_ledger_tally_key','fn_ca_felt_counts_table',
      'fn_ca_tally_balance_move','fn_ca_tally_ledger_leg','fn_ca_balance_has_its_ledger_row',
      -- Every chip store balances with its ledger row (2026-10-02): the store
      -- side of the tally, its pair helper and the Diamond-event scope.
      'fn_ca_tally_store_move','fn_ca_tally_pair','fn_ca_tournament_counts',
      -- And the list itself.
      'fn_ca_guard_watchlist'
    ]) x)
$function$;
ALTER FUNCTION public.fn_ca_guard_watchlist() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_guard_watchlist() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_guard_watchlist() TO service_role;
-- @@END fn_ca_guard_watchlist()

-- @@DOOR fn_ca_declare_guard_redefinition(p_proname text, p_ref text)
-- @@PIN md5=3a3746dc6e0a5b7a1db97805588c0eb8 len=2019 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_declare_guard_redefinition(p_proname text, p_ref text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_hash text;
  v_def text;
BEGIN
  /* A DECLARED GUARD CHANGE IS RECORDED, NOT RAISED (2026-09-10).
     Call this from a migration that deliberately redefines a watched guard,
     in the SAME transaction as the redefinition, passing the migration name.
     It moves the baseline to the definition this transaction just produced,
     so fn_ca_guard_defs_watch has nothing to report. A change nobody declares
     still moves the hash away from the baseline and still raises. */
  IF COALESCE(btrim(p_ref), '') = '' THEN
    RAISE EXCEPTION 'a guard redefinition must name the migration that made it';
  END IF;
  IF NOT (p_proname = ANY (public.fn_ca_guard_watchlist())) THEN
    RAISE EXCEPTION 'fn_ca_declare_guard_redefinition called for %, which is not on the guard watchlist', p_proname;
  END IF;

  SELECT md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)),
         string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)
    INTO v_hash, v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = p_proname;

  IF v_hash IS NULL THEN
    RAISE EXCEPTION 'guard function % does not exist; a declaration cannot baseline an absent guard', p_proname;
  END IF;

  -- keep the text so any later notice still has something to diff against
  INSERT INTO public.ca_guard_def_history (proname, def_hash, def_text)
  VALUES (p_proname, v_hash, v_def)
  ON CONFLICT (proname, def_hash) DO NOTHING;

  INSERT INTO public.ca_guard_defs (proname, def_hash, declared_ref, declared_at)
  VALUES (p_proname, v_hash, p_ref, now())
  ON CONFLICT (proname) DO UPDATE
    SET def_hash = EXCLUDED.def_hash,
        declared_ref = EXCLUDED.declared_ref,
        declared_at = EXCLUDED.declared_at,
        updated_at = now();

  RETURN v_hash;
END;
$function$;
ALTER FUNCTION public.fn_ca_declare_guard_redefinition(p_proname text, p_ref text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_declare_guard_redefinition(p_proname text, p_ref text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_declare_guard_redefinition(p_proname text, p_ref text) TO service_role;
-- @@END fn_ca_declare_guard_redefinition(p_proname text, p_ref text)

-- @@DOOR trg_tournaments_guarantee_affordable()
-- @@PIN md5=df859238ed5ef32a565a44b6bd7143ea len=3803 owner=postgres
CREATE OR REPLACE FUNCTION public.trg_tournaments_guarantee_affordable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_union uuid; v_enforce boolean; v_club_name text;
  v_bank numeric; v_floor numeric; v_bank_label text;
  v_exposure numeric; v_this numeric; v_headroom numeric;
begin
  if coalesce(new.guaranteed_prize, 0) <= 0 or new.club_id is null then
    return new;
  end if;

  -- DIAMOND PHASE 9, STEP 0 (2026-09-29): a Diamond event has no chip bank. Reading
  -- the Diamond Arena's chip treasury would refuse it in chips or file a chip alert;
  -- its guarantee waits for a Diamond destination.
  if exists (select 1 from public.clubs c where c.id = new.club_id and c.asset = 'diamonds') then
    raise exception 'diamond_guarantee_has_no_chip_bank' using errcode = '55000';
  end if;

  select c.union_id, coalesce(c.guarantee_enforcement_enabled, true), c.name,
         coalesce(c.guarantee_treasury_floor, 0)
    into v_union, v_enforce, v_club_name, v_floor
    from public.clubs c where c.id = new.club_id;
  if not found then return new; end if;

  if v_union is not null then
    select coalesce(uw.chip_balance, 0) into v_bank
      from public.union_wallets uw where uw.union_id = v_union;
    v_bank := coalesce(v_bank, 0);
    v_bank_label := 'union bank';
    v_floor := 0;

    select coalesce(sum(greatest(coalesce(t.guaranteed_prize,0) - coalesce(t.prize_pool,0), 0)), 0)
      into v_exposure
      from public.tournaments t
      join public.clubs c2 on c2.id = t.club_id
     where c2.union_id = v_union
       and t.id <> new.id
       and coalesce(t.guaranteed_prize, 0) > 0
       and coalesce(t.prize_pool_finalized, false) = false
       and t.status in ('ANNOUNCED','REGISTERING','RUNNING');
  else
    select coalesce(c.chip_treasury, 0) into v_bank
      from public.clubs c where c.id = new.club_id;
    v_bank_label := 'club bank';

    select coalesce(sum(greatest(coalesce(t.guaranteed_prize,0) - coalesce(t.prize_pool,0), 0)), 0)
      into v_exposure
      from public.tournaments t
     where t.club_id = new.club_id
       and t.id <> new.id
       and coalesce(t.guaranteed_prize, 0) > 0
       and coalesce(t.prize_pool_finalized, false) = false
       and t.status in ('ANNOUNCED','REGISTERING','RUNNING');
  end if;

  v_this     := greatest(coalesce(new.guaranteed_prize,0) - coalesce(new.prize_pool,0), 0);
  v_headroom := v_bank - v_floor - v_exposure - v_this;

  if v_headroom < 0 then
    if v_enforce then
      raise exception
        'Club % cannot guarantee % chips: % holds %, floor %, already promised % on live events - short by %. Add chips to the bank to cover the guarantee.',
        coalesce(v_club_name, new.club_id::text), new.guaranteed_prize,
        v_bank_label, round(v_bank,2), round(v_floor,2), round(v_exposure,2), round(-v_headroom,2)
        using errcode = '55000';
    else
      insert into public.financial_alerts (severity, source, message, context)
      values ('critical', 'trg_tournaments_guarantee_affordable',
              'Guaranteed tournament announced that the ' || v_bank_label || ' cannot cover: '
                || coalesce(v_club_name, new.club_id::text),
              jsonb_build_object('club_id', new.club_id, 'union_id', v_union,
                                 'tournament_id', new.id,
                                 'guaranteed_prize', new.guaranteed_prize,
                                 'bank', v_bank, 'bank_label', v_bank_label,
                                 'floor', v_floor,
                                 'live_exposure', v_exposure, 'short_by', -v_headroom,
                                 'note', 'enforcement disabled for this club; no money was blocked'));
    end if;
  end if;

  return new;
end;
$function$;
ALTER FUNCTION public.trg_tournaments_guarantee_affordable() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.trg_tournaments_guarantee_affordable() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.trg_tournaments_guarantee_affordable() TO service_role;
-- @@END trg_tournaments_guarantee_affordable()

-- @@DOOR fn_ca_fund_overlay_on_lock()
-- @@PIN md5=3f55869778cc3c02ca1406fa22c908d4 len=11178 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_fund_overlay_on_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_short numeric; v_union uuid; v_bank numeric; v_from text; v_store text;
  v_pool_before numeric;
  v_entrants int; v_places int; v_existing jsonb;
  v_guarantee numeric; v_seat_guarantee numeric; v_target uuid;
  v_attempt int; v_fallback numeric;
BEGIN
  IF NOT (COALESCE(OLD.status,'') IN ('ANNOUNCED','REGISTERING')
          AND NEW.status IN ('RUNNING','COMPLETING','COMPLETED')) THEN
    RETURN NEW;
  END IF;

  /* ── 1. payout table, from the field that actually entered ─────────────
     Only when nobody has registered yet. With registrations present,
     fn_guard_managed_game_lifecycle protects payout_structure and this
     trigger currently runs BEFORE it, so writing here refuses the whole
     start. Re-enabled once the trigger is renamed to sort after the guard.

     NOT FOR A SPIN (2026-09-02). A Spin's ladder comes from the tier the
     wheel drew - 10x is 80/20 - and this rule is "pay the top N% of the
     field", which on three seats rounds to one place and silently replaced
     every high multiplier with winner-take-all. 32 games, 1,592 chips. */
  SELECT count(*) INTO v_entrants
    FROM public.tournament_players tp WHERE tp.tournament_id = NEW.id;

  -- A recovered RUNNING transition is not a new payout contract. The row
  -- is locked by its owning UPDATE; prepared/paid terms cannot be refitted
  -- to today's field. Keep the existing overlay transaction below intact.
  IF public.fn_tournament_payout_terms_committed_v1(OLD.id) THEN
    IF OLD.prize_pool_finalized IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Committed tournament payout terms have no finalized pool'
        USING ERRCODE='55000';
    END IF;
  ELSIF lower(COALESCE(NEW.variant,''))<>'spin'
        AND upper(COALESCE(NEW.tournament_type,''))<>'SPIN' THEN
    IF v_entrants > 0 AND NOT EXISTS (
         SELECT 1 FROM pg_trigger tg
          WHERE tg.tgrelid = 'public.tournaments'::regclass
            AND tg.tgname = 'zz_ca_fund_overlay_on_lock')
    THEN
      NULL;  -- stand down: the guard would refuse the start
    ELSIF v_entrants > 0 THEN
      /* Same rule as the entry close: a mystery bounty of 10 or fewer
         entries (rows plus rebuys) with at least 3 players pays 50/30/20
         (Dan, 2026-10-05). */
      v_places := CASE
        WHEN COALESCE(NEW.is_mystery_bounty,false) AND v_entrants >= 3
         AND (SELECT (count(*)+COALESCE(sum(GREATEST(COALESCE(tp.rebuys,0),0)),0))::integer
                FROM public.tournament_players tp WHERE tp.tournament_id = NEW.id) BETWEEN 1 AND 10
        THEN 3
        ELSE GREATEST(1, LEAST(v_entrants,
                    ceil(v_entrants * COALESCE(NEW.payout_percent,10) / 100.0)::int)) END;
      BEGIN
        v_existing := NULLIF(btrim(COALESCE(NEW.payout_structure,'')), '')::jsonb;
      EXCEPTION WHEN OTHERS THEN v_existing := NULL; END;

      IF v_existing IS NULL
         OR jsonb_typeof(v_existing) <> 'array'
         OR jsonb_array_length(v_existing) = 0
         OR v_existing = '[{"place":1,"percentage":100}]'::jsonb
         OR jsonb_array_length(v_existing) <> v_places
      THEN
        NEW.payout_structure := CASE
          WHEN COALESCE(NEW.is_mystery_bounty,false) AND v_entrants >= 3
           AND (SELECT (count(*)+COALESCE(sum(GREATEST(COALESCE(tp.rebuys,0),0)),0))::integer
                  FROM public.tournament_players tp WHERE tp.tournament_id = NEW.id) BETWEEN 1 AND 10
          THEN '[{"place":1,"percentage":50},{"place":2,"percentage":30},{"place":3,"percentage":20}]'::jsonb::text
          ELSE public.fn_ca_payout_structure(
                                  v_entrants, COALESCE(NEW.payout_percent,10))::text END;
      END IF;
    END IF;
  END IF;

  /* ── 2. the guarantee overlay, from the main bank ─────────────────────── */
  v_pool_before := round(COALESCE(NEW.prize_pool,0),2);
  v_guarantee   := round(COALESCE(NEW.guaranteed_prize,0),2);

  /* A GUARANTEED SEAT IS A GUARANTEE (2026-09-02). A satellite's advertised
     seats are worth target buy-in + fee each; the engine awards every one of
     them, so the bank funds the shortfall here, like any other guarantee. */
  IF COALESCE(NEW.satellite_seats, 0) > 0
     AND (NEW.variant = 'satellite'
          OR UPPER(COALESCE(NEW.tournament_type, '')) = 'SATELLITE'
          OR NEW.satellite_target_id IS NOT NULL) THEN
    v_target := COALESCE(NEW.satellite_target_id, NEW.satellite_target);
    IF v_target IS NOT NULL THEN
      SELECT round((COALESCE(t2.buy_in_amount,0) + COALESCE(t2.buy_in_fee,0)) * NEW.satellite_seats, 2)
        INTO v_seat_guarantee
        FROM public.tournaments t2 WHERE t2.id = v_target;
      v_guarantee := GREATEST(v_guarantee, COALESCE(v_seat_guarantee, 0));
    END IF;
  END IF;

  v_short := GREATEST(0, v_guarantee - v_pool_before);
  IF v_short <= 0 THEN RETURN NEW; END IF;

  /* DIAMOND PHASE 9, STEP 0 (2026-09-29): a Diamond event is never topped up from a
     chip bank. A shortfall (a guarantee, or a satellite's guaranteed seats) waits for a
     Diamond destination; until one exists the start is refused by name rather than
     funded from the Diamond Arena's chip treasury or started without its overlay. */
  IF EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = NEW.club_id AND c.asset = 'diamonds') THEN
    RAISE EXCEPTION 'diamond_overlay_has_no_chip_bank' USING ERRCODE = '55000';
  END IF;

  PERFORM set_config('app.ledger_category', 'overlay', true);
  PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
  PERFORM set_config('app.ledger_counterparty_entity', NEW.id::text, true);

  v_union := CASE WHEN COALESCE(NEW.is_private,false) THEN NULL ELSE NEW.union_id END;

  /* FOR NO KEY UPDATE, NOT FOR UPDATE (2026-10-05). The start-readiness guard
     already locks this bank row FOR NO KEY UPDATE in the same transaction
     (20260929071925, installed by 20261002083400). FOR UPDATE here upgraded
     that lock mid-start to the one mode that also conflicts with FOR KEY
     SHARE, so an overlay start still queued behind every open foreign-key
     insert that references the club. A treasury debit is a non-key update
     and needs no more than this; start-vs-start and every treasury write
     still serialize exactly as before. */
  IF v_union IS NOT NULL THEN
    SELECT chip_balance INTO v_bank FROM public.union_wallets
     WHERE union_id = v_union FOR NO KEY UPDATE;
    v_from := 'union_bank';
    v_store := 'union_wallets.chip_balance';
    IF COALESCE(v_bank,0) < v_short THEN
      /* THE MAIN BANK IS SHORT - FALL BACK TO THE CLUB TREASURY.
         Dan 2026-09-04. Refusing here meant advertising a guarantee and then
         not paying it. */
      SELECT chip_treasury INTO v_fallback
        FROM public.clubs WHERE id = NEW.club_id FOR NO KEY UPDATE;

      IF COALESCE(v_fallback,0) >= v_short THEN
        v_from  := 'club_treasury';
        v_store := 'clubs.chip_treasury';
        PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
        UPDATE public.clubs
           SET chip_treasury = COALESCE(chip_treasury,0) - v_short, updated_at = now()
         WHERE id = NEW.club_id;
        PERFORM set_config('app.ledger_autoskip_clubs', '0', true);
        PERFORM public.fn_raise_server_financial_alert(
          'warning', 'fn_ca_fund_overlay_on_lock',
          format('%s took its %s chip overlay from the club treasury: the union bank held only %s. The guarantee WAS met. Refill the union bank.',
                 COALESCE(NEW.name, NEW.id::text), v_short, COALESCE(v_bank,0)),
          jsonb_build_object('kind','overlay_funded_from_fallback','tournament_id',NEW.id,
            'shortfall',v_short,'union_bank',COALESCE(v_bank,0),
            'club_treasury',COALESCE(v_fallback,0)), NEW.id::text);
        v_union := NULL;  -- the ledger row names the account that actually moved
      ELSE
        PERFORM public.fn_raise_server_financial_alert(
          'critical', 'fn_ca_fund_overlay_on_lock',
          format('%s needs %s chips of overlay to meet its %s guarantee. The union bank holds %s and the club treasury holds %s. BOTH are short and the pool was NOT topped up.',
                 COALESCE(NEW.name, NEW.id::text), v_short, v_guarantee,
                 COALESCE(v_bank,0), COALESCE(v_fallback,0)),
          jsonb_build_object('kind','overlay_unfunded','tournament_id',NEW.id,
            'shortfall',v_short,'bank',COALESCE(v_bank,0),
            'club_treasury',COALESCE(v_fallback,0)), NEW.id::text);
        RETURN NEW;
      END IF;
    ELSE
      PERFORM set_config('app.ledger_autoskip_union_wallets', '1', true);
      UPDATE public.union_wallets
         SET chip_balance = chip_balance - v_short, updated_at = now()
       WHERE union_id = v_union;
      PERFORM set_config('app.ledger_autoskip_union_wallets', '0', true);
    END IF;
  ELSE
    SELECT chip_treasury INTO v_bank FROM public.clubs
     WHERE id = NEW.club_id FOR NO KEY UPDATE;
    v_from := 'club_treasury';
    v_store := 'clubs.chip_treasury';
    IF COALESCE(v_bank,0) < v_short THEN
      PERFORM public.fn_raise_server_financial_alert(
        'critical', 'fn_ca_fund_overlay_on_lock',
        format('%s needs %s chips of overlay to meet its %s guarantee and the club treasury holds %s. The pool was NOT topped up.',
               COALESCE(NEW.name, NEW.id::text), v_short,
               v_guarantee, COALESCE(v_bank,0)),
        jsonb_build_object('kind','overlay_unfunded','tournament_id',NEW.id,
          'shortfall',v_short,'bank',COALESCE(v_bank,0)), NEW.id::text);
      RETURN NEW;
    END IF;
    PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
    UPDATE public.clubs
       SET chip_treasury = COALESCE(chip_treasury,0) - v_short, updated_at = now()
     WHERE id = NEW.club_id;
    PERFORM set_config('app.ledger_autoskip_clubs', '0', true);
  END IF;

  NEW.prize_pool := round(v_pool_before + v_short, 2);

  -- Funding and its escrow/journal leg are one transaction. A failed
  -- journal insert must undo the bank debit and the advertised pool change.
  -- Retry only transient deadlocks; every final error propagates to the
  -- original status update, whose existing lifecycle can retry safely.
  FOR v_attempt IN 1..3 LOOP
    BEGIN
      INSERT INTO public.chip_ledger (
        performed_by, from_type, from_entity_id, to_type, to_entity_id,
        amount, category, club_id, tournament_id, description)
      VALUES (
        COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
        v_from, COALESCE(v_union, NEW.club_id), 'prize_liability', NEW.id,
        v_short, 'overlay', NEW.club_id, NEW.id,
        format('Guarantee overlay from the main bank: %s (%s) was %s short of its %s guarantee - field made %s, bank paid %s',
               COALESCE(NEW.name, 'tournament'), NEW.id::text,
               v_short, v_guarantee,
               v_pool_before, v_short));
      EXIT;
    EXCEPTION WHEN deadlock_detected THEN
      IF v_attempt = 3 THEN RAISE; END IF;
    END;
  END LOOP;

  RETURN NEW;
END;
$function$;
ALTER FUNCTION public.fn_ca_fund_overlay_on_lock() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_fund_overlay_on_lock() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_fund_overlay_on_lock() TO service_role;
-- @@END fn_ca_fund_overlay_on_lock()

-- @@DOOR fn_ca_return_excess_start_overlay_locked(p_tournament_id uuid)
-- @@PIN md5=2e670daae9319aed70b3477283aacba5 len=6567 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_return_excess_start_overlay_locked(p_tournament_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_system_actor constant uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
  v_t public.tournaments%ROWTYPE;
  v_key text;
  v_sources integer;
  v_from_type text;
  v_from_entity uuid;
  v_first_leg uuid;
  v_funded numeric;
  v_returned numeric;
  v_pool numeric;
  v_guarantee numeric;
  v_seat_guarantee numeric;
  v_target_id uuid;
  v_collected numeric;
  v_target numeric;
  v_excess numeric;
  v_before numeric;
  v_after numeric;
  v_ledger_id uuid;
BEGIN
  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id = p_tournament_id FOR UPDATE;
  IF NOT FOUND OR COALESCE(v_t.prize_pool_finalized, false) THEN
    RETURN NULL;  -- a finalized pool is never repriced
  END IF;
  v_key := 'tourney:' || p_tournament_id::text || ':guarantee_overlay_excess_return';
  IF EXISTS (SELECT 1 FROM public.chip_ledger l WHERE l.idempotency_key = v_key) THEN
    RETURN NULL;
  END IF;

  -- The start-time legs fn_ca_fund_overlay_on_lock wrote (the finalization
  -- leg carries its own idempotency key and cannot exist before finalizing).
  SELECT count(DISTINCT (l.from_type, l.from_entity_id)), min(l.from_type),
         (array_agg(l.from_entity_id ORDER BY l.created_at, l.id))[1],
         (array_agg(l.id ORDER BY l.created_at, l.id))[1],
         round(COALESCE(sum(l.amount), 0), 2)
    INTO v_sources, v_from_type, v_from_entity, v_first_leg, v_funded
    FROM public.chip_ledger l
   WHERE l.tournament_id = p_tournament_id
     AND l.category = 'overlay'
     AND l.to_type = 'prize_liability'
     AND l.to_entity_id = p_tournament_id
     AND l.from_type IN ('union_bank', 'club_treasury')
     AND l.idempotency_key IS DISTINCT FROM 'tourney:' || p_tournament_id::text || ':guarantee_overlay'
     AND COALESCE(l.description, '') NOT LIKE 'auto-ledgered%';
  IF COALESCE(v_funded, 0) <= 0 OR v_sources <> 1 THEN
    RETURN NULL;
  END IF;
  SELECT round(COALESCE(sum(r.amount), 0), 2) INTO v_returned
    FROM public.chip_ledger r
   WHERE r.tournament_id = p_tournament_id AND r.category = 'reversal'
     AND r.from_type = 'prize_liability' AND r.from_entity_id = p_tournament_id
     AND r.metadata->>'kind' = 'reviewed_void_overlay_return';
  v_funded := round(v_funded - v_returned, 2);
  IF v_funded <= 0 THEN RETURN NULL; END IF;

  v_pool := round(COALESCE(v_t.prize_pool, 0), 2);
  v_guarantee := round(COALESCE(v_t.guaranteed_prize, 0), 2);
  -- The same effective guarantee the lock trigger funded: a satellite's
  -- guaranteed seats are worth target buy-in + fee each.
  IF COALESCE(v_t.satellite_seats, 0) > 0
     AND (v_t.variant = 'satellite'
          OR upper(COALESCE(v_t.tournament_type, '')) = 'SATELLITE'
          OR v_t.satellite_target_id IS NOT NULL) THEN
    v_target_id := COALESCE(v_t.satellite_target_id, v_t.satellite_target);
    IF v_target_id IS NOT NULL THEN
      SELECT round((COALESCE(t2.buy_in_amount, 0) + COALESCE(t2.buy_in_fee, 0)) * v_t.satellite_seats, 2)
        INTO v_seat_guarantee FROM public.tournaments t2 WHERE t2.id = v_target_id;
      v_guarantee := GREATEST(v_guarantee, COALESCE(v_seat_guarantee, 0));
    END IF;
  END IF;

  v_collected := round(v_pool - v_funded, 2);
  v_target := GREATEST(v_guarantee, v_collected);
  v_excess := round(LEAST(v_funded, GREATEST(0, v_pool - v_target)), 2);
  IF v_excess <= 0 THEN RETURN NULL; END IF;

  -- Lock order of the finalization core: tournament, escrow, then the bank.
  PERFORM 1 FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id FOR UPDATE;
  IF v_from_type = 'union_bank' THEN
    SELECT round(COALESCE(chip_balance, 0), 2) INTO v_before FROM public.union_wallets
     WHERE union_id = v_from_entity FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    PERFORM set_config('app.ledger_autoskip_union_wallets', '1', true);
    UPDATE public.union_wallets SET chip_balance = chip_balance + v_excess, updated_at = now()
     WHERE union_id = v_from_entity RETURNING round(chip_balance, 2) INTO v_after;
    PERFORM set_config('app.ledger_autoskip_union_wallets', '0', true);
  ELSE
    SELECT round(COALESCE(chip_treasury, 0), 2) INTO v_before FROM public.clubs
     WHERE id = v_from_entity FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    PERFORM set_config('app.ledger_autoskip_clubs', '1', true);
    UPDATE public.clubs SET chip_treasury = COALESCE(chip_treasury, 0) + v_excess, updated_at = now()
     WHERE id = v_from_entity RETURNING round(chip_treasury, 2) INTO v_after;
    PERFORM set_config('app.ledger_autoskip_clubs', '0', true);
  END IF;
  IF v_after IS DISTINCT FROM round(v_before + v_excess, 2) THEN
    RAISE EXCEPTION 'excess overlay return did not credit its bank exactly'
      USING ERRCODE = '40001';
  END IF;

  INSERT INTO public.chip_ledger (
    performed_by, from_type, from_entity_id, to_type, to_entity_id,
    amount, category, club_id, tournament_id, description, idempotency_key, metadata)
  VALUES (
    c_system_actor, 'prize_liability', p_tournament_id, v_from_type, v_from_entity,
    v_excess, 'reversal', v_t.club_id, p_tournament_id,
    format('Guarantee overlay excess returned to its source: %s (%s) collected %s against its %s guarantee, so the %s start-time overlay needed only %s',
           COALESCE(v_t.name, 'tournament'), p_tournament_id, v_collected, v_guarantee,
           v_funded, round(v_funded - v_excess, 2)),
    v_key,
    jsonb_build_object('kind', 'reviewed_void_overlay_return',
      'reason', 'guarantee_overlay_excess_at_finalization',
      'original_overlay_ledger_id', v_first_leg, 'funded_overlay', v_funded,
      'collected', v_collected, 'guarantee', v_guarantee,
      'pool_before', v_pool, 'pool_after', round(v_pool - v_excess, 2),
      'source_balance_before', v_before, 'source_balance_after', v_after))
  RETURNING id INTO v_ledger_id;
  PERFORM public.fn_ca_escrow_apply(p_tournament_id, 'guarantee overlay excess return',
                                    p_overlay_in => -v_excess);

  UPDATE public.tournaments
     SET prize_pool = round(v_pool - v_excess, 2)
   WHERE id = p_tournament_id;

  RETURN jsonb_build_object('amount', v_excess, 'bank_type', v_from_type,
    'bank_entity_id', v_from_entity, 'funded_overlay', v_funded,
    'collected', v_collected, 'guarantee', v_guarantee,
    'pool_before', v_pool, 'pool_after', round(v_pool - v_excess, 2),
    'ledger_id', v_ledger_id);
END;
$function$;
ALTER FUNCTION public.fn_ca_return_excess_start_overlay_locked(p_tournament_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_return_excess_start_overlay_locked(p_tournament_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_return_excess_start_overlay_locked(p_tournament_id uuid)

-- @@DOOR fn_ca_apply_prize_guarantee_core(p_tournament_id uuid, p_source text)
-- @@PIN md5=f7eb032cfb11ef3fd0275e4b390047f9 len=11226 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_ca_apply_prize_guarantee_core(p_tournament_id uuid, p_source text DEFAULT 'engine'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t                    record;
  v_after                record;
  v_overlay_row          public.tournament_guarantee_overlays%ROWTYPE;
  v_result               jsonb;
  v_pool_before          numeric := 0;
  v_guarantee            numeric := 0;
  v_final                numeric := 0;
  v_overlay              numeric := 0;
  v_escrow_before        numeric := 0;
  v_escrow_after         numeric := 0;
  v_escrow_before_found  boolean := false;
  v_escrow_after_found   boolean := false;
  v_escrow_enforced      boolean := false;
  v_union                uuid;
  v_expected_bank_type   text;
  v_expected_bank_entity uuid;
  v_club_bank_before     numeric := 0;
  v_bank_before          numeric := 0;
  v_bank_after           numeric := 0;
  v_bank_row_found       boolean := false;
  v_ledger_inserted      integer := 0;
  v_old_category         text;
  v_old_counterparty     text;
  v_old_entity           text;
  v_old_tournament       text;
  v_failure              text;
  v_failure_state        text;
BEGIN
  IF p_tournament_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_id_required',
                              'retryable', false);
  END IF;

  SELECT t.id, t.club_id, t.name, t.status, t.union_id,
         COALESCE(t.is_private, false) AS is_private,
         round(COALESCE(t.prize_pool, 0), 2) AS pool,
         round(COALESCE(t.guaranteed_prize, 0), 2) AS guarantee,
         COALESCE(t.prize_pool_finalized, false) AS finalized
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found',
                              'retryable', false);
  END IF;

  v_pool_before := v_t.pool;
  v_guarantee := v_t.guarantee;
  v_final := GREATEST(v_pool_before, v_guarantee);
  v_overlay := round(v_final - v_pool_before, 2);

  /* Finalized is irreversible. A published pool that was finalized below its
     guarantee is evidence requiring an explicit, reviewed correction; the
     runtime must never reopen and silently reprice it. */
  IF v_t.finalized AND v_pool_before + 0.005 < v_guarantee THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'finalized_guarantee_is_below_published_floor',
      'prize_pool', v_pool_before, 'guaranteed_prize', v_guarantee,
      'retryable', false);
  END IF;

  SELECT round(COALESCE(e.prize_balance, 0), 2)
    INTO v_escrow_before
    FROM public.tournament_escrow e
   WHERE e.tournament_id = p_tournament_id
   FOR UPDATE;
  v_escrow_before_found := FOUND;

  BEGIN
    IF v_overlay > 0 THEN
      /* Lock and snapshot the real bank before calling the legacy debit core.
         Its overlay row describes the movement; only the live before/after
         balance proves that movement happened exactly once. */
      SELECT round(COALESCE(c.chip_treasury, 0), 2)
        INTO v_club_bank_before
        FROM public.clubs c
       WHERE c.id = v_t.club_id
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'guarantee host club does not exist',
                              ERRCODE = '23503';
      END IF;

      /* Funding ownership was captured on the event. A later club union move
         cannot redirect this liability, and a private event always belongs to
         its host club even when that club is currently union-affiliated. */
      v_union := CASE WHEN v_t.is_private THEN NULL ELSE v_t.union_id END;
      IF v_union IS NOT NULL THEN
        SELECT round(COALESCE(uw.chip_balance, 0), 2)
          INTO v_bank_before
          FROM public.union_wallets uw
         WHERE uw.union_id = v_union
         FOR UPDATE;
        v_bank_row_found := FOUND;
      END IF;
      IF v_bank_row_found THEN
        v_expected_bank_type := 'union';
        v_expected_bank_entity := v_union;
      ELSE
        v_expected_bank_type := 'club';
        v_expected_bank_entity := v_t.club_id;
        v_bank_before := v_club_bank_before;
      END IF;
      IF v_bank_before + 0.005 < v_overlay THEN
        RAISE EXCEPTION USING
          MESSAGE = format(
            'guarantee bank holds %s but the advertised overlay requires %s',
            v_bank_before, v_overlay),
          ERRCODE = '23514';
      END IF;
    END IF;

    v_old_category := current_setting('app.ledger_category', true);
    v_old_counterparty := current_setting('app.ledger_counterparty', true);
    v_old_entity := current_setting('app.ledger_counterparty_entity', true);
    v_old_tournament := current_setting('app.ledger_tournament', true);
    PERFORM set_config('app.ledger_tournament', p_tournament_id::text, true);

    v_result := public.fn_apply_prize_guarantee_before_atomic_proof(
      p_tournament_id, COALESCE(NULLIF(btrim(p_source), ''), 'engine'));
    IF NOT COALESCE((v_result->>'ok')::boolean, false) THEN
      RAISE EXCEPTION USING MESSAGE = COALESCE(v_result->>'reason', 'guarantee core refused'),
                            ERRCODE = '23514';
    END IF;
    IF v_overlay > 0 AND COALESCE((v_result->>'already_funded')::boolean, false) THEN
      RAISE EXCEPTION USING
        MESSAGE = 'an existing overlay claim did not prove this short pool was funded',
        ERRCODE = '23514';
    END IF;

    IF v_overlay > 0 THEN
      SELECT * INTO v_overlay_row
        FROM public.tournament_guarantee_overlays o
       WHERE o.tournament_id = p_tournament_id
       FOR UPDATE;
      IF NOT FOUND
         OR v_overlay_row.club_id IS DISTINCT FROM v_t.club_id
         OR abs(round(v_overlay_row.amount, 2) - v_overlay) > 0.005
         OR abs(round(v_overlay_row.pool_before, 2) - v_pool_before) > 0.005
         OR abs(round(v_overlay_row.pool_after, 2) - v_final) > 0.005
         OR v_overlay_row.bank_type IS DISTINCT FROM v_expected_bank_type
         OR v_overlay_row.bank_entity_id IS DISTINCT FROM v_expected_bank_entity
         OR v_overlay_row.treasury_after IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'guarantee overlay claim does not match its bank debit and pool',
                              ERRCODE = '23514';
      END IF;

      IF v_expected_bank_type = 'union' THEN
        SELECT round(COALESCE(uw.chip_balance, 0), 2)
          INTO v_bank_after
          FROM public.union_wallets uw
         WHERE uw.union_id = v_expected_bank_entity
         FOR UPDATE;
      ELSE
        SELECT round(COALESCE(c.chip_treasury, 0), 2)
          INTO v_bank_after
          FROM public.clubs c
         WHERE c.id = v_expected_bank_entity
         FOR UPDATE;
      END IF;
      IF NOT FOUND
         OR abs(v_bank_after - (v_bank_before - v_overlay)) > 0.005
         OR abs(round(v_overlay_row.treasury_after, 2) - v_bank_after) > 0.005 THEN
        RAISE EXCEPTION USING MESSAGE = 'guarantee bank did not debit the exact overlay',
                              ERRCODE = '23514';
      END IF;

      /* The legacy core's balance UPDATE produces an auto-ledger twin. Live
         escrow deliberately ignores auto-ledger overlay rows, so publish the
         one explicit, deterministic bank -> prize-liability leg it requires.
         This insert is in the same subtransaction as the bank debit. */
      INSERT INTO public.chip_ledger (
        performed_by, from_type, from_entity_id, to_type, to_entity_id,
        amount, category, club_id, tournament_id, idempotency_key, description)
      VALUES (
        COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
        CASE WHEN v_expected_bank_type = 'union' THEN 'union_bank' ELSE 'club_treasury' END,
        v_expected_bank_entity, 'prize_liability', p_tournament_id,
        v_overlay, 'overlay', v_t.club_id, p_tournament_id,
        'tourney:' || p_tournament_id::text || ':guarantee_overlay',
        'Guarantee Overlay Funded For ' || COALESCE(v_t.name, p_tournament_id::text))
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
      GET DIAGNOSTICS v_ledger_inserted = ROW_COUNT;
      IF v_ledger_inserted <> 1 THEN
        RAISE EXCEPTION USING MESSAGE = 'guarantee overlay journal key already exists unexpectedly',
                              ERRCODE = '23505';
      END IF;
    END IF;

    SELECT t.status, round(COALESCE(t.prize_pool, 0), 2) AS pool,
           round(COALESCE(t.guaranteed_prize, 0), 2) AS guarantee,
           COALESCE(t.prize_pool_finalized, false) AS finalized
      INTO v_after
      FROM public.tournaments t
     WHERE t.id = p_tournament_id
     FOR UPDATE;
    IF NOT FOUND OR NOT v_after.finalized
       OR abs(v_after.pool - v_final) > 0.005
       OR v_after.pool + 0.005 < v_after.guarantee THEN
      RAISE EXCEPTION USING MESSAGE = 'guarantee core did not publish the exact funded final pool',
                            ERRCODE = '23514';
    END IF;

    SELECT COALESCE(e.enforced, false), round(COALESCE(e.prize_balance, 0), 2)
      INTO v_escrow_enforced, v_escrow_after
      FROM public.tournament_escrow e
     WHERE e.tournament_id = p_tournament_id
     FOR UPDATE;
    v_escrow_after_found := FOUND;
    IF v_overlay > 0 AND (
         NOT v_escrow_after_found OR NOT v_escrow_enforced
         OR abs((v_escrow_after - CASE WHEN v_escrow_before_found
                                      THEN v_escrow_before ELSE 0 END) - v_overlay) > 0.005
       ) THEN
      RAISE EXCEPTION USING MESSAGE = 'guarantee bank debit did not credit live escrow exactly',
                            ERRCODE = '23514';
    END IF;

    PERFORM set_config('app.ledger_category', COALESCE(v_old_category, ''), true);
    PERFORM set_config('app.ledger_counterparty', COALESCE(v_old_counterparty, ''), true);
    PERFORM set_config('app.ledger_counterparty_entity', COALESCE(v_old_entity, ''), true);
    PERFORM set_config('app.ledger_tournament', COALESCE(v_old_tournament, ''), true);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_failure = MESSAGE_TEXT,
                            v_failure_state = RETURNED_SQLSTATE;
  END;

  IF v_failure IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'atomic_guarantee_funding_aborted',
      'detail', v_failure, 'sqlstate', v_failure_state,
      'prize_pool', v_pool_before, 'guaranteed_prize', v_guarantee,
      'retryable', v_failure_state IN ('40001', '40P01', '55P03'));
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'prize_pool', v_after.pool,
    'overlay', v_overlay, 'bank_type', v_expected_bank_type,
    'bank_entity_id', v_expected_bank_entity,
    'bank_before', CASE WHEN v_overlay > 0 THEN v_bank_before ELSE NULL END,
    'bank_after', CASE WHEN v_overlay > 0 THEN v_bank_after ELSE NULL END,
    'treasury_after', CASE WHEN v_overlay > 0 THEN v_bank_after ELSE NULL END,
    'escrow_before', CASE WHEN v_escrow_before_found THEN v_escrow_before ELSE NULL END,
    'escrow_after', CASE WHEN v_escrow_after_found THEN v_escrow_after ELSE NULL END,
    'already_finalized', v_t.finalized AND v_overlay = 0,
    'retryable', false);
END;
$function$;
ALTER FUNCTION public.fn_ca_apply_prize_guarantee_core(p_tournament_id uuid, p_source text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_ca_apply_prize_guarantee_core(p_tournament_id uuid, p_source text) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_ca_apply_prize_guarantee_core(p_tournament_id uuid, p_source text)

-- @@DOOR fn_apply_prize_guarantee(p_tournament_id uuid, p_source text)
-- @@PIN md5=c11535297ab88cfdc254f9336fdc5110 len=2871 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_apply_prize_guarantee(p_tournament_id uuid, p_source text DEFAULT 'engine'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
  v_overlay numeric;
  v_ledger_count integer;
  v_escrow public.tournament_escrow%ROWTYPE;
  v_return jsonb := NULL;
  v_refusal jsonb;
BEGIN
  /* A GUARANTEE IS A FLOOR (2026-10-01). The start-time overlay part that
     money collected since has made unnecessary goes back to its bank before
     the pool is finalized, so the final pool is max(guarantee, collected).
     One subtransaction with the finalization: a refused finalization rolls
     the return back too, and the caller sees the refusal unchanged. */
  BEGIN
    v_return := public.fn_ca_return_excess_start_overlay_locked(p_tournament_id);
    v_result:=public.fn_ca_apply_prize_guarantee_core(
      p_tournament_id,p_source);
    IF COALESCE((v_result->>'ok')::boolean,false) IS NOT TRUE THEN
      v_refusal := v_result;
      RAISE EXCEPTION USING ERRCODE='P0405',
        MESSAGE='guarantee finalization refused; the excess return is rolled back with it';
    END IF;
  EXCEPTION WHEN SQLSTATE 'P0405' THEN
    RETURN v_refusal;
  END;
  v_overlay:=COALESCE((v_result->>'overlay')::numeric,0);
  IF v_overlay::text IN ('NaN','Infinity','-Infinity')
     OR v_overlay<0 OR v_overlay IS DISTINCT FROM round(v_overlay,2) THEN
    RAISE EXCEPTION 'guarantee core returned invalid overlay %',v_overlay
      USING ERRCODE='P0404';
  END IF;
  IF v_overlay>0 THEN
    SELECT count(*) INTO v_ledger_count
      FROM public.chip_ledger l
     WHERE l.idempotency_key=
             'tourney:'||p_tournament_id::text||':guarantee_overlay'
       AND l.tournament_id=p_tournament_id
       AND l.to_type='prize_liability'
       AND l.to_entity_id=p_tournament_id
       AND l.category='overlay'
       AND l.amount=v_overlay
       AND l.from_entity_id=(v_result->>'bank_entity_id')::uuid
       AND l.from_type=CASE WHEN v_result->>'bank_type'='union'
                            THEN 'union_bank' ELSE 'club_treasury' END;
    SELECT * INTO v_escrow
      FROM public.tournament_escrow e
     WHERE e.tournament_id=p_tournament_id
     FOR UPDATE;
    IF v_ledger_count<>1 OR NOT FOUND
       OR COALESCE(v_escrow.enforced,false) IS NOT TRUE
       OR v_result->>'escrow_after' IS NULL
       OR v_escrow.prize_balance IS DISTINCT FROM
            (v_result->>'escrow_after')::numeric THEN
      RAISE EXCEPTION
        'guarantee overlay is not one exact journaled escrow credit'
        USING ERRCODE='P0404';
    END IF;
  END IF;
  RETURN v_result||jsonb_build_object('overlay_journaled',true)
    ||CASE WHEN v_return IS NOT NULL
           THEN jsonb_build_object('excess_overlay_returned',v_return)
           ELSE '{}'::jsonb END;
END;
$function$;
ALTER FUNCTION public.fn_apply_prize_guarantee(p_tournament_id uuid, p_source text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_apply_prize_guarantee(p_tournament_id uuid, p_source text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_apply_prize_guarantee(p_tournament_id uuid, p_source text) TO service_role;
-- @@END fn_apply_prize_guarantee(p_tournament_id uuid, p_source text)

-- @@DOOR fn_tournament_management_readiness_for_row(p_row jsonb)
-- @@PIN md5=885132de6733f2c3d9c79c33345af45c len=9344 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_tournament_management_readiness_for_row(p_row jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid := NULLIF(p_row ->> 'id', '')::uuid;
  v_club uuid := NULLIF(p_row ->> 'club_id', '')::uuid;
  v_row_union uuid := NULLIF(p_row ->> 'union_id', '')::uuid;
  v_union uuid;
  v_private boolean := COALESCE((p_row ->> 'is_private')::boolean, false);
  v_enforce boolean;
  v_floor numeric;
  v_bank numeric;
  v_bank_type text;
  v_exposure numeric;
  v_guaranteed numeric := COALESCE(NULLIF(p_row ->> 'guaranteed_prize', '')::numeric, 0);
  v_pool numeric := COALESCE(NULLIF(p_row ->> 'prize_pool', '')::numeric, 0);
  v_effective_guarantee numeric;
  v_seat_guarantee numeric := 0;
  v_required numeric;
  v_short numeric;
  v_portfolio_short numeric;
  v_locked boolean;
  v_complete boolean;
  v_status text := upper(COALESCE(p_row ->> 'status', ''));
  v_variant text := lower(COALESCE(p_row ->> 'variant', ''));
  v_tournament_type text := upper(COALESCE(p_row ->> 'tournament_type', ''));
  v_target uuid := COALESCE(
    NULLIF(p_row ->> 'satellite_target_id', ''),
    NULLIF(p_row ->> 'satellite_target', '')
  )::uuid;
  v_satellite_seats integer := COALESCE(
    NULLIF(p_row ->> 'satellite_seats', '')::integer,
    0
  );
  v_is_satellite boolean := v_variant = 'satellite'
    OR v_tournament_type = 'SATELLITE'
    OR v_target IS NOT NULL;
  v_target_found boolean := false;
  v_blinds jsonb;
  v_payouts jsonb;
BEGIN
  IF v_id IS NULL OR v_club IS NULL THEN
    RETURN jsonb_build_object('state', 'missing', 'can_start', false);
  END IF;

  SELECT COALESCE(c.guarantee_enforcement_enabled, true),
         COALESCE(c.guarantee_treasury_floor, 0)
    INTO v_enforce, v_floor
    FROM public.clubs c
   WHERE c.id = v_club;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'missing', 'can_start', false);
  END IF;

  v_union := CASE WHEN v_private THEN NULL ELSE v_row_union END;

  IF v_is_satellite AND v_satellite_seats > 0 AND v_target IS NOT NULL THEN
    SELECT round(
             (COALESCE(t.buy_in_amount, 0) + COALESCE(t.buy_in_fee, 0))
             * v_satellite_seats,
             2
           )
      INTO v_seat_guarantee
      FROM public.tournaments t
     WHERE t.id = v_target;
    v_target_found := FOUND;
    v_seat_guarantee := COALESCE(v_seat_guarantee, 0);
  END IF;

  v_effective_guarantee := greatest(v_guaranteed, v_seat_guarantee);

  IF v_union IS NOT NULL THEN
    v_bank_type := 'union';
    v_floor := 0;
    SELECT COALESCE(uw.chip_balance, 0)
      INTO v_bank
      FROM public.union_wallets uw
     WHERE uw.union_id = v_union;
    v_bank := COALESCE(v_bank, 0);

    SELECT COALESCE(sum(greatest(
             greatest(
               COALESCE(t.guaranteed_prize, 0),
               CASE
                 WHEN COALESCE(t.satellite_seats, 0) > 0
                      AND (
                        lower(COALESCE(t.variant, '')) = 'satellite'
                        OR upper(COALESCE(t.tournament_type, '')) = 'SATELLITE'
                        OR COALESCE(t.satellite_target_id, t.satellite_target) IS NOT NULL
                      )
                 THEN COALESCE(
                   (COALESCE(target.buy_in_amount, 0) + COALESCE(target.buy_in_fee, 0))
                   * t.satellite_seats,
                   0
                 )
                 ELSE 0
               END
             ) - COALESCE(t.prize_pool, 0),
             0
           )), 0)
      INTO v_exposure
      FROM public.tournaments t
      LEFT JOIN public.tournaments target
        ON target.id = COALESCE(t.satellite_target_id, t.satellite_target)
     WHERE t.union_id = v_union
       AND NOT COALESCE(t.is_private, false)
       AND t.id <> v_id
       AND NOT COALESCE(t.prize_pool_finalized, false)
       AND upper(t.status::text) IN ('ANNOUNCED', 'REGISTERING', 'RUNNING');
  ELSE
    v_bank_type := 'club';
    SELECT COALESCE(c.chip_treasury, 0)
      INTO v_bank
      FROM public.clubs c
     WHERE c.id = v_club;
    v_bank := COALESCE(v_bank, 0);

    SELECT COALESCE(sum(greatest(
             greatest(
               COALESCE(t.guaranteed_prize, 0),
               CASE
                 WHEN COALESCE(t.satellite_seats, 0) > 0
                      AND (
                        lower(COALESCE(t.variant, '')) = 'satellite'
                        OR upper(COALESCE(t.tournament_type, '')) = 'SATELLITE'
                        OR COALESCE(t.satellite_target_id, t.satellite_target) IS NOT NULL
                      )
                 THEN COALESCE(
                   (COALESCE(target.buy_in_amount, 0) + COALESCE(target.buy_in_fee, 0))
                   * t.satellite_seats,
                   0
                 )
                 ELSE 0
               END
             ) - COALESCE(t.prize_pool, 0),
             0
           )), 0)
      INTO v_exposure
      FROM public.tournaments t
      LEFT JOIN public.tournaments target
        ON target.id = COALESCE(t.satellite_target_id, t.satellite_target)
     WHERE t.club_id = v_club
       AND (COALESCE(t.is_private, false) OR t.union_id IS NULL)
       AND t.id <> v_id
       AND NOT COALESCE(t.prize_pool_finalized, false)
       AND upper(t.status::text) IN ('ANNOUNCED', 'REGISTERING', 'RUNNING');
  END IF;

  v_required := greatest(v_effective_guarantee - v_pool, 0);
  -- AN EVENT IS REFUSED ONLY FOR ITS OWN UNCOVERED OVERLAY (2026-10-02).
  -- The bank's coverage of OTHER events' guarantees is not this event's
  -- promise: a Spin, a Sit & Go, a heads-up satellite or a freezeout with no
  -- guarantee needs no overlay and is never refused for the bank, and an
  -- event with a guarantee is refused only when the bank (above the club's
  -- floor) cannot pay its own overlay. The bank-wide position is still
  -- reported, as portfolio_short_by, for the owners' bank warnings.
  v_portfolio_short := greatest(
    COALESCE(v_floor, 0) + COALESCE(v_exposure, 0) + v_required - v_bank,
    0
  );
  v_short := CASE
    WHEN v_required > 0 THEN greatest(COALESCE(v_floor, 0) + v_required - v_bank, 0)
    ELSE 0
  END;
  v_locked := EXISTS (
    SELECT 1
      FROM public.tournament_players tp
     WHERE tp.tournament_id = v_id
  );

  v_blinds := CASE
    WHEN jsonb_typeof(p_row -> 'blind_structure') = 'array'
      THEN p_row -> 'blind_structure'
    ELSE public.fn_safe_jsonb_array(p_row ->> 'blind_structure')
  END;
  v_payouts := CASE
    WHEN jsonb_typeof(p_row -> 'payout_structure') = 'array'
      THEN p_row -> 'payout_structure'
    ELSE public.fn_safe_jsonb_array(p_row ->> 'payout_structure')
  END;

  v_complete := NULLIF(trim(COALESCE(p_row ->> 'name', '')), '') IS NOT NULL
    AND (
      NULLIF(p_row ->> 'start_time', '') IS NOT NULL
      OR v_tournament_type IN ('SNG', 'SPIN')
      OR v_variant IN ('sng', 'spin')
    )
    AND COALESCE(NULLIF(p_row ->> 'starting_chips', '')::numeric, 0) > 0
    AND ((p_row->>'format_contract' IS NOT DISTINCT FROM 'mtt-v2' AND p_row->>'max_players' IS NULL
          AND COALESCE(NULLIF(p_row->>'min_players','')::integer,0)>=3)
      OR COALESCE(NULLIF(p_row ->> 'max_players', '')::integer, 0) >= 2)
    AND COALESCE(NULLIF(p_row ->> 'buy_in_amount', '')::numeric, 0) >= 0
    AND jsonb_array_length(v_blinds) > 0
    AND (
      jsonb_array_length(v_payouts) > 0
      OR v_tournament_type = 'SPIN'
      OR v_variant = 'spin'
    )
    AND (
      NOT v_is_satellite
      OR (v_satellite_seats > 0 AND v_target IS NOT NULL AND v_target_found)
      -- DIAMOND PHASE 9: a Diamond satellite promises no seat. A seat count
      -- promised in advance is a guarantee; a Diamond guarantee is funded only
      -- from an authorised Diamond house budget, which is not built and whose
      -- size is the owner's, and the creation door refuses one by name. The
      -- satellite's own prize bank buys whole seats in its Diamond target at
      -- settlement, so its contract is complete with none promised. The test
      -- is fn_poker_diamond_tournament's, read from the row.
      OR (v_satellite_seats = 0 AND v_target IS NOT NULL AND v_row_union IS NULL
          AND EXISTS (SELECT 1 FROM public.clubs c
                       WHERE c.id = v_club AND c.asset = 'diamonds'
                         AND c.is_platform IS TRUE AND c.union_id IS NULL)
          AND public.fn_poker_diamond_tournament(v_target))
    );

  RETURN jsonb_build_object(
    'state', CASE
      WHEN v_status IN ('COMPLETED', 'CANCELLED', 'CANCELED') THEN 'closed'
      WHEN NOT v_complete THEN 'incomplete'
      WHEN v_enforce AND v_short > 0 THEN 'funding_blocked'
      ELSE 'ready'
    END,
    'can_start', v_status NOT IN ('COMPLETED', 'CANCELLED', 'CANCELED')
      AND v_complete
      AND (NOT v_enforce OR v_short = 0),
    'contract_locked', v_locked,
    'guarantee_enforced', v_enforce,
    'guaranteed_prize', v_guaranteed,
    'satellite_seat_guarantee', v_seat_guarantee,
    'effective_guarantee', v_effective_guarantee,
    'current_prize_pool', v_pool,
    'overlay_required', v_required,
    'bank_type', v_bank_type,
    'bank_balance', v_bank,
    'bank_floor', COALESCE(v_floor, 0),
    'other_live_exposure', COALESCE(v_exposure, 0),
    'short_by', v_short,
    'portfolio_short_by', v_portfolio_short
  );
END;
$function$;
ALTER FUNCTION public.fn_tournament_management_readiness_for_row(p_row jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_tournament_management_readiness_for_row(p_row jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_tournament_management_readiness_for_row(p_row jsonb) TO service_role;
-- @@END fn_tournament_management_readiness_for_row(p_row jsonb)

-- @@DOOR fn_register_horse_for_tournament_before_maintenance_gate(p_tournament_id uuid, p_user_id uuid)
-- @@PIN md5=7afb8f82f3d9de26ddec4d6c13ff9d45 len=13768 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_register_horse_for_tournament_before_maintenance_gate(p_tournament_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_original_entitlement uuid; v_original_wallet uuid;
  -- 20261005224736 / A18 'own_balance' + CLAUDE.md 10.5: a Diamond entry is
  -- custody, exactly as it is for a person. The unit decides the asset, read
  -- from the same function the human door reads it from.
  v_unit integer := public.fn_ca_tournament_unit_cents(p_tournament_id);
  v_dia jsonb;
  v_t record; v_username text;
  v_split record;
  v_is_bounty boolean; v_head numeric := 0;
  v_player_id uuid;
  v_is_horse boolean;
  v_ok boolean;
  v_late_open boolean := false;
  v_start_chips integer := 0;
  v_players_before integer;
  v_expected_cached_players integer;
  v_rows integer;
  v_seat jsonb := NULL;
  v_seat_reason text;
  v_led_cat text; v_led_cp text; v_led_ent text; v_led_tid text; -- CHIP STANDARD 1.2 2026-09-02
BEGIN
  SELECT is_horse INTO v_is_horse FROM public.profiles WHERE id = p_user_id;
  IF NOT COALESCE(v_is_horse, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_horse');
  END IF;

  SELECT id, status, buy_in_amount, buy_in_fee, max_players, current_players,
         club_id, name, is_bounty, is_pko, is_mystery_bounty,
         bounty_amount, start_time, early_bird_enabled, early_bird_chips,
         prize_pool_finalized
    INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'tournament_not_found'); END IF;

  -- THE HUMAN DOOR'S STATUS TEST (2026-09-11). A finalized pool takes no
  -- entrant and says so as a reason; a RUNNING event admits an entrant while
  -- its late registration is open, exactly as fn_register_for_tournament does.
  IF COALESCE(v_t.prize_pool_finalized, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'registration_closed');
  END IF;
  IF v_t.status = 'RUNNING' THEN
    v_late_open := public.fn_tournament_late_registration_open(p_tournament_id);
  END IF;
  IF v_t.status NOT IN ('ANNOUNCED', 'REGISTERING') AND NOT v_late_open THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'registration_closed');
  END IF;

  SELECT count(*)::integer INTO v_players_before
    FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.status::text IN ('registered','playing');
  IF v_t.current_players IS DISTINCT FROM v_players_before THEN
    RAISE EXCEPTION
      'Tournament roster cache diverged before horse registration (cached %, actual %)',
      v_t.current_players,v_players_before
      USING ERRCODE='P0404';
  END IF;
  /* ONE DEFINITION OF FULL (2026-09-06). This read `current_players >=
     max_players`, and on a seat-first event that column is overwritten with
     the live SEATED count - so an emptied seat read as a vacancy and this
     function walked back through the door, up to 32 paid entries into a
     two-handed sit-and-go. fn_enforce_tournament_capacity is the authority
     and would now refuse the insert outright; asking here keeps the refusal a
     reason rather than an exception, and rolls back nothing. */
  IF public.fn_tournament_entry_cap_reached(p_tournament_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_full');
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_players
              WHERE tournament_id = p_tournament_id AND user_id = p_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
  END IF;

  IF COALESCE(v_t.early_bird_enabled, false)
     AND now() < v_t.start_time
     AND COALESCE(v_t.early_bird_chips, 0) > 0 THEN
    v_start_chips := v_t.early_bird_chips;
  END IF;

  SELECT COALESCE(NULLIF(display_name, ''), NULLIF(username, ''), 'Player')
    INTO v_username FROM public.profiles WHERE id = p_user_id;

  v_is_bounty := COALESCE(v_t.is_bounty, false) OR COALESCE(v_t.is_pko, false)
                 OR COALESCE(v_t.is_mystery_bounty, false);

  SELECT * INTO v_split FROM public.fn_tournament_entry_split(
    v_t.buy_in_amount, v_t.buy_in_fee, v_t.bounty_amount, v_is_bounty);

  IF v_is_bounty AND v_split.prize < 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'misconfigured_bounty');
  END IF;

  -- MYSTERY BOUNTY 2026-08-25: no roll here either. A horse and a human must
  -- enter the same event on the same terms; when the two register functions
  -- disagreed about how a bounty head was set, they were two tournaments.
  IF v_is_bounty THEN
    v_head := v_split.bounty;
  END IF;

  IF v_split.charge > 0 AND v_unit = 100 THEN
    -- 20261005224736 / A18 'own_balance' + 10.5: THE HORSE PAYS THROUGH THE
    -- DOOR THE PERSON PAYS THROUGH. This arm is the human door's Diamond arm
    -- statement for statement, with the horse's own id in place of auth.uid().
    -- A Diamond entry is custody, not a club-wallet debit; the roster row is
    -- written after the charge and carries the id the custody row was named
    -- with. The horse's Diamonds are its own (profiles.diamonds, ruling 9) -
    -- no house money reaches this path, and the chip treasury funder (a
    -- chip account ruling 16 forbids in a Diamond format) is never called.
    IF v_split.charge <> trunc(v_split.charge) OR v_split.prize <> trunc(v_split.prize)
       OR v_split.rake <> trunc(v_split.rake) OR v_split.bounty <> trunc(v_split.bounty) THEN
      RAISE EXCEPTION 'diamond_tournament_requires_whole_amounts' USING ERRCODE = '23514';
    END IF;
    v_player_id := gen_random_uuid();
    BEGIN
      v_dia := public.fn_poker_diamond_tournament_charge(
        p_user_id, p_tournament_id, 'entry', v_split.charge, v_split.prize, v_split.bounty, v_split.rake,
        v_player_id, 'poker-tournament-entry:' || p_tournament_id::text || ':' || p_user_id::text || ':' || v_player_id::text);
    EXCEPTION WHEN OTHERS THEN
      -- An ordinary refusal is answered the way the chip core answers one,
      -- with a reason the caller can say; anything else is raised.
      IF SQLERRM LIKE '%insufficient_settled_diamonds%' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_diamonds');
      ELSIF SQLERRM LIKE '%diamond_tournaments_not_open%' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'diamond_tournaments_not_open');
      ELSIF SQLERRM LIKE '%diamond_debt_requires_settlement%' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'diamond_debt_requires_settlement');
      ELSIF SQLERRM LIKE '%diamond_tournament_entry_already_held%' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'already_registered');
      END IF;
      RAISE;
    END;
  ELSIF v_split.charge > 0 THEN
    -- CHIP STANDARD 1.2 (2026-09-02): THE HORSE DOOR DECLARES EXACTLY AS THE HUMAN
    -- DOOR (R11 - horses and humans are identical on every path). The wallet write
    -- below is journaled by trg_club_members_audit_chip_movement; undeclared it landed
    -- as adjustment player_wallet -> table_stack with no tournament. set_config, not
    -- fn_ca_declare_ledger, for the same reason as fn_register_for_tournament: a
    -- vocabulary miss must never refuse a buy-in. Restored right after the write.
    v_led_cat := current_setting('app.ledger_category', true);
    v_led_cp  := current_setting('app.ledger_counterparty', true);
    v_led_ent := current_setting('app.ledger_counterparty_entity', true);
    v_led_tid := current_setting('app.ledger_tournament', true);
    PERFORM set_config('app.ledger_category', 'tournament_buyin', true);
    PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_tournament_id::text, true);
    PERFORM set_config('app.ledger_tournament', p_tournament_id::text, true);
    PERFORM set_config('app.pnl_tournament_entitlement','',true);
    v_ok := public.atomic_deduct_wallet_and_log(
      p_user_id, v_split.charge, 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament'),
      NULL, NULL, p_tournament_id);
    v_original_entitlement:=NULLIF(current_setting('app.pnl_tournament_entitlement',true),'')::uuid;
    PERFORM set_config('app.ledger_category', COALESCE(v_led_cat, ''), true);
    PERFORM set_config('app.ledger_counterparty', COALESCE(v_led_cp, ''), true);
    PERFORM set_config('app.ledger_counterparty_entity', COALESCE(v_led_ent, ''), true);
    PERFORM set_config('app.ledger_tournament', COALESCE(v_led_tid, ''), true);
    IF NOT COALESCE(v_ok, false) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'insufficient_balance');
    END IF;
    PERFORM set_config('app.pnl_tournament_wallet_tx','',true);
    PERFORM public.log_wallet_transaction(
      p_user_id, 'PLAYER', v_split.charge, 'debit', 'tournament_buyin',
      'Tournament buy-in: ' || COALESCE(v_t.name, 'tournament'),
      NULL, NULL, p_tournament_id);
    v_original_wallet:=NULLIF(current_setting('app.pnl_tournament_wallet_tx',true),'')::uuid;
  END IF;

  BEGIN
    IF v_dia IS NOT NULL THEN
      -- 20261005224736: the roster row carries the id the custody row was
      -- named with, and the head rides on it as it does for a chip entry so
      -- the roster trigger does not seed it a second time. The human door's
      -- Diamond insert, with the horse's own id.
      INSERT INTO public.tournament_players
        (id, tournament_id, user_id, username, chips, status, current_bounty,
         mystery_bounty_value, bounties_collected, bounty_winnings)
      VALUES (v_player_id, p_tournament_id, p_user_id, COALESCE(v_username,'Player'),
              v_start_chips, 'registered', v_head, 0, 0, 0)
      RETURNING id INTO v_player_id;
    ELSIF v_is_bounty THEN
      INSERT INTO public.tournament_players
        (tournament_id, user_id, username, chips, status, current_bounty,
         mystery_bounty_value, bounties_collected, bounty_winnings)
      VALUES (p_tournament_id, p_user_id, COALESCE(v_username,'Player'), v_start_chips,
              'registered', v_head, 0, 0, 0)
      RETURNING id INTO v_player_id;
    ELSE
      INSERT INTO public.tournament_players (tournament_id, user_id, username, chips, status)
      VALUES (p_tournament_id, p_user_id, COALESCE(v_username,'Player'), v_start_chips, 'registered')
      RETURNING id INTO v_player_id;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION
      'Horse tournament registration identity changed after its atomic debit; retry the complete transaction'
      USING ERRCODE = '40001';
  END;

  IF v_split.rake > 0 AND v_t.club_id IS NOT NULL AND v_unit = 1 THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players, bbj_contribution,
       is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, v_t.club_id, v_split.rake, v_split.charge, 1, 0, true, p_tournament_id,
            'fn_register_horse_for_tournament',
            jsonb_build_object('kind','tournament_entry_fee','user_id',p_user_id,
                               'registration_id',v_player_id));
  END IF;

  -- The roster trigger refreshes the cached count while ANNOUNCED/REGISTERING
  -- and leaves RUNNING to the transaction that seats the late entrant - the
  -- same expectation the human core holds.
  v_expected_cached_players := CASE
    WHEN v_t.status IN ('ANNOUNCED','REGISTERING') THEN v_players_before + 1
    ELSE v_players_before
  END;
  UPDATE public.tournaments
     SET current_players = v_players_before + 1,
         prize_pool  = COALESCE(prize_pool, 0)  + v_split.prize,
         bounty_pool = COALESCE(bounty_pool, 0) + v_split.bounty,
         total_rake  = COALESCE(total_rake, 0)  + v_split.rake
   WHERE id = p_tournament_id
     AND current_players IS NOT DISTINCT FROM v_expected_cached_players;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION
      'Tournament roster cache changed during horse registration'
      USING ERRCODE='40001';
  END IF;

  -- LATE SEAT, as the human core does it: an entrant who cannot be seated is
  -- not charged - the 55000 abort rolls the debit, the roster row, the rake
  -- record and the pool increments back together.
  IF v_late_open THEN
    v_seat := public.fn_seat_late_registrant(p_tournament_id, p_user_id);
    v_seat_reason := v_seat->>'reason';
    IF NOT COALESCE((v_seat->>'ok')::boolean, false)
       AND COALESCE(v_seat_reason, '') <> 'already_seated_or_missing' THEN
      RAISE EXCEPTION
        'Late registration could not seat the player (%) - no charge has been made',
        COALESCE(v_seat_reason, 'unknown')
        USING ERRCODE = '55000';
    END IF;
  END IF;

  -- 20261005224736: the asset follows the unit, exactly as the human door
  -- records it. A chip entry still binds this transaction's actual debit IDs;
  -- a Diamond entry binds its custody receipt instead, which is what every
  -- later Diamond door reads.
  PERFORM public.fn_ca_record_tournament_participant_funding(v_player_id,'entry',NULL,
    v_split.charge,CASE WHEN v_unit=100 THEN 'diamonds' ELSE 'chips' END,
    v_original_entitlement,v_original_wallet,v_dia);

  RETURN jsonb_build_object('ok', true, 'registration_id', v_player_id,
    'cost', v_split.charge, 'prize_contribution', v_split.prize,
    'bounty_contribution', v_split.bounty, 'rake', v_split.rake,
    'late_registration', v_late_open,
    'asset', CASE WHEN v_dia IS NOT NULL THEN 'diamonds' ELSE 'chips' END,
    'diamonds_after', CASE WHEN v_dia IS NOT NULL
                           THEN (SELECT p.diamonds FROM public.profiles p WHERE p.id = p_user_id) END,
    'seat', v_seat);
END;
$function$;
ALTER FUNCTION public.fn_register_horse_for_tournament_before_maintenance_gate(p_tournament_id uuid, p_user_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_register_horse_for_tournament_before_maintenance_gate(p_tournament_id uuid, p_user_id uuid) FROM PUBLIC, anon, authenticated, service_role;
-- @@END fn_register_horse_for_tournament_before_maintenance_gate(p_tournament_id uuid, p_user_id uuid)

-- @@DOOR fn_register_horse_for_tournament(p_tournament_id uuid, p_user_id uuid, p_allow_wallet_charge boolean)
-- @@PIN md5=026901ecf8d4c4909cea685dc51c69ee len=2498 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_register_horse_for_tournament(p_tournament_id uuid, p_user_id uuid, p_allow_wallet_charge boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_gate jsonb;
BEGIN
  -- 20261005224736 / A18 (horse_entry_funding, recorded 2026-10-05) and
  -- CLAUDE.md 10.5 (HORSES ARE PLAYERS - NO EXCEPTIONS). The owner's answer
  -- reads: "a horse funds its Diamond entry from its own balance, through the
  -- ordinary Diamond registration door a person uses." So this is no longer a
  -- blanket refusal resting on a Phase-9 assumption; it is that answer, READ
  -- AT CALL TIME. Changing the answer is one INSERT into ca_diamond_economics
  -- and no code change - 'own_balance' is never hard-coded as the decision.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    DECLARE
      v_horse_entry_funding text;
    BEGIN
      BEGIN
        v_horse_entry_funding :=
          public.fn_ca_diamond_economic_text('horse_entry_funding','all');
      EXCEPTION WHEN SQLSTATE 'P0D01' THEN
        -- No answer recorded. Refuse by name below rather than guess which
        -- funding the owner meant.
        v_horse_entry_funding := NULL;
      END;
      IF v_horse_entry_funding = 'funding_account' THEN
        -- House money, and there is no funding path for it yet. Refused by
        -- name, and the reason names the setting that produced the refusal.
        RETURN jsonb_build_object('ok',false,
          'reason','diamond_horse_funding_account_not_open',
          'horse_entry_funding',v_horse_entry_funding);
      ELSIF v_horse_entry_funding IS DISTINCT FROM 'own_balance' THEN
        RETURN jsonb_build_object('ok',false,
          'reason','diamond_horse_entry_funding_unrecognised',
          'horse_entry_funding',v_horse_entry_funding);
      END IF;
      -- 'own_balance': fall through. The horse takes the same seat-acquisition
      -- lock and the same registration chain a person takes, and pays from its
      -- own profiles.diamonds through the same Diamond door (10.5).
    END;
  END IF;
  v_gate:=public.fn_ca_lock_tournament_seat_acquisition(
    p_tournament_id,NULL,p_user_id);
  IF COALESCE((v_gate->>'ok')::boolean,false) IS NOT TRUE THEN
    RETURN v_gate;
  END IF;
  RETURN public.fn_register_horse_for_tournament_before_terminal_gate(
    p_tournament_id,p_user_id,p_allow_wallet_charge);
END;
$function$;
ALTER FUNCTION public.fn_register_horse_for_tournament(p_tournament_id uuid, p_user_id uuid, p_allow_wallet_charge boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_register_horse_for_tournament(p_tournament_id uuid, p_user_id uuid, p_allow_wallet_charge boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_register_horse_for_tournament(p_tournament_id uuid, p_user_id uuid, p_allow_wallet_charge boolean) TO service_role;
-- @@END fn_register_horse_for_tournament(p_tournament_id uuid, p_user_id uuid, p_allow_wallet_charge boolean)

-- @@DOOR fn_settle_tournament_rake(p_tournament_id uuid, p_source text)
-- @@PIN md5=15acb041213e75e30cefdff37e04179b len=15073 owner=postgres
CREATE OR REPLACE FUNCTION public.fn_settle_tournament_rake(p_tournament_id uuid, p_source text DEFAULT 'engine'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
 v_t record;v_prior record;v_claimed int;v_plan jsonb;v_att jsonb;v_res jsonb;
 v_net numeric;v_union uuid;v_dest text;v_reason text;v_raw record;v_bank_id uuid;v_journal_id uuid;v_matches int;
 v_week_start timestamptz;v_week_end timestamptz;v_lock_key text;v_attempt int:=0;
BEGIN
 PERFORM public.fn_ca_lock_settlement_lane_global();
 SELECT t.id,t.status,t.club_id,t.union_id,t.is_private,t.name,t.current_players INTO v_t
  FROM public.tournaments t WHERE t.id=p_tournament_id FOR NO KEY UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','not_found'); END IF;
 IF upper(COALESCE(v_t.status,'')) NOT IN('COMPLETING','COMPLETED','CANCELLED','CANCELED') THEN
  RETURN jsonb_build_object('ok',false,'reason','not_terminal','status',v_t.status); END IF;
 PERFORM public.fn_ca_begin_legacy_fee_resolution(p_tournament_id);
 INSERT INTO public.tournament_rake_settlements(tournament_id,club_id,amount,destination,source)
 VALUES(p_tournament_id,v_t.club_id,0,'pending',COALESCE(p_source,'engine')) ON CONFLICT(tournament_id) DO NOTHING;
 GET DIAGNOSTICS v_claimed=ROW_COUNT;
 IF v_claimed=0 THEN
  SELECT * INTO v_prior FROM public.tournament_rake_settlements WHERE tournament_id=p_tournament_id;
  -- Historical claims do not authorize another fee transfer or a success
  -- claim unless their stored attribution actually completed.
  IF v_prior.settled_at IS NULL OR v_prior.attributed_at IS NULL
   OR v_prior.attributed_users IS NULL OR v_prior.attributed_users<0
   OR v_prior.attribution_error IS NOT NULL
   OR NULLIF(v_prior.destination,'') IS NULL OR v_prior.destination='pending' THEN
   RETURN jsonb_build_object('ok',false,'already_settled',true,
    'reason','settlement_attribution_incomplete','amount',v_prior.amount,
    'destination',v_prior.destination,'settled_at',v_prior.settled_at,'attributed',false);
  END IF;
  IF v_prior.amount>0 AND v_prior.union_id IS NULL AND NOT public.fn_poker_diamond_tournament(p_tournament_id)
   AND v_prior.destination IS DISTINCT FROM 'chip_retirement:'||v_prior.club_id::text THEN
   RAISE EXCEPTION 'tournament_fee_legacy_treasury_leg_requires_adjustment' USING ERRCODE='55000'; END IF;
  v_att:=public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id);
  IF v_prior.amount>0 AND v_prior.union_id IS NULL AND NOT public.fn_poker_diamond_tournament(p_tournament_id) AND v_att IS NULL THEN
   RAISE EXCEPTION 'tournament_fee_disposition_receipt_missing' USING ERRCODE='55000'; END IF;
  RETURN jsonb_build_object('ok',true,'already_settled',true,'amount',v_prior.amount,'destination',v_prior.destination,
    'settled_at',v_prior.settled_at,'attributed',true,'attributed_users',v_prior.attributed_users,
    'no_attribution_due',v_prior.amount=0,'accounting',v_att);
 END IF;
  -- DIAMOND PHASE 8: a Diamond event's fee sits in its custody rows, not in
  -- rake_records; it goes to the house, and then the emptied custody closes.
  IF public.fn_poker_diamond_tournament(p_tournament_id) THEN
    v_res := public.fn_poker_diamond_tournament_settle_fee(p_tournament_id, COALESCE(p_source, 'engine'));
    v_net := COALESCE((v_res->>'amount')::numeric, 0);
    UPDATE public.tournament_rake_settlements
       SET amount = v_net,
           destination = CASE WHEN v_net > 0 THEN 'diamond_house' ELSE 'none' END,
           settled_at = now(), attributed_at = now(), attributed_users = 0
     WHERE tournament_id = p_tournament_id;
    v_res := public.fn_poker_diamond_tournament_close_custody(p_tournament_id);
    RETURN jsonb_build_object('ok', true, 'amount', v_net,
      'destination', CASE WHEN v_net > 0 THEN 'diamond_house' ELSE 'none' END,
      'attributed', true, 'attributed_users', 0, 'members', 0, 'asset', 'diamonds',
      'custody_closed', v_res->>'closed', 'custody_still_held', v_res->>'still_held');
  END IF;

 -- Deferred capture is normally already committed. A same-transaction Spin
 -- close still captures the original exact charge before it can be recognized.
 FOR v_raw IN SELECT r.id FROM public.rake_records r WHERE r.tournament_id=p_tournament_id AND r.is_tournament
  AND r.rake_amount>0 AND r.created_at=transaction_timestamp()
  AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches b WHERE b.rake_record_id=r.id) ORDER BY r.id LOOP
  PERFORM public.fn_stamp_accounting_tournament_fee(v_raw.id);
 END LOOP;
 -- 2026-09-20. A fee charged BEFORE the cutover was never captured by a
 -- producer, and fn_ca_capture_tournament_fee_from_recorded_evidence - the
 -- reader built for exactly that record - was reachable only from
 -- fn_ca_begin_legacy_fee_resolution, which does nothing unless the event
 -- already holds a custody obligation, which only a named event can get.
 -- So the reader was never called for an event that was not on a list.
 -- Call it here, on the ordinary close, while the event is COMPLETING.
 -- Each capture takes its own subtransaction: one that cannot prove itself
 -- rolls back alone and leaves its record exactly as it was, so the net
 -- plan below still refuses in the same words and legacy custody still
 -- receives the same reason. This can only add proof, never remove it.
 FOR v_raw IN SELECT r.id FROM public.rake_records r
   JOIN public.accounting_tournament_fee_cutover c ON c.singleton
  WHERE r.tournament_id=p_tournament_id AND r.is_tournament
    AND r.rake_amount>0 AND r.hand_id IS NULL AND r.created_at<c.starts_at
    AND NOT EXISTS(SELECT 1 FROM public.accounting_tournament_fee_batches b WHERE b.rake_record_id=r.id)
  ORDER BY r.id LOOP
  BEGIN
   PERFORM public.fn_ca_capture_tournament_fee_from_recorded_evidence(v_raw.id);
  EXCEPTION WHEN OTHERS THEN
   -- Not silence: the reason travels to the log, and the refusal that
   -- follows is unchanged. "Could not prove it" is not "there was nothing".
   RAISE NOTICE 'pre-cutover fee % left uncaptured: % (%)', v_raw.id, SQLERRM, SQLSTATE;
  END;
 END LOOP;
 SELECT COALESCE(sum(r.rake_amount),0) INTO v_net FROM public.rake_records r WHERE r.tournament_id=p_tournament_id AND r.is_tournament;
 IF v_net<0 OR v_net<>round(v_net,2) OR v_net::text IN('NaN','Infinity','-Infinity') THEN
  RAISE EXCEPTION 'tournament_fee_net_invalid' USING ERRCODE='23514'; END IF;
 BEGIN
  -- Qualify only this owning close's complete original mixed-cutover Spin
  -- receipts. The original batch remains unchanged; any failure below rolls
  -- proof, source rows, claim, bank transfer and recognition back together.
  FOR v_raw IN SELECT r.id FROM public.rake_records r
   JOIN public.accounting_tournament_fee_batches b ON b.rake_record_id=r.id
   JOIN public.accounting_tournament_fee_cutover c ON c.singleton
   WHERE r.tournament_id=p_tournament_id AND r.is_tournament AND r.rake_amount>0
    AND r.source='fn_spin_book_entry' AND r.created_at>=c.starts_at
    AND b.status='legacy_unverified' AND b.source_manifest IS NULL ORDER BY r.id LOOP
   PERFORM public.fn_accounting_qualify_mixed_cutover_spin_fee(v_raw.id);
  END LOOP;
  v_plan:=public.fn_accounting_tournament_fee_net_plan(p_tournament_id);
 EXCEPTION WHEN SQLSTATE '55000' THEN
  IF SQLERRM NOT IN('tournament_fee_sources_require_reconciliation','accounting_terms_not_observed','accounting_terms_not_active','tournament_fee_not_captured_by_original_producer') THEN RAISE; END IF;
  v_reason:=SQLERRM;
  -- A new positive fee cannot leave custody before its exact attribution is
  -- available. Throw: direct callers must also roll back the inserted claim.
  IF v_net>0 THEN
   RAISE EXCEPTION 'tournament % rake attribution incomplete: %',p_tournament_id,v_reason USING ERRCODE='P0404';
  END IF;
  -- Exact zero owes no new attribution. Preserve the predecessor's zero-fee
  -- completion without inventing a source, bank, commission or paid receipt.
 END;
 v_union:=CASE WHEN v_reason IS NULL THEN NULLIF(v_plan->>'union_id','')::uuid
  WHEN v_t.is_private THEN NULL ELSE v_t.union_id END;
 PERFORM public.fn_lock_accounting_tournament_recognition_week(p_tournament_id,transaction_timestamp());
 -- A legacy event may have no captured contributor scope. Its actual bank
 -- still takes the exact same close lock, before either wallet is touched.
 v_week_start:=public.fn_union_week_start(transaction_timestamp());
 v_week_end:=((v_week_start AT TIME ZONE 'America/Los_Angeles')+interval '7 days') AT TIME ZONE 'America/Los_Angeles';
 v_lock_key:=CASE WHEN v_union IS NULL THEN 'club-accounting:'||v_t.club_id::text ELSE 'union-accounting:'||v_union::text END
  ||':'||extract(epoch FROM v_week_start)::text||':'||extract(epoch FROM v_week_end)::text;
 IF v_lock_key IS NOT NULL THEN PERFORM pg_advisory_xact_lock_shared(hashtextextended(v_lock_key,0)); END IF;
 IF EXISTS(SELECT 1 FROM public.accounting_routed_settlement_runs x WHERE x.period_start<=transaction_timestamp() AND x.period_end>transaction_timestamp()
   AND ((v_union IS NOT NULL AND x.union_id=v_union) OR(v_union IS NULL AND x.standalone_club_id=v_t.club_id))) THEN
  RAISE EXCEPTION 'tournament_accrual_closed_period_requires_adjustment' USING ERRCODE='23514'; END IF;
 IF v_net>0 THEN
  IF v_t.club_id IS NULL THEN RAISE EXCEPTION 'tournament_fee_bank_club_required' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM public.club_wallets WHERE club_id=v_t.club_id FOR NO KEY UPDATE;
  PERFORM set_config('app.ledger_category','rake',true);
  PERFORM set_config('app.ledger_counterparty','prize_liability',true);
  PERFORM set_config('app.ledger_counterparty_entity',p_tournament_id::text,true);
  /* THE TOURNAMENT RAKE LEG NAMES THE CLUB IT WAS EARNED IN (2026-09-21).
     The union fee is routed by UPDATE-ing union_wallets.rake_wallet through
     increment_union_wallet; fn_ca_autoledger journals that delta, and
     union_wallets has no club_id column, so every tournament union rake leg
     was written club-less. 20260920192513 taught the autoledger to read a
     declaring payer and fixed the PRIZE legs; 20260921040847 made the
     cash-table rake payer declare; this is the tournament rake payer saying
     the same thing. v_t.club_id is refused NULL above, and is the same club
     handed to increment_union_wallet for union_wallet_transactions.club_id,
     so the leg and its sibling receipt name one club or the fee does not
     move at all. NOT app.ledger_club_id: that name decides which club a
     WALLET credit is paid into (atomic_credit_wallet_and_log) and is set and
     restored by the rakeback close, so clearing it here would move money. */
  PERFORM set_config('app.ledger_autoledger_club_id',COALESCE(v_t.club_id::text,''),true);
  IF v_union IS NOT NULL THEN
   v_res:=public.increment_union_wallet(v_union,v_net,v_t.club_id,
    'Tournament rake: '||COALESCE(v_t.name,'tournament')||' [tournament '||p_tournament_id::text||']');
   IF COALESCE((v_res->>'success')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'tournament_fee_union_credit_failed' USING ERRCODE='23514'; END IF;
   SELECT count(*),(array_agg(id))[1] INTO v_matches,v_bank_id FROM public.union_wallet_transactions
    WHERE union_id=v_union AND club_id=v_t.club_id AND wallet='rake_wallet' AND direction='credit' AND tx_type='rake'
     AND amount=v_net AND created_at=transaction_timestamp() AND position('[tournament '||p_tournament_id::text||']' IN COALESCE(notes,''))>0;
   v_dest:='union:'||v_union::text;
  ELSE
   -- The original settlement-row trigger removes this exact fee from escrow.
   -- Retire that liability in the canonical journal; never debit a treasury or
   -- call fn_ca_burn, which would take these same chips from a wallet again.
   UPDATE public.clubs SET total_rake=COALESCE(total_rake,0)+v_net,updated_at=now()
    WHERE id=v_t.club_id;
   IF NOT FOUND THEN RAISE EXCEPTION 'tournament_fee_club_missing' USING ERRCODE='23514'; END IF;
   INSERT INTO public.chip_ledger
    (performed_by,from_type,from_entity_id,to_type,to_entity_id,club_id,tournament_id,category,amount,description)
   VALUES(COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
    'prize_liability',p_tournament_id,'chip_retirement',NULL,v_t.club_id,p_tournament_id,'burn',v_net,
    'Standalone tournament fee retired (fn_settle_tournament_rake)') RETURNING id INTO v_journal_id;
   v_matches:=1;
   v_dest:='chip_retirement:'||v_t.club_id::text;
  END IF;
  IF v_matches<>1 THEN RAISE EXCEPTION 'tournament_fee_exact_bank_receipt_required' USING ERRCODE='23514'; END IF;
  UPDATE public.club_wallets SET period_rake_collected=COALESCE(period_rake_collected,0)+v_net,
   lifetime_rake_collected=COALESCE(lifetime_rake_collected,0)+v_net,updated_at=now() WHERE club_id=v_t.club_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'tournament_fee_club_wallet_missing' USING ERRCODE='23514'; END IF;
  PERFORM set_config('app.ledger_autoledger_club_id','',true);
 ELSE v_dest:='none'; END IF;
 IF v_reason IS NULL THEN
  -- Preserve the installed bounded retry contract, now around the sole
  -- canonical recognition writer. Exhaustion and permanent errors escape the
  -- whole settlement; rolled-back attempts cannot retain partial attribution.
  LOOP
   v_attempt:=v_attempt+1;
   BEGIN
    v_att:=public.fn_recognize_accounting_tournament_fees(p_tournament_id,transaction_timestamp(),v_t.club_id,v_bank_id,v_journal_id);
    EXIT;
   EXCEPTION WHEN deadlock_detected OR lock_not_available THEN
    IF v_attempt>=4 THEN RAISE; END IF;
    PERFORM pg_sleep(CASE v_attempt WHEN 1 THEN 0.1 WHEN 2 THEN 0.3 ELSE 0.6 END);
   END;
  END LOOP;
  IF v_att->>'status' IS DISTINCT FROM (CASE WHEN v_net>0 THEN 'recognized' ELSE 'cancelled' END)
   OR (v_att->>'attributed_chips')::numeric IS DISTINCT FROM v_net
   OR (v_net>0 AND COALESCE((v_att->>'attributed_users')::int,0)<1) THEN
   RAISE EXCEPTION 'tournament % rake attribution incomplete: canonical source receipt',p_tournament_id USING ERRCODE='P0404';
  END IF;
 END IF;
 UPDATE public.tournament_rake_settlements SET amount=v_net,union_id=v_union,destination=v_dest,settled_at=transaction_timestamp(),
  attributed_at=transaction_timestamp(),attributed_users=COALESCE((v_att->>'attributed_users')::int,0),
  attribution_error=NULL WHERE tournament_id=p_tournament_id;
 IF EXISTS(SELECT 1 FROM public.accounting_tournament_fee_custody_resolutions WHERE tournament_id=p_tournament_id AND transaction_id=txid_current()) THEN
  UPDATE public.tournament_rake_settlements SET terminal_closed_at=(SELECT completed_at FROM public.tournament_terminal_settlements WHERE tournament_id=p_tournament_id) WHERE tournament_id=p_tournament_id AND terminal_closed_at IS NULL;
 END IF;
 RETURN jsonb_build_object('ok',true,'amount',v_net,'destination',v_dest,'attributed',true,
  'attributed_users',COALESCE((v_att->>'attributed_users')::int,0),'attribution_attempts',v_attempt,
  'no_attribution_due',v_net=0,'accounting',public.fn_accounting_tournament_terminal_fee_receipt(p_tournament_id));
END;
$function$;
ALTER FUNCTION public.fn_settle_tournament_rake(p_tournament_id uuid, p_source text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_settle_tournament_rake(p_tournament_id uuid, p_source text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_settle_tournament_rake(p_tournament_id uuid, p_source text) TO service_role;
-- @@END fn_settle_tournament_rake(p_tournament_id uuid, p_source text)

