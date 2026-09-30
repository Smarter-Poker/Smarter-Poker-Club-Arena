-- ===========================================================================
--  THE WORLD THE DISPOSAL DOOR READS
-- ===========================================================================
--
-- Captured from production (kuklfnapbkmacvwxktbh) on 2026-09-28 for the law
-- test of 20260928001934_a_hand_the_table_has_already_dealt_past_is_disposed.
--
-- CAPTURED, NOT INVENTED: every table below is generated from pg_attribute and
-- pg_constraint of the live schema - exact column order, types, NOT NULLs,
-- defaults, generated columns, primary keys, unique and check constraints. The
-- door under test reads these columns and nothing else decides its answer, so
-- a stub with a guessed shape would pin a fiction.
--
-- DELIBERATELY ABSENT: foreign keys and business triggers. This test asks one
-- question - does the door dispose only what it can prove is dead, and does
-- the table then start - and that question is answered from rows in these
-- tables. Referential integrity is a different law with its own tests.
--
-- A STAND-IN, AND SAID SO: the four functions at the foot of this file marked
-- "test stand-in". Each is a leaf the door calls but does not reason about (a
-- lane share, a staleness constant, a freeze flag, an F06 prefix).
-- smarter_private.hand_submission_immutable() is NOT a stand-in: it is the
-- live definition, byte for byte, because the migration hangs the receipt
-- table's immutability triggers on it and that behaviour is under test.
--
-- auth.role() reads request.jwt.claim.role, which is how every other database
-- law test in this repo drives Supabase role checks.

-- The Supabase roles the migration REVOKEs from and GRANTs to. A bare cluster
-- has none of them, and a migration that cannot name them cannot be tested.
DO $roles$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;
  END LOOP;
END $roles$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS smarter_private;

-- public.table_seats defaults its id with uuid_generate_v4(); the extension is
-- not installed in a bare cluster and the door never reads that column.
CREATE OR REPLACE FUNCTION public.uuid_generate_v4() RETURNS uuid
  LANGUAGE sql VOLATILE AS $$ SELECT gen_random_uuid() $$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.role', true) $$;

-- public.tables defaults f06_lifecycle from this sequence. Captured: the live
-- definition is exactly this, over smarter_private.f06_lifecycle_seq.
CREATE SEQUENCE IF NOT EXISTS smarter_private.f06_lifecycle_seq;
CREATE OR REPLACE FUNCTION smarter_private.f06_new_lifecycle()
 RETURNS bigint
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$ SELECT nextval('smarter_private.f06_lifecycle_seq') $function$;

CREATE TABLE public.engine_table_leases (
  table_id uuid NOT NULL,
  instance_id text NOT NULL,
  engine_version text,
  acquired_at timestamp with time zone NOT NULL DEFAULT now(),
  heartbeat_at timestamp with time zone NOT NULL DEFAULT now(),
  lease_generation uuid NOT NULL DEFAULT gen_random_uuid(),
  protocol_version integer NOT NULL DEFAULT 1,
  CONSTRAINT engine_table_leases_pkey PRIMARY KEY (table_id),
  CONSTRAINT engine_table_leases_protocol_version_check CHECK ((protocol_version = ANY (ARRAY[1, 2])))
);

CREATE TABLE public.engine_tournament_leases (
  tournament_id uuid NOT NULL,
  instance_id text NOT NULL,
  engine_version text,
  acquired_at timestamp with time zone NOT NULL DEFAULT now(),
  heartbeat_at timestamp with time zone NOT NULL DEFAULT now(),
  lease_generation uuid NOT NULL DEFAULT gen_random_uuid(),
  protocol_version integer NOT NULL DEFAULT 1,
  CONSTRAINT engine_tournament_leases_pkey PRIMARY KEY (tournament_id),
  CONSTRAINT engine_tournament_leases_protocol_version_check CHECK ((protocol_version = ANY (ARRAY[1, 2])))
);

