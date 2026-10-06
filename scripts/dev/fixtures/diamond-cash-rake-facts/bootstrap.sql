\set ON_ERROR_STOP on
\set VERBOSITY verbose

-- ═══════════════════════════════════════════════════════════════════════════
--  THE SMALLEST DATABASE A DIAMOND CASH HAND CAN SETTLE IN
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Disposable local PostgreSQL 17 only. Every object here is synthetic; the
-- economics rows are the owner's published answers as production holds them
-- on 2026-10-05, and the three reader functions are production's own source.
-- The settler itself is NOT written here: the probe extracts it verbatim from
-- supabase/migrations/20261005183028_diamond_cash_rake_reads_the_owner_settings.sql
-- so these scenarios exercise the definition production is running.

DO $preflight$
BEGIN
  IF current_user <> 'postgres'
     OR current_setting('server_version_num')::integer / 10000 <> 17
     OR NOT (inet_server_addr() IS NULL
             OR inet_server_addr() <<= inet '127.0.0.0/8'
             OR inet_server_addr() = inet '::1') THEN
    RAISE EXCEPTION 'DIAMOND_RAKE_FACTS_FIXTURE_REQUIRES_DISPOSABLE_LOCAL_PG17';
  END IF;
END $preflight$;

CREATE TABLE public.profiles (id uuid PRIMARY KEY);
CREATE TABLE public.clubs (
  id uuid PRIMARY KEY, asset text, is_platform boolean, union_id uuid);
CREATE TABLE public.tables (
  id uuid PRIMARY KEY, club_id uuid REFERENCES public.clubs(id),
  big_blind numeric, union_id uuid, tournament_id uuid, game_variant text);
CREATE TABLE public.table_seats (
  id uuid PRIMARY KEY, table_id uuid, user_id uuid, joined_at timestamptz,
  left_at timestamptz, stack numeric(15,2), occupancy_id uuid, seat_number integer);
CREATE TABLE public.poker_diamond_custody (
  id uuid PRIMARY KEY, user_id uuid, arena_id uuid, purpose text,
  target_id uuid, entry_key text, balance bigint, state text,
  created_at timestamptz DEFAULT now(), released_at timestamptz,
  seat_id uuid, seat_joined_at timestamptz, occupancy_id uuid);
CREATE TABLE public.diamond_purchase_lots (
  id uuid PRIMARY KEY, user_id uuid, purchase_id uuid, issued integer,
  consumed integer, refunded integer, frozen_at timestamptz,
  settled_at timestamptz, created_at timestamptz DEFAULT now(),
  arena_reserved bigint);
CREATE TABLE public.poker_diamond_lot_reservations (
  custody_id uuid, lot_id uuid, amount bigint, released_at timestamptz,
  consumed bigint);
CREATE TABLE public.poker_diamond_hand_receipts (
  table_id uuid, hand_number bigint, request jsonb, receipt jsonb,
  created_at timestamptz DEFAULT now(), PRIMARY KEY (table_id, hand_number));
CREATE TABLE public.ca_diamond_rake_accrual (
  id bigserial PRIMARY KEY, table_id uuid, hand_number bigint, arena_id uuid,
  user_id uuid, kind text, amount bigint, swept_at timestamptz,
  sweep_id uuid, created_at timestamptz DEFAULT now());
CREATE TABLE public.ca_diamond_economics (
  id bigserial PRIMARY KEY, name text, scope text, value numeric,
  value_text text, units text, approved_quote text, basis text,
  approved_on date, recorded_by text, recorded_at timestamptz DEFAULT now());

-- ── production source: the economics readers ─────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_economics_units_of(p_name text)
 RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE p_name
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
    WHEN 'rake_earns_vip_points'                  THEN 'boolean'
  END
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_economic(p_name text, p_scope text DEFAULT 'all'::text)
 RETURNS numeric LANGUAGE plpgsql STABLE SET search_path TO 'public', 'pg_temp'
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

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_economic_text(p_name text, p_scope text DEFAULT 'all'::text)
 RETURNS text LANGUAGE plpgsql STABLE SET search_path TO 'public', 'pg_temp'
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

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_economic_on(p_name text, p_scope text DEFAULT 'all'::text)
 RETURNS boolean LANGUAGE sql STABLE SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT public.fn_ca_diamond_economic_text(p_name, p_scope) = 'yes'
