CREATE SCHEMA extensions;

CREATE EXTENSION pgcrypto WITH SCHEMA extensions;

CREATE EXTENSION "uuid-ossp";

CREATE SCHEMA auth;

CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('test.actor',true),'')::uuid $$;

CREATE SEQUENCE public.hand_id_seq;

CREATE SEQUENCE public.chip_ledger_chain_seq;

CREATE TABLE public.ca_financial_epochs(id integer PRIMARY KEY,is_current boolean NOT NULL);

CREATE TABLE public.chip_ledger_idem(idempotency_key text PRIMARY KEY,leg_id uuid NOT NULL,created_at timestamptz NOT NULL);

CREATE TABLE public."ca_settle_sources" (
"source" text NOT NULL,
"note" text NOT NULL,
"added_at" timestamp with time zone DEFAULT now() NOT NULL,
CONSTRAINT "ca_settle_sources_pkey" PRIMARY KEY (source)
);

CREATE TABLE public."chip_ledger" (
"id" uuid DEFAULT gen_random_uuid() NOT NULL,
"performed_by" uuid NOT NULL,
"from_type" text NOT NULL,
"from_entity_id" uuid,
"from_label" text,
"to_type" text NOT NULL,
"to_entity_id" uuid,
"to_label" text,
"amount" numeric(15,2) NOT NULL,
"category" text DEFAULT 'transfer'::text NOT NULL,
"description" text,
"notes" text,
"club_id" uuid,
"union_id" uuid,
"table_id" uuid,
"hand_id" uuid,
"tournament_id" uuid,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"idempotency_key" text,
"correlation_id" uuid,
"causation_id" uuid,
"settlement_id" text,
"epoch_id" integer,
"actor_service" text,
"db_role" text,
"pre_from_balance" numeric,
"post_from_balance" numeric,
"pre_to_balance" numeric,
"post_to_balance" numeric,
"status" text DEFAULT 'posted'::text NOT NULL,
"metadata" jsonb,
"chain_seq" bigint,
"prev_hash" text,
"row_hash" text,
CONSTRAINT "chip_ledger_amount_check" CHECK ((amount > (0)::numeric)),
CONSTRAINT "chip_ledger_category_check" CHECK ((category = ANY (ARRAY['buyin'::text, 'cashout'::text, 'rake'::text, 'commission'::text, 'transfer'::text, 'player_funding'::text, 'agent_funding'::text, 'mint'::text, 'burn'::text, 'legacy_seed_reconcile'::text, 'rakeback'::text, 'settlement'::text, 'tournament_buyin'::text, 'tournament_prize'::text, 'bounty'::text, 'adjustment'::text, 'refund'::text, 'addon'::text, 'rebuy'::text, 'table_cashout'::text, 'tournament_refund'::text, 'bbj_contribution'::text, 'bbj_payout'::text, 'promo'::text, 'promo_release'::text, 'promo_send'::text, 'credit_draw'::text, 'credit_repayment'::text, 'insurance'::text, 'spin_entry'::text, 'spin_prize'::text, 'overlay'::text, 'correction'::text, 'reversal'::text, 'escrow_hold'::text, 'escrow_release'::text, 'treasury_transfer'::text, 'horse_funding'::text, 'fee'::text, 'eco'::text, 'pnl_settlement'::text, 'union_send'::text, 'cashier_send'::text, 'cashier_claim_back'::text, 'ticket_issue'::text, 'ticket_redeem'::text, 'club_opening_allocation'::text, 'leaderboard_payout'::text, 'club_bank_send'::text, 'club_bank_claim'::text, 'agent_send'::text, 'agent_claim'::text, 'union_settlement'::text, 'wheel_prize'::text, 'plinko_prize'::text, 'crash_prize'::text]))) NOT VALID,
CONSTRAINT "chip_ledger_exact_scale" CHECK ((amount = round(amount, 2))) NOT VALID,
CONSTRAINT "chip_ledger_from_type_check" CHECK ((from_type = ANY (ARRAY['player_wallet'::text, 'club_treasury'::text, 'union_bank'::text, 'agent_wallet'::text, 'system_mint'::text, 'system_burn'::text, 'table_stack'::text, 'promo_wallet'::text, 'club_wallet'::text, 'union_wallet'::text, 'bbj_pool'::text, 'spin_reserve'::text, 'insurance_bank'::text, 'escrow'::text, 'prize_liability'::text, 'bounty_liability'::text, 'rakeback_payable'::text, 'refund_payable'::text, 'settlement_suspense'::text, 'issuance_reserve'::text, 'chip_retirement'::text, 'credit_facility'::text, 'credit_receivable'::text, 'opening_setup'::text, 'leaderboard_round'::text]))) NOT VALID,
CONSTRAINT "chip_ledger_no_diamond_category_check" CHECK (((category !~* '^diamond'::text) AND (category !~* '_diamond'::text))),
CONSTRAINT "chip_ledger_pkey" PRIMARY KEY (id),
CONSTRAINT "chip_ledger_positive_amount" CHECK ((amount > (0)::numeric)),
CONSTRAINT "chip_ledger_status_check" CHECK ((status = ANY (ARRAY['posted'::text, 'correction'::text, 'reversal'::text]))),
CONSTRAINT "chip_ledger_to_type_check" CHECK ((to_type = ANY (ARRAY['player_wallet'::text, 'club_treasury'::text, 'union_bank'::text, 'agent_wallet'::text, 'system_mint'::text, 'system_burn'::text, 'table_stack'::text, 'promo_wallet'::text, 'club_wallet'::text, 'union_wallet'::text, 'bbj_pool'::text, 'spin_reserve'::text, 'insurance_bank'::text, 'escrow'::text, 'prize_liability'::text, 'bounty_liability'::text, 'rakeback_payable'::text, 'refund_payable'::text, 'settlement_suspense'::text, 'issuance_reserve'::text, 'chip_retirement'::text, 'credit_facility'::text, 'credit_receivable'::text, 'opening_setup'::text, 'leaderboard_round'::text]))) NOT VALID,
CONSTRAINT "chk_post_from_balance_is_two_decimal_places" CHECK (((post_from_balance IS NULL) OR (post_from_balance = round(post_from_balance, 2)))),
CONSTRAINT "chk_post_to_balance_is_two_decimal_places" CHECK (((post_to_balance IS NULL) OR (post_to_balance = round(post_to_balance, 2)))),
CONSTRAINT "chk_pre_from_balance_is_two_decimal_places" CHECK (((pre_from_balance IS NULL) OR (pre_from_balance = round(pre_from_balance, 2)))),
CONSTRAINT "chk_pre_to_balance_is_two_decimal_places" CHECK (((pre_to_balance IS NULL) OR (pre_to_balance = round(pre_to_balance, 2)))),
CONSTRAINT "ck_whole_cents" CHECK (((created_at < '2026-09-07 22:00:00+00'::timestamp with time zone) OR (amount = round(amount, 2)))) NOT VALID
);

CREATE TABLE public."chip_transactions" (
"id" uuid DEFAULT gen_random_uuid() NOT NULL,
"club_id" uuid NOT NULL,
"from_user_id" uuid,
"to_user_id" uuid,
"amount" numeric(14,2) NOT NULL,
"transaction_type" text NOT NULL,
"notes" text,
"related_cashout_id" uuid,
"metadata" jsonb DEFAULT '{}'::jsonb,
"created_at" timestamp with time zone DEFAULT now(),
"balance_after" numeric(14,2),
"clawed_back" boolean DEFAULT false,
"reversible_until" timestamp with time zone,
"is_reversed" boolean DEFAULT false,
"table_id" uuid,
CONSTRAINT "chip_transactions_pkey" PRIMARY KEY (id)
);

CREATE TABLE public."club_members" (
"club_id" uuid NOT NULL,
"user_id" uuid NOT NULL,
"role" text DEFAULT 'player'::text,
"agent_id" uuid,
"joined_at" timestamp with time zone DEFAULT now(),
"parent_agent_id" uuid,
"invited_by" uuid,
"notes" text,
"last_active_at" timestamp with time zone,
"created_at" timestamp with time zone DEFAULT now(),
"updated_at" timestamp with time zone DEFAULT now(),
"is_bot" boolean DEFAULT false,
"status" text DEFAULT 'active'::text,
"chip_balance" numeric(20,2) DEFAULT 0 NOT NULL,
"diamonds" integer DEFAULT 0 NOT NULL,
"is_active" boolean DEFAULT true,
"orange_ball_status" text DEFAULT 'inactive'::text,
"rank_level" integer DEFAULT 1,
"credit_limit" numeric(15,2) DEFAULT 0,
"credit_used" numeric(15,2) DEFAULT 0,
"nickname" text,
"last_active" timestamp with time zone DEFAULT now(),
"tier" text DEFAULT 'bronze'::text,
"trust_score" integer DEFAULT 50,
"sessions_played" integer DEFAULT 0,
"promo_balance" numeric(14,2) DEFAULT 0,
"chips_won" bigint DEFAULT 0,
"chips_lost" bigint DEFAULT 0,
"commission_rate" numeric(5,2) DEFAULT 0,
"rakeback_rate" numeric(5,2) DEFAULT 0,
"hands_played" integer DEFAULT 0,
"total_rake_paid" bigint DEFAULT 0,
"biggest_pot" bigint DEFAULT 0,
"locked_chips" integer DEFAULT 0,
"player_rakeback_pct" numeric(5,4) DEFAULT 0.0000,
"held_chips" numeric DEFAULT 0,
"display_name" text,
"is_prepaid" boolean DEFAULT true,
"promo_received_total" numeric(14,2) DEFAULT 0,
"promo_wagered" numeric(14,2) DEFAULT 0,
"promo_playthrough_required" numeric(14,2) DEFAULT 0,
"missions_completed" integer DEFAULT 0,
"membership_lifecycle_status" text DEFAULT 'active'::text NOT NULL,
"departed_at" timestamp with time zone,
"departed_by" uuid,
"departure_reason" text,
CONSTRAINT "chk_held_chips_is_two_decimal_places" CHECK (((held_chips IS NULL) OR (held_chips = round(held_chips, 2)))),
CONSTRAINT "club_members_chip_balance_nonneg" CHECK ((chip_balance >= (0)::numeric)),
CONSTRAINT "club_members_membership_lifecycle_check" CHECK ((membership_lifecycle_status = ANY (ARRAY['active'::text, 'departed'::text]))),
CONSTRAINT "club_members_pkey" PRIMARY KEY (club_id, user_id),
CONSTRAINT "club_members_promo_balance_nonneg" CHECK ((promo_balance >= (0)::numeric)),
CONSTRAINT "club_members_role_check" CHECK ((role = ANY (ARRAY['owner'::text, 'co_owner'::text, 'admin'::text, 'super_agent'::text, 'agent'::text, 'sub_agent'::text, 'player'::text])))
);

CREATE TABLE public."rake_records" (
"id" uuid DEFAULT gen_random_uuid() NOT NULL,
"hand_id" uuid,
"table_id" uuid,
"club_id" uuid,
"rake_amount" numeric(18,4) DEFAULT 0 NOT NULL,
"bbj_contribution" numeric(18,4) DEFAULT 0,
"pot_size" numeric(18,4),
"num_players" integer,
"created_at" timestamp with time zone DEFAULT now(),
"player_contributions" jsonb,
"global_hand_id" bigint DEFAULT nextval('hand_id_seq'::regclass),
"is_tournament" boolean DEFAULT false NOT NULL,
"tournament_id" uuid,
"source" text DEFAULT 'cash_game'::text,
"metadata" jsonb,
"rake_method" text DEFAULT 'DEALT_EQUAL'::text NOT NULL,
"returned_uncalled" jsonb,
CONSTRAINT "chk_rake_amount_is_two_decimal_places" CHECK (((rake_amount IS NULL) OR (rake_amount = round(rake_amount, 2)))),
CONSTRAINT "ck_whole_cents" CHECK (((created_at < '2026-09-07 22:00:00+00'::timestamp with time zone) OR ((rake_amount = round(rake_amount, 2)) AND (bbj_contribution = round(bbj_contribution, 2))))) NOT VALID,
CONSTRAINT "rake_records_pkey" PRIMARY KEY (id),
CONSTRAINT "rake_records_rake_method_check" CHECK ((rake_method = ANY (ARRAY['DEALT_EQUAL'::text, 'WEIGHTED_CONTRIBUTED'::text])))
);

CREATE TABLE public."spin_reserve_ledger" (
"id" uuid DEFAULT gen_random_uuid() NOT NULL,
"club_id" uuid NOT NULL,
"tournament_id" uuid,
"kind" text NOT NULL,
"amount" numeric NOT NULL,
"balance_after" numeric NOT NULL,
"multiplier" numeric,
"buy_in" numeric,
"seats" integer,
"house_rake" numeric,
"note" text,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
CONSTRAINT "chk_amount_is_two_decimal_places" CHECK (((amount IS NULL) OR (amount = round(amount, 2)))),
CONSTRAINT "spin_reserve_ledger_kind_check" CHECK ((kind = ANY (ARRAY['seed'::text, 'contribution'::text, 'jackpot_draw'::text, 'surplus_return'::text, 'adjustment'::text, 'merge'::text, 'wallet_return'::text, 'seed_return'::text, 'activation'::text, 'deactivation'::text]))),
CONSTRAINT "spin_reserve_ledger_pkey" PRIMARY KEY (id)
);

CREATE TABLE public."table_seats" (
"id" uuid DEFAULT uuid_generate_v4() NOT NULL,
"table_id" uuid NOT NULL,
"seat_number" integer NOT NULL,
"user_id" uuid,
"player_id" integer,
"member_id" uuid,
"stack" numeric(15,2) DEFAULT 0,
"is_sitting_out" boolean DEFAULT false,
"is_away" boolean DEFAULT false,
"joined_at" timestamp with time zone DEFAULT now(),
"horse_id" uuid,
"scheduled_leave_hands" integer,
"left_at" timestamp with time zone,
"status" text DEFAULT 'active'::text,
"leave_pending" boolean DEFAULT false,
"auto_rebuy" boolean DEFAULT false,
"time_bank_remaining" integer DEFAULT 30,
"time_bank_uses_remaining" integer DEFAULT 4,
"club_id" uuid,
"sit_out_at" timestamp with time zone,
"entry_hold" text,
"entry_post_agreed" boolean DEFAULT false NOT NULL,
"occupancy_id" uuid DEFAULT gen_random_uuid() NOT NULL,
"active_game_scope" text,
"active_parent_key" text,
CONSTRAINT "active_seat_requires_game_scope" CHECK ((((left_at IS NULL) AND (active_game_scope IS NOT NULL) AND (user_id IS NOT NULL) AND (table_id IS NOT NULL)) OR ((left_at IS NOT NULL) AND (active_game_scope IS NULL)))),
CONSTRAINT "active_seat_requires_open_parent" CHECK ((((left_at IS NULL) AND (active_parent_key IS NOT NULL) AND (active_parent_key <> 'closed'::text)) OR ((left_at IS NOT NULL) AND (active_parent_key IS NULL)))),
CONSTRAINT "one_committed_seat_per_game_player" UNIQUE (user_id, active_game_scope) DEFERRABLE INITIALLY DEFERRED,
CONSTRAINT "table_seats_entry_hold_check" CHECK (((entry_hold IS NULL) OR (entry_hold = ANY (ARRAY['waiting'::text, 'posting'::text, 'moved'::text])))),
CONSTRAINT "table_seats_pkey" PRIMARY KEY (id),
CONSTRAINT "table_seats_seat_number_check" CHECK (((seat_number >= 1) AND (seat_number <= 10))),
CONSTRAINT "table_seats_stack_nonneg" CHECK ((stack >= (0)::numeric)),
CONSTRAINT "table_seats_table_id_seat_number_key" UNIQUE (table_id, seat_number)
);

CREATE TABLE public."tables" (
"id" uuid DEFAULT gen_random_uuid() NOT NULL,
"club_id" uuid,
"name" text NOT NULL,
"game_type" text DEFAULT 'nlhe'::text,
"stakes" text,
"small_blind" numeric(15,2) DEFAULT 1,
"big_blind" numeric(15,2) DEFAULT 2,
"min_buy_in" numeric(15,2) DEFAULT 40,
"max_buy_in" numeric(15,2) DEFAULT 200,
"max_players" integer DEFAULT 9,
"current_players" integer DEFAULT 0,
"status" text DEFAULT 'waiting'::text,
"is_private" boolean DEFAULT false,
"settings" jsonb DEFAULT '{}'::jsonb,
"created_at" timestamp with time zone DEFAULT now(),
"updated_at" timestamp with time zone DEFAULT now(),
"game_variant" text DEFAULT 'nlh'::text,
"enable_straddle" boolean DEFAULT true,
"run_it_twice" boolean DEFAULT true,
"auto_muck" boolean DEFAULT true,
"ante" numeric(15,2) DEFAULT 0,
"allow_rabbit_hunt" boolean DEFAULT true,
"allow_run_it_twice" boolean DEFAULT true,
"allow_straddle" boolean DEFAULT true,
"game_mode" character varying(10) DEFAULT 'regular'::character varying,
"is_vip_only" boolean DEFAULT false,
"is_anonymous" boolean DEFAULT false,
"ban_chat" boolean DEFAULT false,
"label_as_new" boolean DEFAULT false,
"is_featured" boolean DEFAULT false,
"hide_club_name" boolean DEFAULT false,
"is_template" boolean DEFAULT false,
"bomb_pot_enabled" boolean DEFAULT false,
"double_board" boolean DEFAULT false,
"triple_board" boolean DEFAULT false,
"pineapple_holdem" boolean DEFAULT false,
"seven_deuce_enabled" boolean DEFAULT false,
"nit_game" boolean DEFAULT false,
"cap_enabled" boolean DEFAULT false,
"no_rathole" boolean DEFAULT false,
"action_time_seconds" integer DEFAULT 15,
"ante_bb" numeric(10,2) DEFAULT 0,
"career_percent_min" integer DEFAULT 0,
"maintain_percent_min" integer DEFAULT 0,
"maintain_hands" integer DEFAULT 10,
"auto_start_players" integer DEFAULT 2,
"game_length_hours" integer DEFAULT 12,
"created_by" uuid,
"calltime_enabled" boolean DEFAULT false,
"auto_extension" boolean DEFAULT false,
"auto_restart" boolean DEFAULT false,
"auto_create_table" boolean DEFAULT false,
"auto_utg_straddle" boolean DEFAULT false,
"voluntary_straddle" boolean DEFAULT false,
"insurance_enabled" boolean DEFAULT false,
"run_it_mode" character varying(20) DEFAULT 'none'::character varying,
"rake_percent" numeric(5,2) DEFAULT '-1'::integer,
"rake_cap_bb" numeric(5,2) DEFAULT '-1'::integer,
"agent_downline_limit" integer,
"buy_in_authorization" boolean DEFAULT false,
"restrict_device" boolean DEFAULT true,
"restrict_observers" boolean DEFAULT false,
"gps_restriction" boolean DEFAULT true,
"ip_restriction" boolean DEFAULT false,
"pc_emulator_restriction" boolean DEFAULT false,
"photo_rotation_verification" boolean DEFAULT false,
"short_description" text DEFAULT ''::text,
"accelerated_mtt" boolean DEFAULT false,
"all_in_or_fold" boolean DEFAULT false,
"custom_rebuy_reentry_cost" boolean DEFAULT false,
"number_of_rebuys_reentries" integer DEFAULT 3,
"add_on_multiplier" numeric(3,1) DEFAULT 1.0,
"custom_add_on" boolean DEFAULT false,
"add_on_break_length_minutes" integer DEFAULT 1,
"ko_bounty" boolean DEFAULT false,
"gtd_prize_pool" boolean DEFAULT false,
"final_table_deal" boolean DEFAULT false,
"big_blind_ante" boolean DEFAULT false,
"authorized_to_register" boolean DEFAULT false,
"late_registration_level" integer DEFAULT 6,
"early_bird_registration" boolean DEFAULT false,
"bubble_protection" boolean DEFAULT false,
"featured_tournament" boolean DEFAULT false,
"min_players_mtt" integer DEFAULT 30,
"max_players_mtt" integer DEFAULT 300,
"multi_day_mtt" boolean DEFAULT false,
"save_start_time" boolean DEFAULT false,
"start_time" timestamp with time zone,
"restart_tournament_every" boolean DEFAULT false,
"tournament_schedule" boolean DEFAULT false,
"synchronized_breaks" boolean DEFAULT true,
"sng_buy_in" numeric(10,2) DEFAULT 0,
"blind_structure" character varying(20) DEFAULT 'standard'::character varying,
"payout_structure" character varying(50) DEFAULT 'winner_takes_all'::character varying,
"starting_chips" integer DEFAULT 1500,
"blinds_up_minutes" integer DEFAULT 10,
"next_step_satellite" boolean DEFAULT false,
"sng_custom_buy_in" boolean DEFAULT false,
"sng_player_count" integer DEFAULT 9,
"is_spins" boolean DEFAULT false,
"spins_multiplier" integer,
"is_deleted" boolean DEFAULT false,
"deleted_at" timestamp with time zone,
"deleted_by" uuid,
"bbj_percent" numeric(5,2) DEFAULT 100,
"tournament_id" uuid,
"live_state" jsonb,
"union_id" uuid,
"big_blind_ante_enabled" boolean DEFAULT false,
"straddle_enabled" boolean DEFAULT false,
"straddle_type" text DEFAULT 'utg'::text,
"max_straddles" integer DEFAULT 1,
"run_it_twice_enabled" boolean DEFAULT false,
"auto_muck_enabled" boolean DEFAULT true,
"show_hand_enabled" boolean DEFAULT true,
"disconnect_timeout_seconds" integer DEFAULT 30,
"max_consecutive_timeouts" integer DEFAULT 3,
"prefer_check_over_fold" boolean DEFAULT true,
"time_bank_max_uses" integer DEFAULT 4,
"time_bank_enabled" boolean DEFAULT true,
"ante_enabled" boolean DEFAULT false,
"bomb_pot_frequency" integer DEFAULT 0,
"bomb_pot_ante_multiplier" integer DEFAULT 2,
"wait_for_big_blind" boolean DEFAULT true NOT NULL,
"seven_deuce_amount" numeric DEFAULT 2 NOT NULL,
"hands_dealt" bigint DEFAULT 0 NOT NULL,
"avg_pot" numeric(14,2) DEFAULT 0 NOT NULL,
"bomb_pot_double_board" boolean DEFAULT false NOT NULL,
"cap_bb" numeric(10,2),
"bomb_pot_board_count" smallint DEFAULT 1 NOT NULL,
"bomb_pot_trigger_mode" text DEFAULT 'every_n_hands'::text NOT NULL,
"bomb_pot_interval_seconds" integer,
"bomb_pot_min_players" smallint DEFAULT 3 NOT NULL,
"bomb_pot_ante_fixed" numeric,
"first_button_seat" integer,
"bomb_pot_variant" text,
"bomb_pot_next_due_at" timestamp with time zone,
"bomb_pot_sched_state" jsonb,
"bomb_pot_manual_pending" boolean DEFAULT false NOT NULL,
"bomb_pot_button_policy" text DEFAULT 'regular'::text NOT NULL,
"bomb_pot_announce_seconds" integer,
"min_buy_in_bb" integer GENERATED ALWAYS AS (
CASE
    WHEN ((tournament_id IS NULL) AND (COALESCE(big_blind, (0)::numeric) > (0)::numeric) AND (min_buy_in IS NOT NULL)) THEN (ceil((min_buy_in / big_blind)))::integer
    ELSE NULL::integer
END) STORED,
"max_buy_in_bb" integer GENERATED ALWAYS AS (
CASE
    WHEN ((tournament_id IS NULL) AND (COALESCE(big_blind, (0)::numeric) > (0)::numeric) AND (max_buy_in IS NOT NULL)) THEN (floor((max_buy_in / big_blind)))::integer
    ELSE NULL::integer
END) STORED,
"min_buyin" integer GENERATED ALWAYS AS (
CASE
    WHEN ((tournament_id IS NULL) AND (COALESCE(big_blind, (0)::numeric) > (0)::numeric) AND (min_buy_in IS NOT NULL)) THEN (ceil((min_buy_in / big_blind)))::integer
    ELSE NULL::integer
END) STORED,
"max_buyin" integer GENERATED ALWAYS AS (
CASE
    WHEN ((tournament_id IS NULL) AND (COALESCE(big_blind, (0)::numeric) > (0)::numeric) AND (max_buy_in IS NOT NULL)) THEN (floor((max_buy_in / big_blind)))::integer
    ELSE NULL::integer
END) STORED,
"cluster_id" uuid,
"role" text,
"main_index" integer,
"lifecycle" text,
"opened_at" timestamp with time zone,
"live_at" timestamp with time zone,
"break_started_at" timestamp with time zone,
"break_eligible_since" timestamp with time zone,
"promote_pending" boolean DEFAULT false NOT NULL,
"observer_show_cards" boolean DEFAULT false NOT NULL,
"terminal_closed_at" timestamp with time zone,
"seat_game_scope" text,
"seat_admission_key" text,
CONSTRAINT "table_game_scope_is_derived" CHECK (((seat_game_scope IS NULL) OR (seat_game_scope =
CASE
    WHEN (cluster_id IS NULL) THEN ('table:'::text || (id)::text)
    ELSE ('cluster:'::text || (cluster_id)::text)
END))),
CONSTRAINT "table_game_scope_parent_key" UNIQUE (id, seat_game_scope),
CONSTRAINT "table_seat_admission_is_derived" CHECK (((seat_admission_key IS NULL) OR (seat_admission_key =
CASE
    WHEN ((lower(COALESCE(status, ''::text)) = ANY (ARRAY['closed'::text, 'completed'::text, 'cancelled'::text, 'finished'::text])) OR (lifecycle = 'closed'::text) OR COALESCE(is_deleted, false) OR COALESCE(is_template, false)) THEN 'closed'::text
    WHEN (tournament_id IS NOT NULL) THEN ('tournament:'::text || (tournament_id)::text)
    ELSE 'cash'::text
END))),
CONSTRAINT "table_seat_admission_parent_key" UNIQUE (id, seat_admission_key),
CONSTRAINT "tables_bomb_pot_board_count_check" CHECK (((bomb_pot_board_count >= 1) AND (bomb_pot_board_count <= 3))),
CONSTRAINT "tables_bomb_pot_button_policy_check" CHECK ((bomb_pot_button_policy = ANY (ARRAY['regular'::text, 'separate'::text]))),
CONSTRAINT "tables_bomb_pot_trigger_mode_check" CHECK ((bomb_pot_trigger_mode = ANY (ARRAY['every_n_hands'::text, 'once_per_orbit'::text, 'timed'::text, 'bomb_pot_only'::text]))),
CONSTRAINT "tables_bomb_pot_variant_check" CHECK (((bomb_pot_variant IS NULL) OR ((bomb_pot_variant = ANY (ARRAY['nlh'::text, 'plo4'::text, 'plo5'::text, 'plo6'::text, 'flh'::text, 'flo8'::text])) AND ((lower(COALESCE(game_variant, 'nlh'::text)) = ANY (ARRAY['flh'::text, 'flo8'::text])) = (bomb_pot_variant = ANY (ARRAY['flh'::text, 'flo8'::text])))))),
CONSTRAINT "tables_cash_needs_a_game" CHECK (((tournament_id IS NOT NULL) OR (cluster_id IS NOT NULL) OR (status = ANY (ARRAY['closed'::text, 'deleted'::text])) OR COALESCE(is_deleted, false) OR (club_id IS NULL) OR (game_variant IS NULL) OR (COALESCE(small_blind, (0)::numeric) <= (0)::numeric) OR (COALESCE(big_blind, (0)::numeric) <= COALESCE(small_blind, (0)::numeric)))),
CONSTRAINT "tables_game_type_is_format" CHECK ((game_type = ANY (ARRAY['cash'::text, 'tournament'::text]))),
CONSTRAINT "tables_lifecycle_check" CHECK ((lifecycle = ANY (ARRAY['opening'::text, 'live'::text, 'breaking'::text, 'closed'::text]))),
CONSTRAINT "tables_main_index_check" CHECK ((main_index >= 1)),
CONSTRAINT "tables_pkey" PRIMARY KEY (id),
CONSTRAINT "tables_rake_cap_bb_range" CHECK (((rake_cap_bb IS NULL) OR (rake_cap_bb = ('-1'::integer)::numeric) OR ((rake_cap_bb >= (0)::numeric) AND (rake_cap_bb <= (10)::numeric)))) NOT VALID,
CONSTRAINT "tables_rake_percent_range" CHECK (((rake_percent IS NULL) OR (rake_percent = ('-1'::integer)::numeric) OR ((rake_percent >= (0)::numeric) AND (rake_percent <= (10)::numeric)))) NOT VALID,
CONSTRAINT "tables_role_check" CHECK ((role = ANY (ARRAY['main'::text, 'feeder'::text]))),
CONSTRAINT "tables_status_check" CHECK ((status = ANY (ARRAY['waiting'::text, 'active'::text, 'running'::text, 'paused'::text, 'closed'::text]))),
CONSTRAINT "tables_straddle_type_check" CHECK ((straddle_type = 'utg'::text))
);