CREATE TABLE public.hand_atomic_commits (
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  hand_id uuid NOT NULL,
  payload_hash text NOT NULL,
  stack_result jsonb NOT NULL,
  committed_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  post_commit_payload jsonb,
  post_commit_request_hash text,
  post_commit_payload_hash text,
  post_commit_completed_at timestamp with time zone,
  post_commit_result jsonb,
  CONSTRAINT hand_atomic_commits_hand_id_key UNIQUE (hand_id),
  CONSTRAINT hand_atomic_commits_hand_number_check CHECK ((hand_number >= 1000000)),
  CONSTRAINT hand_atomic_commits_hand_number_key UNIQUE (hand_number),
  CONSTRAINT hand_atomic_commits_payload_hash_check CHECK ((payload_hash ~ '^[0-9a-f]{64}$'::text)),
  CONSTRAINT hand_atomic_commits_pkey PRIMARY KEY (table_id, hand_number)
);

CREATE TABLE public.hand_history (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  winner_name text,
  pot_size numeric(12,2),
  created_at timestamp with time zone DEFAULT now(),
  table_id uuid,
  tournament_id uuid,
  hand_number integer,
  game_variant text DEFAULT 'nlh'::text,
  small_blind numeric(12,2) DEFAULT 0,
  big_blind numeric(12,2) DEFAULT 0,
  rake_amount numeric(12,2) DEFAULT 0,
  community_cards text[],
  winners jsonb,
  players jsonb DEFAULT '[]'::jsonb,
  actions jsonb DEFAULT '[]'::jsonb,
  summary text,
  bbj_amount numeric(12,2) NOT NULL DEFAULT 0,
  source text DEFAULT 'manual'::text,
  hand_name text,
  seed text,
  version text DEFAULT 'v1'::text,
  started_at timestamp with time zone DEFAULT now(),
  ended_at timestamp with time zone,
  hole_cards jsonb,
  board jsonb,
  reported boolean NOT NULL DEFAULT false,
  reported_at timestamp with time zone,
  button_seat smallint,
  has_human boolean,
  community_cards2 text[],
  pots jsonb,
  showdown jsonb,
  rit_boards jsonb,
  community_cards3 text[],
  bomb_pot jsonb,
  daily_mission_events jsonb,
  winners_by_board jsonb,
  kill_pot jsonb,
  CONSTRAINT hand_history_kill_pot_is_object CHECK (((kill_pot IS NULL) OR (jsonb_typeof(kill_pot) = 'object'::text))) NOT VALID,
  CONSTRAINT hand_history_pkey PRIMARY KEY (id)
);

CREATE TABLE public.hand_state_snapshots (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL,
  hand_number integer NOT NULL,
  state_json jsonb NOT NULL,
  config_json jsonb NOT NULL,
  dealer_seat integer NOT NULL,
  players_json jsonb NOT NULL,
  stage text NOT NULL DEFAULT 'preflop'::text,
  is_complete boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  pending_deadlines jsonb NOT NULL DEFAULT '[]'::jsonb,
  disconnect_states jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT hand_state_snapshots_pkey PRIMARY KEY (id)
);

CREATE TABLE public.table_seats (
  id uuid NOT NULL DEFAULT uuid_generate_v4(),
  table_id uuid NOT NULL,
  seat_number integer NOT NULL,
  user_id uuid,
  player_id integer,
  member_id uuid,
  stack numeric(15,2) DEFAULT 0,
  is_sitting_out boolean DEFAULT false,
  is_away boolean DEFAULT false,
  joined_at timestamp with time zone DEFAULT now(),
  horse_id uuid,
  scheduled_leave_hands integer,
  left_at timestamp with time zone,
  status text DEFAULT 'active'::text,
  leave_pending boolean DEFAULT false,
  auto_rebuy boolean DEFAULT false,
  time_bank_remaining integer DEFAULT 30,
  time_bank_uses_remaining integer DEFAULT 4,
  club_id uuid,
  sit_out_at timestamp with time zone,
  entry_hold text,
  entry_post_agreed boolean NOT NULL DEFAULT false,
  occupancy_id uuid NOT NULL DEFAULT gen_random_uuid(),
  active_game_scope text,
  active_parent_key text,
  terminal_closed_at timestamp with time zone,
  CONSTRAINT active_seat_requires_game_scope CHECK ((((left_at IS NULL) AND (active_game_scope IS NOT NULL) AND (user_id IS NOT NULL) AND (table_id IS NOT NULL)) OR ((left_at IS NOT NULL) AND (active_game_scope IS NULL)))),
  CONSTRAINT active_seat_requires_open_parent CHECK ((((left_at IS NULL) AND (active_parent_key IS NOT NULL) AND (active_parent_key <> 'closed'::text)) OR ((left_at IS NOT NULL) AND (active_parent_key IS NULL)))),
  CONSTRAINT one_committed_seat_per_game_player UNIQUE (user_id, active_game_scope) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT table_seats_entry_hold_check CHECK (((entry_hold IS NULL) OR (entry_hold = ANY (ARRAY['waiting'::text, 'posting'::text, 'moved'::text])))),
  CONSTRAINT table_seats_pkey PRIMARY KEY (id),
  CONSTRAINT table_seats_seat_number_check CHECK (((seat_number >= 1) AND (seat_number <= 10))),
  CONSTRAINT table_seats_stack_nonneg CHECK ((stack >= (0)::numeric)),
  CONSTRAINT table_seats_table_id_seat_number_key UNIQUE (table_id, seat_number)
);