$function$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_cash_variant(p_variant text)
 RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT p_variant IS NOT NULL
     AND p_variant IN ('nlh','plo4','plo5','plo6','plo8','pineapple','short_deck','flh','flo8');
$function$;

-- ── the owner's published answers, as production holds them 2026-10-05 ───
INSERT INTO public.ca_diamond_economics (name, scope, value, value_text, units) VALUES
  ('cash_rake_enabled',             'all',      NULL, 'yes',  'boolean'),
  ('cash_rake_no_flop_no_drop',     'all',      NULL, 'yes',  'boolean'),
  ('cash_rake_rounding',            'all',      NULL, 'down', 'choice'),
  ('cash_rake_destination',         'all',      NULL, 'ca_diamond_house', 'account'),
  ('cash_rake_min_pot',             'all',         0,  NULL,  'diamonds'),
  ('cash_rake_percent',             'all',        10,  NULL,  'percent'),
  ('cash_rake_percent_heads_up',    'all',         5,  NULL,  'percent'),
  ('cash_rake_percent_three_handed','all',        10,  NULL,  'percent'),
  ('cash_rake_cap',                 'bb:2',       30,  NULL,  'diamonds_per_hand'),
  ('cash_rake_cap_three_handed',    'bb:2',       30,  NULL,  'diamonds_per_hand'),
  ('cash_rake_cap_heads_up',        'bb:2',       15,  NULL,  'diamonds_per_hand'),
  ('cash_rake_cap',                 'bb:5',       75,  NULL,  'diamonds_per_hand'),
  ('cash_rake_cap_three_handed',    'bb:5',       75,  NULL,  'diamonds_per_hand'),
  ('cash_rake_cap_heads_up',        'bb:5',       37,  NULL,  'diamonds_per_hand'),
  ('cash_rake_cap',                 'bb:10000', 2000,  NULL,  'diamonds_per_hand'),
  ('cash_rake_cap_three_handed',    'bb:10000', 2000,  NULL,  'diamonds_per_hand'),
  ('cash_rake_cap_heads_up',        'bb:10000', 1000,  NULL,  'diamonds_per_hand'),
  ('rakeback_percent',              'all',         0,  NULL,  'percent'),
  ('rake_earns_vip_points',         'all',      NULL, 'no',   'boolean');

-- ── one Diamond arena, two plain cash tables, three seats ────────────────
INSERT INTO public.clubs (id, asset, is_platform, union_id)
VALUES ('11111111-1111-1111-1111-111111111111','diamonds',true,NULL);
INSERT INTO public.tables (id, club_id, big_blind, union_id, tournament_id, game_variant) VALUES
  ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111',2,NULL,NULL,'nlh'),
  ('22222222-2222-2222-2222-222222222225','11111111-1111-1111-1111-111111111111',5,NULL,NULL,'nlh');
INSERT INTO public.profiles (id) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001'),
  ('bbbbbbbb-0000-0000-0000-000000000002'),
  ('cccccccc-0000-0000-0000-000000000003');

-- A helper that seats a player with the custody and purchased-lot backing the
-- settler consumes, so the lot arithmetic is exercised rather than skipped.
CREATE FUNCTION pg_temp.seat(
  p_table uuid, p_user uuid, p_seat uuid, p_occupancy uuid,
  p_joined timestamptz, p_stack bigint, p_seat_number integer)
RETURNS void LANGUAGE plpgsql AS $seat$
DECLARE v_custody uuid := gen_random_uuid(); v_lot uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.table_seats (id,table_id,user_id,joined_at,left_at,stack,occupancy_id,seat_number)
  VALUES (p_seat,p_table,p_user,p_joined,NULL,p_stack,p_occupancy,p_seat_number);
  INSERT INTO public.poker_diamond_custody
    (id,user_id,arena_id,purpose,target_id,balance,state,seat_id,seat_joined_at,occupancy_id)
  VALUES (v_custody,p_user,(SELECT club_id FROM public.tables WHERE id=p_table),
          'cash_seat',p_table,p_stack,'active',p_seat,p_joined,p_occupancy);
  INSERT INTO public.diamond_purchase_lots
    (id,user_id,issued,consumed,refunded,arena_reserved,created_at)
  VALUES (v_lot,p_user,p_stack,0,0,p_stack,now());
  INSERT INTO public.poker_diamond_lot_reservations
    (custody_id,lot_id,amount,released_at,consumed)
  VALUES (v_custody,v_lot,p_stack,NULL,0);
END $seat$;