CREATE TABLE public."tournament_escrow" (
"tournament_id" uuid NOT NULL,
"enforced" boolean DEFAULT true NOT NULL,
"gross_in" numeric DEFAULT 0 NOT NULL,
"fee_entries_in" numeric DEFAULT 0 NOT NULL,
"satellite_fee_in" numeric DEFAULT 0 NOT NULL,
"bounty_in" numeric DEFAULT 0 NOT NULL,
"overlay_in" numeric DEFAULT 0 NOT NULL,
"satellite_in" numeric DEFAULT 0 NOT NULL,
"prize_out" numeric DEFAULT 0 NOT NULL,
"bounty_out" numeric DEFAULT 0 NOT NULL,
"fee_out" numeric DEFAULT 0 NOT NULL,
"refund_prize" numeric DEFAULT 0 NOT NULL,
"refund_bounty" numeric DEFAULT 0 NOT NULL,
"refund_fee" numeric DEFAULT 0 NOT NULL,
"prize_balance" numeric(15,2) DEFAULT 0 NOT NULL,
"bounty_balance" numeric(15,2) DEFAULT 0 NOT NULL,
"fee_balance" numeric(15,2) DEFAULT 0 NOT NULL,
"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
"opened_from" text NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
"closed_at" timestamp with time zone,
"close_note" text,
"reserve_out" numeric DEFAULT 0 NOT NULL,
"reserve_in" numeric DEFAULT 0 NOT NULL,
CONSTRAINT "tournament_escrow_pkey" PRIMARY KEY (tournament_id)
);

CREATE TABLE public."tournament_guarantee_overlays" (
"tournament_id" uuid NOT NULL,
"club_id" uuid,
"amount" numeric(15,2) NOT NULL,
"pool_before" numeric(15,2) NOT NULL,
"pool_after" numeric(15,2) NOT NULL,
"treasury_after" numeric(15,2),
"source" text DEFAULT 'engine'::text NOT NULL,
"funded_at" timestamp with time zone DEFAULT now() NOT NULL,
"bank_type" character varying(10),
"bank_entity_id" uuid,
"union_id" uuid,
CONSTRAINT "tournament_guarantee_overlays_pkey" PRIMARY KEY (tournament_id)
);

CREATE TABLE public."tournament_obligations" (
"id" uuid DEFAULT gen_random_uuid() NOT NULL,
"tournament_id" uuid NOT NULL,
"kind" text NOT NULL,
"place" integer,
"user_id" uuid,
"amount_owed" numeric(15,2) DEFAULT 0 NOT NULL,
"amount_paid" numeric(15,2) DEFAULT 0 NOT NULL,
"source" text,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
"settled_at" timestamp with time zone,
"adjustment_id" uuid,
CONSTRAINT "tournament_obligations_amount_owed_check" CHECK ((amount_owed >= (0)::numeric)),
CONSTRAINT "tournament_obligations_check" CHECK (((amount_paid >= (0)::numeric) AND (amount_paid <= amount_owed))),
CONSTRAINT "tournament_obligations_check1" CHECK (((place IS NOT NULL) OR (user_id IS NOT NULL))),
CONSTRAINT "tournament_obligations_kind_check" CHECK ((kind = ANY (ARRAY['place'::text, 'bounty'::text, 'bounty_residual'::text, 'mystery_bounty'::text, 'refund'::text, 'seat'::text, 'satellite_remainder'::text, 'bubble_protection'::text, 'final_table_deal'::text, 'late_reg_adjustment'::text]))),
CONSTRAINT "tournament_obligations_pkey" PRIMARY KEY (id)
);

CREATE TABLE public."tournament_payouts" (
"id" uuid DEFAULT gen_random_uuid() NOT NULL,
"tournament_id" uuid NOT NULL,
"user_id" uuid NOT NULL,
"position" integer,
"amount" numeric(15,2) DEFAULT 0 NOT NULL,
"source" text DEFAULT 'payout'::text NOT NULL,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"idempotency_key" text,
"paid_at" timestamp with time zone DEFAULT now() NOT NULL,
"tournament_type" text,
"field_size" integer,
"prize_pool" numeric,
"payout_structure" jsonb,
"recorded_by" text,
"metadata" jsonb,
CONSTRAINT "chk_prize_pool_is_two_decimal_places" CHECK (((prize_pool IS NULL) OR (prize_pool = round(prize_pool, 2)))),
CONSTRAINT "tournament_payouts_amount_check" CHECK (((amount >= (0)::numeric) OR (source = 'clawback'::text))),
CONSTRAINT "tournament_payouts_pkey" PRIMARY KEY (id)
);

CREATE TABLE public."tournament_players" (
"id" uuid DEFAULT gen_random_uuid() NOT NULL,
"tournament_id" uuid NOT NULL,
"user_id" uuid NOT NULL,
"username" text,
"chips" integer DEFAULT 0,
"status" text DEFAULT 'registered'::text,
"position" integer,
"prize" numeric(15,2) DEFAULT 0,
"rebuys" integer DEFAULT 0,
"add_on" boolean DEFAULT false,
"registered_at" timestamp with time zone DEFAULT now(),
"eliminated_at" timestamp with time zone,
"bounties_collected" integer DEFAULT 0,
"bounty_winnings" numeric(15,2) DEFAULT 0,
"mystery_bounty_value" numeric(15,2) DEFAULT 0,
"current_bounty" numeric DEFAULT 0,
"table_id" uuid,
"seat_number" integer,
"chip_count" numeric DEFAULT 0,
"club_id" uuid,
"is_satellite_qualifier" boolean DEFAULT false,
"rebuy_prompt_until" timestamp with time zone,
"push_15m_sent" boolean DEFAULT false,
"push_2m_sent" boolean DEFAULT false,
"source_satellite_id" uuid,
"elimination_sequence" bigint,
CONSTRAINT "tournament_players_elimination_sequence_positive" CHECK (((elimination_sequence IS NULL) OR (elimination_sequence > 0))),
CONSTRAINT "tournament_players_pkey" PRIMARY KEY (id),
CONSTRAINT "tournament_players_status_check" CHECK ((status = ANY (ARRAY['registered'::text, 'playing'::text, 'eliminated'::text, 'winner'::text]))),
CONSTRAINT "tournament_players_tournament_id_user_id_key" UNIQUE (tournament_id, user_id)
);

CREATE TABLE public."tournament_rake_settlements" (
"tournament_id" uuid NOT NULL,
"club_id" uuid,
"union_id" uuid,
"amount" numeric(15,2) DEFAULT 0 NOT NULL,
"destination" text DEFAULT 'pending'::text NOT NULL,
"source" text DEFAULT 'engine'::text NOT NULL,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"settled_at" timestamp with time zone,
"attributed_at" timestamp with time zone,
"attribution_error" text,
"attributed_users" integer,
CONSTRAINT "tournament_rake_settlements_pkey" PRIMARY KEY (tournament_id)
);