CREATE TABLE public.tables (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  club_id uuid,
  name text NOT NULL,
  game_type text DEFAULT 'nlhe'::text,
  stakes text,
  small_blind numeric(15,2) DEFAULT 1,
  big_blind numeric(15,2) DEFAULT 2,
  min_buy_in numeric(15,2) DEFAULT 40,
  max_buy_in numeric(15,2) DEFAULT 200,
  max_players integer DEFAULT 9,
  current_players integer DEFAULT 0,
  status text DEFAULT 'waiting'::text,
  is_private boolean DEFAULT false,
  settings jsonb DEFAULT '{}'::jsonb,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  game_variant text DEFAULT 'nlh'::text,
  enable_straddle boolean DEFAULT true,
  run_it_twice boolean DEFAULT true,
  auto_muck boolean DEFAULT true,
  ante numeric(15,2) DEFAULT 0,
  allow_rabbit_hunt boolean DEFAULT true,
  allow_run_it_twice boolean DEFAULT true,
  allow_straddle boolean DEFAULT true,
  game_mode character varying(10) DEFAULT 'regular'::character varying,
  is_vip_only boolean DEFAULT false,
  is_anonymous boolean DEFAULT false,
  ban_chat boolean DEFAULT false,
  label_as_new boolean DEFAULT false,
  is_featured boolean DEFAULT false,
  hide_club_name boolean DEFAULT false,
  is_template boolean DEFAULT false,
  bomb_pot_enabled boolean DEFAULT false,
  double_board boolean DEFAULT false,
  triple_board boolean DEFAULT false,
  pineapple_holdem boolean DEFAULT false,
  seven_deuce_enabled boolean DEFAULT false,
  nit_game boolean DEFAULT false,
  cap_enabled boolean DEFAULT false,
  no_rathole boolean DEFAULT false,
  action_time_seconds integer DEFAULT 15,
  ante_bb numeric(10,2) DEFAULT 0,
  career_percent_min integer DEFAULT 0,
  maintain_percent_min integer DEFAULT 0,
  maintain_hands integer DEFAULT 10,
  auto_start_players integer DEFAULT 2,
  game_length_hours integer DEFAULT 12,
  created_by uuid,
  calltime_enabled boolean DEFAULT false,
  auto_extension boolean DEFAULT false,
  auto_restart boolean DEFAULT false,
  auto_create_table boolean DEFAULT false,
  auto_utg_straddle boolean DEFAULT false,
  voluntary_straddle boolean DEFAULT false,
  insurance_enabled boolean DEFAULT false,
  run_it_mode character varying(20) DEFAULT 'none'::character varying,
  rake_percent numeric(5,2) DEFAULT '-1'::integer,
  rake_cap_bb numeric(5,2) DEFAULT '-1'::integer,
  agent_downline_limit integer,
  buy_in_authorization boolean DEFAULT false,
  restrict_device boolean DEFAULT true,
  restrict_observers boolean DEFAULT false,
  gps_restriction boolean DEFAULT true,
  ip_restriction boolean DEFAULT false,
  pc_emulator_restriction boolean DEFAULT false,
  photo_rotation_verification boolean DEFAULT false,
  short_description text DEFAULT ''::text,
  accelerated_mtt boolean DEFAULT false,
  all_in_or_fold boolean DEFAULT false,
  custom_rebuy_reentry_cost boolean DEFAULT false,
  number_of_rebuys_reentries integer DEFAULT 3,
  add_on_multiplier numeric(3,1) DEFAULT 1.0,
  custom_add_on boolean DEFAULT false,
  add_on_break_length_minutes integer DEFAULT 1,
  ko_bounty boolean DEFAULT false,
  gtd_prize_pool boolean DEFAULT false,
  final_table_deal boolean DEFAULT false,
  big_blind_ante boolean DEFAULT false,
  authorized_to_register boolean DEFAULT false,
  late_registration_level integer DEFAULT 6,
  early_bird_registration boolean DEFAULT false,
  bubble_protection boolean DEFAULT false,
  featured_tournament boolean DEFAULT false,
  min_players_mtt integer DEFAULT 30,
  max_players_mtt integer DEFAULT 300,
  multi_day_mtt boolean DEFAULT false,
  save_start_time boolean DEFAULT false,
  start_time timestamp with time zone,
  restart_tournament_every boolean DEFAULT false,
  tournament_schedule boolean DEFAULT false,
  synchronized_breaks boolean DEFAULT true,
  sng_buy_in numeric(10,2) DEFAULT 0,
  blind_structure character varying(20) DEFAULT 'standard'::character varying,
  payout_structure character varying(50) DEFAULT 'winner_takes_all'::character varying,
  starting_chips integer DEFAULT 1500,
  blinds_up_minutes integer DEFAULT 10,
  next_step_satellite boolean DEFAULT false,
  sng_custom_buy_in boolean DEFAULT false,
  sng_player_count integer DEFAULT 9,
  is_spins boolean DEFAULT false,
  spins_multiplier integer,
  is_deleted boolean DEFAULT false,
  deleted_at timestamp with time zone,
  deleted_by uuid,
  bbj_percent numeric(5,2) DEFAULT 100,
  tournament_id uuid,
  live_state jsonb,
  union_id uuid,
  big_blind_ante_enabled boolean DEFAULT false,
  straddle_enabled boolean DEFAULT false,
  straddle_type text DEFAULT 'utg'::text,
  max_straddles integer DEFAULT 1,
  run_it_twice_enabled boolean DEFAULT false,
  auto_muck_enabled boolean DEFAULT true,
  show_hand_enabled boolean DEFAULT true,
  disconnect_timeout_seconds integer DEFAULT 30,
  max_consecutive_timeouts integer DEFAULT 3,
  prefer_check_over_fold boolean DEFAULT true,
  time_bank_max_uses integer DEFAULT 4,
  time_bank_enabled boolean DEFAULT true,
  ante_enabled boolean DEFAULT false,
  bomb_pot_frequency integer DEFAULT 0,
  bomb_pot_ante_multiplier integer DEFAULT 2,
  wait_for_big_blind boolean NOT NULL DEFAULT true,
  seven_deuce_amount numeric NOT NULL DEFAULT 2,
  hands_dealt bigint NOT NULL DEFAULT 0,
  avg_pot numeric(14,2) NOT NULL DEFAULT 0,
  bomb_pot_double_board boolean NOT NULL DEFAULT false,
  cap_bb numeric(10,2),
  bomb_pot_board_count smallint NOT NULL DEFAULT 1,
  bomb_pot_trigger_mode text NOT NULL DEFAULT 'every_n_hands'::text,
  bomb_pot_interval_seconds integer,
  bomb_pot_min_players smallint NOT NULL DEFAULT 3,
  bomb_pot_ante_fixed numeric,
  first_button_seat integer,
  bomb_pot_variant text,
  bomb_pot_next_due_at timestamp with time zone,
  bomb_pot_sched_state jsonb,
  bomb_pot_manual_pending boolean NOT NULL DEFAULT false,
  bomb_pot_button_policy text NOT NULL DEFAULT 'regular'::text,
  bomb_pot_announce_seconds integer,
  min_buy_in_bb integer GENERATED ALWAYS AS (
CASE
    WHEN ((tournament_id IS NULL) AND (COALESCE(big_blind, (0)::numeric) > (0)::numeric) AND (min_buy_in IS NOT NULL)) THEN (ceil((min_buy_in / big_blind)))::integer
    ELSE NULL::integer
END) STORED,
  max_buy_in_bb integer GENERATED ALWAYS AS (
CASE
    WHEN ((tournament_id IS NULL) AND (COALESCE(big_blind, (0)::numeric) > (0)::numeric) AND (max_buy_in IS NOT NULL)) THEN (floor((max_buy_in / big_blind)))::integer
    ELSE NULL::integer
END) STORED,
  min_buyin integer GENERATED ALWAYS AS (
CASE
    WHEN ((tournament_id IS NULL) AND (COALESCE(big_blind, (0)::numeric) > (0)::numeric) AND (min_buy_in IS NOT NULL)) THEN (ceil((min_buy_in / big_blind)))::integer
    ELSE NULL::integer
END) STORED,
  max_buyin integer GENERATED ALWAYS AS (
CASE
    WHEN ((tournament_id IS NULL) AND (COALESCE(big_blind, (0)::numeric) > (0)::numeric) AND (max_buy_in IS NOT NULL)) THEN (floor((max_buy_in / big_blind)))::integer
    ELSE NULL::integer
END) STORED,
  cluster_id uuid,
  role text,
  main_index integer,
  lifecycle text,
  opened_at timestamp with time zone,
  live_at timestamp with time zone,
  break_started_at timestamp with time zone,
  break_eligible_since timestamp with time zone,
  promote_pending boolean NOT NULL DEFAULT false,
  observer_show_cards boolean NOT NULL DEFAULT false,
  terminal_closed_at timestamp with time zone,
  seat_game_scope text,
  seat_admission_key text,
  f06_lifecycle bigint NOT NULL DEFAULT smarter_private.f06_new_lifecycle(),
  dealing_halted_at timestamp with time zone,
  dealing_halted_reason text,
  kill_mode text NOT NULL DEFAULT 'off'::text,
  kill_threshold_bb smallint NOT NULL DEFAULT 10,
  dealing_halt_observed_at timestamp with time zone,
  CONSTRAINT table_game_scope_is_derived CHECK (((seat_game_scope IS NULL) OR (seat_game_scope =
CASE
    WHEN (cluster_id IS NULL) THEN ('table:'::text || (id)::text)
    ELSE ('cluster:'::text || (cluster_id)::text)
END))),
  CONSTRAINT table_game_scope_parent_key UNIQUE (id, seat_game_scope),
  CONSTRAINT table_seat_admission_is_derived CHECK (((seat_admission_key IS NULL) OR (seat_admission_key =
CASE
    WHEN ((lower(COALESCE(status, ''::text)) = ANY (ARRAY['closed'::text, 'completed'::text, 'cancelled'::text, 'finished'::text])) OR (lifecycle = 'closed'::text) OR COALESCE(is_deleted, false) OR COALESCE(is_template, false)) THEN 'closed'::text
    WHEN (tournament_id IS NOT NULL) THEN ('tournament:'::text || (tournament_id)::text)
    ELSE 'cash'::text
END))),
  CONSTRAINT table_seat_admission_parent_key UNIQUE (id, seat_admission_key),
  CONSTRAINT tables_bomb_pot_board_count_check CHECK (((bomb_pot_board_count >= 1) AND (bomb_pot_board_count <= 3))),
  CONSTRAINT tables_bomb_pot_button_policy_check CHECK ((bomb_pot_button_policy = ANY (ARRAY['regular'::text, 'separate'::text]))),
  CONSTRAINT tables_bomb_pot_trigger_mode_check CHECK ((bomb_pot_trigger_mode = ANY (ARRAY['every_n_hands'::text, 'once_per_orbit'::text, 'timed'::text, 'bomb_pot_only'::text]))),
  CONSTRAINT tables_bomb_pot_variant_check CHECK (((bomb_pot_variant IS NULL) OR ((bomb_pot_variant = ANY (ARRAY['nlh'::text, 'plo4'::text, 'plo5'::text, 'plo6'::text, 'flh'::text, 'flo8'::text])) AND ((lower(COALESCE(game_variant, 'nlh'::text)) = ANY (ARRAY['flh'::text, 'flo8'::text])) = (bomb_pot_variant = ANY (ARRAY['flh'::text, 'flo8'::text])))))),
  CONSTRAINT tables_cash_needs_a_game CHECK (((tournament_id IS NOT NULL) OR (cluster_id IS NOT NULL) OR (status = ANY (ARRAY['closed'::text, 'deleted'::text])) OR COALESCE(is_deleted, false) OR (club_id IS NULL) OR (game_variant IS NULL) OR (COALESCE(small_blind, (0)::numeric) <= (0)::numeric) OR (COALESCE(big_blind, (0)::numeric) <= COALESCE(small_blind, (0)::numeric)) OR (club_id = '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid))),
  CONSTRAINT tables_dealing_halt_is_explained CHECK ((((dealing_halted_at IS NULL) AND (dealing_halted_reason IS NULL)) OR ((dealing_halted_at IS NOT NULL) AND (dealing_halted_reason IS NOT NULL) AND (dealing_halted_reason = ANY (ARRAY['lightning_pending_on'::text, 'lightning'::text]))))),
  CONSTRAINT tables_game_type_is_format CHECK ((game_type = ANY (ARRAY['cash'::text, 'tournament'::text]))),
  CONSTRAINT tables_kill_mode_check CHECK ((kill_mode = ANY (ARRAY['off'::text, 'half'::text, 'full'::text]))) NOT VALID,
  CONSTRAINT tables_kill_threshold_bb_check CHECK ((kill_threshold_bb = ANY (ARRAY[8, 10, 12, 15]))) NOT VALID,
  CONSTRAINT tables_lifecycle_check CHECK ((lifecycle = ANY (ARRAY['opening'::text, 'live'::text, 'breaking'::text, 'closed'::text]))),
  CONSTRAINT tables_main_index_check CHECK ((main_index >= 1)),
  CONSTRAINT tables_name_is_not_a_javascript_accident CHECK (((name IS NULL) OR ((name !~ 'undefined'::text) AND (name !~ 'NaN'::text) AND (name !~ '\[object'::text)))) NOT VALID,
  CONSTRAINT tables_pkey PRIMARY KEY (id),
  CONSTRAINT tables_rake_cap_bb_range CHECK (((rake_cap_bb IS NULL) OR (rake_cap_bb = ('-1'::integer)::numeric) OR ((rake_cap_bb >= (0)::numeric) AND (rake_cap_bb <= (10)::numeric)))) NOT VALID,
  CONSTRAINT tables_rake_percent_range CHECK (((rake_percent IS NULL) OR (rake_percent = ('-1'::integer)::numeric) OR ((rake_percent >= (0)::numeric) AND (rake_percent <= (10)::numeric)))) NOT VALID,
  CONSTRAINT tables_role_check CHECK ((role = ANY (ARRAY['main'::text, 'feeder'::text]))),
  CONSTRAINT tables_stakes_is_not_a_javascript_accident CHECK (((stakes IS NULL) OR ((stakes !~ 'undefined'::text) AND (stakes !~ 'NaN'::text) AND (stakes !~ '\[object'::text) AND (stakes <> 'null/null'::text)))) NOT VALID,
  CONSTRAINT tables_status_check CHECK ((status = ANY (ARRAY['waiting'::text, 'active'::text, 'running'::text, 'paused'::text, 'closed'::text]))),
  CONSTRAINT tables_straddle_type_check CHECK ((straddle_type = 'utg'::text)),
  CONSTRAINT tables_terminal_closed_shape CHECK (((terminal_closed_at IS NULL) OR ((lower(COALESCE(status, ''::text)) = 'closed'::text) AND (lower(COALESCE(lifecycle, ''::text)) = 'closed'::text) AND (NOT (current_players IS DISTINCT FROM 0)))))
);

CREATE TABLE smarter_private.f06_hand_permits (
  permit_id uuid NOT NULL,
  tournament_id uuid NOT NULL,
  table_id uuid NOT NULL,
  lifecycle bigint NOT NULL,
  hand_number bigint NOT NULL,
  custody_id uuid NOT NULL,
  generation uuid NOT NULL,
  state text NOT NULL DEFAULT 'reserved'::text,
  evidence_id uuid,
  CONSTRAINT f06_hand_permits_pkey PRIMARY KEY (permit_id),
  CONSTRAINT f06_hand_permits_state_check CHECK ((state = ANY (ARRAY['reserved'::text, 'accepted'::text, 'never_started'::text, 'aborted_unsettled'::text]))),
  CONSTRAINT f06_hand_permits_table_id_hand_number_key UNIQUE (table_id, hand_number)
);

CREATE TABLE smarter_private.hand_submission_dispatch (
  transaction_id bigint NOT NULL,
  submission_id uuid NOT NULL,
  request_hash text NOT NULL,
  instance_id text NOT NULL,
  lease_generation uuid NOT NULL,
  CONSTRAINT hand_submission_dispatch_pkey PRIMARY KEY (transaction_id, submission_id)
);

CREATE TABLE smarter_private.hand_submission_dispositions (
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  permit_id uuid,
  disposition text NOT NULL,
  submission_id uuid,
  CONSTRAINT hand_submission_dispositions_check CHECK (((disposition = 'retained'::text) = (submission_id IS NOT NULL))),
  CONSTRAINT hand_submission_dispositions_disposition_check CHECK ((disposition = ANY (ARRAY['retained'::text, 'disposed'::text]))),
  CONSTRAINT hand_submission_dispositions_hand_number_check CHECK ((hand_number > 0)),
  CONSTRAINT hand_submission_dispositions_permit_id_key UNIQUE (permit_id),
  CONSTRAINT hand_submission_dispositions_pkey PRIMARY KEY (table_id, hand_number)
);

CREATE TABLE smarter_private.hand_submission_handoffs (
  submission_id uuid NOT NULL,
  original_generation uuid NOT NULL,
  instance_id text NOT NULL,
  lease_generation uuid NOT NULL,
  request_hash text NOT NULL,
  transaction_id bigint NOT NULL,
  CONSTRAINT hand_submission_handoffs_check CHECK ((original_generation <> lease_generation)),
  CONSTRAINT hand_submission_handoffs_pkey PRIMARY KEY (submission_id)
);

CREATE TABLE smarter_private.hand_submissions (
  submission_id uuid NOT NULL,
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL,
  instance_id text NOT NULL,
  lease_generation uuid NOT NULL,
  request jsonb NOT NULL,
  request_hash text NOT NULL,
  retained_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT hand_submissions_hand_number_check CHECK ((hand_number > 0)),
  CONSTRAINT hand_submissions_instance_id_check CHECK ((length(btrim(instance_id)) > 0)),
  CONSTRAINT hand_submissions_pkey PRIMARY KEY (submission_id),
  CONSTRAINT hand_submissions_request_check CHECK ((jsonb_typeof(request) = 'object'::text)),
  CONSTRAINT hand_submissions_request_hash_check CHECK ((request_hash ~ '^[0-9a-f]{64}$'::text)),
  CONSTRAINT hand_submissions_table_id_hand_number_key UNIQUE (table_id, hand_number)
);


-- Live definition, byte for byte (pg_get_functiondef, 2026-09-28). The
-- migration hangs the receipt table's UPDATE/DELETE/TRUNCATE triggers on this.
CREATE OR REPLACE FUNCTION smarter_private.hand_submission_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN RAISE EXCEPTION 'HAND_SUBMISSION_IMMUTABLE' USING ERRCODE='55000'; END
$function$;

-- Test stand-in: the platform freeze, driven by a setting so the law test can
-- close the door and watch it refuse.
CREATE OR REPLACE FUNCTION public.fn_platform_frozen() RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.test_platform_frozen', true), '')::text NOT IN ('', 'false') $$;

-- Test stand-in: in production this takes the table's shared settlement lane.
-- The door's own exclusive lane is pg_try_advisory_xact_lock, which is real.
CREATE OR REPLACE FUNCTION public.fn_ca_share_settlement_lane_for_table(p_table_id uuid)
  RETURNS void LANGUAGE sql AS $$ SELECT NULL::void $$;

-- Test stand-in: the lease staleness constant read by the resume door.
CREATE OR REPLACE FUNCTION public.fn_engine_lease_stale_seconds() RETURNS integer
  LANGUAGE sql IMMUTABLE AS $$ SELECT 30 $$;

-- Test stand-in: the F06 tournament prefix. Every fixture here is a CASH table
-- (tournament_id IS NULL), so the resume door never reaches this.
CREATE OR REPLACE FUNCTION smarter_private.f06_prefix(
  p_tournament uuid, p_generation uuid, p_users uuid[], p_tables uuid[])
  RETURNS void LANGUAGE sql AS $$ SELECT NULL::void $$;

-- ===========================================================================
--  ADDITIONAL WORLD FOR THE RETENTION-DISPOSAL LAW TEST (2026-09-28)
-- ===========================================================================
--
-- Everything above this point is the disposal law's own captured world,
-- reused unchanged: this test applies migration
-- 20260928001934_a_hand_the_table_has_already_dealt_past_is_disposed for real
-- before applying 20260928031344_retention_closes_the_settlement_request_it_
-- prunes under test, exactly as production received them in that order.
--
-- Everything below is what sp_prune_hand_history additionally reads that the
-- disposal law never touched: the retention window policy, the tables its
-- candidate CTE joins against to prove a hand's tournament is not an
-- unresolved Spin, the two F06 leaves it calls, and public.profiles, which is
-- how the sweep tells a horse hand from a human one. Columns are typed to
-- match what the candidate query reads from public.hand_history above
-- (table_id uuid, hand_number matched against hh.hand_number, hand_id uuid
-- matched against hh.id).

CREATE TABLE public.hand_history_retention_policy (
  horse_retention_days integer
);

CREATE TABLE public.profiles (
  id uuid NOT NULL,
  is_horse boolean,
  CONSTRAINT profiles_pkey PRIMARY KEY (id)
);

CREATE TABLE public.tournaments (
  id uuid NOT NULL,
  variant text,
  tournament_type text,
  status text,
  CONSTRAINT tournaments_pkey PRIMARY KEY (id)
);

CREATE TABLE public.tournament_terminal_settlements (
  tournament_id uuid NOT NULL
);

CREATE TABLE public.tournament_cancellation_receipts (
  tournament_id uuid NOT NULL
);

CREATE TABLE public.bbj_payouts (
  table_id uuid NOT NULL,
  hand_number bigint NOT NULL
);

CREATE TABLE public.hand_projection_outbox (
  hand_id uuid NOT NULL
);

CREATE TABLE public.tournament_knockout_candidates (
  hand_id uuid NOT NULL,
  state text NOT NULL
);

CREATE TABLE public.ca_hand_player_idx (
  hand_id uuid NOT NULL
);

-- Test stand-ins: two SECURITY DEFINER leaves sp_prune_hand_history calls to
-- ask F06 whether a hand's cards are still unresolved or it is a table's
-- current movement boundary (migrations 20260920232341, 20260925210126). Real
-- F06 permit/movement machinery is a different law with its own tests (the F06
-- must-move audits, smarter_private.f06_hand_permits above); this test asks
-- only whether retention closes the settlement request it prunes, so both
-- leaves are driven to false, exactly as the disposal fixture stands in for
-- fn_platform_frozen and fn_engine_lease_stale_seconds. Every doomed hand in
-- this fixture clears them honestly: it holds no F06 permit and claims no
-- movement boundary.
CREATE OR REPLACE FUNCTION smarter_private.f06_hand_cards_unresolved(p_table_id uuid, p_hand_number bigint)
  RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;

CREATE OR REPLACE FUNCTION smarter_private.f06_movement_boundary_retained(p_table_id uuid, p_hand_number bigint)
  RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