CREATE TABLE public."tournament_refund_authorizations" (
"token" uuid NOT NULL,
"idempotency_key" text NOT NULL,
"tournament_id" uuid NOT NULL,
"obligation_id" uuid NOT NULL,
"user_id" uuid NOT NULL,
"source_wallet_club_id" uuid NOT NULL,
"entitlement_id" uuid NOT NULL,
"amount_paid_before" numeric(15,2) NOT NULL,
"amount_paid_now" numeric(15,2) NOT NULL,
"refund_prize" numeric(15,2) NOT NULL,
"refund_bounty" numeric(15,2) NOT NULL,
"refund_fee" numeric(15,2) NOT NULL,
"source" text NOT NULL,
"description" text NOT NULL,
"created_at" timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
CONSTRAINT "tournament_refund_authorizations_amount_paid_before_check" CHECK (((amount_paid_before >= (0)::numeric) AND ((amount_paid_before)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND (amount_paid_before = round(amount_paid_before, 2)))),
CONSTRAINT "tournament_refund_authorizations_amount_paid_now_check" CHECK ((((amount_paid_now)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND (amount_paid_now > (0)::numeric) AND (amount_paid_now = round(amount_paid_now, 2)))),
CONSTRAINT "tournament_refund_authorizations_check" CHECK ((amount_paid_now = ((refund_prize + refund_bounty) + refund_fee))),
CONSTRAINT "tournament_refund_authorizations_description_check" CHECK ((length(btrim(description)) > 0)),
CONSTRAINT "tournament_refund_authorizations_entitlement_id_key" UNIQUE (entitlement_id),
CONSTRAINT "tournament_refund_authorizations_idempotency_key_key" UNIQUE (idempotency_key),
CONSTRAINT "tournament_refund_authorizations_pkey" PRIMARY KEY (token),
CONSTRAINT "tournament_refund_authorizations_refund_bounty_check" CHECK ((((refund_bounty)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND (refund_bounty >= (0)::numeric) AND (refund_bounty = round(refund_bounty, 2)))),
CONSTRAINT "tournament_refund_authorizations_refund_fee_check" CHECK ((((refund_fee)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND (refund_fee >= (0)::numeric) AND (refund_fee = round(refund_fee, 2)))),
CONSTRAINT "tournament_refund_authorizations_refund_prize_check" CHECK ((((refund_prize)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND (refund_prize >= (0)::numeric) AND (refund_prize = round(refund_prize, 2)))),
CONSTRAINT "tournament_refund_authorizations_source_check" CHECK ((length(btrim(source)) > 0))
);

CREATE TABLE public."tournament_refund_entitlements" (
"id" uuid DEFAULT gen_random_uuid() NOT NULL,
"tournament_id" uuid NOT NULL,
"user_id" uuid NOT NULL,
"entitlement_kind" text NOT NULL,
"charge_category" text NOT NULL,
"refund_wallet_club_id" uuid NOT NULL,
"gross" numeric(15,2) NOT NULL,
"refund_prize" numeric(15,2) NOT NULL,
"refund_bounty" numeric(15,2) NOT NULL,
"refund_fee" numeric(15,2) NOT NULL,
"source_ledger_id" uuid NOT NULL,
"registration_id" uuid,
"source_satellite_id" uuid,
"source_award_place" integer,
"source_ticket_id" uuid,
"escrow_bucket" text NOT NULL,
"evidence_kind" text NOT NULL,
"created_at" timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
CONSTRAINT "tournament_refund_entitlement_tournament_id_user_id_entitle_key" UNIQUE (tournament_id, user_id, entitlement_kind, source_ledger_id),
CONSTRAINT "tournament_refund_entitlements_charge_category_check" CHECK ((charge_category = ANY (ARRAY['tournament_buyin'::text, 'rebuy'::text, 'addon'::text, 'satellite_seat'::text, 'tournament_ticket'::text]))),
CONSTRAINT "tournament_refund_entitlements_check" CHECK ((gross = ((refund_prize + refund_bounty) + refund_fee))),
CONSTRAINT "tournament_refund_entitlements_check1" CHECK (((((entitlement_kind = 'wallet_charge'::text) AND (charge_category = ANY (ARRAY['tournament_buyin'::text, 'rebuy'::text, 'addon'::text])) AND (registration_id IS NULL) AND (source_satellite_id IS NULL) AND (source_award_place IS NULL) AND (source_ticket_id IS NULL) AND (escrow_bucket = 'wallet_gross'::text) AND (evidence_kind = ANY (ARRAY['atomic_wallet_charge'::text, 'cutover_wallet_charge'::text]))) OR ((entitlement_kind = 'satellite_seat'::text) AND (charge_category = 'satellite_seat'::text) AND (registration_id IS NOT NULL) AND (source_satellite_id IS NOT NULL) AND (source_satellite_id <> tournament_id) AND (source_award_place > 0) AND (source_ticket_id IS NULL) AND (escrow_bucket = ANY (ARRAY['satellite_gross'::text, 'satellite_in'::text])) AND (evidence_kind = ANY (ARRAY['atomic_satellite_seat'::text, 'cutover_satellite_seat'::text]))) OR ((entitlement_kind = 'tournament_ticket'::text) AND (charge_category = 'tournament_ticket'::text) AND (registration_id IS NOT NULL) AND (source_satellite_id IS NOT NULL) AND (source_award_place IS NULL) AND (source_ticket_id IS NOT NULL) AND (escrow_bucket = 'ticket_gross'::text) AND (evidence_kind = 'atomic_tournament_ticket'::text))) IS TRUE)),
CONSTRAINT "tournament_refund_entitlements_entitlement_kind_check" CHECK ((entitlement_kind = ANY (ARRAY['wallet_charge'::text, 'satellite_seat'::text, 'tournament_ticket'::text]))),
CONSTRAINT "tournament_refund_entitlements_escrow_bucket_check" CHECK ((escrow_bucket = ANY (ARRAY['wallet_gross'::text, 'satellite_gross'::text, 'satellite_in'::text, 'ticket_gross'::text]))),
CONSTRAINT "tournament_refund_entitlements_evidence_kind_check" CHECK ((evidence_kind = ANY (ARRAY['atomic_wallet_charge'::text, 'cutover_wallet_charge'::text, 'atomic_satellite_seat'::text, 'cutover_satellite_seat'::text, 'atomic_tournament_ticket'::text]))),
CONSTRAINT "tournament_refund_entitlements_gross_check" CHECK ((((gross)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND (gross > (0)::numeric) AND (gross = round(gross, 2)))),
CONSTRAINT "tournament_refund_entitlements_pkey" PRIMARY KEY (id),
CONSTRAINT "tournament_refund_entitlements_refund_bounty_check" CHECK ((((refund_bounty)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND (refund_bounty >= (0)::numeric) AND (refund_bounty = round(refund_bounty, 2)))),
CONSTRAINT "tournament_refund_entitlements_refund_fee_check" CHECK ((((refund_fee)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND (refund_fee >= (0)::numeric) AND (refund_fee = round(refund_fee, 2)))),
CONSTRAINT "tournament_refund_entitlements_refund_prize_check" CHECK ((((refund_prize)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND (refund_prize >= (0)::numeric) AND (refund_prize = round(refund_prize, 2)))),
CONSTRAINT "tournament_refund_entitlements_source_ledger_id_key" UNIQUE (source_ledger_id)
);

CREATE TABLE public."tournament_refund_tranches" (
"wallet_transaction_id" uuid NOT NULL,
"idempotency_key" text NOT NULL,
"tournament_id" uuid NOT NULL,
"obligation_id" uuid NOT NULL,
"user_id" uuid NOT NULL,
"source_wallet_club_id" uuid NOT NULL,
"entitlement_id" uuid NOT NULL,
"credit_ledger_id" uuid NOT NULL,
"amount_paid_before" numeric(15,2) NOT NULL,
"amount_paid_now" numeric(15,2) NOT NULL,
"refund_prize" numeric(15,2) NOT NULL,
"refund_bounty" numeric(15,2) NOT NULL,
"refund_fee" numeric(15,2) NOT NULL,
"source" text NOT NULL,
"description" text NOT NULL,
"created_at" timestamp with time zone DEFAULT transaction_timestamp() NOT NULL,
CONSTRAINT "tournament_refund_tranches_amount_paid_before_check" CHECK (((amount_paid_before >= (0)::numeric) AND ((amount_paid_before)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND (amount_paid_before = round(amount_paid_before, 2)))),
CONSTRAINT "tournament_refund_tranches_amount_paid_now_check" CHECK ((((amount_paid_now)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND (amount_paid_now > (0)::numeric) AND (amount_paid_now = round(amount_paid_now, 2)))),
CONSTRAINT "tournament_refund_tranches_check" CHECK ((amount_paid_now = ((refund_prize + refund_bounty) + refund_fee))),
CONSTRAINT "tournament_refund_tranches_check1" CHECK ((idempotency_key = ((('tourney:'::text || (tournament_id)::text) || ':refund-entitlement:'::text) || (entitlement_id)::text))),
CONSTRAINT "tournament_refund_tranches_credit_ledger_id_key" UNIQUE (credit_ledger_id),
CONSTRAINT "tournament_refund_tranches_description_check" CHECK ((length(btrim(description)) > 0)),
CONSTRAINT "tournament_refund_tranches_entitlement_id_key" UNIQUE (entitlement_id),
CONSTRAINT "tournament_refund_tranches_idempotency_key_key" UNIQUE (idempotency_key),
CONSTRAINT "tournament_refund_tranches_obligation_id_amount_paid_before_key" UNIQUE (obligation_id, amount_paid_before),
CONSTRAINT "tournament_refund_tranches_pkey" PRIMARY KEY (wallet_transaction_id),
CONSTRAINT "tournament_refund_tranches_refund_bounty_check" CHECK ((((refund_bounty)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND (refund_bounty >= (0)::numeric) AND (refund_bounty = round(refund_bounty, 2)))),
CONSTRAINT "tournament_refund_tranches_refund_fee_check" CHECK ((((refund_fee)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND (refund_fee >= (0)::numeric) AND (refund_fee = round(refund_fee, 2)))),
CONSTRAINT "tournament_refund_tranches_refund_prize_check" CHECK ((((refund_prize)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND (refund_prize >= (0)::numeric) AND (refund_prize = round(refund_prize, 2)))),
CONSTRAINT "tournament_refund_tranches_source_check" CHECK ((length(btrim(source)) > 0))
);

CREATE TABLE public."tournament_satellite_awards" (
"tournament_id" uuid NOT NULL,
"place" integer NOT NULL,
"user_id" uuid NOT NULL,
"delivery_kind" text NOT NULL,
"amount" numeric(15,2) NOT NULL,
"payout_id" uuid NOT NULL,
"payout_source" text NOT NULL,
"idempotency_key" text NOT NULL,
"registration_id" uuid,
"ticket_id" uuid,
"obligation_id" uuid,
"obligation_kind" text,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
CONSTRAINT "tournament_satellite_awards_amount_check" CHECK (((amount > (0)::numeric) AND (amount = round(amount, 2)))),
CONSTRAINT "tournament_satellite_awards_check" CHECK (((((delivery_kind = 'seat'::text) AND (registration_id IS NOT NULL) AND (ticket_id IS NULL) AND (obligation_id IS NULL) AND (obligation_kind IS NULL) AND (payout_source = 'satellite_seat'::text)) OR ((delivery_kind = 'cash'::text) AND (registration_id IS NULL) AND (ticket_id IS NULL) AND (obligation_id IS NOT NULL) AND (obligation_kind = ANY (ARRAY['seat'::text, 'place'::text])) AND (payout_source <> 'satellite_seat'::text)) OR ((delivery_kind = 'ticket'::text) AND (registration_id IS NULL) AND (ticket_id IS NOT NULL) AND (obligation_id IS NULL) AND (obligation_kind IS NULL) AND (payout_source = 'satellite_ticket'::text))) IS TRUE)),
CONSTRAINT "tournament_satellite_awards_delivery_kind_check" CHECK ((delivery_kind = ANY (ARRAY['seat'::text, 'cash'::text, 'ticket'::text]))),
CONSTRAINT "tournament_satellite_awards_idempotency_key_check" CHECK ((length(btrim(idempotency_key)) > 0)),
CONSTRAINT "tournament_satellite_awards_idempotency_key_key" UNIQUE (idempotency_key),
CONSTRAINT "tournament_satellite_awards_payout_id_key" UNIQUE (payout_id),
CONSTRAINT "tournament_satellite_awards_payout_source_check" CHECK ((length(btrim(payout_source)) > 0)),
CONSTRAINT "tournament_satellite_awards_pkey" PRIMARY KEY (tournament_id, place),
CONSTRAINT "tournament_satellite_awards_place_check" CHECK ((place > 0)),
CONSTRAINT "tournament_satellite_awards_registration_id_key" UNIQUE (registration_id),
CONSTRAINT "tournament_satellite_awards_ticket_id_key" UNIQUE (ticket_id),
CONSTRAINT "tournament_satellite_awards_tournament_id_user_id_key" UNIQUE (tournament_id, user_id)
);

CREATE TABLE public."tournament_tickets" (
"id" uuid DEFAULT gen_random_uuid() NOT NULL,
"club_id" uuid NOT NULL,
"issued_by" uuid NOT NULL,
"holder_id" uuid NOT NULL,
"value" numeric NOT NULL,
"note" text,
"status" text DEFAULT 'issued'::text NOT NULL,
"redeemed_at" timestamp with time zone,
"cancelled_at" timestamp with time zone,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"redemption_mode" text DEFAULT 'wallet_chips'::text NOT NULL,
"source_tournament_id" uuid,
"source_satellite_id" uuid,
"source_refund_entitlement_id" uuid,
"source_satellite_award_place" integer,
"entry_prize" numeric(15,2),
"entry_bounty" numeric(15,2),
"entry_fee" numeric(15,2),
CONSTRAINT "tournament_tickets_pkey" PRIMARY KEY (id),
CONSTRAINT "tournament_tickets_redemption_mode_check" CHECK ((redemption_mode = ANY (ARRAY['wallet_chips'::text, 'tournament_entry_only'::text]))),
CONSTRAINT "tournament_tickets_satellite_entry_contract_check" CHECK (((((redemption_mode = 'wallet_chips'::text) AND (source_tournament_id IS NULL) AND (source_satellite_id IS NULL) AND (source_refund_entitlement_id IS NULL) AND (source_satellite_award_place IS NULL) AND (entry_prize IS NULL) AND (entry_bounty IS NULL) AND (entry_fee IS NULL)) OR ((redemption_mode = 'tournament_entry_only'::text) AND (issued_by = '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid) AND (source_tournament_id IS NOT NULL) AND (source_satellite_id IS NOT NULL) AND (((source_refund_entitlement_id IS NOT NULL) AND (source_satellite_award_place IS NULL)) OR ((source_refund_entitlement_id IS NULL) AND (source_satellite_award_place > 0) AND (source_tournament_id <> source_satellite_id))) AND (entry_prize IS NOT NULL) AND (entry_prize >= (0)::numeric) AND (entry_prize = round(entry_prize, 2)) AND (entry_bounty IS NOT NULL) AND (entry_bounty >= (0)::numeric) AND (entry_bounty = round(entry_bounty, 2)) AND (entry_fee IS NOT NULL) AND (entry_fee >= (0)::numeric) AND (entry_fee = round(entry_fee, 2)) AND (value = round(((entry_prize + entry_bounty) + entry_fee), 2)))) IS TRUE)),
CONSTRAINT "tournament_tickets_status_check" CHECK ((status = ANY (ARRAY['issued'::text, 'redeemed'::text, 'cancelled'::text]))),
CONSTRAINT "tournament_tickets_value_check" CHECK ((value > (0)::numeric))
);

CREATE TABLE public."tournament_unregistration_receipts" (
"registration_id" uuid NOT NULL,
"request_id" uuid NOT NULL,
"tournament_id" uuid NOT NULL,
"user_id" uuid NOT NULL,
"source_table_id" uuid,
"refunded_chips" numeric(15,2) NOT NULL,
"returned_ticket_value" numeric(15,2) NOT NULL,
"entitlement_ids" uuid[] NOT NULL,
"ticket_ids" uuid[] NOT NULL,
"source_wallet_club_ids" uuid[] NOT NULL,
"credit_ledger_ids" uuid[] NOT NULL,
"wallet_transaction_ids" uuid[] NOT NULL,
"fees_reversed" numeric(15,2) NOT NULL,
"fee_reversal_ids" uuid[] NOT NULL,
"fee_source_rake_record_ids" uuid[] NOT NULL,
"seat_number" integer,
"seats_taken" integer,
"scheduled_start_at" timestamp with time zone NOT NULL,
"settled_at" timestamp with time zone NOT NULL,
CONSTRAINT "tournament_unregistration_receipts_check" CHECK (((array_position(entitlement_ids, NULL::uuid) IS NULL) AND (array_position(ticket_ids, NULL::uuid) IS NULL) AND (array_position(source_wallet_club_ids, NULL::uuid) IS NULL) AND (array_position(credit_ledger_ids, NULL::uuid) IS NULL) AND (array_position(wallet_transaction_ids, NULL::uuid) IS NULL) AND (array_position(fee_reversal_ids, NULL::uuid) IS NULL) AND (array_position(fee_source_rake_record_ids, NULL::uuid) IS NULL))),
CONSTRAINT "tournament_unregistration_receipts_check1" CHECK ((cardinality(entitlement_ids) = cardinality(source_wallet_club_ids))),
CONSTRAINT "tournament_unregistration_receipts_check2" CHECK ((cardinality(entitlement_ids) = (cardinality(ticket_ids) + cardinality(wallet_transaction_ids)))),
CONSTRAINT "tournament_unregistration_receipts_check3" CHECK ((cardinality(credit_ledger_ids) = cardinality(wallet_transaction_ids))),
CONSTRAINT "tournament_unregistration_receipts_check4" CHECK (((returned_ticket_value = (0)::numeric) = (cardinality(ticket_ids) = 0))),
CONSTRAINT "tournament_unregistration_receipts_check5" CHECK (((refunded_chips = (0)::numeric) = (cardinality(wallet_transaction_ids) = 0))),
CONSTRAINT "tournament_unregistration_receipts_check6" CHECK (((fees_reversed = (0)::numeric) = (cardinality(fee_reversal_ids) = 0))),
CONSTRAINT "tournament_unregistration_receipts_check7" CHECK (((fees_reversed = (0)::numeric) = (cardinality(fee_source_rake_record_ids) = 0))),
CONSTRAINT "tournament_unregistration_receipts_check8" CHECK ((((source_table_id IS NULL) AND (seat_number IS NULL)) OR ((source_table_id IS NOT NULL) AND (seat_number IS NOT NULL)))),
CONSTRAINT "tournament_unregistration_receipts_check9" CHECK ((settled_at < scheduled_start_at)),
CONSTRAINT "tournament_unregistration_receipts_fees_reversed_check" CHECK (((fees_reversed >= (0)::numeric) AND ((fees_reversed)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND (fees_reversed = round(fees_reversed, 2)))),
CONSTRAINT "tournament_unregistration_receipts_pkey" PRIMARY KEY (registration_id),
CONSTRAINT "tournament_unregistration_receipts_refunded_chips_check" CHECK (((refunded_chips >= (0)::numeric) AND ((refunded_chips)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND (refunded_chips = round(refunded_chips, 2)))),
CONSTRAINT "tournament_unregistration_receipts_request_id_key" UNIQUE (request_id),
CONSTRAINT "tournament_unregistration_receipts_returned_ticket_value_check" CHECK (((returned_ticket_value >= (0)::numeric) AND ((returned_ticket_value)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text])) AND (returned_ticket_value = round(returned_ticket_value, 2))))
);

CREATE TABLE public."tournaments" (
"id" uuid DEFAULT gen_random_uuid() NOT NULL,
"name" text NOT NULL,
"description" text,
"game_type" text DEFAULT 'NLH'::text NOT NULL,
"variant" text,
"buy_in_amount" numeric(15,2) NOT NULL,
"buy_in_fee" numeric(15,2) NOT NULL,
"guaranteed_prize" numeric(15,2) DEFAULT 0,
"start_time" timestamp with time zone NOT NULL,
"status" text DEFAULT 'ANNOUNCED'::text NOT NULL,
"current_players" integer DEFAULT 0,
"max_players" integer NOT NULL,
"late_reg_mins" integer DEFAULT 60,
"starting_chips" integer DEFAULT 10000,
"blind_structure" text DEFAULT 'Standard'::text,
"payout_structure" text DEFAULT 'Standard'::text,
"created_at" timestamp with time zone DEFAULT now(),
"updated_at" timestamp with time zone DEFAULT now(),
"club_id" uuid,
"started_at" timestamp with time zone,
"ended_at" timestamp with time zone,
"current_level" integer DEFAULT 0,
"prize_pool" numeric(18,2) DEFAULT 0,
"is_rebuy" boolean DEFAULT false,
"add_on_available" boolean DEFAULT false,
"rebuy_cost" numeric(15,2) DEFAULT 0,
"rebuy_chips" integer DEFAULT 0,
"rebuy_levels" integer DEFAULT 4,
"addon_cost" numeric(15,2) DEFAULT 0,
"addon_chips" integer DEFAULT 0,
"min_players" integer DEFAULT 3,
"tournament_type" text DEFAULT 'MTT'::text,
"is_bounty" boolean DEFAULT false,
"bounty_amount" numeric(15,2) DEFAULT 0,
"is_pko" boolean DEFAULT false,
"is_mystery_bounty" boolean DEFAULT false,
"mystery_bounty_min" numeric(15,2) DEFAULT 0,
"mystery_bounty_max" numeric(15,2) DEFAULT 0,
"is_xmtt" boolean DEFAULT false,
"union_id" uuid,
"is_multi_day" boolean DEFAULT false,
"parent_tournament_id" uuid,
"flight_number" integer,
"day_number" integer DEFAULT 1,
"total_days" integer DEFAULT 1,
"flight_end_chips_snapshot" jsonb,
"survivors_advance_to" uuid,
"is_pinned" boolean DEFAULT false,
"spin_multiplier" numeric DEFAULT 0,
"is_premium_spin" boolean DEFAULT false,
"prize_pool_finalized" boolean DEFAULT false,
"is_turbo" boolean DEFAULT false,
"blind_speed" text DEFAULT 'standard'::text,
"spin_type" text DEFAULT 'standard'::text,
"total_rake" numeric(18,2) DEFAULT 0 NOT NULL,
"late_reg_levels" integer DEFAULT 0,
"addon_levels" integer DEFAULT 1,
"is_reentry" boolean DEFAULT false,
"satellite_target" uuid,
"max_rebuys" integer DEFAULT 0,
"max_reentries" integer DEFAULT 0,
"level_started_at" timestamp with time zone,
"addon_period_triggered" boolean DEFAULT false,
"satellite_target_id" uuid,
"final_table_triggered" boolean DEFAULT false NOT NULL,
"bounty_pool" numeric(18,2) DEFAULT 0 NOT NULL,
"bounty_pool_paid" numeric DEFAULT 0 NOT NULL,
"on_break" boolean DEFAULT false NOT NULL,
"break_started_at" timestamp with time zone,
"break_ends_at" timestamp with time zone,
"is_private" boolean DEFAULT false NOT NULL,
"spin_locked_tiers" jsonb,
"short_description" text,
"is_vip_only" boolean DEFAULT false NOT NULL,
"ban_chat" boolean DEFAULT false NOT NULL,
"all_in_or_fold" boolean DEFAULT false NOT NULL,
"label_as_new" boolean DEFAULT false NOT NULL,
"hide_club_name" boolean DEFAULT false NOT NULL,
"action_time_seconds" integer DEFAULT 15 NOT NULL,
"table_size" integer DEFAULT 9 NOT NULL,
"accelerated_mtt" boolean DEFAULT false NOT NULL,
"addon_break_minutes" integer DEFAULT 1 NOT NULL,
"big_blind_ante" boolean DEFAULT false NOT NULL,
"authorized_to_register" boolean DEFAULT false NOT NULL,
"early_bird_enabled" boolean DEFAULT false NOT NULL,
"early_bird_chips" integer DEFAULT 0 NOT NULL,
"bubble_protection" boolean DEFAULT false NOT NULL,
"final_table_deal_enabled" boolean DEFAULT false NOT NULL,
"restart_every_minutes" integer,
"synchronized_breaks" boolean DEFAULT true NOT NULL,
"satellite_seats" integer,
"schedule_id" uuid,
"mystery_bounty_activation" text DEFAULT 'at_the_money'::text NOT NULL,
"mystery_bounty_activation_value" numeric,
"mystery_bounty_profile" text DEFAULT 'classic'::text NOT NULL,
"mystery_bounty_top_percent" numeric DEFAULT 20 NOT NULL,
"mystery_bounty_regular_pool_percent" numeric DEFAULT 50 NOT NULL,
"mystery_bounty_pool_percent" numeric DEFAULT 50 NOT NULL,
"mystery_bounty_stage" text DEFAULT 'pending'::text NOT NULL,
"mystery_bounty_activated_at" timestamp with time zone,
"mystery_bounty_activated_players" integer,
"mystery_bounty_pool_cents" bigint,
"allow_rabbit_hunt" boolean DEFAULT true NOT NULL,
"spin_reveal_lag_ms" integer,
"addon_period_started_at" timestamp with time zone,
"addon_period_ends_at" timestamp with time zone,
"payout_percent" smallint DEFAULT 10 NOT NULL,
"free_buy" boolean DEFAULT false NOT NULL,
"addon_from_start" boolean DEFAULT false NOT NULL,
"spin_reveal_at" timestamp with time zone,
"mystery_bounty_activation_generation" bigint DEFAULT 0 NOT NULL,
"entry_contract_locked" boolean DEFAULT false NOT NULL,
CONSTRAINT "tournaments_free_buy_entry_is_free" CHECK (((NOT free_buy) OR ((COALESCE(buy_in_amount, (0)::numeric) = (0)::numeric) AND (COALESCE(buy_in_fee, (0)::numeric) = (0)::numeric)))),
CONSTRAINT "tournaments_heads_up_rake_within_5_pct" CHECK (((max_players IS NULL) OR (max_players > 2) OR (COALESCE(buy_in_fee, (0)::numeric) <= (round(((COALESCE(buy_in_amount, (0)::numeric) + COALESCE(buy_in_fee, (0)::numeric)) * 0.05), 2) + 0.005)))) NOT VALID,
CONSTRAINT "tournaments_mystery_activation_chk" CHECK ((mystery_bounty_activation = ANY (ARRAY['at_the_money'::text, 'percent_field'::text, 'player_count'::text]))),
CONSTRAINT "tournaments_mystery_activation_generation_nonnegative" CHECK ((mystery_bounty_activation_generation >= 0)),
CONSTRAINT "tournaments_mystery_profile_chk" CHECK ((mystery_bounty_profile = ANY (ARRAY['balanced'::text, 'classic'::text, 'jackpot'::text]))),
CONSTRAINT "tournaments_mystery_stage_chk" CHECK ((mystery_bounty_stage = ANY (ARRAY['pending'::text, 'active'::text, 'complete'::text]))),
CONSTRAINT "tournaments_never_pko_and_mystery" CHECK ((NOT (COALESCE(is_pko, false) AND COALESCE(is_mystery_bounty, false)))),
CONSTRAINT "tournaments_no_pko_mystery_hybrid" CHECK ((NOT (COALESCE(is_pko, false) AND COALESCE(is_mystery_bounty, false)))),
CONSTRAINT "tournaments_payout_percent_check" CHECK ((payout_percent = ANY (ARRAY[10, 15, 20]))) NOT VALID,
CONSTRAINT "tournaments_pkey" PRIMARY KEY (id),
CONSTRAINT "tournaments_rake_within_10_pct" CHECK ((COALESCE(buy_in_fee, (0)::numeric) <= (((COALESCE(buy_in_amount, (0)::numeric) + COALESCE(buy_in_fee, (0)::numeric)) * 0.1) + 0.000000001))) NOT VALID,
CONSTRAINT "tournaments_spin_has_no_fee" CHECK (((created_at < '2026-08-21 00:00:00+00'::timestamp with time zone) OR (((lower(COALESCE(variant, ''::text)) <> 'spin'::text) AND (upper(COALESCE(tournament_type, ''::text)) <> 'SPIN'::text)) OR (COALESCE(buy_in_fee, (0)::numeric) = (0)::numeric)))) NOT VALID,
CONSTRAINT "tournaments_spin_no_extra_rake" CHECK (((created_at < '2026-08-21 00:00:00+00'::timestamp with time zone) OR ((variant IS DISTINCT FROM 'spin'::text) AND (upper(COALESCE(tournament_type, ''::text)) <> 'SPIN'::text)) OR (COALESCE(buy_in_fee, (0)::numeric) = (0)::numeric))) NOT VALID,
CONSTRAINT "tournaments_status_check" CHECK ((status = ANY (ARRAY['ANNOUNCED'::text, 'REGISTERING'::text, 'LATE_REG'::text, 'RUNNING'::text, 'COMPLETING'::text, 'COMPLETED'::text, 'CANCELLED'::text])))
);

CREATE TABLE public."wallet_credit_idempotency" (
"key" text NOT NULL,
"user_id" uuid,
"amount" numeric,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
CONSTRAINT "wallet_credit_idempotency_pkey" PRIMARY KEY (key)
);

CREATE TABLE public."wallet_transactions" (
"id" uuid DEFAULT gen_random_uuid() NOT NULL,
"user_id" uuid NOT NULL,
"wallet_type" text NOT NULL,
"amount" numeric(15,2) NOT NULL,
"type" text NOT NULL,
"category" text NOT NULL,
"description" text,
"related_entity_id" uuid,
"table_id" uuid,
"hand_id" uuid,
"created_at" timestamp with time zone DEFAULT now(),
"balance_after" numeric,
CONSTRAINT "chk_balance_after_is_two_decimal_places" CHECK (((balance_after IS NULL) OR (balance_after = round(balance_after, 2)))) NOT VALID,
CONSTRAINT "wallet_transactions_amount_non_negative" CHECK ((amount >= (0)::numeric)) NOT VALID,
CONSTRAINT "wallet_transactions_category_check" CHECK ((category = ANY (ARRAY['buyin'::text, 'cashout'::text, 'promo'::text, 'rake'::text, 'transfer'::text, 'tournament_buyin'::text, 'tournament_winnings'::text, 'tournament_cashout'::text, 'horse_refill'::text, 'deposit'::text, 'withdrawal'::text, 'refund'::text, 'bbj'::text, 'bonus'::text, 'mint'::text, 'settlement'::text, 'commission'::text, 'INSURANCE'::text, 'prize'::text, 'rebuy'::text, 'addon'::text, 'funding'::text, 'promotion'::text, 'rakeback'::text, 'bounty'::text, 'addon_refund'::text, 'bounty_own'::text, 'prize_reversal'::text, 'leaderboard_payout'::text]))) NOT VALID,
CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY (id),
CONSTRAINT "wallet_transactions_type_check" CHECK ((type = ANY (ARRAY['credit'::text, 'debit'::text]))),
CONSTRAINT "wallet_transactions_wallet_type_check" CHECK ((wallet_type = ANY (ARRAY['PLAYER'::text, 'BUSINESS'::text, 'PROMO'::text, 'CLUB'::text, 'UNION'::text, 'PLATFORM'::text])))
);

CREATE OR REPLACE FUNCTION public.fn_ca_current_epoch()
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$ SELECT id FROM public.ca_financial_epochs WHERE is_current LIMIT 1 $function$;

CREATE OR REPLACE FUNCTION public.fn_tournament_entry_split(p_buy_in numeric, p_fee numeric, p_bounty numeric, p_is_bounty boolean)
 RETURNS TABLE(charge numeric, rake numeric, bounty numeric, prize numeric)
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_charge numeric; v_rake numeric; v_bounty numeric; v_prize numeric;
BEGIN
  IF NOT COALESCE(p_is_bounty, false) THEN
    -- Non-bounty: unchanged - fee charged on top of the buy-in portion.
    v_charge := round(COALESCE(p_buy_in,0),2) + round(COALESCE(p_fee,0),2);
    v_rake   := round(COALESCE(p_fee,0),2);
    v_bounty := 0;
    v_prize  := round(COALESCE(p_buy_in,0),2);
  ELSE
    -- Bounty event: the rake is exactly the fee. A zero fee is a legitimate
    -- outcome of the whole-number floor rule (totals under 10 take no rake)
    -- and must NEVER be replaced with a percentage default.
    v_charge := round(COALESCE(p_buy_in,0),2) + round(COALESCE(p_fee,0),2);
    v_rake   := round(COALESCE(p_fee,0),2);
    v_bounty := round(COALESCE(p_bounty,0), 2);
    v_prize  := round(v_charge - v_rake - v_bounty, 2);  -- = buy_in - bounty
  END IF;
  RETURN QUERY SELECT v_charge, v_rake, v_bounty, v_prize;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_declare_ledger(p_category text, p_counterparty text, p_counterparty_entity uuid DEFAULT NULL::uuid, p_settlement_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_autoskip_tables text[] DEFAULT NULL::text[])
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_t text;
BEGIN
  -- validate against the LIVE vocabulary so this can never lag a CHECK change
  IF p_category IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.chip_ledger'::regclass
       AND conname = 'chip_ledger_category_check'
       AND pg_get_constraintdef(oid) LIKE '%''' || p_category || '''%') THEN
    RAISE EXCEPTION 'fn_ca_declare_ledger: category % is not in the ledger vocabulary - add it to chip_ledger_category_check FIRST, then declare it', p_category;
  END IF;
  IF p_counterparty IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.chip_ledger'::regclass
       AND conname = 'chip_ledger_from_type_check'
       AND pg_get_constraintdef(oid) LIKE '%''' || p_counterparty || '''%') THEN
    RAISE EXCEPTION 'fn_ca_declare_ledger: counterparty % is not in the ledger vocabulary - add it to the from/to type CHECKs FIRST, then declare it', p_counterparty;
  END IF;

  PERFORM set_config('app.ledger_category', p_category, true);
  PERFORM set_config('app.ledger_counterparty', p_counterparty, true);
  PERFORM set_config('app.ledger_counterparty_entity',
                     COALESCE(p_counterparty_entity::text, ''), true);
  IF p_settlement_id IS NOT NULL THEN
    PERFORM set_config('app.ledger_settlement', p_settlement_id::text, true);
  END IF;
  IF p_idempotency_key IS NOT NULL THEN
    PERFORM set_config('app.ledger_idempotency_key', p_idempotency_key, true);
  END IF;
  IF p_autoskip_tables IS NOT NULL THEN
    FOREACH v_t IN ARRAY p_autoskip_tables LOOP
      IF v_t !~ '^[a-z_]+$' THEN
        RAISE EXCEPTION 'fn_ca_declare_ledger: bad autoskip table name %', v_t;
      END IF;
      PERFORM set_config('app.ledger_autoskip_' || v_t, '1', true);
    END LOOP;
  END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_escrow(p_tournament_id uuid)
 RETURNS TABLE(prize_in numeric, bounty_in numeric, fee_in numeric, overlay_in numeric, satellite_in numeric, prize_out numeric, bounty_out numeric, fee_out numeric, refund_out numeric, prize_balance numeric, bounty_balance numeric, fee_balance numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
WITH t AS (
  SELECT id,COALESCE(buy_in_amount,0) AS buy_in_amount,
         COALESCE(buy_in_fee,0) AS buy_in_fee,
         COALESCE(bounty_amount,0) AS bounty_amount,
         (COALESCE(is_bounty,false) OR COALESCE(is_pko,false)
          OR COALESCE(is_mystery_bounty,false)) AS is_b
    FROM public.tournaments WHERE id=p_tournament_id
), w AS (
  SELECT
    COALESCE(sum(amount) FILTER (WHERE type='debit'
      AND category IN ('tournament_buyin','rebuy','addon')),0) AS gross_in,
    COALESCE(sum(amount) FILTER (WHERE type='credit' AND category='prize'),0)
      - COALESCE(sum(amount) FILTER (WHERE type='debit'
          AND category IN ('prize','prize_reversal')),0) AS prize_out,
    COALESCE(sum(amount) FILTER (WHERE type='credit' AND category='bounty'),0)
      AS bounty_out,
    COALESCE(sum(amount) FILTER (WHERE type='credit'
      AND category IN ('refund','tournament_refund')),0) AS refund_out
  FROM public.wallet_transactions WHERE related_entity_id=p_tournament_id
), direct_bounty AS (
  SELECT round(COALESCE(sum(CASE
    WHEN NOT t.is_b OR lower(l.category)='addon' THEN 0
    WHEN lower(l.category)='tournament_buyin' THEN round(t.bounty_amount,2)
    ELSE LEAST(
      GREATEST(0,round(t.bounty_amount,2)),
      round(l.amount,2)-LEAST(
        trunc(round(l.amount,2)*(CASE
          WHEN t.buy_in_amount+t.buy_in_fee>0 AND t.buy_in_fee>0
            THEN t.buy_in_fee/(t.buy_in_amount+t.buy_in_fee)
          ELSE 0.1 END)*100+0.000001)/100,
        trunc(round(l.amount,2)*0.1*100+0.000001)/100))
    END),0),2) AS amount
  FROM t LEFT JOIN public.chip_ledger l
    ON l.tournament_id=p_tournament_id
   AND l.from_type='player_wallet' AND l.to_type='prize_liability'
   AND l.to_entity_id=p_tournament_id
   AND lower(l.category) IN ('tournament_buyin','rebuy','addon')
), rr AS (
  SELECT
    COALESCE(sum(rake_amount),0) AS fee_in,
    COALESCE(sum(rake_amount) FILTER (
      WHERE source='fn_award_satellite_seat'),0) AS fee_sat,
    COALESCE(sum(rake_amount) FILTER (
      WHERE source='fn_award_satellite_seat'
        AND metadata->>'entry_split_version'='2'),0) AS fee_sat_split,
    COALESCE(sum(COALESCE(pot_size,0)-rake_amount) FILTER (
      WHERE source='fn_award_satellite_seat'),0) AS satellite_in
  FROM public.rake_records
  WHERE tournament_id=p_tournament_id AND is_tournament
    AND NOT (rake_amount<0 AND source IN (
      'atomic_cancel_tournament','fn_unregister_from_tournament'))
), ov AS (
  SELECT COALESCE(sum(a.amount),0) AS ledger_overlay
    FROM public.chip_ledger a
   WHERE a.to_entity_id=p_tournament_id
     AND a.to_type='prize_liability'
     AND (a.category='overlay' OR
       (a.category='correction' AND a.from_type IN ('union_bank','club_treasury')))
     AND NOT (COALESCE(a.description,'') LIKE 'auto-ledgered%'
       AND EXISTS (
         SELECT 1 FROM public.chip_ledger b
          WHERE b.to_entity_id=a.to_entity_id AND b.category='overlay'
            AND b.to_type='prize_liability' AND b.id<>a.id
            AND b.amount=a.amount
            AND COALESCE(b.description,'') NOT LIKE 'auto-ledgered%'
            AND abs(extract(epoch FROM (b.created_at-a.created_at)))<5))
), stl AS (
  SELECT COALESCE(sum(amount),0) AS moved,
    COALESCE(sum(amount) FILTER (
      WHERE metadata->>'entry_split_version'='2'),0) AS split_moved,
    COALESCE(sum((metadata->>'entry_fee')::numeric) FILTER (
      WHERE metadata->>'entry_split_version'='2'),0) AS split_fee,
    COALESCE(sum((metadata->>'entry_bounty')::numeric) FILTER (
      WHERE metadata->>'entry_split_version'='2'),0) AS split_bounty
  FROM public.chip_ledger
  WHERE to_entity_id=p_tournament_id AND to_type='prize_liability'
    AND idempotency_key LIKE 'tourney:%:seat:%:pool_transfer'
), tgo AS (
  SELECT COALESCE(sum(amount),0) AS tgo_amount
    FROM public.tournament_guarantee_overlays
   WHERE tournament_id=p_tournament_id
), sat AS (
  SELECT COALESCE(sum(p.amount),0) AS funded_awards_out
    FROM public.tournament_payouts p
    LEFT JOIN public.tournament_satellite_awards a
      ON a.payout_id=p.id
     AND a.tournament_id=p.tournament_id
     AND a.delivery_kind='ticket'
   WHERE p.tournament_id=p_tournament_id
     AND (p.source='satellite_seat'
       OR (p.source='satellite_ticket' AND a.payout_id IS NOT NULL))
), fo AS (
  SELECT COALESCE(sum(amount),0) AS fee_out
    FROM public.tournament_rake_settlements
   WHERE tournament_id=p_tournament_id AND settled_at IS NOT NULL
), exact_refunds AS (
  SELECT COALESCE(sum(amount_paid_now),0) AS total,
         COALESCE(sum(refund_prize),0) AS prize,
         COALESCE(sum(refund_bounty),0) AS bounty,
         COALESCE(sum(refund_fee),0) AS fee
    FROM public.tournament_refund_tranches
   WHERE tournament_id=p_tournament_id
), calc AS (
  SELECT
    round(w.gross_in+stl.split_moved-stl.split_fee,2) AS gross_in,
    round(rr.fee_in,2) AS fee_in,
    round(rr.fee_in-rr.fee_sat,2) AS fee_entries,
    round(direct_bounty.amount+stl.split_bounty,2) AS bounty_in,
    round(CASE WHEN ov.ledger_overlay>0 THEN ov.ledger_overlay
      ELSE tgo.tgo_amount END,2) AS overlay_in,
    round(stl.moved-stl.split_moved-rr.fee_sat+rr.fee_sat_split,2)
      AS satellite_in,
    round(w.prize_out+sat.funded_awards_out,2) AS prize_out,
    round(w.bounty_out,2) AS bounty_out,
    round(fo.fee_out,2) AS fee_out,
    round(w.refund_out,2) AS refund_out,
    round(exact_refunds.total,2) AS exact_total,
    round(exact_refunds.prize,2) AS exact_prize,
    round(exact_refunds.bounty,2) AS exact_bounty,
    round(exact_refunds.fee,2) AS exact_fee
  FROM t,w,direct_bounty,rr,stl,ov,tgo,sat,fo,exact_refunds
), split AS (
  SELECT c.*,round(c.gross_in-c.fee_entries-c.bounty_in,2) AS prize_in,
         round(c.refund_out-c.exact_total,2) AS legacy_refund
    FROM calc c
), apportioned AS (
  SELECT s.*,
    CASE WHEN (s.prize_in+s.satellite_in+s.bounty_in+s.fee_in)>0
      THEN round(s.legacy_refund*(s.prize_in+s.satellite_in)
        /(s.prize_in+s.satellite_in+s.bounty_in+s.fee_in),2)
      ELSE s.legacy_refund END AS legacy_prize,
    CASE WHEN (s.prize_in+s.satellite_in+s.bounty_in+s.fee_in)>0
      THEN round(s.legacy_refund*s.bounty_in
        /(s.prize_in+s.satellite_in+s.bounty_in+s.fee_in),2)
      ELSE 0 END AS legacy_bounty
  FROM split s
)
SELECT a.prize_in,a.bounty_in,a.fee_in,a.overlay_in,a.satellite_in,
       a.prize_out,a.bounty_out,a.fee_out,a.refund_out,
       round(a.prize_in+a.overlay_in+a.satellite_in-a.prize_out
         -a.legacy_prize-a.exact_prize,2) AS prize_balance,
       round(a.bounty_in-a.bounty_out-a.legacy_bounty-a.exact_bounty,2)
         AS bounty_balance,
       round(a.fee_in-a.fee_out
         -(a.legacy_refund-a.legacy_prize-a.legacy_bounty)-a.exact_fee,2)
         AS fee_balance
  FROM apportioned a;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_escrow_apply(p_tournament_id uuid, p_what text, p_gross_in numeric DEFAULT 0, p_fee_entries_in numeric DEFAULT 0, p_satellite_fee_in numeric DEFAULT 0, p_bounty_in numeric DEFAULT 0, p_overlay_in numeric DEFAULT 0, p_satellite_in numeric DEFAULT 0, p_prize_out numeric DEFAULT 0, p_bounty_out numeric DEFAULT 0, p_fee_out numeric DEFAULT 0, p_refund numeric DEFAULT 0, p_reserve_out numeric DEFAULT 0, p_reserve_in numeric DEFAULT 0)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v public.tournament_escrow%ROWTYPE;
  v_spin boolean; e record; v_sat_fee numeric;
  v_prize_in numeric; v_tot numeric; r_p numeric := 0; r_b numeric := 0; r_f numeric := 0;
  v_outflow boolean := COALESCE(p_prize_out, 0) > 0 OR COALESCE(p_bounty_out, 0) > 0 OR COALESCE(p_fee_out, 0) > 0 OR COALESCE(p_refund, 0) > 0;
  r_out numeric := 0; r_in numeric := 0;
  v_sp_prize numeric; v_sp_bounty numeric;
BEGIN
  SELECT * INTO v FROM public.tournament_escrow WHERE tournament_id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    SELECT (COALESCE(t.variant, '') = 'spin' OR COALESCE(t.is_premium_spin, false)) INTO v_spin
      FROM public.tournaments t WHERE t.id = p_tournament_id;
    IF NOT FOUND THEN
      RETURN;
    END IF;
    SELECT * INTO e FROM public.fn_ca_tournament_escrow(p_tournament_id);
    SELECT COALESCE(sum(rr.rake_amount), 0) INTO v_sat_fee FROM public.rake_records rr
     WHERE rr.tournament_id = p_tournament_id AND rr.is_tournament AND rr.source = 'fn_award_satellite_seat';
    v_prize_in := e.prize_in; v_tot := e.prize_in + e.satellite_in + e.bounty_in + e.fee_in;
    IF v_tot > 0 THEN
      r_p := round(e.refund_out * (e.prize_in + e.satellite_in) / v_tot, 2);
      r_b := round(e.refund_out * e.bounty_in / v_tot, 2);
    ELSE
      r_p := e.refund_out;
    END IF;
    r_f := round(e.refund_out - r_p - r_b, 2);
    /* PHASE 5.2: a spin's prize bank also moves through the reserve.
       2026-09-07: read from spin_reserve_ledger, not from the chip_ledger
       spin_entry / spin_prize legs it used to read. Those legs are the DERIVED
       record and one pair of them went missing: on 2026-09-06 at 12:50:38 both
       legs of tournament afa045db landed as `adjustment` rows into
       settlement_suspense with a NULL entity, their intended category
       surviving only inside the description text. The escrow therefore never
       learned that 60.00 had been drawn for a 60.00 prize, and
       fn_settle_tournament_obligation refused the winner's last 4.80 as
       escrow_short - for a day, with an open critical alert nobody could act
       on. spin_reserve_ledger is the record the pool balance itself moved by;
       it cannot be missing while the money has moved. Verified across 18,318
       escrow rows: 0 disagree with it, 1 was missing the legs entirely. */
    SELECT COALESCE(sum(l.amount) FILTER (WHERE l.kind = 'contribution'), 0),
           COALESCE(-sum(l.amount) FILTER (WHERE l.kind = 'jackpot_draw'), 0)
      INTO r_out, r_in
      FROM public.spin_reserve_ledger l
     WHERE l.tournament_id = p_tournament_id
       AND l.kind IN ('contribution', 'jackpot_draw');
    INSERT INTO public.tournament_escrow
      (tournament_id, enforced, gross_in, fee_entries_in, satellite_fee_in, bounty_in, overlay_in, satellite_in,
       prize_out, bounty_out, fee_out, refund_prize, refund_bounty, refund_fee, reserve_out, reserve_in,
       prize_balance, bounty_balance, fee_balance, opened_from)
    VALUES
      (p_tournament_id, true,
       round(e.prize_in + e.bounty_in + (e.fee_in - v_sat_fee), 2), round(e.fee_in - v_sat_fee, 2), round(v_sat_fee, 2),
       e.bounty_in, e.overlay_in, e.satellite_in, e.prize_out, e.bounty_out, e.fee_out, r_p, r_b, r_f, round(r_out, 2), round(r_in, 2),
       round(e.prize_balance - r_out + r_in, 2), e.bounty_balance, e.fee_balance,
       'shadow at first sight (' || p_what || ')')
    ON CONFLICT (tournament_id) DO NOTHING;
    RETURN;
  END IF;

  IF COALESCE(p_refund, 0) > 0 THEN
    v_prize_in := v.gross_in - v.fee_entries_in - v.bounty_in + v.satellite_in;
    v_tot := v.gross_in + v.satellite_in + v.satellite_fee_in;
    IF v_tot > 0 THEN
      r_p := round(p_refund * v_prize_in / v_tot, 2);
      r_b := round(p_refund * v.bounty_in / v_tot, 2);
    ELSE
      SELECT s.prize, s.bounty INTO v_sp_prize, v_sp_bounty
        FROM public.tournaments t2
        CROSS JOIN LATERAL public.fn_tournament_entry_split(t2.buy_in_amount, t2.buy_in_fee, t2.bounty_amount,
               COALESCE(t2.is_bounty, false) OR COALESCE(t2.is_pko, false) OR COALESCE(t2.is_mystery_bounty, false)) s
       WHERE t2.id = p_tournament_id;
      IF COALESCE(v_sp_prize, 0) + COALESCE(v_sp_bounty, 0) > 0 THEN
        r_p := round(p_refund * v_sp_prize / (v_sp_prize + v_sp_bounty + (SELECT COALESCE(t3.buy_in_fee, 0) FROM public.tournaments t3 WHERE t3.id = p_tournament_id)), 2);
        r_b := round(p_refund * v_sp_bounty / (v_sp_prize + v_sp_bounty + (SELECT COALESCE(t3.buy_in_fee, 0) FROM public.tournaments t3 WHERE t3.id = p_tournament_id)), 2);
      ELSE
        r_p := p_refund;
      END IF;
    END IF;
    r_f := round(p_refund - r_p - r_b, 2);
  END IF;

  UPDATE public.tournament_escrow
     SET gross_in = gross_in + COALESCE(p_gross_in, 0),
         fee_entries_in = fee_entries_in + COALESCE(p_fee_entries_in, 0),
         satellite_fee_in = satellite_fee_in + COALESCE(p_satellite_fee_in, 0),
         bounty_in = bounty_in + COALESCE(p_bounty_in, 0),
         overlay_in = overlay_in + COALESCE(p_overlay_in, 0),
         satellite_in = satellite_in + COALESCE(p_satellite_in, 0),
         prize_out = prize_out + COALESCE(p_prize_out, 0),
         bounty_out = bounty_out + COALESCE(p_bounty_out, 0),
         fee_out = fee_out + COALESCE(p_fee_out, 0),
         refund_prize = refund_prize + r_p, refund_bounty = refund_bounty + r_b, refund_fee = refund_fee + r_f,
         reserve_out = reserve_out + COALESCE(p_reserve_out, 0), reserve_in = reserve_in + COALESCE(p_reserve_in, 0),
         updated_at = now()
   WHERE tournament_id = p_tournament_id;
  UPDATE public.tournament_escrow
     SET prize_balance  = round((gross_in - fee_entries_in - bounty_in) + overlay_in + satellite_in - reserve_out + reserve_in - prize_out - refund_prize, 2),
         bounty_balance = round(bounty_in - bounty_out - refund_bounty, 2),
         fee_balance    = round(fee_entries_in + satellite_fee_in - fee_out - refund_fee, 2)
   WHERE tournament_id = p_tournament_id
   RETURNING * INTO v;

  IF v.enforced AND v_outflow
     AND (v.prize_balance < -0.005 OR v.bounty_balance < -0.005 OR v.fee_balance < -0.005) THEN
    RAISE EXCEPTION 'escrow_short: tournament % cannot pay this % - it would leave prize %, bounty %, fee % (chip standard Phase 5.1: an event pays only what it holds)',
      p_tournament_id, p_what, v.prize_balance, v.bounty_balance, v.fee_balance
      USING ERRCODE = 'P0403';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_escrow_apply_exact_refund(p_tournament_id uuid, p_what text, p_refund_prize numeric, p_refund_bounty numeric, p_refund_fee numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v public.tournament_escrow%ROWTYPE;
  v_prize numeric := round(COALESCE(p_refund_prize,0),2);
  v_bounty numeric := round(COALESCE(p_refund_bounty,0),2);
  v_fee numeric := round(COALESCE(p_refund_fee,0),2);
BEGIN
  IF p_tournament_id IS NULL
     OR p_refund_prize IS NULL OR p_refund_bounty IS NULL OR p_refund_fee IS NULL
     OR p_refund_prize::text IN ('NaN','Infinity','-Infinity')
     OR p_refund_bounty::text IN ('NaN','Infinity','-Infinity')
     OR p_refund_fee::text IN ('NaN','Infinity','-Infinity')
     OR p_refund_prize < 0 OR p_refund_bounty < 0 OR p_refund_fee < 0
     OR p_refund_prize IS DISTINCT FROM v_prize
     OR p_refund_bounty IS DISTINCT FROM v_bounty
     OR p_refund_fee IS DISTINCT FROM v_fee
     OR v_prize + v_bounty + v_fee <= 0 THEN
    RAISE EXCEPTION 'exact refund requires finite nonnegative whole-cent rails'
      USING ERRCODE = '22003';
  END IF;

  UPDATE public.tournament_escrow
     SET refund_prize = refund_prize + v_prize,
         refund_bounty = refund_bounty + v_bounty,
         refund_fee = refund_fee + v_fee,
         prize_balance = round(
           (gross_in - fee_entries_in - bounty_in) + overlay_in + satellite_in
           - reserve_out + reserve_in - prize_out - refund_prize - v_prize,2),
         bounty_balance = round(
           bounty_in - bounty_out - refund_bounty - v_bounty,2),
         fee_balance = round(
           fee_entries_in + satellite_fee_in - fee_out - refund_fee - v_fee,2),
         updated_at = now()
   WHERE tournament_id = p_tournament_id
   RETURNING * INTO v;
  IF v.tournament_id IS NULL OR v.enforced IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'exact refund escrow for tournament % is absent or unenforced',
      p_tournament_id USING ERRCODE = 'P0404';
  END IF;
  IF v.prize_balance IS NULL OR v.bounty_balance IS NULL OR v.fee_balance IS NULL
     OR v.refund_prize IS NULL OR v.refund_bounty IS NULL OR v.refund_fee IS NULL
     OR v.prize_balance::text IN ('NaN','Infinity','-Infinity')
     OR v.bounty_balance::text IN ('NaN','Infinity','-Infinity')
     OR v.fee_balance::text IN ('NaN','Infinity','-Infinity')
     OR v.refund_prize::text IN ('NaN','Infinity','-Infinity')
     OR v.refund_bounty::text IN ('NaN','Infinity','-Infinity')
     OR v.refund_fee::text IN ('NaN','Infinity','-Infinity')
     OR v.prize_balance IS DISTINCT FROM round(v.prize_balance,2)
     OR v.bounty_balance IS DISTINCT FROM round(v.bounty_balance,2)
     OR v.fee_balance IS DISTINCT FROM round(v.fee_balance,2)
     OR v.refund_prize IS DISTINCT FROM round(v.refund_prize,2)
     OR v.refund_bounty IS DISTINCT FROM round(v.refund_bounty,2)
     OR v.refund_fee IS DISTINCT FROM round(v.refund_fee,2)
     OR v.prize_balance < -0.005
     OR v.bounty_balance < -0.005
     OR v.fee_balance < -0.005 THEN
    RAISE EXCEPTION
      'escrow_short: tournament % cannot pay exact % rails %, %, %; balances would be %, %, %',
      p_tournament_id,p_what,v_prize,v_bounty,v_fee,
      v.prize_balance,v.bounty_balance,v.fee_balance USING ERRCODE = 'P0403';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_chip_ledger_enrich()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_prev text;
BEGIN
  NEW.amount := round(NEW.amount, 2);
  NEW.created_at := COALESCE(NEW.created_at, now());

  NEW.epoch_id      := COALESCE(NEW.epoch_id, public.fn_ca_current_epoch());
  NEW.actor_service := COALESCE(NEW.actor_service,
                                current_setting('application_name', true));
  NEW.db_role       := COALESCE(NEW.db_role, current_user);
  NEW.correlation_id := COALESCE(NEW.correlation_id,
      NULLIF(current_setting('app.ledger_correlation', true), '')::uuid);
  NEW.settlement_id  := COALESCE(NEW.settlement_id,
      NULLIF(current_setting('app.ledger_settlement', true), ''));
  IF NEW.idempotency_key IS NULL THEN
    NEW.idempotency_key := NULLIF(current_setting('app.ledger_idempotency_key', true), '');
    IF NEW.idempotency_key IS NOT NULL THEN
      -- consume-once: the next row in this transaction must not inherit it
      PERFORM set_config('app.ledger_idempotency_key', '', true);
    END IF;
  END IF;

  /* PHASE 6.4 (2026-09-05): EVERY LEG NAMES ITS HAND OR ITS EVENT. The doors
     that know the hand say so on app.ledger_hand_id (the rake door and the
     BBJ drop, since today) or on a 'bbj:<hand>' settlement; the rake
     settlement is not read for it because it carries a random key when the
     hand is unknown, and a guessed hand is worse than none; a spin's reserve legs
     carry the spin on their prize_liability side. Read them here, once, so
     the hand and the event are columns a per-hand audit can index on rather
     than strings it has to parse. 231,211 legs a day; 29,617 named a hand
     and 50,359 an event before this. */
  IF NEW.hand_id IS NULL THEN
    NEW.hand_id := NULLIF(current_setting('app.ledger_hand_id', true), '')::uuid;
    IF NEW.hand_id IS NULL AND NEW.settlement_id ~ '^bbj:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      NEW.hand_id := split_part(NEW.settlement_id, ':', 2)::uuid;
    END IF;
  END IF;
  IF NEW.tournament_id IS NULL THEN
    NEW.tournament_id := NULLIF(current_setting('app.ledger_tournament_id', true), '')::uuid;
    /* PHASE 6 GATE (2026-09-05): a prize_liability side IS the event, on every
       category, not only the two spin ones. This is what the 6.4 measurement
       missed: 777 tournament rake settlements in three hours (the fee leaving
       an event to a union rake wallet or a club treasury) and every tournament
       add-on named nothing. Read against the rows first: all 777 from_entity_id
       values are real tournaments. The FROM side wins when both sides are
       prize_liability (a satellite seat's pool transfer, which already stamps
       the satellite itself). */
    IF NEW.tournament_id IS NULL THEN
      IF NEW.from_type = 'prize_liability' THEN NEW.tournament_id := NEW.from_entity_id;
      ELSIF NEW.to_type = 'prize_liability' THEN NEW.tournament_id := NEW.to_entity_id;
      END IF;
    END IF;
  END IF;
  /* PHASE 6 GATE: and a table_stack side IS the table. Every cash buy-in,
     add-on and cash-out carries the table on its felt side (231, 53 and 222
     of each measured in the same window, every one a real table row) and
     none of them carried table_id. A cash buy-in is not a hand; the table is
     the name it has. */
  IF NEW.table_id IS NULL THEN
    IF NEW.to_type = 'table_stack' THEN NEW.table_id := NEW.to_entity_id;
    ELSIF NEW.from_type = 'table_stack' THEN NEW.table_id := NEW.from_entity_id;
    END IF;
  END IF;

  -- Tamper evidence: monotone sequence + per-row content checksum. NOT chained
  -- through the previous row's hash at insert time - that would put a global
  -- serialization point (and deadlock surface) inside every money transaction,
  -- which the availability policy forbids. prev_hash is best-effort forensics.
  NEW.chain_seq := nextval('public.chip_ledger_chain_seq');
  SELECT row_hash INTO v_prev
    FROM public.chip_ledger
   WHERE chain_seq = NEW.chain_seq - 1;
  NEW.prev_hash := v_prev;
  NEW.row_hash := encode(extensions.digest(
      'v1'
      || '|' || NEW.chain_seq::text
      || '|' || COALESCE(NEW.epoch_id::text,'')
      || '|' || NEW.amount::text
      || '|' || NEW.from_type || ':' || COALESCE(NEW.from_entity_id::text,'')
      || '|' || NEW.to_type   || ':' || COALESCE(NEW.to_entity_id::text,'')
      || '|' || NEW.category
      || '|' || COALESCE(NEW.idempotency_key,'')
      || '|' || COALESCE(NEW.correlation_id::text,'')
      || '|' || NEW.created_at::text,
      'sha256'), 'hex');
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_club_members_ledger_writer()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  d     numeric;
  actor uuid;
  cat   text;
  tid   uuid;
  st    text;
  msg   text;
  cp    text;
  cpid  uuid;
BEGIN
  /* THE AUTOSKIP CONTRACT IS ONE CONTRACT (2026-09-09). Every other journal
     writer on this platform stands down when the caller sets
     app.ledger_autoskip_<table>, because the caller is writing the leg itself
     with the period, the key and the metadata that only it knows. This writer
     never learned that clause. So a settlement that suppressed the clubs
     trigger and wrote its own named leg still got an anonymous twin from this
     side, and the movement reached the journal twice: on 2026-09-09 round 2
     moved 20,377.49 of commission and recorded 40,754.98 of legs. Standing
     down here is what makes one movement, one leg true for the busiest
     balance column on the platform. */
  IF current_setting('app.ledger_autoskip_club_members', true) = '1' THEN
    RETURN NEW;
  END IF;

  d := COALESCE(NEW.chip_balance, 0) - COALESCE(OLD.chip_balance, 0);

  IF d = 0 THEN
    RETURN NEW;
  END IF;

  actor := COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);

  cat := COALESCE(NULLIF(current_setting('app.ledger_category', true), ''), 'adjustment');

  BEGIN
    tid := NULLIF(current_setting('app.ledger_tournament', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    tid := NULL;
  END;

  /* THE COUNTERPARTY IS DECLARED, NEVER INFERRED (2026-08-31). */
  cp := COALESCE(NULLIF(current_setting('app.ledger_counterparty', true), ''), 'settlement_suspense');
  BEGIN
    cpid := NULLIF(current_setting('app.ledger_counterparty_entity', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN
    cpid := NULL;
  END;

  BEGIN
    INSERT INTO public.chip_ledger
      (performed_by, from_type, from_entity_id, to_type, to_entity_id,
       amount, category, club_id, tournament_id, description)
    VALUES (
      actor,
      CASE WHEN d > 0 THEN cp              ELSE 'player_wallet' END,
      CASE WHEN d > 0 THEN cpid            ELSE NEW.user_id     END,
      CASE WHEN d > 0 THEN 'player_wallet' ELSE cp              END,
      CASE WHEN d > 0 THEN NEW.user_id     ELSE cpid            END,
      abs(d), cat, NEW.club_id, tid,
      'auto-audited club_members.chip_balance delta ' || d::text);

  EXCEPTION WHEN OTHERS THEN
      -- A journal failure must abort the enclosing chip movement.
      -- Preserve SQLSTATE so the existing caller can retry the whole operation.
      RAISE;
    END;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.zz_chip_ledger_key_is_claimed_once()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  /* 99.92% of legs carry no key and this does nothing for them. */
  IF NEW.idempotency_key IS NULL THEN
    RETURN NEW;
  END IF;

  /* No ON CONFLICT: the unique violation IS the refusal, and it must reach the
     caller exactly as ux_chip_ledger_idempotency_key's does today. Both are
     live until the cut; either one refusing is the correct outcome. */
  INSERT INTO public.chip_ledger_idem (idempotency_key, leg_id, created_at)
  VALUES (NEW.idempotency_key, NEW.id, COALESCE(NEW.created_at, now()));

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_satellite_settlement_receipts_are_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  RAISE EXCEPTION
    'satellite settlement evidence is immutable; % is refused for tournament %',
    TG_OP, OLD.tournament_id USING ERRCODE = '55000';
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_refund_entitlement_commit_valid()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ent_count bigint;
  v_ent_amount numeric;
  v_wallet_count bigint;
  v_wallet_amount numeric;
  v_rows integer;
BEGIN
  IF NEW.entitlement_kind='wallet_charge' THEN
    SELECT count(*) INTO v_rows FROM public.chip_ledger l
     WHERE l.id=NEW.source_ledger_id
       AND l.tournament_id=NEW.tournament_id
       AND l.club_id=NEW.refund_wallet_club_id
       AND l.from_type='player_wallet' AND l.from_entity_id=NEW.user_id
       AND l.to_type='prize_liability'
       AND l.to_entity_id=NEW.tournament_id
       AND lower(l.category)=NEW.charge_category
       AND l.amount=NEW.gross;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'wallet charge entitlement lost its exact source ledger'
        USING ERRCODE = 'P0404';
    END IF;
    SELECT count(*),round(COALESCE(sum(e.gross),0),2)
      INTO v_ent_count,v_ent_amount
      FROM public.tournament_refund_entitlements e
     WHERE e.tournament_id=NEW.tournament_id AND e.user_id=NEW.user_id
       AND e.entitlement_kind='wallet_charge'
       AND e.charge_category=NEW.charge_category;
    SELECT count(*),round(COALESCE(sum(w.amount),0),2)
      INTO v_wallet_count,v_wallet_amount
      FROM public.wallet_transactions w
     WHERE w.related_entity_id=NEW.tournament_id AND w.user_id=NEW.user_id
       AND w.type='debit' AND lower(w.category)=NEW.charge_category;
    IF v_ent_count IS DISTINCT FROM v_wallet_count
       OR v_ent_amount IS DISTINCT FROM v_wallet_amount THEN
      RAISE EXCEPTION
        'wallet charge entitlement and reporting debit do not commit together'
        USING ERRCODE = 'P0404';
    END IF;
  ELSIF NEW.entitlement_kind='satellite_seat' THEN
    SELECT count(*) INTO v_rows FROM public.chip_ledger l
     WHERE l.id=NEW.source_ledger_id
       AND l.club_id=NEW.refund_wallet_club_id
       AND l.from_type='prize_liability'
       AND l.from_entity_id=NEW.source_satellite_id
       AND l.to_type='prize_liability'
       AND l.to_entity_id=NEW.tournament_id
       AND l.amount=NEW.gross
       AND l.metadata->>'user_id'=NEW.user_id::text
       AND l.metadata->>'registration_id'=NEW.registration_id::text;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION 'satellite seat entitlement lost its exact pool transfer'
        USING ERRCODE = 'P0404';
    END IF;
  ELSE
    SELECT count(*) INTO v_rows
      FROM public.chip_ledger l
      JOIN public.tournament_tickets tk ON tk.id=NEW.source_ticket_id
     WHERE l.id=NEW.source_ledger_id
       AND l.tournament_id=NEW.tournament_id
       AND l.club_id=NEW.refund_wallet_club_id
       AND l.from_type='escrow' AND l.from_entity_id=NEW.source_ticket_id
       AND l.to_type='prize_liability'
       AND l.to_entity_id=NEW.tournament_id
       AND l.category='ticket_redeem' AND l.amount=NEW.gross
       AND l.metadata->>'user_id'=NEW.user_id::text
       AND l.metadata->>'registration_id'=NEW.registration_id::text
       AND tk.holder_id=NEW.user_id
       AND tk.status='redeemed'
       AND tk.redemption_mode='tournament_entry_only'
       AND tk.value=NEW.gross
       AND tk.entry_prize=NEW.refund_prize
       AND tk.entry_bounty=NEW.refund_bounty
       AND tk.entry_fee=NEW.refund_fee
       AND tk.source_satellite_id=NEW.source_satellite_id;
    IF v_rows <> 1 THEN
      RAISE EXCEPTION
        'tournament-ticket entitlement lost its exact admission transfer'
        USING ERRCODE = 'P0404';
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_wallet_tx()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cat text := lower(COALESCE(NEW.category,''));
  v_amt numeric := round(COALESCE(NEW.amount,0),2);
  v_bounty numeric;
  v_split record;
  v_ent_count bigint;
  v_ent_amount numeric;
  v_wallet_count bigint;
  v_wallet_amount numeric;
  v_exact_token uuid := NULLIF(
    current_setting('app.ca_exact_refund_token',true),'')::uuid;
  v_authorization public.tournament_refund_authorizations%ROWTYPE;
  v_rows integer;
  v_credit_ledger_id uuid;
BEGIN
  IF NEW.related_entity_id IS NULL OR v_amt = 0 THEN RETURN NULL; END IF;
  IF NEW.type = 'debit' AND v_cat IN ('tournament_buyin','rebuy','addon') THEN
    SELECT * INTO v_split FROM public.fn_ca_tournament_charge_split(
      NEW.related_entity_id,v_cat,v_amt);
    SELECT count(*),round(COALESCE(sum(e.gross),0),2)
      INTO v_ent_count,v_ent_amount
      FROM public.tournament_refund_entitlements e
     WHERE e.tournament_id=NEW.related_entity_id AND e.user_id=NEW.user_id
       AND e.entitlement_kind='wallet_charge'
       AND e.charge_category=v_cat;
    SELECT count(*),round(COALESCE(sum(w.amount),0),2)
      INTO v_wallet_count,v_wallet_amount
      FROM public.wallet_transactions w
     WHERE w.related_entity_id=NEW.related_entity_id AND w.user_id=NEW.user_id
       AND w.type='debit' AND lower(w.category)=v_cat;
    IF v_ent_count IS DISTINCT FROM v_wallet_count
       OR v_ent_amount IS DISTINCT FROM v_wallet_amount THEN
      RAISE EXCEPTION
        'tournament wallet debit has no exact immutable charge entitlement'
        USING ERRCODE = 'P0404';
    END IF;
    v_bounty := v_split.refund_bounty;
    PERFORM public.fn_ca_escrow_apply(
      NEW.related_entity_id,v_cat,p_gross_in => v_amt,p_bounty_in => v_bounty);
  ELSIF NEW.type = 'credit' AND v_cat = 'prize' THEN
    PERFORM public.fn_ca_escrow_apply(
      NEW.related_entity_id,'prize',p_prize_out => v_amt);
  ELSIF NEW.type = 'debit' AND v_cat IN ('prize','prize_reversal') THEN
    PERFORM public.fn_ca_escrow_apply(
      NEW.related_entity_id,'prize reversal',p_prize_out => -v_amt);
  ELSIF NEW.type = 'credit' AND v_cat = 'bounty' THEN
    PERFORM public.fn_ca_escrow_apply(
      NEW.related_entity_id,'bounty',p_bounty_out => v_amt);
  ELSIF NEW.type = 'credit' AND v_cat IN ('refund','tournament_refund') THEN
    IF v_exact_token IS NULL THEN
      RAISE EXCEPTION
        'tournament refund credits require the one-use exact refund authority'
        USING ERRCODE = '42501';
    ELSE
      SELECT * INTO v_authorization
        FROM public.tournament_refund_authorizations a
       WHERE a.token = v_exact_token FOR UPDATE;
      IF v_authorization.token IS NULL
         OR v_authorization.tournament_id IS DISTINCT FROM NEW.related_entity_id
         OR v_authorization.user_id IS DISTINCT FROM NEW.user_id
         OR v_authorization.amount_paid_now IS DISTINCT FROM v_amt
         OR v_authorization.description IS DISTINCT FROM NEW.description
         OR NOT EXISTS (
           SELECT 1 FROM public.tournament_refund_entitlements e
            WHERE e.id=v_authorization.entitlement_id
              AND e.tournament_id=NEW.related_entity_id
              AND e.user_id=NEW.user_id
              AND e.refund_wallet_club_id=
                    v_authorization.source_wallet_club_id
              AND e.gross=v_authorization.amount_paid_now
              AND e.refund_prize=v_authorization.refund_prize
              AND e.refund_bounty=v_authorization.refund_bounty
              AND e.refund_fee=v_authorization.refund_fee)
         OR NOT EXISTS (
           SELECT 1 FROM public.tournament_obligations o
            WHERE o.id = v_authorization.obligation_id
              AND o.tournament_id = NEW.related_entity_id
              AND o.kind = 'refund' AND o.place IS NULL
              AND o.user_id = NEW.user_id
              AND o.amount_paid IS NOT DISTINCT FROM
                    v_authorization.amount_paid_before)
         OR NOT EXISTS (
           SELECT 1 FROM public.wallet_credit_idempotency k
            WHERE k.key = v_authorization.idempotency_key
              AND k.user_id = NEW.user_id AND k.amount = v_amt) THEN
        RAISE EXCEPTION 'wallet refund has no exact authorized component tranche'
          USING ERRCODE = 'P0404';
      END IF;
      DELETE FROM public.tournament_refund_authorizations a
       WHERE a.token = v_exact_token;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows <> 1 THEN
        RAISE EXCEPTION 'exact refund authorization was not consumed once'
          USING ERRCODE = '40001';
      END IF;
      SELECT count(*),min(l.id::text)::uuid
        INTO v_rows,v_credit_ledger_id
        FROM public.chip_ledger l
       WHERE l.idempotency_key = v_authorization.idempotency_key
         AND l.tournament_id = NEW.related_entity_id
         AND l.club_id = v_authorization.source_wallet_club_id
         AND l.category = 'refund'
         AND l.from_type = 'prize_liability'
         AND l.from_entity_id = NEW.related_entity_id
         AND l.to_type = 'player_wallet'
         AND l.to_entity_id = NEW.user_id
         AND l.amount = v_amt;
      IF v_rows <> 1 OR v_credit_ledger_id IS NULL THEN
        RAISE EXCEPTION
          'wallet refund has no single exact source-club journal credit'
          USING ERRCODE = 'P0404';
      END IF;
      INSERT INTO public.tournament_refund_tranches(
        wallet_transaction_id,idempotency_key,tournament_id,obligation_id,user_id,
        source_wallet_club_id,entitlement_id,credit_ledger_id,
        amount_paid_before,amount_paid_now,refund_prize,refund_bounty,refund_fee,
        source,description,created_at)
      VALUES(
        NEW.id,v_authorization.idempotency_key,NEW.related_entity_id,
        v_authorization.obligation_id,NEW.user_id,
        v_authorization.source_wallet_club_id,
        v_authorization.entitlement_id,v_credit_ledger_id,
        v_authorization.amount_paid_before,v_amt,
        v_authorization.refund_prize,v_authorization.refund_bounty,
        v_authorization.refund_fee,v_authorization.source,
        NEW.description,transaction_timestamp());
      PERFORM public.fn_ca_escrow_apply_exact_refund(
        NEW.related_entity_id,'authorized exact refund',
        v_authorization.refund_prize,v_authorization.refund_bounty,
        v_authorization.refund_fee);
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_escrow_on_rake_record()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_fee numeric := round(COALESCE(NEW.rake_amount,0),2);
BEGIN
  IF NOT COALESCE(NEW.is_tournament,false) OR NEW.tournament_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_fee < 0 AND NEW.source IN (
       'atomic_cancel_tournament',
       'fn_unregister_from_tournament') THEN
    RETURN NULL;
  END IF;
  IF NEW.source = 'fn_award_satellite_seat' THEN
    PERFORM public.fn_ca_escrow_apply(
      NEW.tournament_id,'satellite seat fee',
      p_satellite_fee_in => v_fee,p_satellite_in => -v_fee);
  ELSE
    PERFORM public.fn_ca_escrow_apply(
      NEW.tournament_id,'entry fee',p_fee_entries_in => v_fee);
  END IF;
  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_sync_tournament_current_players()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tid uuid;
  v_count integer;
BEGIN
  v_tid := COALESCE(NEW.tournament_id, OLD.tournament_id);
  IF v_tid IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT count(*) INTO v_count
  FROM public.tournament_players
  WHERE tournament_id = v_tid
    AND status IN ('registered', 'playing');

  UPDATE public.tournaments
     SET current_players = v_count
   WHERE id = v_tid
     AND status IN ('ANNOUNCED', 'REGISTERING')
     AND current_players IS DISTINCT FROM v_count;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_assert_live_tournament_seat_has_roster()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_tournament_id uuid;
  v_user_id uuid;
  v_parent_status text;
BEGIN
  IF TG_TABLE_NAME = 'table_seats' THEN
    IF TG_OP = 'DELETE' OR NEW.left_at IS NOT NULL OR NEW.user_id IS NULL THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
    SELECT t.tournament_id INTO v_tournament_id
      FROM public.tables t
     WHERE t.id = NEW.table_id;
    v_user_id := NEW.user_id;
  ELSE
    IF TG_OP = 'INSERT' THEN
      RETURN NEW;
    END IF;
    v_tournament_id := OLD.tournament_id;
    v_user_id := OLD.user_id;
  END IF;

  IF v_tournament_id IS NOT NULL THEN
    SELECT t.status::text INTO v_parent_status
      FROM public.tournaments t
     WHERE t.id = v_tournament_id;
  END IF;

  /* Terminal cleanup may intentionally close the roster and seats in
     separate idempotent requests.  The invariant is strict while the event
     is joinable or playable; finished/cancelled tables are separately barred
     from acquiring new live seats and may drain without being wedged. */
  IF v_tournament_id IS NOT NULL
     AND upper(COALESCE(v_parent_status, '')) IN ('REGISTERING', 'RUNNING')
     AND EXISTS (
       SELECT 1
         FROM public.table_seats s
         JOIN public.tables t ON t.id = s.table_id
        WHERE t.tournament_id = v_tournament_id
          AND s.user_id = v_user_id
          AND s.left_at IS NULL
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.tournament_players p
        WHERE p.tournament_id = v_tournament_id
          AND p.user_id = v_user_id
          AND p.status IN ('registered', 'playing')
     ) THEN
    RAISE EXCEPTION
      'TOURNAMENT_SEAT_ROSTER_REQUIRED: live seat user % has no active roster in tournament % at commit',
      v_user_id, v_tournament_id
      USING ERRCODE = '23514';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_return_satellite_entitlement_as_ticket(p_entitlement_id uuid, p_source text, p_description text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_e public.tournament_refund_entitlements%ROWTYPE;
  v_t public.tournaments%ROWTYPE;
  v_tournament_id uuid;
  v_ticket public.tournament_tickets%ROWTYPE;
  v_key text;
  v_before numeric;
  v_rows integer;
  v_ledger_id uuid;
  v_tx_id uuid;
BEGIN
  IF p_entitlement_id IS NULL OR p_source IS NULL
     OR length(btrim(p_source))=0 OR p_description IS NULL
     OR length(btrim(p_description))=0 THEN
    RAISE EXCEPTION 'satellite ticket return received an invalid contract'
      USING ERRCODE = '22003';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.ca_settle_sources s
     WHERE s.source=lower(btrim(p_source))) THEN
    RAISE EXCEPTION 'satellite ticket return source % is not an authority',p_source
      USING ERRCODE = '42501';
  END IF;
  SELECT e.tournament_id INTO v_tournament_id
    FROM public.tournament_refund_entitlements e
   WHERE e.id=p_entitlement_id;
  IF v_tournament_id IS NULL THEN
    RAISE EXCEPTION 'satellite refund entitlement % does not exist',p_entitlement_id
      USING ERRCODE = 'P0002';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=v_tournament_id FOR UPDATE;
  SELECT * INTO v_e FROM public.tournament_refund_entitlements e
   WHERE e.id=p_entitlement_id FOR UPDATE;
  IF v_e.id IS NULL
     OR v_e.entitlement_kind NOT IN ('satellite_seat','tournament_ticket')
     OR v_e.tournament_id IS DISTINCT FROM v_t.id THEN
    RAISE EXCEPTION
      'entitlement % is not a satellite-funded tournament entry',p_entitlement_id
      USING ERRCODE = 'P0404';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tournament_refund_tranches tr
     WHERE tr.entitlement_id=v_e.id) THEN
    RAISE EXCEPTION 'satellite seat entitlement was incorrectly converted to chips'
      USING ERRCODE = 'P0404';
  END IF;
  SELECT * INTO v_ticket FROM public.tournament_tickets tk
   WHERE tk.source_refund_entitlement_id=v_e.id FOR UPDATE;
  IF FOUND THEN
    SELECT count(*),min(l.id::text)::uuid
      INTO v_rows,v_ledger_id FROM public.chip_ledger l
     WHERE l.idempotency_key='tourney:'||v_e.tournament_id::text
             ||':satellite-ticket-return:'||v_e.id::text
       AND l.from_type='prize_liability'
       AND l.from_entity_id=v_e.tournament_id
       AND l.to_type='escrow' AND l.to_entity_id=v_ticket.id
       AND l.club_id=v_e.refund_wallet_club_id AND l.amount=v_e.gross;
    IF v_rows<>1 OR v_ledger_id IS NULL
       OR (SELECT count(*) FROM public.chip_transactions ct
            WHERE ct.transaction_type='tournament_ticket_issue'
              AND ct.club_id=v_e.refund_wallet_club_id
              AND ct.from_user_id IS NULL AND ct.to_user_id=v_e.user_id
              AND ct.amount=v_e.gross
              AND ct.metadata->>'ticket_id'=v_ticket.id::text
              AND ct.metadata->>'entitlement_id'=v_e.id::text
              AND ct.metadata->>'ledger_id'=v_ledger_id::text) <> 1
       OR v_ticket.status NOT IN ('issued','redeemed')
       OR v_ticket.holder_id IS DISTINCT FROM v_e.user_id
       OR v_ticket.value IS DISTINCT FROM v_e.gross
       OR v_ticket.redemption_mode<>'tournament_entry_only'
       OR v_ticket.source_tournament_id IS DISTINCT FROM v_e.tournament_id
       OR v_ticket.source_satellite_id IS DISTINCT FROM v_e.source_satellite_id
       OR v_ticket.source_refund_entitlement_id IS DISTINCT FROM v_e.id
       OR v_ticket.entry_prize IS DISTINCT FROM v_e.refund_prize
       OR v_ticket.entry_bounty IS DISTINCT FROM v_e.refund_bounty
       OR v_ticket.entry_fee IS DISTINCT FROM v_e.refund_fee THEN
      RAISE EXCEPTION 'satellite ticket replay evidence is incomplete'
        USING ERRCODE = 'P0404';
    END IF;
    RETURN jsonb_build_object(
      'ok',true,'replayed',true,'ticket_id',v_ticket.id,
      'entitlement_id',v_e.id,'value',v_e.gross,
      'refund_prize',v_e.refund_prize,
      'refund_bounty',v_e.refund_bounty,'refund_fee',v_e.refund_fee,
      'refund_wallet_club_id',v_e.refund_wallet_club_id);
  END IF;

  PERFORM public.fn_ca_escrow_apply(
    v_e.tournament_id,'satellite ticket return escrow prelock');
  SELECT round(e.prize_balance+e.bounty_balance+e.fee_balance,2)
    INTO v_before FROM public.tournament_escrow e
   WHERE e.tournament_id=v_e.tournament_id FOR UPDATE;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'satellite ticket return has no enforced target escrow'
      USING ERRCODE = 'P0404';
  END IF;
  v_ticket.id:=gen_random_uuid();
  INSERT INTO public.tournament_tickets(
    id,club_id,issued_by,holder_id,value,status,note,
    redemption_mode,source_tournament_id,source_satellite_id,
    source_refund_entitlement_id,entry_prize,entry_bounty,entry_fee,created_at)
  VALUES(
    v_ticket.id,v_e.refund_wallet_club_id,
    '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid,
    v_e.user_id,v_e.gross,'issued',
    p_description,'tournament_entry_only',v_e.tournament_id,
    v_e.source_satellite_id,v_e.id,v_e.refund_prize,v_e.refund_bounty,
    v_e.refund_fee,transaction_timestamp())
  RETURNING * INTO v_ticket;
  v_key:='tourney:'||v_e.tournament_id::text
         ||':satellite-ticket-return:'||v_e.id::text;
  INSERT INTO public.chip_ledger(
    performed_by,from_type,from_entity_id,from_label,
    to_type,to_entity_id,to_label,amount,category,club_id,tournament_id,
    idempotency_key,settlement_id,actor_service,description,metadata,
    pre_from_balance,post_from_balance,pre_to_balance,post_to_balance)
  VALUES(
    COALESCE(auth.uid(),'2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
    'prize_liability',v_e.tournament_id,'tournaments escrow',
    'escrow',v_ticket.id,'satellite tournament entry ticket',
    v_e.gross,'ticket_issue',v_e.refund_wallet_club_id,v_e.tournament_id,
    v_key,'satellite-ticket:'||v_ticket.id::text,lower(btrim(p_source)),
    p_description,jsonb_build_object(
      'kind','tournament_entry_ticket_return','ticket_id',v_ticket.id,
      'entitlement_id',v_e.id,'user_id',v_e.user_id,
      'entitlement_kind',v_e.entitlement_kind,
      'source_satellite_id',v_e.source_satellite_id,
      'refund_prize',v_e.refund_prize,'refund_bounty',v_e.refund_bounty,
      'refund_fee',v_e.refund_fee),
    v_before,round(v_before-v_e.gross,2),0,v_e.gross)
  RETURNING id INTO v_ledger_id;
  INSERT INTO public.chip_transactions(
    club_id,from_user_id,to_user_id,amount,transaction_type,notes,
    balance_after,metadata)
  VALUES(
    v_e.refund_wallet_club_id,NULL,v_e.user_id,v_e.gross,
    'tournament_ticket_issue',p_description,NULL,jsonb_build_object(
      'ticket_id',v_ticket.id,'escrow_entity_id',v_ticket.id,
      'holder_id',v_e.user_id,'value',v_e.gross,
      'redemption_mode','tournament_entry_only',
      'source_tournament_id',v_e.tournament_id,
      'source_satellite_id',v_e.source_satellite_id,
      'entitlement_id',v_e.id,'entitlement_kind',v_e.entitlement_kind,
      'ledger_id',v_ledger_id,
      'idempotency_key',v_key))
  RETURNING id INTO v_tx_id;
  PERFORM public.fn_ca_escrow_apply_exact_refund(
    v_e.tournament_id,'satellite seat returned as tournament ticket',
    v_e.refund_prize,v_e.refund_bounty,v_e.refund_fee);
  RETURN jsonb_build_object(
    'ok',true,'replayed',false,'ticket_id',v_ticket.id,
    'entitlement_id',v_e.id,'value',v_e.gross,
    'refund_prize',v_e.refund_prize,
    'refund_bounty',v_e.refund_bounty,'refund_fee',v_e.refund_fee,
    'refund_wallet_club_id',v_e.refund_wallet_club_id,
    'ledger_id',v_ledger_id,'transaction_id',v_tx_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_tournament_unregistration_receipt(p_tournament_id uuid, p_user_id uuid, p_source_table_id uuid DEFAULT NULL::uuid, p_request_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_r public.tournament_unregistration_receipts%ROWTYPE;
  v_entitlement_count integer;
  v_fee_entitlement_count integer;
  v_entitlement_total numeric;
  v_entitlement_fee numeric;
  v_source_count integer;
  v_wallet_count integer;
  v_wallet_total numeric;
  v_ticket_count integer;
  v_ticket_total numeric;
  v_ticket_ledger_count integer;
  v_ticket_transaction_count integer;
  v_fee_reversal_count integer;
  v_fee_reversal_total numeric;
  v_fee_source_ids uuid[];
  v_fee_mapping_count integer;
  v_fee_mapping_entitlement_count integer;
  v_fee_mapping_ids uuid[];
BEGIN
  SELECT * INTO v_r
    FROM public.tournament_unregistration_receipts r
   WHERE r.tournament_id=p_tournament_id AND r.user_id=p_user_id
     AND r.source_table_id IS NOT DISTINCT FROM p_source_table_id
     AND (p_request_id IS NULL OR r.request_id=p_request_id)
   ORDER BY r.settled_at DESC,r.registration_id DESC
   LIMIT 1;
  IF v_r.registration_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- A later registration, including an eliminated one, makes an unkeyed
  -- "latest receipt" unsafe. The exact request-key path is also refused while
  -- any later registration row exists: a replay is an outcome read, never an
  -- operation against a new lifecycle.
  IF EXISTS(
    SELECT 1 FROM public.tournament_players tp
     WHERE tp.tournament_id=v_r.tournament_id AND tp.user_id=v_r.user_id) THEN
    RETURN NULL;
  END IF;

  SELECT count(*),count(*) FILTER (WHERE e.refund_fee>0),
         round(COALESCE(sum(e.gross),0),2),
         round(COALESCE(sum(e.refund_fee),0),2)
    INTO v_entitlement_count,v_fee_entitlement_count,
         v_entitlement_total,v_entitlement_fee
    FROM public.tournament_refund_entitlements e
   WHERE e.id=ANY(v_r.entitlement_ids)
     AND e.tournament_id=v_r.tournament_id AND e.user_id=v_r.user_id;
  SELECT count(*) INTO v_source_count
    FROM unnest(v_r.entitlement_ids) WITH ORDINALITY entitlement(id,n)
    JOIN unnest(v_r.source_wallet_club_ids) WITH ORDINALITY source(club_id,n)
      USING(n)
    JOIN public.tournament_refund_entitlements e
      ON e.id=entitlement.id AND e.refund_wallet_club_id=source.club_id
     AND e.tournament_id=v_r.tournament_id AND e.user_id=v_r.user_id;
  SELECT count(*),round(COALESCE(sum(tr.amount_paid_now),0),2)
    INTO v_wallet_count,v_wallet_total
    FROM public.tournament_refund_tranches tr
    JOIN public.tournament_refund_entitlements e ON e.id=tr.entitlement_id
   WHERE e.id=ANY(v_r.entitlement_ids)
     AND e.entitlement_kind='wallet_charge'
     AND tr.wallet_transaction_id=ANY(v_r.wallet_transaction_ids)
     AND tr.credit_ledger_id=ANY(v_r.credit_ledger_ids)
     AND tr.tournament_id=v_r.tournament_id AND tr.user_id=v_r.user_id;
  SELECT count(*),round(COALESCE(sum(tk.value),0),2)
    INTO v_ticket_count,v_ticket_total
    FROM public.tournament_tickets tk
    JOIN public.tournament_refund_entitlements e
      ON e.id=tk.source_refund_entitlement_id
   WHERE tk.id=ANY(v_r.ticket_ids)
     AND tk.redemption_mode='tournament_entry_only'
     AND e.id=ANY(v_r.entitlement_ids)
     AND e.entitlement_kind IN ('satellite_seat','tournament_ticket')
     AND e.tournament_id=v_r.tournament_id AND e.user_id=v_r.user_id
     AND tk.value=e.gross;
  SELECT count(*) INTO v_ticket_ledger_count
    FROM public.chip_ledger l
    JOIN public.tournament_tickets tk ON tk.id=l.to_entity_id
    JOIN public.tournament_refund_entitlements e
      ON e.id=tk.source_refund_entitlement_id
   WHERE tk.id=ANY(v_r.ticket_ids)
     AND e.id=ANY(v_r.entitlement_ids)
     AND l.idempotency_key='tourney:'||e.tournament_id::text
          ||':satellite-ticket-return:'||e.id::text
     AND l.from_type='prize_liability'
     AND l.from_entity_id=e.tournament_id
     AND l.to_type='escrow' AND l.to_entity_id=tk.id
     AND l.club_id=e.refund_wallet_club_id AND l.amount=e.gross;
  SELECT count(*) INTO v_ticket_transaction_count
    FROM public.chip_transactions ct
    JOIN public.tournament_tickets tk
      ON tk.id::text=ct.metadata->>'ticket_id'
    JOIN public.tournament_refund_entitlements e
      ON e.id=tk.source_refund_entitlement_id
    JOIN public.chip_ledger l
      ON l.id::text=ct.metadata->>'ledger_id'
   WHERE tk.id=ANY(v_r.ticket_ids)
     AND e.id=ANY(v_r.entitlement_ids)
     AND ct.transaction_type='tournament_ticket_issue'
     AND ct.club_id=e.refund_wallet_club_id
     AND ct.from_user_id IS NULL AND ct.to_user_id=e.user_id
     AND ct.amount=e.gross
     AND ct.metadata->>'entitlement_id'=e.id::text
     AND l.to_entity_id=tk.id
     AND l.idempotency_key='tourney:'||e.tournament_id::text
          ||':satellite-ticket-return:'||e.id::text;

  SELECT count(*),round(COALESCE(-sum(reversal.rake_amount),0),2)
    INTO v_fee_reversal_count,v_fee_reversal_total
    FROM public.rake_records reversal
   WHERE reversal.id=ANY(v_r.fee_reversal_ids)
     AND reversal.tournament_id=v_r.tournament_id
     AND reversal.is_tournament IS TRUE
     AND reversal.source='fn_unregister_from_tournament'
     AND reversal.rake_amount<0
     AND reversal.metadata->>'kind'='tournament_fee_refund'
     AND reversal.metadata->>'user_id'=v_r.user_id::text
     AND reversal.metadata->>'registration_id'=v_r.registration_id::text;
  SELECT COALESCE(array_agg(source.id ORDER BY source.id),ARRAY[]::uuid[])
    INTO v_fee_source_ids
    FROM public.rake_records reversal
   CROSS JOIN LATERAL jsonb_array_elements_text(
     reversal.metadata->'original_rake_record_ids') raw(id)
   JOIN LATERAL (SELECT raw.id::uuid AS id) source ON true
   WHERE reversal.id=ANY(v_r.fee_reversal_ids);
  WITH exact_fee_mapping AS MATERIALIZED (
    SELECT e.id AS entitlement_id,r.id AS rake_record_id
      FROM public.tournament_refund_entitlements e
      JOIN public.chip_ledger l ON l.id=e.source_ledger_id
      JOIN public.rake_records r
        ON r.id=ANY(v_r.fee_source_rake_record_ids)
       AND r.tournament_id=e.tournament_id
       AND r.is_tournament IS TRUE
       AND r.club_id IS NOT NULL
       AND r.rake_amount=e.refund_fee
       AND r.created_at=l.created_at
       AND r.metadata->>'user_id'=e.user_id::text
       AND (
         (e.entitlement_kind='wallet_charge'
          AND e.charge_category='tournament_buyin'
          AND r.source IN (
            'fn_register_for_tournament','fn_register_horse_for_tournament')
          AND r.metadata->>'kind'='tournament_entry_fee'
          AND r.metadata->>'registration_id'=v_r.registration_id::text)
         OR (e.entitlement_kind='wallet_charge'
          AND e.charge_category='rebuy'
          AND r.source='process_tournament_rebuy'
          AND r.metadata->>'kind' IN (
            'tournament_rebuy_fee','tournament_reentry_fee'))
         OR (e.entitlement_kind='satellite_seat'
          AND r.source='fn_award_satellite_seat'
          AND r.metadata->>'kind'='satellite_seat_entry_fee'
          AND r.metadata->>'registration_id'=e.registration_id::text)
         OR (e.entitlement_kind='tournament_ticket'
          AND r.source='fn_register_for_tournament_with_ticket'
          AND r.metadata->>'kind'='tournament_ticket_entry_fee'
          AND r.metadata->>'registration_id'=e.registration_id::text))
     WHERE e.id=ANY(v_r.entitlement_ids) AND e.refund_fee>0
  )
  SELECT count(*),count(DISTINCT entitlement_id),
         COALESCE(array_agg(rake_record_id ORDER BY rake_record_id),
                  ARRAY[]::uuid[])
    INTO v_fee_mapping_count,v_fee_mapping_entitlement_count,v_fee_mapping_ids
    FROM exact_fee_mapping;

  IF v_r.settled_at>=v_r.scheduled_start_at
     OR v_entitlement_count<>cardinality(v_r.entitlement_ids)
     OR v_source_count<>cardinality(v_r.entitlement_ids)
     OR v_entitlement_total IS DISTINCT FROM
          round(v_r.refunded_chips+v_r.returned_ticket_value,2)
     OR v_wallet_count<>cardinality(v_r.wallet_transaction_ids)
     OR v_wallet_total IS DISTINCT FROM v_r.refunded_chips
     OR v_ticket_count<>cardinality(v_r.ticket_ids)
     OR v_ticket_total IS DISTINCT FROM v_r.returned_ticket_value
     OR v_ticket_ledger_count<>cardinality(v_r.ticket_ids)
     OR v_ticket_transaction_count<>cardinality(v_r.ticket_ids)
     OR v_r.fees_reversed IS DISTINCT FROM v_entitlement_fee
     OR v_fee_reversal_count<>cardinality(v_r.fee_reversal_ids)
     OR v_fee_reversal_total IS DISTINCT FROM v_r.fees_reversed
     OR v_fee_source_ids IS DISTINCT FROM v_r.fee_source_rake_record_ids
     OR v_fee_mapping_ids IS DISTINCT FROM v_r.fee_source_rake_record_ids
     OR v_fee_mapping_count<>v_fee_entitlement_count
     OR v_fee_mapping_entitlement_count<>v_fee_entitlement_count
     OR cardinality(v_fee_source_ids)<>(
       SELECT count(DISTINCT id) FROM unnest(v_fee_source_ids) source(id))
     OR EXISTS (
       SELECT 1 FROM public.tournament_unregistration_receipts other
        WHERE other.registration_id<>v_r.registration_id
          AND (other.fee_reversal_ids && v_r.fee_reversal_ids
            OR other.fee_source_rake_record_ids
                 && v_r.fee_source_rake_record_ids))
     OR EXISTS (
       SELECT 1
         FROM public.rake_records reversal
        WHERE reversal.id=ANY(v_r.fee_reversal_ids)
          AND (
            jsonb_typeof(reversal.metadata->'original_rake_record_ids')
              IS DISTINCT FROM 'array'
            OR jsonb_array_length(
                 reversal.metadata->'original_rake_record_ids')=0
            OR (SELECT round(COALESCE(sum(original.rake_amount),0),2)
                  FROM jsonb_array_elements_text(
                    reversal.metadata->'original_rake_record_ids') raw(id)
                  JOIN public.rake_records original
                    ON original.id=raw.id::uuid
                 WHERE original.tournament_id=v_r.tournament_id
                   AND original.club_id=reversal.club_id
                   AND original.is_tournament IS TRUE
                   AND original.rake_amount>0
                   AND original.metadata->>'user_id'=v_r.user_id::text
                   AND (
                     (original.source IN (
                        'fn_register_for_tournament',
                        'fn_register_horse_for_tournament')
                       AND original.metadata->>'kind'='tournament_entry_fee')
                     OR (original.source='process_tournament_rebuy'
                       AND original.metadata->>'kind' IN (
                         'tournament_rebuy_fee','tournament_reentry_fee'))
                     OR (original.source=
                           'fn_register_for_tournament_with_ticket'
                       AND original.metadata->>'kind'=
                           'tournament_ticket_entry_fee')
                     OR (original.source='fn_award_satellite_seat'
                       AND original.metadata->>'kind'=
                           'satellite_seat_entry_fee')))
                IS DISTINCT FROM -reversal.rake_amount))
     OR (v_r.source_table_id IS NOT NULL AND NOT EXISTS(
       SELECT 1 FROM public.tables tb
        WHERE tb.id=v_r.source_table_id
          AND tb.tournament_id=v_r.tournament_id)) THEN
    RAISE EXCEPTION 'tournament unregistration receipt % is not exact',
      v_r.registration_id USING ERRCODE='P0404';
  END IF;

  RETURN jsonb_build_object(
    'ok',true,'request_id',v_r.request_id,
    'registration_id',v_r.registration_id,
    'refunded_chips',v_r.refunded_chips,
    'returned_ticket_value',v_r.returned_ticket_value,
    'wallet_chips_from_satellite_entitlements',0,
    'entitlement_ids',to_jsonb(v_r.entitlement_ids),
    'ticket_ids',to_jsonb(v_r.ticket_ids),
    'source_wallet_club_ids',to_jsonb(v_r.source_wallet_club_ids),
    'credit_ledger_ids',to_jsonb(v_r.credit_ledger_ids),
    'wallet_transaction_ids',to_jsonb(v_r.wallet_transaction_ids),
    'fees_reversed',v_r.fees_reversed,
    'fee_reversal_ids',to_jsonb(v_r.fee_reversal_ids),
    'fee_source_rake_record_ids',to_jsonb(v_r.fee_source_rake_record_ids),
    'seat_number',v_r.seat_number,'seats_taken',v_r.seats_taken,
    'scheduled_start_at',v_r.scheduled_start_at,
    'settled_at',v_r.settled_at);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_settle_tournament_refund_exact(p_tournament_id uuid, p_user_id uuid, p_source_wallet_club_id uuid, p_total_owed numeric, p_refund_prize numeric, p_refund_bounty numeric, p_refund_fee numeric, p_source text, p_description text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total numeric := round(COALESCE(p_total_owed,0),2);
  v_prize numeric := round(COALESCE(p_refund_prize,0),2);
  v_bounty numeric := round(COALESCE(p_refund_bounty,0),2);
  v_fee numeric := round(COALESCE(p_refund_fee,0),2);
  v_ob public.tournament_obligations%ROWTYPE;
  v_seeded_paid numeric := 0;
  v_pay numeric;
  v_key text;
  v_rows integer;
  v_token uuid;
  v_source_debits numeric;
  v_source_credits numeric;
  v_balance_before numeric;
  v_balance_after numeric;
  v_credit_ledger_id uuid;
  v_wallet_transaction_id uuid;
  v_prev_category text;
  v_prev_counterparty text;
  v_prev_counterparty_entity text;
  v_prev_tournament text;
  v_prev_tournament_id text;
  v_prev_idempotency text;
  v_entitlement record;
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL
     OR p_source_wallet_club_id IS NULL
     OR p_total_owed IS NULL OR p_refund_prize IS NULL
     OR p_refund_bounty IS NULL OR p_refund_fee IS NULL
     OR p_total_owed::text IN ('NaN','Infinity','-Infinity')
     OR p_refund_prize::text IN ('NaN','Infinity','-Infinity')
     OR p_refund_bounty::text IN ('NaN','Infinity','-Infinity')
     OR p_refund_fee::text IN ('NaN','Infinity','-Infinity')
     OR p_total_owed IS DISTINCT FROM v_total
     OR p_refund_prize IS DISTINCT FROM v_prize
     OR p_refund_bounty IS DISTINCT FROM v_bounty
     OR p_refund_fee IS DISTINCT FROM v_fee
     OR v_total <= 0 OR v_prize < 0 OR v_bounty < 0 OR v_fee < 0
     OR p_source IS NULL OR length(btrim(p_source)) = 0
     OR p_description IS NULL OR length(btrim(p_description)) = 0 THEN
    RAISE EXCEPTION 'exact refund payer received an invalid contract'
      USING ERRCODE = '22003';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.ca_settle_sources s
     WHERE s.source = lower(btrim(p_source))) THEN
    RAISE EXCEPTION 'exact refund source % is not a platform authority',p_source
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM public.tournaments t
   WHERE t.id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exact refund tournament % does not exist',p_tournament_id
      USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id,'exact refund escrow prelock');

  SELECT * INTO v_ob FROM public.tournament_obligations o
   WHERE o.tournament_id = p_tournament_id
     AND o.kind = 'refund' AND o.place IS NULL AND o.user_id = p_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    SELECT round(COALESCE(sum(w.amount),0),2) INTO v_seeded_paid
      FROM public.wallet_transactions w
     WHERE w.related_entity_id = p_tournament_id
       AND w.user_id = p_user_id AND w.type = 'credit'
       AND lower(w.category) IN ('refund','tournament_refund');
    IF v_seeded_paid > v_total THEN
      RAISE EXCEPTION 'refund ledger already exceeds exact entitlement'
        USING ERRCODE = 'P0404';
    END IF;
    INSERT INTO public.tournament_obligations(
      tournament_id,kind,place,user_id,amount_owed,amount_paid,source)
    VALUES(
      p_tournament_id,'refund',NULL,p_user_id,v_total,v_seeded_paid,p_source)
    RETURNING * INTO v_ob;
  ELSE
    IF v_ob.amount_owed::text IN ('NaN','Infinity','-Infinity')
       OR v_ob.amount_paid::text IN ('NaN','Infinity','-Infinity')
       OR v_ob.amount_owed < 0 OR v_ob.amount_paid < 0
       OR v_ob.amount_paid > v_ob.amount_owed
       OR v_total < v_ob.amount_owed THEN
      RAISE EXCEPTION 'existing refund obligation is incompatible with exact entitlement'
        USING ERRCODE = 'P0404';
    END IF;
  END IF;

  v_pay := round(v_total - v_ob.amount_paid,2);
  IF v_pay <= 0 OR v_pay IS DISTINCT FROM round(v_prize + v_bounty + v_fee,2) THEN
    RAISE EXCEPTION
      'exact refund components %, %, % do not equal newly owed amount %',
      v_prize,v_bounty,v_fee,v_pay USING ERRCODE = '23514';
  END IF;

  -- The caller cannot choose money. Resolve one deterministic, still-open
  -- immutable entitlement whose stored club and rails exactly match this
  -- tranche. A funded satellite seat is deliberately excluded: that source
  -- can be returned only as another tournament-entry ticket, never as chips.
  SELECT e.* INTO v_entitlement
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND e.refund_wallet_club_id = p_source_wallet_club_id
     AND e.gross = v_pay
     AND e.refund_prize = v_prize
     AND e.refund_bounty = v_bounty
     AND e.refund_fee = v_fee
     AND NOT EXISTS (
       SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.entitlement_id=e.id)
     AND e.entitlement_kind='wallet_charge'
   ORDER BY e.entitlement_kind,e.id
   LIMIT 1;
  IF v_entitlement.id IS NULL THEN
    RAISE EXCEPTION
      'refund source club and component rails do not match one immutable entitlement'
      USING ERRCODE = 'P0404';
  END IF;
  SELECT count(*) INTO v_rows FROM public.chip_ledger l
   WHERE l.id=v_entitlement.source_ledger_id
     AND l.tournament_id=v_entitlement.tournament_id
     AND l.club_id=v_entitlement.refund_wallet_club_id
     AND l.from_type='player_wallet'
     AND l.from_entity_id=v_entitlement.user_id
     AND l.to_type='prize_liability'
     AND l.to_entity_id=v_entitlement.tournament_id
     AND lower(l.category)=v_entitlement.charge_category
     AND l.amount=v_entitlement.gross;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'refund entitlement lost its exact wallet-debit source'
      USING ERRCODE = 'P0404';
  END IF;
  v_key := 'tourney:' || p_tournament_id::text
           || ':refund-entitlement:'
           || v_entitlement.id::text;

  v_token := gen_random_uuid();
  INSERT INTO public.tournament_refund_authorizations(
    token,idempotency_key,tournament_id,obligation_id,user_id,
    source_wallet_club_id,entitlement_id,
    amount_paid_before,amount_paid_now,refund_prize,refund_bounty,refund_fee,
    source,description,created_at)
  VALUES(
    v_token,v_key,p_tournament_id,v_ob.id,p_user_id,
    p_source_wallet_club_id,v_entitlement.id,
    v_ob.amount_paid,v_pay,v_prize,v_bounty,v_fee,
    lower(btrim(p_source)),p_description,transaction_timestamp());
  -- The debit journal is the immutable source-wallet fact. A refund may land
  -- only in that same club wallet, and never through the generic tournament
  -- wallet chooser. Existing credits in that wallet reduce its remaining
  -- capacity, so even an owner-only caller cannot redirect or over-credit it.
  SELECT round(COALESCE(sum(l.amount),0),2) INTO v_source_debits
    FROM public.chip_ledger l
   WHERE l.tournament_id = p_tournament_id
     AND l.club_id = p_source_wallet_club_id
     AND l.from_type = 'player_wallet'
     AND l.from_entity_id = p_user_id
     AND l.to_type = 'prize_liability'
     AND l.to_entity_id = p_tournament_id
     AND l.category IN ('tournament_buyin','rebuy','addon');
  SELECT round(COALESCE(sum(l.amount),0),2) INTO v_source_credits
    FROM public.chip_ledger l
   WHERE l.tournament_id = p_tournament_id
     AND l.club_id = p_source_wallet_club_id
     AND l.from_type = 'prize_liability'
     AND l.from_entity_id = p_tournament_id
     AND l.to_type = 'player_wallet'
     AND l.to_entity_id = p_user_id
     AND l.category IN ('refund','tournament_refund');
  IF v_source_debits IS NULL OR v_source_credits IS NULL
     OR v_source_debits::text IN ('NaN','Infinity','-Infinity')
     OR v_source_credits::text IN ('NaN','Infinity','-Infinity')
     OR v_source_debits < 0 OR v_source_credits < 0
     OR round(v_source_debits-v_source_credits,2) < v_pay THEN
    RAISE EXCEPTION
      'source club % has only % of exact tournament debit left for refund %',
      p_source_wallet_club_id,
      round(v_source_debits-v_source_credits,2),v_pay
      USING ERRCODE = 'P0404';
  END IF;

  SELECT m.chip_balance INTO v_balance_before
    FROM public.club_members m
   WHERE m.user_id = p_user_id AND m.club_id = p_source_wallet_club_id
   FOR UPDATE;
  IF NOT FOUND OR v_balance_before IS NULL
     OR v_balance_before::text IN ('NaN','Infinity','-Infinity')
     OR v_balance_before IS DISTINCT FROM round(v_balance_before,2) THEN
    RAISE EXCEPTION
      'exact source wallet % for player % is absent or invalid',
      p_source_wallet_club_id,p_user_id USING ERRCODE = 'P0404';
  END IF;

  INSERT INTO public.wallet_credit_idempotency(key,user_id,amount)
  VALUES(v_key,p_user_id,v_pay)
  ON CONFLICT(key) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'exact refund credit key % was already claimed',v_key
      USING ERRCODE = '23505';
  END IF;

  v_prev_category := current_setting('app.ledger_category',true);
  v_prev_counterparty := current_setting('app.ledger_counterparty',true);
  v_prev_counterparty_entity := current_setting(
    'app.ledger_counterparty_entity',true);
  v_prev_tournament := current_setting('app.ledger_tournament',true);
  v_prev_tournament_id := current_setting('app.ledger_tournament_id',true);
  v_prev_idempotency := current_setting('app.ledger_idempotency_key',true);
  PERFORM public.fn_ca_declare_ledger(
    'refund','prize_liability',p_tournament_id,NULL,v_key,NULL);
  PERFORM set_config('app.ledger_tournament',p_tournament_id::text,true);
  PERFORM set_config('app.ledger_tournament_id',p_tournament_id::text,true);
  UPDATE public.club_members
     SET chip_balance = chip_balance + v_pay,updated_at = now()
   WHERE user_id = p_user_id AND club_id = p_source_wallet_club_id
     AND chip_balance IS NOT DISTINCT FROM v_balance_before
  RETURNING chip_balance INTO v_balance_after;
  PERFORM set_config('app.ledger_category',COALESCE(v_prev_category,''),true);
  PERFORM set_config('app.ledger_counterparty',COALESCE(v_prev_counterparty,''),true);
  PERFORM set_config('app.ledger_counterparty_entity',
                     COALESCE(v_prev_counterparty_entity,''),true);
  PERFORM set_config('app.ledger_tournament',COALESCE(v_prev_tournament,''),true);
  PERFORM set_config('app.ledger_tournament_id',COALESCE(v_prev_tournament_id,''),true);
  PERFORM set_config('app.ledger_idempotency_key',COALESCE(v_prev_idempotency,''),true);
  IF v_balance_after IS NULL
     OR v_balance_after IS DISTINCT FROM round(v_balance_before+v_pay,2) THEN
    RAISE EXCEPTION 'exact source wallet changed during refund'
      USING ERRCODE = '40001';
  END IF;
  SELECT count(*),min(l.id::text)::uuid INTO v_rows,v_credit_ledger_id
    FROM public.chip_ledger l
   WHERE l.idempotency_key = v_key
     AND l.tournament_id = p_tournament_id
     AND l.club_id = p_source_wallet_club_id
     AND l.from_type = 'prize_liability'
     AND l.from_entity_id = p_tournament_id
     AND l.to_type = 'player_wallet'
     AND l.to_entity_id = p_user_id
     AND l.category = 'refund' AND l.amount = v_pay;
  IF v_rows <> 1 OR v_credit_ledger_id IS NULL THEN
    RAISE EXCEPTION 'exact source-wallet credit % has no single journal row',v_key
      USING ERRCODE = 'P0404';
  END IF;

  PERFORM set_config('app.ca_exact_refund_token',v_token::text,true);
  INSERT INTO public.wallet_transactions(
    user_id,wallet_type,amount,type,category,description,
    related_entity_id,table_id,hand_id,balance_after)
  VALUES(
    p_user_id,'PLAYER',v_pay,'credit','refund',p_description,
    p_tournament_id,NULL,NULL,v_balance_after)
  RETURNING id INTO v_wallet_transaction_id;
  PERFORM set_config('app.ca_exact_refund_token','',true);
  IF EXISTS (
    SELECT 1 FROM public.tournament_refund_authorizations a
     WHERE a.token = v_token) THEN
    RAISE EXCEPTION 'exact refund authorization % was not consumed',v_token
      USING ERRCODE = 'P0404';
  END IF;

  SELECT count(*) INTO v_rows FROM public.tournament_refund_tranches tr
   WHERE tr.wallet_transaction_id = v_wallet_transaction_id
     AND tr.idempotency_key = v_key
     AND tr.tournament_id = p_tournament_id
     AND tr.obligation_id = v_ob.id AND tr.user_id = p_user_id
     AND tr.source_wallet_club_id = p_source_wallet_club_id
     AND tr.entitlement_id = v_entitlement.id
     AND tr.credit_ledger_id = v_credit_ledger_id
     AND tr.amount_paid_before = v_ob.amount_paid
     AND tr.amount_paid_now = v_pay
     AND tr.refund_prize = v_prize
     AND tr.refund_bounty = v_bounty
     AND tr.refund_fee = v_fee
     AND tr.source = lower(btrim(p_source))
     AND tr.description = p_description;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'exact refund credit % has no single component receipt',v_key
      USING ERRCODE = 'P0404';
  END IF;

  UPDATE public.tournament_obligations
     SET amount_paid = amount_paid + v_pay,
         amount_owed = v_total,
         source = p_source,
         updated_at = now(),settled_at = now()
   WHERE id = v_ob.id AND amount_paid = v_ob.amount_paid
  RETURNING * INTO v_ob;
  IF v_ob.id IS NULL OR v_ob.amount_paid IS DISTINCT FROM v_total THEN
    RAISE EXCEPTION 'exact refund obligation did not close at %',v_total
      USING ERRCODE = '40001';
  END IF;
  RETURN jsonb_build_object(
    'ok',true,'fully_settled',true,'remaining',0,
    'obligation_id',v_ob.id,'idempotency_key',v_key,
    'entitlement_id',v_entitlement.id,
    'entitlement_kind',v_entitlement.entitlement_kind,
    'source_wallet_club_id',p_source_wallet_club_id,
    'credit_ledger_id',v_credit_ledger_id,
    'wallet_transaction_id',v_wallet_transaction_id,
    'already_paid',round(v_total-v_pay,2),'paid',v_pay,
    'amount_owed',v_total,'amount_paid',v_total,
    'refund_prize',v_prize,'refund_bounty',v_bounty,'refund_fee',v_fee);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_ca_unregister_tournament_player_exact(p_tournament_id uuid, p_user_id uuid, p_expected_table_id uuid DEFAULT NULL::uuid, p_description text DEFAULT NULL::text, p_request_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t public.tournaments%ROWTYPE;
  v_reg public.tournament_players%ROWTYPE;
  v_ent record;
  v_fee_group record;
  v_settle jsonb;
  v_ticket jsonb;
  v_receipt jsonb;
  v_escrow_before public.tournament_escrow%ROWTYPE;
  v_escrow_after public.tournament_escrow%ROWTYPE;
  v_players_before integer;
  v_rows integer;
  v_seat_number integer;
  v_seats_taken integer;
  v_non_cash_count integer;
  v_wallet_debits numeric:=0;
  v_wallet_refunds_before numeric:=0;
  v_wallet_refunds_after numeric:=0;
  v_entitled_wallet_total numeric:=0;
  v_tranche_total numeric:=0;
  v_refund_prize numeric:=0;
  v_refund_bounty numeric:=0;
  v_refund_fee numeric:=0;
  v_refund_total numeric:=0;
  v_wallet_amount numeric:=0;
  v_ticket_amount numeric:=0;
  v_running_owed numeric:=0;
  v_rake_before numeric:=0;
  v_rake_after numeric:=0;
  v_fees_reversed numeric:=0;
  v_entitlement_ids uuid[]:='{}'::uuid[];
  v_ticket_ids uuid[]:='{}'::uuid[];
  v_credit_ledger_ids uuid[]:='{}'::uuid[];
  v_wallet_transaction_ids uuid[]:='{}'::uuid[];
  v_source_wallet_club_ids uuid[]:='{}'::uuid[];
  v_fee_reversal_ids uuid[]:='{}'::uuid[];
  v_fee_source_rake_record_ids uuid[]:='{}'::uuid[];
  v_fee_entitlement_ids uuid[]:='{}'::uuid[];
  v_fee_reversal_id uuid;
  v_fee_source_count integer:=0;
  v_fee_source_entitlement_count integer:=0;
  v_fee_source_amount numeric:=0;
  v_request_id uuid:=COALESCE(p_request_id,gen_random_uuid());
  v_unregistered_at timestamptz;
  v_description text:=COALESCE(
    NULLIF(btrim(p_description),''),'Tournament unregistration refund');
BEGIN
  IF p_tournament_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'tournament and player ids are required'
      USING ERRCODE='22004';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('ca:tournament-terminal-settlement:v1',0));
  SELECT * INTO v_t FROM public.tournaments t
   WHERE t.id=p_tournament_id FOR UPDATE;
  IF v_t.id IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_not_found');
  END IF;

  -- A caller-supplied request id is a durable operation identity. It may only
  -- name this exact player/event/endpoint scope. If its pre-start outcome is
  -- already committed, replay that immutable outcome even when the wall clock
  -- is now past the start; this branch performs no new unregistration writes.
  IF p_request_id IS NOT NULL THEN
    IF EXISTS(
      SELECT 1 FROM public.tournament_unregistration_receipts r
       WHERE r.request_id=p_request_id
         AND (r.tournament_id IS DISTINCT FROM p_tournament_id
           OR r.user_id IS DISTINCT FROM p_user_id
           OR r.source_table_id IS DISTINCT FROM p_expected_table_id)) THEN
      RAISE EXCEPTION 'unregistration request id belongs to another intent'
        USING ERRCODE='22023';
    END IF;
    IF EXISTS(
      SELECT 1 FROM public.tournament_unregistration_receipts r
       WHERE r.request_id=p_request_id) THEN
      v_receipt:=public.fn_ca_tournament_unregistration_receipt(
        p_tournament_id,p_user_id,p_expected_table_id,p_request_id);
      IF v_receipt IS NOT NULL THEN
        RETURN v_receipt||jsonb_build_object('replayed',true);
      END IF;
      RAISE EXCEPTION
        'unregistration request id belongs to a prior registration lifecycle'
        USING ERRCODE='P0404';
    END IF;
  END IF;

  SELECT * INTO v_reg FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id AND tp.user_id=p_user_id
     AND tp.status::text IN ('registered','playing')
   ORDER BY tp.id LIMIT 1 FOR UPDATE;
  IF upper(COALESCE(v_t.status::text,'')) NOT IN ('ANNOUNCED','REGISTERING') THEN
    RETURN jsonb_build_object('ok',false,'reason','registration_closed');
  END IF;
  IF v_t.start_time IS NULL THEN
    RETURN jsonb_build_object('ok',false,'reason','registration_schedule_unset');
  END IF;
  IF clock_timestamp()>=v_t.start_time THEN
    RETURN jsonb_build_object('ok',false,'reason','tournament_started');
  END IF;
  IF v_reg.id IS NULL THEN
    -- Rolling clients without a request id may recover a just-lost response
    -- only while registration remains open. They can never turn an old receipt
    -- into a successful post-start response.
    IF p_request_id IS NULL THEN
      v_receipt:=public.fn_ca_tournament_unregistration_receipt(
        p_tournament_id,p_user_id,p_expected_table_id,NULL);
      IF v_receipt IS NOT NULL THEN
        RETURN v_receipt||jsonb_build_object('replayed',true);
      END IF;
    END IF;
    RETURN jsonb_build_object('ok',false,'reason','not_registered');
  END IF;
  IF p_expected_table_id IS NOT NULL THEN
    SELECT s.seat_number INTO v_seat_number
      FROM public.table_seats s JOIN public.tables tb ON tb.id=s.table_id
     WHERE s.table_id=p_expected_table_id AND s.user_id=p_user_id
       AND s.left_at IS NULL AND tb.tournament_id=p_tournament_id
     ORDER BY s.id LIMIT 1 FOR UPDATE OF s;
    IF v_seat_number IS NULL THEN
      RETURN jsonb_build_object('ok',false,'reason','not_seated');
    END IF;
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.spin_reserve_ledger r
     WHERE r.tournament_id=p_tournament_id
       AND r.kind IN ('contribution','jackpot_draw')) THEN
    RETURN jsonb_build_object('ok',false,'reason','spin_entry_already_booked');
  END IF;

  PERFORM 1 FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
   ORDER BY e.entitlement_kind,e.id FOR UPDATE;
  SELECT count(*) INTO v_non_cash_count
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND e.registration_id=v_reg.id
     AND e.entitlement_kind IN ('satellite_seat','tournament_ticket')
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.source_refund_entitlement_id=e.id)
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.entitlement_id=e.id);
  IF COALESCE(v_reg.is_satellite_qualifier,false)
     AND v_non_cash_count<>1 THEN
    RAISE EXCEPTION
      'satellite-funded registration % requires one unspent ticket entitlement',
      v_reg.id USING ERRCODE='P0404';
  END IF;
  IF NOT COALESCE(v_reg.is_satellite_qualifier,false)
     AND v_non_cash_count<>0 THEN
    RAISE EXCEPTION
      'cash registration % cannot own a satellite ticket entitlement',v_reg.id
      USING ERRCODE='P0404';
  END IF;

  SELECT round(COALESCE(sum(e.refund_prize),0),2),
         round(COALESCE(sum(e.refund_bounty),0),2),
         round(COALESCE(sum(e.refund_fee),0),2),
         round(COALESCE(sum(e.gross),0),2),
         round(COALESCE(sum(e.gross) FILTER(
           WHERE e.entitlement_kind='wallet_charge'),0),2),
         round(COALESCE(sum(e.gross) FILTER(
           WHERE e.entitlement_kind IN ('satellite_seat','tournament_ticket')),0),2)
    INTO v_refund_prize,v_refund_bounty,v_refund_fee,v_refund_total,
         v_wallet_amount,v_ticket_amount
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND (e.entitlement_kind='wallet_charge' OR e.registration_id=v_reg.id)
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.entitlement_id=e.id)
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.source_refund_entitlement_id=e.id);
  IF v_refund_total IS DISTINCT FROM
       round(v_refund_prize+v_refund_bounty+v_refund_fee,2)
     OR v_refund_total IS DISTINCT FROM
       round(v_wallet_amount+v_ticket_amount,2) THEN
    RAISE EXCEPTION 'registration % has invalid entitlement totals',v_reg.id
      USING ERRCODE='P0404';
  END IF;
  -- A satellite seat, including a returned ticket that was used for a later
  -- target entry, is a noncash entry for its entire registration lifecycle.
  -- Any wallet-charge entitlement attached to that registration is corrupt;
  -- refuse the whole transaction instead of ever returning chips.
  IF COALESCE(v_reg.is_satellite_qualifier,false)
     AND (v_wallet_amount<>0 OR v_ticket_amount<=0
       OR v_refund_total IS DISTINCT FROM v_ticket_amount) THEN
    RAISE EXCEPTION
      'satellite-funded registration % can return only a tournament ticket',
      v_reg.id USING ERRCODE='P0404';
  END IF;

  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_wallet_debits
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=p_user_id
     AND w.type='debit'
     AND lower(w.category) IN ('tournament_buyin','rebuy','addon');
  SELECT round(COALESCE(sum(e.gross),0),2) INTO v_entitled_wallet_total
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND e.entitlement_kind='wallet_charge';
  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_wallet_refunds_before
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=p_user_id
     AND w.type='credit'
     AND lower(w.category) IN ('refund','tournament_refund');
  SELECT round(COALESCE(sum(tr.amount_paid_now),0),2) INTO v_tranche_total
    FROM public.tournament_refund_tranches tr
   WHERE tr.tournament_id=p_tournament_id AND tr.user_id=p_user_id;
  IF v_wallet_debits IS DISTINCT FROM v_entitled_wallet_total
     OR v_wallet_refunds_before IS DISTINCT FROM v_tranche_total
     OR v_wallet_refunds_before>v_wallet_debits THEN
    RAISE EXCEPTION 'registration % wallet and entitlement journals disagree',v_reg.id
      USING ERRCODE='P0404';
  END IF;
  v_running_owed:=v_tranche_total;

  SELECT round(COALESCE(sum(r.rake_amount),0),2) INTO v_rake_before
    FROM public.rake_records r
   WHERE r.tournament_id=p_tournament_id AND r.is_tournament;
  SELECT COALESCE(array_agg(e.id ORDER BY e.id),ARRAY[]::uuid[])
    INTO v_fee_entitlement_ids
    FROM public.tournament_refund_entitlements e
   WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
     AND (e.entitlement_kind='wallet_charge' OR e.registration_id=v_reg.id)
     AND e.refund_fee>0
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_refund_tranches tr
        WHERE tr.entitlement_id=e.id)
     AND NOT EXISTS(
       SELECT 1 FROM public.tournament_tickets tk
        WHERE tk.source_refund_entitlement_id=e.id);

  -- Bind every fee-bearing entitlement to its actual same-transaction rake
  -- journal. The refund wallet club is deliberately absent from this match:
  -- it identifies the payer, while rake_records.club_id identifies the fee
  -- recipient and can be a different club.
  WITH fee_sources AS MATERIALIZED (
    SELECT e.id AS entitlement_id,r.id AS rake_record_id,
           r.club_id,r.rake_amount
      FROM public.tournament_refund_entitlements e
      JOIN public.chip_ledger l ON l.id=e.source_ledger_id
      JOIN public.rake_records r
        ON r.tournament_id=e.tournament_id
       AND r.is_tournament IS TRUE
       AND r.club_id IS NOT NULL
       AND r.rake_amount=e.refund_fee
       AND r.created_at=l.created_at
       AND r.metadata->>'user_id'=e.user_id::text
       AND (
         (e.entitlement_kind='wallet_charge'
          AND e.charge_category='tournament_buyin'
          AND r.source IN (
            'fn_register_for_tournament','fn_register_horse_for_tournament')
          AND r.metadata->>'kind'='tournament_entry_fee'
          AND r.metadata->>'registration_id'=v_reg.id::text)
         OR (e.entitlement_kind='wallet_charge'
          AND e.charge_category='rebuy'
          AND r.source='process_tournament_rebuy'
          AND r.metadata->>'kind' IN (
            'tournament_rebuy_fee','tournament_reentry_fee'))
         OR (e.entitlement_kind='satellite_seat'
          AND r.source='fn_award_satellite_seat'
          AND r.metadata->>'kind'='satellite_seat_entry_fee'
          AND r.metadata->>'registration_id'=e.registration_id::text)
         OR (e.entitlement_kind='tournament_ticket'
          AND r.source='fn_register_for_tournament_with_ticket'
          AND r.metadata->>'kind'='tournament_ticket_entry_fee'
          AND r.metadata->>'registration_id'=e.registration_id::text))
     WHERE e.id=ANY(v_fee_entitlement_ids)
  )
  SELECT count(*),count(DISTINCT entitlement_id),
         round(COALESCE(sum(rake_amount),0),2),
         COALESCE(array_agg(rake_record_id ORDER BY rake_record_id),
                  ARRAY[]::uuid[])
    INTO v_fee_source_count,v_fee_source_entitlement_count,
         v_fee_source_amount,v_fee_source_rake_record_ids
    FROM fee_sources;
  IF v_fee_source_count<>cardinality(v_fee_entitlement_ids)
     OR v_fee_source_entitlement_count<>cardinality(v_fee_entitlement_ids)
     OR v_fee_source_count<>(
       SELECT count(DISTINCT id)
         FROM unnest(v_fee_source_rake_record_ids) source(id))
     OR v_fee_source_amount IS DISTINCT FROM v_refund_fee THEN
    RAISE EXCEPTION
      'registration % fee entitlements do not map one-to-one to exact rake evidence',
      v_reg.id USING ERRCODE='P0404';
  END IF;
  PERFORM 1 FROM public.rake_records r
   WHERE r.id=ANY(v_fee_source_rake_record_ids)
   ORDER BY r.club_id,r.id FOR UPDATE;

  PERFORM public.fn_ca_escrow_apply(
    p_tournament_id,'unregister entitlement escrow prelock');
  SELECT * INTO v_escrow_before FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id FOR UPDATE;
  SELECT count(*) INTO v_players_before FROM public.tournament_players tp
   WHERE tp.tournament_id=p_tournament_id
     AND tp.status::text IN ('registered','playing');
  IF v_escrow_before.tournament_id IS NULL
     OR v_escrow_before.enforced IS DISTINCT FROM true
     OR v_players_before<=0
     OR v_t.current_players IS DISTINCT FROM v_players_before
     OR v_t.prize_pool IS DISTINCT FROM v_escrow_before.prize_balance
     OR v_t.bounty_pool IS DISTINCT FROM v_escrow_before.bounty_balance
     OR v_t.total_rake IS DISTINCT FROM v_escrow_before.fee_balance
     OR v_t.total_rake IS DISTINCT FROM v_rake_before
     OR v_t.prize_pool<v_refund_prize
     OR v_t.bounty_pool<v_refund_bounty
     OR v_t.total_rake<v_refund_fee THEN
    RAISE EXCEPTION 'registration % cannot leave divergent tournament state',v_reg.id
      USING ERRCODE='P0404';
  END IF;

  FOR v_ent IN
    SELECT e.* FROM public.tournament_refund_entitlements e
     WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
       AND e.entitlement_kind='wallet_charge'
       AND NOT EXISTS(
         SELECT 1 FROM public.tournament_refund_tranches tr
          WHERE tr.entitlement_id=e.id)
       AND NOT EXISTS(
         SELECT 1 FROM public.tournament_tickets tk
          WHERE tk.source_refund_entitlement_id=e.id)
     ORDER BY e.id
  LOOP
    v_running_owed:=round(v_running_owed+v_ent.gross,2);
    v_settle:=public.fn_settle_tournament_refund_exact(
      p_tournament_id,p_user_id,v_ent.refund_wallet_club_id,v_running_owed,
      v_ent.refund_prize,v_ent.refund_bounty,v_ent.refund_fee,
      'fn_unregister_from_tournament',v_description);
    IF COALESCE((v_settle->>'ok')::boolean,false) IS NOT TRUE
       OR (v_settle->>'entitlement_id')::uuid IS DISTINCT FROM v_ent.id
       OR (v_settle->>'paid')::numeric IS DISTINCT FROM v_ent.gross
       OR (v_settle->>'amount_paid')::numeric IS DISTINCT FROM v_running_owed
       OR (v_settle->>'source_wallet_club_id')::uuid
            IS DISTINCT FROM v_ent.refund_wallet_club_id THEN
      RAISE EXCEPTION 'registration % exact wallet refund failed',v_reg.id
        USING ERRCODE='P0404';
    END IF;
    v_entitlement_ids:=array_append(v_entitlement_ids,v_ent.id);
    v_source_wallet_club_ids:=array_append(
      v_source_wallet_club_ids,v_ent.refund_wallet_club_id);
    v_credit_ledger_ids:=array_append(
      v_credit_ledger_ids,(v_settle->>'credit_ledger_id')::uuid);
    v_wallet_transaction_ids:=array_append(
      v_wallet_transaction_ids,(v_settle->>'wallet_transaction_id')::uuid);
  END LOOP;

  FOR v_ent IN
    SELECT e.* FROM public.tournament_refund_entitlements e
     WHERE e.tournament_id=p_tournament_id AND e.user_id=p_user_id
       AND e.registration_id=v_reg.id
       AND e.entitlement_kind IN ('satellite_seat','tournament_ticket')
       AND NOT EXISTS(
         SELECT 1 FROM public.tournament_refund_tranches tr
          WHERE tr.entitlement_id=e.id)
       AND NOT EXISTS(
         SELECT 1 FROM public.tournament_tickets tk
          WHERE tk.source_refund_entitlement_id=e.id)
     ORDER BY e.id
  LOOP
    v_ticket:=public.fn_ca_return_satellite_entitlement_as_ticket(
      v_ent.id,'fn_unregister_from_tournament',v_description);
    IF COALESCE((v_ticket->>'ok')::boolean,false) IS NOT TRUE
       OR (v_ticket->>'entitlement_id')::uuid IS DISTINCT FROM v_ent.id
       OR (v_ticket->>'value')::numeric IS DISTINCT FROM v_ent.gross
       OR (v_ticket->>'refund_wallet_club_id')::uuid
            IS DISTINCT FROM v_ent.refund_wallet_club_id
       OR (v_ticket->>'ticket_id') IS NULL THEN
      RAISE EXCEPTION 'registration % tournament-ticket return failed',v_reg.id
        USING ERRCODE='P0404';
    END IF;
    v_entitlement_ids:=array_append(v_entitlement_ids,v_ent.id);
    v_source_wallet_club_ids:=array_append(
      v_source_wallet_club_ids,v_ent.refund_wallet_club_id);
    v_ticket_ids:=array_append(v_ticket_ids,(v_ticket->>'ticket_id')::uuid);
  END LOOP;

  FOR v_fee_group IN
    SELECT r.club_id,round(sum(r.rake_amount),2) AS fee,
           array_agg(r.id ORDER BY r.id) AS source_rake_record_ids,
           array_agg(e.id ORDER BY e.id) AS entitlement_ids
      FROM public.rake_records r
      JOIN public.tournament_refund_entitlements e
        ON e.id=ANY(v_fee_entitlement_ids)
       AND e.refund_fee=r.rake_amount
       AND e.tournament_id=r.tournament_id
       AND e.user_id=p_user_id
       AND r.metadata->>'user_id'=e.user_id::text
       AND (
         (e.entitlement_kind='wallet_charge'
          AND e.charge_category='tournament_buyin'
          AND r.source IN (
            'fn_register_for_tournament','fn_register_horse_for_tournament')
          AND r.metadata->>'kind'='tournament_entry_fee'
          AND r.metadata->>'registration_id'=v_reg.id::text)
         OR (e.entitlement_kind='wallet_charge'
          AND e.charge_category='rebuy'
          AND r.source='process_tournament_rebuy'
          AND r.metadata->>'kind' IN (
            'tournament_rebuy_fee','tournament_reentry_fee'))
         OR (e.entitlement_kind='satellite_seat'
          AND r.source='fn_award_satellite_seat'
          AND r.metadata->>'kind'='satellite_seat_entry_fee'
          AND r.metadata->>'registration_id'=e.registration_id::text)
         OR (e.entitlement_kind='tournament_ticket'
          AND r.source='fn_register_for_tournament_with_ticket'
          AND r.metadata->>'kind'='tournament_ticket_entry_fee'
          AND r.metadata->>'registration_id'=e.registration_id::text))
      JOIN public.chip_ledger l
        ON l.id=e.source_ledger_id AND l.created_at=r.created_at
     WHERE r.id=ANY(v_fee_source_rake_record_ids)
     GROUP BY r.club_id ORDER BY r.club_id
  LOOP
    IF v_fee_group.fee>0 THEN
      INSERT INTO public.rake_records(
        hand_id,table_id,club_id,rake_amount,pot_size,num_players,
        bbj_contribution,is_tournament,tournament_id,source,metadata)
      VALUES(
        NULL,NULL,v_fee_group.club_id,-v_fee_group.fee,v_fee_group.fee,1,
        0,true,p_tournament_id,'fn_unregister_from_tournament',
        jsonb_build_object(
          'kind','tournament_fee_refund','user_id',p_user_id,
          'registration_id',v_reg.id,
          'fee_recipient_club_id',v_fee_group.club_id,
          'entitlement_ids',to_jsonb(v_fee_group.entitlement_ids),
          'original_rake_record_ids',
            to_jsonb(v_fee_group.source_rake_record_ids)))
      RETURNING id INTO v_fee_reversal_id;
      v_fee_reversal_ids:=array_append(
        v_fee_reversal_ids,v_fee_reversal_id);
      v_fees_reversed:=round(v_fees_reversed+v_fee_group.fee,2);
    END IF;
  END LOOP;
  SELECT COALESCE(array_agg(id ORDER BY id),ARRAY[]::uuid[])
    INTO v_fee_reversal_ids
    FROM unnest(v_fee_reversal_ids) reversal(id);
  IF v_fees_reversed IS DISTINCT FROM v_refund_fee THEN
    RAISE EXCEPTION
      'registration % reversed % in exact fee rows but owes %',
      v_reg.id,v_fees_reversed,v_refund_fee USING ERRCODE='P0404';
  END IF;

  UPDATE public.tournaments
     SET current_players=v_players_before-1,
         prize_pool=round(v_t.prize_pool-v_refund_prize,2),
         bounty_pool=round(v_t.bounty_pool-v_refund_bounty,2),
         total_rake=round(v_t.total_rake-v_refund_fee,2),updated_at=now()
   WHERE id=p_tournament_id
     AND current_players IS NOT DISTINCT FROM v_players_before
     AND prize_pool IS NOT DISTINCT FROM v_t.prize_pool
     AND bounty_pool IS NOT DISTINCT FROM v_t.bounty_pool
     AND total_rake IS NOT DISTINCT FROM v_t.total_rake;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'registration % tournament cache changed',v_reg.id
      USING ERRCODE='40001';
  END IF;

  UPDATE public.table_seats s
     SET left_at=transaction_timestamp(),status='left',leave_pending=false,
         is_sitting_out=false,is_away=false,sit_out_at=NULL,
         scheduled_leave_hands=NULL
   WHERE s.user_id=p_user_id AND s.left_at IS NULL
     AND EXISTS(SELECT 1 FROM public.tables tb
                 WHERE tb.id=s.table_id AND tb.tournament_id=p_tournament_id);
  UPDATE public.tables tb
     SET current_players=(SELECT count(*) FROM public.table_seats s
                           WHERE s.table_id=tb.id AND s.left_at IS NULL),
         updated_at=now()
   WHERE tb.tournament_id=p_tournament_id;
  DELETE FROM public.tournament_players tp WHERE tp.id=v_reg.id;
  GET DIAGNOSTICS v_rows=ROW_COUNT;
  IF v_rows<>1 THEN
    RAISE EXCEPTION 'registration % was not deleted after settlement',v_reg.id
      USING ERRCODE='40001';
  END IF;

  SELECT * INTO v_escrow_after FROM public.tournament_escrow e
   WHERE e.tournament_id=p_tournament_id;
  SELECT round(COALESCE(sum(r.rake_amount),0),2) INTO v_rake_after
    FROM public.rake_records r
   WHERE r.tournament_id=p_tournament_id AND r.is_tournament;
  SELECT round(COALESCE(sum(w.amount),0),2) INTO v_wallet_refunds_after
    FROM public.wallet_transactions w
   WHERE w.related_entity_id=p_tournament_id AND w.user_id=p_user_id
     AND w.type='credit'
     AND lower(w.category) IN ('refund','tournament_refund');
  IF (SELECT count(*) FROM public.tournament_players tp
       WHERE tp.tournament_id=p_tournament_id
         AND tp.status::text IN ('registered','playing'))<>v_players_before-1
     OR v_wallet_refunds_after IS DISTINCT FROM
          round(v_wallet_refunds_before+v_wallet_amount,2)
     OR v_escrow_after.prize_balance IS DISTINCT FROM
          round(v_escrow_before.prize_balance-v_refund_prize,2)
     OR v_escrow_after.bounty_balance IS DISTINCT FROM
          round(v_escrow_before.bounty_balance-v_refund_bounty,2)
     OR v_escrow_after.fee_balance IS DISTINCT FROM
          round(v_escrow_before.fee_balance-v_refund_fee,2)
     OR v_rake_after IS DISTINCT FROM round(v_rake_before-v_refund_fee,2)
     OR NOT EXISTS(
       SELECT 1 FROM public.tournaments t
        WHERE t.id=p_tournament_id
          AND t.current_players=v_players_before-1
          AND t.prize_pool=v_escrow_after.prize_balance
          AND t.bounty_pool=v_escrow_after.bounty_balance
          AND t.total_rake=v_rake_after) THEN
    RAISE EXCEPTION 'registration % did not leave exact final state',v_reg.id
      USING ERRCODE='P0404';
  END IF;
  IF p_expected_table_id IS NOT NULL THEN
    SELECT count(*) INTO v_seats_taken FROM public.table_seats s
     WHERE s.table_id=p_expected_table_id AND s.left_at IS NULL;
  END IF;

  -- The entire transaction is refused if its final verified outcome was not
  -- established before the locked schedule cutoff. All preceding writes then
  -- roll back atomically; no wall-clock grace period exists.
  v_unregistered_at:=clock_timestamp();
  IF v_unregistered_at>=v_t.start_time THEN
    RAISE EXCEPTION 'tournament started before unregistration could commit'
      USING ERRCODE='55000';
  END IF;

  INSERT INTO public.tournament_unregistration_receipts(
    registration_id,request_id,tournament_id,user_id,source_table_id,
    refunded_chips,returned_ticket_value,entitlement_ids,ticket_ids,
    source_wallet_club_ids,credit_ledger_ids,wallet_transaction_ids,
    fees_reversed,fee_reversal_ids,fee_source_rake_record_ids,
    seat_number,seats_taken,scheduled_start_at,settled_at)
  VALUES(
    v_reg.id,v_request_id,p_tournament_id,p_user_id,p_expected_table_id,
    v_wallet_amount,v_ticket_amount,v_entitlement_ids,v_ticket_ids,
    v_source_wallet_club_ids,v_credit_ledger_ids,v_wallet_transaction_ids,
    v_fees_reversed,v_fee_reversal_ids,v_fee_source_rake_record_ids,
    v_seat_number,v_seats_taken,v_t.start_time,v_unregistered_at);
  v_receipt:=public.fn_ca_tournament_unregistration_receipt(
    p_tournament_id,p_user_id,p_expected_table_id,v_request_id);
  IF v_receipt IS NULL
     OR (v_receipt->>'registration_id')::uuid IS DISTINCT FROM v_reg.id THEN
    RAISE EXCEPTION 'registration % has no exact unregistration receipt',v_reg.id
      USING ERRCODE='P0404';
  END IF;
  RETURN v_receipt||jsonb_build_object('replayed',false);
END;
$function$;

CREATE TRIGGER trg_club_members_audit_chip_movement AFTER UPDATE OF chip_balance ON public.club_members FOR EACH ROW EXECUTE FUNCTION public.fn_club_members_ledger_writer();

CREATE TRIGGER trg_ca_chip_ledger_enrich BEFORE INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION public.fn_ca_chip_ledger_enrich();

CREATE TRIGGER zz_chip_ledger_key_is_claimed_once BEFORE INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION public.zz_chip_ledger_key_is_claimed_once();

CREATE TRIGGER zz_ca_escrow_wallet_tx AFTER INSERT ON public.wallet_transactions FOR EACH ROW EXECUTE FUNCTION public.fn_ca_escrow_on_wallet_tx();

CREATE TRIGGER zz_ca_escrow_rake_record AFTER INSERT ON public.rake_records FOR EACH ROW EXECUTE FUNCTION public.fn_ca_escrow_on_rake_record();

CREATE TRIGGER trg_sync_tournament_current_players AFTER INSERT OR DELETE ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION public.fn_sync_tournament_current_players();

CREATE CONSTRAINT TRIGGER tournament_roster_cannot_orphan_live_seat AFTER DELETE ON public.tournament_players DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.trg_assert_live_tournament_seat_has_roster();

CREATE CONSTRAINT TRIGGER tournament_refund_entitlement_commit_valid AFTER INSERT ON public.tournament_refund_entitlements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_ca_refund_entitlement_commit_valid();

CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.tournament_refund_entitlements FOR EACH ROW EXECUTE FUNCTION public.fn_satellite_settlement_receipts_are_append_only();

CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.tournament_refund_tranches FOR EACH ROW EXECUTE FUNCTION public.fn_satellite_settlement_receipts_are_append_only();

CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON public.tournament_unregistration_receipts FOR EACH ROW EXECUTE FUNCTION public.fn_satellite_settlement_receipts_are_append_only();
