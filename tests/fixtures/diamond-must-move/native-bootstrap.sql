CREATE EXTENSION "uuid-ossp";
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth;
CREATE SEQUENCE cash_cluster_events_id_seq;
CREATE SCHEMA smarter_private; CREATE SEQUENCE smarter_private.f06_lifecycle_seq;
CREATE FUNCTION smarter_private.f06_new_lifecycle() RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path TO pg_catalog AS $$ SELECT nextval('smarter_private.f06_lifecycle_seq') $$;
CREATE TABLE "ca_arena_settings" ("id" smallint DEFAULT 1 NOT NULL,
"club_id" uuid,
"settlement_window_days" integer DEFAULT 14 NOT NULL,
"note" text,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
"cash_games_enabled" boolean DEFAULT false NOT NULL,
"tournaments_enabled" boolean DEFAULT false NOT NULL);
CREATE TABLE "cash_cluster_events" ("id" bigint DEFAULT nextval('cash_cluster_events_id_seq'::regclass) NOT NULL,
"game_id" uuid NOT NULL,
"table_id" uuid,
"kind" text NOT NULL,
"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
"at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
"cluster_epoch" integer DEFAULT 0 NOT NULL,
"event_version" smallint DEFAULT 1 NOT NULL,
"request_id" uuid);
CREATE TABLE "cash_game_roster" ("id" uuid DEFAULT gen_random_uuid() NOT NULL,
"game_id" uuid NOT NULL,
"user_id" uuid NOT NULL,
"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
"left_at" timestamp with time zone,
"seat_change_used_at" timestamp with time zone);
CREATE TABLE "cash_game_waitlist" ("id" uuid DEFAULT gen_random_uuid() NOT NULL,
"game_id" uuid NOT NULL,
"user_id" uuid NOT NULL,
"status" text DEFAULT 'waiting'::text NOT NULL,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL);
CREATE TABLE "cash_games" ("id" uuid DEFAULT gen_random_uuid() NOT NULL,
"club_id" uuid NOT NULL,
"union_id" uuid,
"name" text NOT NULL,
"template_name" text NOT NULL,
"variant" text NOT NULL,
"sb" numeric(14,2) NOT NULL,
"bb" numeric(14,2) NOT NULL,
"handedness" integer NOT NULL,
"ruleset_snapshot" jsonb NOT NULL,
"enabled" boolean DEFAULT true NOT NULL,
"state" text DEFAULT 'live'::text NOT NULL,
"cap_mains" integer DEFAULT 8 NOT NULL,
"allow_second_feeder" boolean DEFAULT false NOT NULL,
"created_by" uuid,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
"must_move" boolean DEFAULT true NOT NULL,
"closed_at" timestamp with time zone,
"closed_by" uuid,
"opening_hold_since" timestamp with time zone,
"last_tick_at" timestamp with time zone,
"last_tick_actions" jsonb,
"opening_hold_rested_until" timestamp with time zone,
"cluster_mode" text DEFAULT 'must_move'::text NOT NULL,
"lightning_enabled" boolean DEFAULT false NOT NULL,
"cluster_epoch" integer DEFAULT 0 NOT NULL,
"lightning_off_condition_since" timestamp with time zone);
CREATE TABLE "cash_player_session" ("id" uuid DEFAULT gen_random_uuid() NOT NULL,
"player_id" uuid NOT NULL,
"club_id" uuid,
"scope_type" text NOT NULL,
"scope_id" uuid NOT NULL,
"table_id" uuid NOT NULL,
"variant" text,
"sb" numeric(14,2),
"bb" numeric(14,2),
"baseline" numeric(14,2) DEFAULT 0 NOT NULL,
"stay_clock_ms" integer DEFAULT 600000 NOT NULL,
"rejoin_window_ms" integer DEFAULT 7200000 NOT NULL,
"stay_remaining_ms" integer DEFAULT 600000 NOT NULL,
"stay_running" boolean DEFAULT false NOT NULL,
"stay_last_tick_at" timestamp with time zone DEFAULT now() NOT NULL,
"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
"closed_at" timestamp with time zone,
"closed_reason" text,
"cluster_id" uuid,
"final_stack" numeric(14,2),
"final_stack_captured_at" timestamp with time zone,
"financial_capture_status" text DEFAULT 'legacy_unavailable'::text NOT NULL,
"close_table_id" uuid);
CREATE TABLE "cash_seat_move_receipts" ("move_id" uuid NOT NULL,
"player_id" uuid NOT NULL,
"game_id" uuid NOT NULL,
"club_id" uuid NOT NULL,
"from_table_id" uuid NOT NULL,
"from_seat_number" integer NOT NULL,
"source_occupancy_id" uuid NOT NULL,
"to_table_id" uuid NOT NULL,
"to_seat_number" integer NOT NULL,
"destination_occupancy_id" uuid NOT NULL,
"amount" numeric NOT NULL,
"receipt" jsonb NOT NULL,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"transaction_id" xid8 DEFAULT pg_current_xact_id());
CREATE TABLE "cash_seat_moves" ("id" uuid DEFAULT gen_random_uuid() NOT NULL,
"game_id" uuid NOT NULL,
"player_id" uuid NOT NULL,
"from_table_id" uuid NOT NULL,
"to_table_id" uuid NOT NULL,
"reason" text NOT NULL,
"state" text DEFAULT 'pending'::text NOT NULL,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"expires_at" timestamp with time zone NOT NULL,
"executed_at" timestamp with time zone,
"to_seat_number" integer,
"note" text,
"announced_at" timestamp with time zone,
"swap_move_id" uuid,
"ready_at" timestamp with time zone,
"source_occupancy_id" uuid,
"source_seat_number" integer,
"resolved_at" timestamp with time zone);
CREATE TABLE "clubs" ("id" uuid DEFAULT uuid_generate_v4() NOT NULL,
"name" text NOT NULL,
"description" text,
"owner_id" uuid,
"created_at" timestamp with time zone DEFAULT now(),
"is_union" boolean DEFAULT false,
"club_id" integer DEFAULT (((10000)::double precision + floor((random() * (90000)::double precision))))::integer,
"avatar_url" text,
"is_public" boolean DEFAULT true,
"requires_approval" boolean DEFAULT false,
"gps_restricted" boolean DEFAULT false,
"settings" jsonb DEFAULT '{"rake_cap": 15, "max_buy_in_bb": 200, "min_buy_in_bb": 40, "allow_straddle": true, "time_bank_seconds": 30, "allow_run_it_twice": true, "default_rake_percent": 5}'::jsonb,
"updated_at" timestamp with time zone DEFAULT now(),
"union_id" uuid,
"color_theme" text DEFAULT 'royal-blue'::text,
"slug" text,
"chip_treasury" numeric(18,2) DEFAULT 100000,
"total_rake" numeric(18,2) DEFAULT 0 NOT NULL,
"online_count" integer DEFAULT 0,
"game_types" text[] DEFAULT ARRAY['NLH'::text],
"member_count" integer DEFAULT 0,
"table_count" integer DEFAULT 0,
"promo_balance" numeric(14,2) DEFAULT 0,
"code" text,
"rake_percent" numeric(5,2) DEFAULT 5.0,
"rake_cap_bb" numeric(8,2) DEFAULT 3.0,
"max_tables" integer DEFAULT 20,
"max_members" integer DEFAULT 500,
"status" text DEFAULT 'active'::text,
"hands_played" bigint DEFAULT 0,
"logo_url" text,
"banner_url" text,
"game_variants" text[] DEFAULT ARRAY['nlh'::text],
"settlement_locked" boolean DEFAULT false,
"settlement_locked_until" timestamp with time zone,
"auto_settlement_enabled" boolean DEFAULT true,
"auto_settlement_day" text DEFAULT 'monday'::text,
"auto_settlement_hour" integer DEFAULT 10,
"club_commission_rate" numeric(5,4) DEFAULT 0.9000,
"insurance_balance" numeric(14,2) DEFAULT 0,
"bbj_enabled" boolean,
"player_level" integer DEFAULT 1,
"hierarchy_level" integer DEFAULT 1,
"level" integer DEFAULT 1,
"player_threshold_current" integer DEFAULT 0,
"player_threshold_next" integer DEFAULT 30,
"hierarchy_units" numeric(10,2) DEFAULT 0,
"hierarchy_units_rounded_up" integer DEFAULT 0,
"hierarchy_threshold_current" integer DEFAULT 0,
"hierarchy_threshold_next" integer DEFAULT 2,
"tags" text[] DEFAULT '{}'::text[],
"average_rating" numeric(3,2) DEFAULT 0,
"game_type" text DEFAULT 'Texas Holdem'::text,
"settlement_lock_until" timestamp with time zone,
"card_image_url" text,
"active_players" integer DEFAULT 0,
"default_rake_percent" numeric(5,2) DEFAULT '-1'::integer,
"rake_cap" numeric(18,4) DEFAULT '-1'::integer,
"min_buyin_bb" integer DEFAULT 20,
"max_buyin_bb" integer DEFAULT 200,
"allow_straddle" boolean DEFAULT true,
"allow_run_it_twice" boolean DEFAULT true,
"allow_rabbit_hunt" boolean DEFAULT false,
"logo" text,
"is_private" boolean DEFAULT false,
"min_buy_in" numeric(18,4) DEFAULT 0,
"max_buy_in" numeric(18,4) DEFAULT 0,
"default_game_type" text DEFAULT 'NLHE'::text,
"allow_insurance" boolean DEFAULT false,
"auto_approve_agents" boolean DEFAULT false,
"auto_settlement" boolean DEFAULT false,
"active_tables" integer DEFAULT 0,
"admin_count" integer DEFAULT 0,
"super_agent_count" integer DEFAULT 0,
"agent_count" integer DEFAULT 0,
"chip_pool" numeric(18,2) DEFAULT 0 NOT NULL,
"bbj_rake_enabled" boolean DEFAULT true,
"spins_enabled" boolean DEFAULT false,
"spins_preseed_amount" integer DEFAULT 0,
"spins_wallet_funding" text DEFAULT 'PROMO'::text,
"ticker_enabled" boolean DEFAULT true NOT NULL,
"guarantee_treasury_floor" numeric DEFAULT 0 NOT NULL,
"guarantee_enforcement_enabled" boolean DEFAULT true NOT NULL,
"tagline" text,
"opening_checklist_started_at" timestamp with time zone,
"lobby_message" text,
"lobby_message_updated_at" timestamp with time zone,
"message_revision" bigint DEFAULT 1 NOT NULL,
"lifecycle_status" text DEFAULT 'active'::text NOT NULL,
"retired_at" timestamp with time zone,
"retired_by" uuid,
"retirement_reason" text,
"asset" text DEFAULT 'chips'::text NOT NULL,
"is_platform" boolean DEFAULT false NOT NULL);
CREATE TABLE "diamond_debts" ("id" uuid DEFAULT gen_random_uuid() NOT NULL,
"user_id" uuid NOT NULL,
"purchase_id" uuid,
"amount" integer NOT NULL,
"reason" text NOT NULL,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"settled_at" timestamp with time zone,
"settled_by" text);
CREATE TABLE "diamond_purchase_lots" ("id" uuid DEFAULT gen_random_uuid() NOT NULL,
"user_id" uuid NOT NULL,
"purchase_id" uuid NOT NULL,
"issued" integer NOT NULL,
"consumed" integer DEFAULT 0 NOT NULL,
"refunded" integer DEFAULT 0 NOT NULL,
"frozen_at" timestamp with time zone,
"settled_at" timestamp with time zone,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"arena_reserved" bigint DEFAULT 0 NOT NULL);
CREATE TABLE "poker_diamond_custody" ("id" uuid DEFAULT gen_random_uuid() NOT NULL,
"user_id" uuid NOT NULL,
"arena_id" uuid NOT NULL,
"purpose" text NOT NULL,
"target_id" uuid NOT NULL,
"entry_key" text NOT NULL,
"balance" bigint DEFAULT 0 NOT NULL,
"state" text DEFAULT 'reserved'::text NOT NULL,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"released_at" timestamp with time zone,
"seat_id" uuid,
"seat_joined_at" timestamp with time zone,
"occupancy_id" uuid);
CREATE TABLE "profiles" ("id" uuid NOT NULL,
"full_name" text,
"display_name" text,
"first_name" text,
"last_name" text,
"username" text,
"email" text,
"phone" text,
"bio" text,
"city" text,
"state" text,
"alias" text,
"avatar_url" text,
"role" text DEFAULT 'user'::text,
"status" text DEFAULT 'active'::text,
"is_vip" boolean DEFAULT false,
"is_horse" boolean DEFAULT false,
"is_admin" boolean DEFAULT false,
"is_online" boolean DEFAULT false,
"player_number" text,
"diamonds" integer DEFAULT 0 NOT NULL,
"diamond_balance" integer DEFAULT 0,
"diamond_multiplier" numeric(3,2) DEFAULT 1.00,
"level" integer DEFAULT 1,
"tier" text DEFAULT 'Newcomer'::text,
"skill_tier" text DEFAULT 'Newcomer'::text,
"login_streak" integer DEFAULT 0,
"streak_days" integer DEFAULT 0,
"settings" jsonb DEFAULT '{}'::jsonb,
"preferences" jsonb DEFAULT '{}'::jsonb,
"social_page_id" uuid,
"favorite_venue" uuid,
"home_poker_club" uuid,
"referred_by" uuid,
"friends_count" integer DEFAULT 0,
"hendon_total_cashes" integer DEFAULT 0,
"hendon_total_earnings" numeric DEFAULT 0,
"email_verified" boolean DEFAULT false,
"phone_verified" boolean DEFAULT false,
"onboarding_complete" boolean DEFAULT false,
"last_login" timestamp with time zone DEFAULT now(),
"last_login_date" date DEFAULT CURRENT_DATE,
"last_seen" timestamp with time zone DEFAULT now(),
"created_at" timestamp with time zone DEFAULT now(),
"updated_at" timestamp with time zone DEFAULT now(),
"training_view_mode" text DEFAULT 'grid'::text,
"last_trivia_date" date,
"trivia_streak" integer DEFAULT 0,
"trivia_high_score" integer DEFAULT 0,
"total_hands_played" integer DEFAULT 0,
"notification_token" text,
"referral_code" text,
"horse_status" character varying DEFAULT 'available'::character varying,
"horse_profile" jsonb DEFAULT '{}'::jsonb,
"sounds_enabled" boolean DEFAULT true,
"vibrations_enabled" boolean DEFAULT true,
"show_stack_bb" boolean DEFAULT false,
"birth_year" integer,
"favorite_hand_type" text DEFAULT 'holdem'::text,
"card_back_preference" text DEFAULT 'white'::text,
"country" text,
"website" text,
"twitter" text,
"instagram" text,
"hendon_url" text,
"favorite_game" text,
"favorite_hand" text,
"home_casino" text,
"cover_photo_url" text,
"favorite_hand_plo" text,
"app_settings" jsonb DEFAULT '{}'::jsonb,
"display_name_preference" text DEFAULT 'full_name'::text,
"cover_photo_position" text DEFAULT '50% 50%'::text,
"tiktok" text,
"telegram" text,
"birthday" date,
"hendon_biggest_cash" numeric,
"use_real_name" boolean DEFAULT false,
"streak_count" integer DEFAULT 0,
"access_tier" text DEFAULT 'Full_Access'::text,
"vip_tier" text,
"vip_expires_at" timestamp with time zone,
"last_active" timestamp with time zone DEFAULT now(),
"poker_near_me_preferences" jsonb DEFAULT '{"geofenceAlerts": true, "locationEnabled": true, "showNewcomerFriendly": true}'::jsonb,
"can_review" boolean DEFAULT true,
"deleted_reviews_count" integer DEFAULT 0,
"kyc_status" text DEFAULT 'NONE'::text NOT NULL,
"kyc_provider" text,
"kyc_inquiry_id" text,
"kyc_completed_at" timestamp with time zone,
"kyc_rejection_reason" text,
"age_verified" boolean DEFAULT false NOT NULL,
"age_verified_at" timestamp with time zone,
"jurisdiction_country" text,
"mfa_required" boolean DEFAULT false NOT NULL,
"hub_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
"friend_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
"store_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
"messenger_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
"reels_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
"over_18_attested_at" timestamp with time zone,
"jurisdiction_region" text,
"jurisdiction_acknowledged_at" timestamp with time zone,
"home_games_onboarded_at" timestamp with time zone,
"social_profile_completed" boolean DEFAULT false NOT NULL,
"is_farming_flagged" boolean DEFAULT false,
"stripe_customer_id" text,
"club_arena_tos_accepted_at" timestamp with time zone,
"bankroll_preferences" jsonb,
"memory_games_preferences" jsonb,
"news_preferences" jsonb,
"video_library_preferences" jsonb,
"memory_elo" integer,
"arena_avatar_url" text,
"equipped_frame" text,
"equipped_aura" text,
"use_avatar_as_profile_pic" boolean DEFAULT false,
"status_text" text,
"player_tags" text[] DEFAULT '{}'::text[],
"vip_lifetime_card_purchase_id" uuid,
"lifetime_vip_since" timestamp with time zone,
"trivia_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
"trivia_preferences_revision" bigint DEFAULT 0 NOT NULL);
CREATE TABLE "table_seats" ("id" uuid DEFAULT uuid_generate_v4() NOT NULL,
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
"terminal_closed_at" timestamp with time zone);
CREATE TABLE "table_waitlist" ("id" uuid DEFAULT gen_random_uuid() NOT NULL,
"table_id" uuid NOT NULL,
"user_id" uuid NOT NULL,
"position" integer DEFAULT 1 NOT NULL,
"status" text DEFAULT 'waiting'::text NOT NULL,
"notified_at" timestamp with time zone,
"created_at" timestamp with time zone DEFAULT now(),
"hold_expires_at" timestamp with time zone);
CREATE TABLE "tables" ("id" uuid DEFAULT gen_random_uuid() NOT NULL,
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
"f06_lifecycle" bigint DEFAULT smarter_private.f06_new_lifecycle() NOT NULL,
"dealing_halted_at" timestamp with time zone,
"dealing_halted_reason" text,
"kill_mode" text DEFAULT 'off'::text NOT NULL,
"kill_threshold_bb" smallint DEFAULT 10 NOT NULL,
"dealing_halt_observed_at" timestamp with time zone);
ALTER TABLE cash_seat_move_receipts ADD PRIMARY KEY(move_id);
CREATE UNIQUE INDEX cash_game_roster_one_live ON cash_game_roster(game_id,user_id) WHERE left_at IS NULL;
ALTER TABLE table_seats ADD UNIQUE(table_id,seat_number);
ALTER TABLE table_seats ADD CONSTRAINT one_committed_seat_per_game_player
 UNIQUE (user_id,active_game_scope) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
CREATE FUNCTION fn_caller_is_engine() RETURNS boolean LANGUAGE sql AS $$SELECT coalesce(current_setting('test.engine',true),'true')='true'$$;
CREATE FUNCTION fn_platform_frozen() RETURNS boolean LANGUAGE sql AS $$SELECT coalesce(current_setting('test.frozen',true),'false')='true'$$;
CREATE FUNCTION fn_entry_purchases_frozen() RETURNS boolean LANGUAGE sql AS $$SELECT public.fn_platform_frozen()$$;
CREATE OR REPLACE FUNCTION public.fn_cash_money_text(p numeric)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN p = trunc(p) THEN trunc(p)::bigint::text
              ELSE to_char(p, 'FM999999990.00') END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_ca_cash_wallet_covers(p_user_id uuid, p_table_id uuid, p_preferred_club uuid, p_amount numeric)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_club uuid;
  v_balance numeric;
BEGIN
  IF p_user_id IS NULL OR p_table_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN true;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id = t.club_id
              WHERE t.id = p_table_id AND c.asset = 'diamonds') THEN
    RETURN true;
  END IF;

  v_club := public.fn_seat_club_for_user(p_user_id, p_table_id, p_preferred_club);
  IF v_club IS NOT NULL THEN
    SELECT m.chip_balance INTO v_balance
      FROM public.club_members m
     WHERE m.user_id = p_user_id AND m.club_id = v_club
       AND m.status IN ('active', 'approved');
    IF COALESCE(v_balance, 0) >= p_amount THEN
      RETURN true;
    END IF;
  END IF;

  RETURN public.fn_ca_cash_paying_club(p_user_id, p_table_id, p_preferred_club, p_amount) IS NOT NULL;
END
$function$
;
CREATE OR REPLACE FUNCTION public.fn_cash_apply_ruleset(p_game_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  g record; s jsonb; v_opts jsonb;
  v_ante text; v_ante_chips numeric; v_vpip integer; v_vpip_window integer;
  v_bomb_on boolean; v_bomb_trigger text; v_bomb_ante integer; v_bomb_boards integer;
  v_min_bb integer; v_max_bb integer;
  v_trigger_mode text; v_interval integer; v_action_secs integer;
  v_rit text; v_rit_mode text; v_rit_on boolean; v_sd boolean;
  v_n integer := 0;
  v_kill_mode text; v_kill_bb smallint;
BEGIN
  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id;
  IF NOT FOUND THEN RETURN 0; END IF;
  s := g.ruleset_snapshot;
  IF s IS NULL THEN RETURN 0; END IF;

  -- The same mapping fn_cash_cluster_open_table applies at open. Kept in
  -- one place by construction: the opener's INSERT and this UPDATE must read
  -- the snapshot identically or a fresh table and a reconciled one disagree.
  v_opts := coalesce(s->'options', '{}'::jsonb);
  v_ante := coalesce(s->>'regular_ante', 'none');
  v_ante_chips := CASE v_ante WHEN 'sb' THEN g.sb WHEN 'bb' THEN g.bb ELSE 0 END;
  v_vpip := coalesce((s->>'vpip_floor')::integer, 0);
  v_vpip_window := coalesce((s->>'vpip_window')::integer, 10);
  v_bomb_on := coalesce((s->'bombs'->>'enabled')::boolean, false);
  v_bomb_trigger := s->'bombs'->>'trigger';
  v_bomb_ante := (s->'bombs'->>'ante_bb')::integer;
  v_bomb_boards := (s->'bombs'->>'boards')::integer;
  v_min_bb := coalesce((s->>'min_buyin_bb')::integer, 40);
  v_max_bb := coalesce((s->>'max_buyin_bb')::integer, 200);
  v_trigger_mode := CASE WHEN v_bomb_on AND v_bomb_trigger = 'timed_15m' THEN 'timed'
                         WHEN v_bomb_on AND v_bomb_trigger = 'every_orbit' THEN 'once_per_orbit'
                         ELSE 'every_n_hands' END;
  v_interval := CASE WHEN v_bomb_on AND v_bomb_trigger = 'timed_15m' THEN 900 ELSE NULL END;
  v_action_secs := LEAST(120, GREATEST(10, coalesce((v_opts->>'action_time_seconds')::integer, 15)));
  -- RUN IT N TIMES (2026-09-09, lane E audit): the opener projects the
  -- snapshot's run_it_n_times as run_it_mode + the three RIT booleans and
  -- this function never did, so the 42 tables adopted at the Gate 7 cutover
  -- kept the old form's answer - four tables of one game offering
  -- run-it-twice and the fifth not. The snapshot only ever says 'opt_in'
  -- today; the other spellings are mapped rather than defaulted so a future
  -- writer cannot land 'none' by accident.
  v_rit := lower(coalesce(s->>'run_it_n_times', 'opt_in'));
  v_rit_mode := CASE v_rit
                  WHEN 'opt_in' THEN 'player_choice'
                  WHEN 'player_choice' THEN 'player_choice'
                  WHEN 'mandatory_twice' THEN 'mandatory_twice'
                  WHEN 'mandatory_three' THEN 'mandatory_three'
                  ELSE 'none' END;
  v_rit_on := v_rit_mode <> 'none';
  -- 7-2 IS A HOLD'EM BOUNTY. The create path guards it ("AND v_v = 'nlh'");
  -- the projection guards it too so no other snapshot writer can put a
  -- seven-deuce bounty on an Omaha table.
  v_sd := coalesce((v_opts->>'seven_deuce_enabled')::boolean, false) AND g.variant = 'nlh';
  -- KILL POTS (kill-v1, 20260924034010). Exactly the opener's projection:
  -- 'off' whenever the kill would be refused at this game's tables, so a
  -- tick never fails on a kill setting and a demoted capability turns the
  -- whole game off together rather than one table at a time.
  v_kill_bb := CASE WHEN (s->'kill'->>'threshold_bb') IN ('8','10','12','15')
                    THEN (s->'kill'->>'threshold_bb')::smallint ELSE 10 END;
  v_kill_mode := lower(coalesce(s->'kill'->>'mode', 'off'));
  IF v_kill_mode NOT IN ('half', 'full') THEN
    v_kill_mode := 'off';
  ELSIF public.fn_kill_pot_configuration_refusal(v_kill_mode, g.variant, 'cash', NULL, v_bomb_on, g.bb, g.club_id) IS NOT NULL THEN
    v_kill_mode := 'off';
  ELSIF NOT public.fn_capability_available('cash.fixed_limit.kill_pots') THEN
    v_kill_mode := 'off';
  END IF;

  UPDATE public.tables t
     SET ante_enabled = v_ante_chips > 0,
         ante = v_ante_chips,
         ante_bb = CASE WHEN v_ante_chips > 0 THEN round(v_ante_chips / g.bb, 4) ELSE 0 END,
         big_blind_ante_enabled = (v_ante = 'bb'),
         nit_game = v_vpip > 0,
         career_percent_min = 0,
         maintain_percent_min = v_vpip,
         maintain_hands = v_vpip_window,
         bomb_pot_enabled = v_bomb_on,
         bomb_pot_trigger_mode = v_trigger_mode,
         bomb_pot_interval_seconds = v_interval,
         bomb_pot_frequency = 0,
         bomb_pot_ante_multiplier = coalesce(v_bomb_ante, 2),
         bomb_pot_board_count = coalesce(v_bomb_boards, 1),
         bomb_pot_double_board = coalesce(v_bomb_boards, 1) >= 2,
         bomb_pot_min_players = 2,
         min_buy_in = round(g.bb * v_min_bb, 2),
         max_buy_in = round(g.bb * v_max_bb, 2),
         -- THE CEILING IS THE GAME'S HANDEDNESS, BUT NEVER BELOW AN
         -- OCCUPIED CHAIR (2026-09-09). Two PLO5 Classic tables carried
         -- max_players 7 on a 6-handed game and one had a player in seat
         -- 7; the ceiling follows the seats down at the first tick AFTER
         -- that chair empties, so nobody is closed out of a seat.
         max_players = GREATEST(g.handedness,
                                coalesce((SELECT max(ts.seat_number) FROM public.table_seats ts
                                           WHERE ts.table_id = t.id AND ts.left_at IS NULL), 0)),
         stakes = public.fn_cash_stakes_label(g.sb, g.bb, g.variant),
         small_blind = g.sb, big_blind = g.bb, game_variant = g.variant,
         straddle_enabled = false, auto_utg_straddle = false, voluntary_straddle = false,
         run_it_mode = v_rit_mode,
         run_it_twice = v_rit_on,
         allow_run_it_twice = v_rit_on,
         run_it_twice_enabled = v_rit_on,
         is_private = coalesce((v_opts->>'is_private')::boolean, false),
         is_vip_only = coalesce((v_opts->>'is_vip_only')::boolean, false),
         is_anonymous = coalesce((v_opts->>'is_anonymous')::boolean, false),
         ban_chat = coalesce((v_opts->>'ban_chat')::boolean, false),
         insurance_enabled = coalesce((v_opts->>'insurance_enabled')::boolean, false),
         seven_deuce_enabled = v_sd,
         seven_deuce_amount = CASE WHEN v_sd THEN 2 ELSE 0 END,
         action_time_seconds = v_action_secs,
         kill_mode = v_kill_mode,
         kill_threshold_bb = v_kill_bb,
         updated_at = now()
   WHERE t.cluster_id = g.id
     AND t.lifecycle <> 'closed'
     AND coalesce(t.is_deleted, false) = false
     AND (
          t.ante_enabled IS DISTINCT FROM (v_ante_chips > 0)
       OR t.ante IS DISTINCT FROM v_ante_chips
       OR t.ante_bb IS DISTINCT FROM (CASE WHEN v_ante_chips > 0 THEN round(v_ante_chips / g.bb, 4) ELSE 0 END)
       OR t.big_blind_ante_enabled IS DISTINCT FROM (v_ante = 'bb')
       OR t.nit_game IS DISTINCT FROM (v_vpip > 0)
       OR t.maintain_percent_min IS DISTINCT FROM v_vpip
       OR t.maintain_hands IS DISTINCT FROM v_vpip_window
       OR t.bomb_pot_enabled IS DISTINCT FROM v_bomb_on
       OR t.bomb_pot_trigger_mode IS DISTINCT FROM v_trigger_mode
       OR t.bomb_pot_interval_seconds IS DISTINCT FROM v_interval
       OR t.bomb_pot_ante_multiplier IS DISTINCT FROM coalesce(v_bomb_ante, 2)
       OR t.bomb_pot_board_count IS DISTINCT FROM coalesce(v_bomb_boards, 1)
       OR t.bomb_pot_double_board IS DISTINCT FROM (coalesce(v_bomb_boards, 1) >= 2)
       OR t.bomb_pot_min_players IS DISTINCT FROM 2
       OR t.min_buy_in IS DISTINCT FROM round(g.bb * v_min_bb, 2)
       OR t.max_buy_in IS DISTINCT FROM round(g.bb * v_max_bb, 2)
       OR t.max_players IS DISTINCT FROM GREATEST(g.handedness,
                                coalesce((SELECT max(ts.seat_number) FROM public.table_seats ts
                                           WHERE ts.table_id = t.id AND ts.left_at IS NULL), 0))
       OR t.stakes IS DISTINCT FROM public.fn_cash_stakes_label(g.sb, g.bb, g.variant)
       OR t.small_blind IS DISTINCT FROM g.sb
       OR t.big_blind IS DISTINCT FROM g.bb
       OR t.game_variant IS DISTINCT FROM g.variant
       OR t.career_percent_min IS DISTINCT FROM 0
       OR coalesce(t.straddle_enabled, false) OR coalesce(t.auto_utg_straddle, false) OR coalesce(t.voluntary_straddle, false)
       OR t.run_it_mode IS DISTINCT FROM v_rit_mode
       OR t.run_it_twice IS DISTINCT FROM v_rit_on
       OR t.allow_run_it_twice IS DISTINCT FROM v_rit_on
       OR t.run_it_twice_enabled IS DISTINCT FROM v_rit_on
       OR t.is_private IS DISTINCT FROM coalesce((v_opts->>'is_private')::boolean, false)
       OR t.is_vip_only IS DISTINCT FROM coalesce((v_opts->>'is_vip_only')::boolean, false)
       OR t.is_anonymous IS DISTINCT FROM coalesce((v_opts->>'is_anonymous')::boolean, false)
       OR t.ban_chat IS DISTINCT FROM coalesce((v_opts->>'ban_chat')::boolean, false)
       OR t.insurance_enabled IS DISTINCT FROM coalesce((v_opts->>'insurance_enabled')::boolean, false)
       OR t.seven_deuce_enabled IS DISTINCT FROM v_sd
       OR t.seven_deuce_amount IS DISTINCT FROM (CASE WHEN v_sd THEN 2 ELSE 0 END)
       OR t.action_time_seconds IS DISTINCT FROM v_action_secs
       OR t.kill_mode IS DISTINCT FROM v_kill_mode
       OR t.kill_threshold_bb IS DISTINCT FROM v_kill_bb
     );
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload)
    VALUES (g.id, 'ruleset_applied',
            jsonb_build_object('tables', v_n, 'vpip_floor', v_vpip, 'vpip_window', v_vpip_window,
                               'ante', v_ante, 'bombs', v_bomb_on, 'bomb_trigger', v_trigger_mode,
                               'rit', v_rit_mode, 'kill', v_kill_mode));
  END IF;
  RETURN v_n;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_cash_cluster_open_table(p_game_id uuid, p_role text, p_main_index integer, p_lifecycle text DEFAULT 'opening'::text, p_created_by uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  g record; s jsonb; v_opts jsonb;
  v_ante text; v_ante_chips numeric; v_vpip integer; v_vpip_window integer;
  v_bomb_on boolean; v_bomb_trigger text; v_bomb_ante integer; v_bomb_boards integer;
  v_min_bb integer; v_max_bb integer; v_name text; v_table_id uuid; v_n integer;
  v_kill_mode text; v_kill_bb smallint;
BEGIN
  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND: %', p_game_id; END IF;
  IF p_role NOT IN ('main', 'feeder') THEN RAISE EXCEPTION 'ROLE_INVALID: %', p_role; END IF;
  IF p_role = 'main' AND (p_main_index IS NULL OR p_main_index < 1) THEN
    RAISE EXCEPTION 'MAIN_INDEX_INVALID: %', p_main_index;
  END IF;
  IF p_lifecycle NOT IN ('opening', 'live') THEN RAISE EXCEPTION 'LIFECYCLE_INVALID: %', p_lifecycle; END IF;

  s := g.ruleset_snapshot;
  v_opts := coalesce(s->'options', '{}'::jsonb);
  v_ante := coalesce(s->>'regular_ante', 'none');
  v_ante_chips := CASE v_ante WHEN 'sb' THEN g.sb WHEN 'bb' THEN g.bb ELSE 0 END;
  v_vpip := coalesce((s->>'vpip_floor')::integer, 0);
  v_vpip_window := coalesce((s->>'vpip_window')::integer, 10);
  v_bomb_on := coalesce((s->'bombs'->>'enabled')::boolean, false);
  v_bomb_trigger := s->'bombs'->>'trigger';
  v_bomb_ante := (s->'bombs'->>'ante_bb')::integer;
  v_bomb_boards := (s->'bombs'->>'boards')::integer;
  v_min_bb := coalesce((s->>'min_buyin_bb')::integer, 40);
  v_max_bb := coalesce((s->>'max_buyin_bb')::integer, 200);
  -- KILL POTS (kill-v1, 20260924034010). The game's snapshot carries
  -- {"kill":{"mode","threshold_bb"}}; fn_cash_apply_ruleset projects the
  -- same two values identically. 'off' whenever the kill would be refused
  -- at this table, so opening a table never fails on a kill setting.
  v_kill_bb := CASE WHEN (s->'kill'->>'threshold_bb') IN ('8','10','12','15')
                    THEN (s->'kill'->>'threshold_bb')::smallint ELSE 10 END;
  v_kill_mode := lower(coalesce(s->'kill'->>'mode', 'off'));
  IF v_kill_mode NOT IN ('half', 'full') THEN
    v_kill_mode := 'off';
  ELSIF public.fn_kill_pot_configuration_refusal(v_kill_mode, g.variant, 'cash', NULL, v_bomb_on, g.bb, g.club_id) IS NOT NULL THEN
    v_kill_mode := 'off';
  ELSIF NOT public.fn_capability_available('cash.fixed_limit.kill_pots') THEN
    v_kill_mode := 'off';
  END IF;

  -- "NLH 1/2 Classic" for Main 1, "NLH 1/2 Classic Main 2", "... Feeder".
  -- LIVE tables only. R3 reopens a closed cluster's one table with the
  -- closed row still present, so an all-time count made a reopened lone
  -- feeder "<game> Feeder" and the lone-feeder guard then stopped the ROLES
  -- step ever renaming it (2026-09-21 remediation).
  SELECT count(*) INTO v_n FROM public.tables WHERE cluster_id = p_game_id
     AND lifecycle <> 'closed' AND coalesce(is_deleted, false) = false;
  v_name := CASE
    WHEN p_role = 'main' AND p_main_index = 1 THEN g.name
    WHEN p_role = 'main' THEN left(g.name, 50) || ' Main ' || p_main_index
    -- the cluster's first table stands for the game, whatever its role
    WHEN v_n = 0 THEN g.name
    ELSE left(g.name, 50) || ' Feeder' END;

  INSERT INTO public.tables (
    club_id, union_id, name, game_type, game_variant, game_mode,
    small_blind, big_blind, stakes,
    max_players, min_buy_in, max_buy_in,
    ante_enabled, ante, ante_bb, big_blind_ante_enabled,
    nit_game, career_percent_min, maintain_percent_min, maintain_hands,
    bomb_pot_enabled, bomb_pot_trigger_mode, bomb_pot_interval_seconds, bomb_pot_frequency,
    bomb_pot_ante_multiplier, bomb_pot_board_count, bomb_pot_double_board, bomb_pot_min_players,
    straddle_enabled, auto_utg_straddle, voluntary_straddle,
    run_it_mode, run_it_twice, allow_run_it_twice, run_it_twice_enabled,
    rake_percent, rake_cap_bb,
    is_private, is_vip_only, is_anonymous, ban_chat, insurance_enabled,
    seven_deuce_enabled, seven_deuce_amount,
    action_time_seconds, auto_start_players,
    auto_extension, auto_restart, auto_create_table,
    status, current_players, created_by,
    cluster_id, role, main_index, lifecycle, opened_at, live_at,
    kill_mode, kill_threshold_bb
  ) VALUES (
    g.club_id, g.union_id, v_name, 'cash', g.variant, 'regular',
    g.sb, g.bb, public.fn_cash_stakes_label(g.sb, g.bb, g.variant),
    g.handedness, round(g.bb * v_min_bb, 2), round(g.bb * v_max_bb, 2),
    -- BIG BLIND ANTE (2026-09-05): 'bb' is the format, not just the size -
    -- the big blind posts one ante for the table. 'sb' is the classic ante,
    -- a small blind from every seat.
    v_ante_chips > 0, v_ante_chips, CASE WHEN v_ante_chips > 0 THEN round(v_ante_chips / g.bb, 4) ELSE 0 END,
    (v_ante = 'bb'),
    v_vpip > 0, 0, v_vpip, v_vpip_window,
    v_bomb_on,
    CASE WHEN v_bomb_on AND v_bomb_trigger = 'timed_15m' THEN 'timed'
         WHEN v_bomb_on AND v_bomb_trigger = 'every_orbit' THEN 'once_per_orbit'
         ELSE 'every_n_hands' END,
    CASE WHEN v_bomb_on AND v_bomb_trigger = 'timed_15m' THEN 900 ELSE NULL END,
    0,
    coalesce(v_bomb_ante, 2), coalesce(v_bomb_boards, 1), coalesce(v_bomb_boards, 1) >= 2, 2,
    false, false, false,
    'player_choice', true, true, true,
    -1, -1,
    coalesce((v_opts->>'is_private')::boolean, false), coalesce((v_opts->>'is_vip_only')::boolean, false),
    coalesce((v_opts->>'is_anonymous')::boolean, false), coalesce((v_opts->>'ban_chat')::boolean, false),
    coalesce((v_opts->>'insurance_enabled')::boolean, false),
    coalesce((v_opts->>'seven_deuce_enabled')::boolean, false),
    CASE WHEN coalesce((v_opts->>'seven_deuce_enabled')::boolean, false) THEN 2 ELSE 0 END,
    LEAST(120, GREATEST(10, coalesce((v_opts->>'action_time_seconds')::integer, 15))), 2,
    -- A cluster table's life is the controller's (Slice 6). A manual (R9)
    -- table's life is the host's. Neither uses the lifecycle-pass flags.
    false, false, false,
    'waiting', 0, coalesce(p_created_by, g.created_by),
    p_game_id, p_role, CASE WHEN p_role = 'main' THEN p_main_index END, p_lifecycle,
    clock_timestamp(), CASE WHEN p_lifecycle = 'live' THEN clock_timestamp() END,
    v_kill_mode, v_kill_bb
  ) RETURNING id INTO v_table_id;

  -- BORN HALTED IN A CLUSTER THAT IS NOT DEALING CASH (2026-09-26).
  IF g.cluster_mode IS DISTINCT FROM 'must_move' THEN
    UPDATE public.tables t
       SET dealing_halted_at = clock_timestamp(),
           dealing_halted_reason = CASE WHEN g.cluster_mode = 'pending_on'
                                        THEN 'lightning_pending_on' ELSE 'lightning' END
     WHERE t.id = v_table_id;
  END IF;

  INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
  VALUES (p_game_id, v_table_id, CASE WHEN p_role = 'feeder' THEN 'feeder_opened' ELSE 'main_opened' END,
          jsonb_build_object('role', p_role, 'main_index', p_main_index, 'lifecycle', p_lifecycle, 'name', v_name));
  RETURN v_table_id;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_cash_seat_move_execute(p_move_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
DECLARE
 initial public.cash_seat_moves%ROWTYPE; partner_initial public.cash_seat_moves%ROWTYPE;
 m public.cash_seat_moves%ROWTYPE; pm public.cash_seat_moves%ROWTYPE;
 source_row public.table_seats%ROWTYPE; partner_source public.table_seats%ROWTYPE;
 destination public.table_seats%ROWTYPE; partner_destination public.table_seats%ROWTYPE;
 outcome jsonb; partner_outcome jsonb; previous jsonb; actor uuid;
BEGIN
 IF NOT coalesce(public.fn_caller_is_engine(),false) THEN
  RAISE EXCEPTION 'Engine authority required' USING ERRCODE='42501';
 END IF;
 SELECT receipt INTO previous FROM public.cash_seat_move_receipts WHERE move_id=p_move_id;
 IF FOUND THEN RETURN previous; END IF;
 PERFORM pg_advisory_xact_lock_shared(530090,1);
 IF public.fn_entry_purchases_frozen() OR public.fn_platform_frozen() THEN
  RETURN jsonb_build_object('ok',false,'reason','platform_frozen');
 END IF;
 SELECT * INTO initial FROM public.cash_seat_moves WHERE id=p_move_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','not_found'); END IF;
 IF initial.swap_move_id IS NOT NULL THEN
  SELECT * INTO partner_initial FROM public.cash_seat_moves WHERE id=initial.swap_move_id;
 END IF;
 -- Same user lock as cashout/buy-in; both swap users are ordered before
 -- game, table, move and seat locks. The planner never acquires user locks.
 FOR actor IN SELECT id FROM (VALUES(initial.player_id),(partner_initial.player_id)) v(id)
   WHERE id IS NOT NULL GROUP BY id ORDER BY id LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:'||actor::text,0));
 END LOOP;
 PERFORM 1 FROM public.cash_games
  WHERE id IN(initial.game_id,partner_initial.game_id) ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.tables
  WHERE id IN(initial.from_table_id,initial.to_table_id,partner_initial.from_table_id,partner_initial.to_table_id)
  ORDER BY id FOR UPDATE;
 PERFORM 1 FROM public.cash_seat_moves
  WHERE id IN(initial.id,partner_initial.id) ORDER BY id FOR UPDATE;
 SELECT receipt INTO previous FROM public.cash_seat_move_receipts WHERE move_id=p_move_id;
 IF FOUND THEN RETURN previous; END IF;
 SELECT * INTO m FROM public.cash_seat_moves WHERE id=p_move_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','not_found'); END IF;
 IF m.swap_move_id IS DISTINCT FROM initial.swap_move_id THEN
  RAISE EXCEPTION 'SEAT_MOVE_PARTNER_CHANGED' USING ERRCODE='55000';
 END IF;
 IF m.state<>'pending' THEN RETURN jsonb_build_object('ok',false,'reason',m.state); END IF;
 IF m.swap_move_id IS NOT NULL THEN
  SELECT * INTO pm FROM public.cash_seat_moves WHERE id=m.swap_move_id;
  IF NOT FOUND OR pm.swap_move_id IS DISTINCT FROM m.id OR pm.game_id<>m.game_id
    OR pm.from_table_id<>m.to_table_id OR pm.to_table_id<>m.from_table_id
    OR pm.player_id=m.player_id THEN
   RAISE EXCEPTION 'SEAT_SWAP_SCOPE_MISMATCH' USING ERRCODE='23514';
  END IF;
 END IF;
 SELECT * INTO source_row FROM public.table_seats
  WHERE occupancy_id=m.source_occupancy_id AND table_id=m.from_table_id AND user_id=m.player_id
    AND seat_number=m.source_seat_number AND left_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN
  UPDATE public.cash_seat_moves SET state='cancelled',note='original_occupancy_gone'
   WHERE id IN(m.id,pm.id) AND state='pending';
  RETURN jsonb_build_object('ok',false,'reason','original_occupancy_gone');
 END IF;
 IF pm.id IS NOT NULL THEN
  SELECT * INTO partner_source FROM public.table_seats
   WHERE occupancy_id=pm.source_occupancy_id AND table_id=pm.from_table_id AND user_id=pm.player_id
    AND seat_number=pm.source_seat_number AND left_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
   UPDATE public.cash_seat_moves SET state='cancelled',note='original_occupancy_gone'
    WHERE id IN(m.id,pm.id) AND state='pending';
   RETURN jsonb_build_object('ok',false,'reason','original_occupancy_gone');
  END IF;
 END IF;
  -- 2026-09-09: a table that closed after the move was planned is not a
 -- scope error, it is a move that can no longer happen. Cancel it like a
 -- source occupancy that has gone, and tell the engine why.
 IF EXISTS(SELECT 1 FROM public.tables
    WHERE id IN(m.from_table_id,m.to_table_id,pm.from_table_id,pm.to_table_id)
      AND (status='closed' OR seat_admission_key='closed')) THEN
  UPDATE public.cash_seat_moves SET state='cancelled',note='table_closed'
   WHERE id IN(m.id,pm.id) AND state='pending';
  RETURN jsonb_build_object('ok',false,'reason','table_closed','move_id',m.id,
    'player_id',m.player_id,'from_table_id',m.from_table_id,'to_table_id',m.to_table_id,
    'source_occupancy_id',m.source_occupancy_id,'source_seat_number',m.source_seat_number);
 END IF;

-- A legacy empty cash destination initializes its derived key inside the
 -- native admission trigger. That trigger still rejects every terminal parent.
 IF NOT EXISTS(SELECT 1 FROM public.tables WHERE id=m.from_table_id AND cluster_id=m.game_id AND tournament_id IS NULL
    AND coalesce(seat_admission_key,'cash')='cash')
  OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=m.to_table_id AND cluster_id=m.game_id AND tournament_id IS NULL
    AND coalesce(seat_admission_key,'cash')='cash') THEN
  RAISE EXCEPTION 'SEAT_MOVE_GAME_SCOPE_MISMATCH' USING ERRCODE='23514';
 END IF;
 IF pm.id IS NULL THEN
  outcome:=public.fn_cash_seat_move_execute_before_maintenance_gate(m.id);
 ELSE
  outcome:=public.fn_cash_seat_swap_execute_before_maintenance_gate(m.id);
 END IF;
 IF outcome->>'ok' IS DISTINCT FROM 'true' THEN
  RETURN outcome||jsonb_build_object('move_id',m.id,'player_id',m.player_id,
    'from_table_id',m.from_table_id,'source_occupancy_id',m.source_occupancy_id,
    'source_seat_number',m.source_seat_number);
 END IF;
 SELECT * INTO destination FROM public.table_seats
  WHERE user_id=m.player_id AND table_id=m.to_table_id
    AND seat_number=(outcome->>'to_seat_number')::integer AND left_at IS NULL;
 IF NOT FOUND OR destination.stack IS DISTINCT FROM source_row.stack
   OR destination.occupancy_id=source_row.occupancy_id
   OR (outcome->>'stack')::numeric IS DISTINCT FROM source_row.stack
   OR EXISTS(SELECT 1 FROM public.table_seats WHERE occupancy_id=source_row.occupancy_id AND left_at IS NULL) THEN
  RAISE EXCEPTION 'SEAT_MOVE_CONSERVATION_FAILED' USING ERRCODE='23514';
 END IF;
 outcome:=outcome||jsonb_build_object('move_id',m.id,'player_id',m.player_id,
  'from_table_id',m.from_table_id,'source_seat_number',m.source_seat_number,
  'source_occupancy_id',m.source_occupancy_id,'destination_occupancy_id',destination.occupancy_id,
  'idempotency_key','seatmove:'||m.id::text,'reason',m.reason);
 IF pm.id IS NOT NULL THEN
  SELECT * INTO partner_destination FROM public.table_seats
   WHERE user_id=pm.player_id AND table_id=pm.to_table_id AND left_at IS NULL;
  IF NOT FOUND OR partner_destination.stack IS DISTINCT FROM partner_source.stack
    OR partner_destination.occupancy_id=partner_source.occupancy_id
    OR EXISTS(SELECT 1 FROM public.table_seats WHERE occupancy_id=partner_source.occupancy_id AND left_at IS NULL) THEN
   RAISE EXCEPTION 'SEAT_SWAP_CONSERVATION_FAILED' USING ERRCODE='23514';
  END IF;
  outcome:=jsonb_set(outcome,'{partner}',coalesce(outcome->'partner','{}'::jsonb)||
    jsonb_build_object('move_id',pm.id,'source_occupancy_id',pm.source_occupancy_id,
      'source_seat_number',pm.source_seat_number,'destination_occupancy_id',partner_destination.occupancy_id));
  partner_outcome:=jsonb_build_object('ok',true,'swap',true,'move_id',pm.id,'player_id',pm.player_id,
    'from_table_id',pm.from_table_id,'source_seat_number',pm.source_seat_number,
    'source_occupancy_id',pm.source_occupancy_id,'destination_occupancy_id',partner_destination.occupancy_id,
    'to_table_id',pm.to_table_id,'to_seat_number',partner_destination.seat_number,
    'stack',partner_source.stack,'reason',pm.reason,'idempotency_key','seatmove:'||pm.id::text,
    'partner',jsonb_build_object('move_id',m.id,'player_id',m.player_id,
      'from_table_id',m.from_table_id,'to_table_id',m.to_table_id,'to_seat_number',destination.seat_number,
      'stack',source_row.stack,'source_occupancy_id',m.source_occupancy_id,
      'source_seat_number',m.source_seat_number,'destination_occupancy_id',destination.occupancy_id));
  INSERT INTO public.cash_seat_move_receipts(move_id,player_id,game_id,club_id,from_table_id,
    from_seat_number,source_occupancy_id,to_table_id,to_seat_number,destination_occupancy_id,amount,receipt)
   VALUES(pm.id,pm.player_id,pm.game_id,partner_source.club_id,pm.from_table_id,
    pm.source_seat_number,pm.source_occupancy_id,pm.to_table_id,partner_destination.seat_number,
    partner_destination.occupancy_id,partner_source.stack,partner_outcome);
 END IF;
 INSERT INTO public.cash_seat_move_receipts(move_id,player_id,game_id,club_id,from_table_id,
    from_seat_number,source_occupancy_id,to_table_id,to_seat_number,destination_occupancy_id,amount,receipt)
  VALUES(m.id,m.player_id,m.game_id,source_row.club_id,m.from_table_id,
    m.source_seat_number,m.source_occupancy_id,m.to_table_id,destination.seat_number,
    destination.occupancy_id,source_row.stack,outcome);
 RETURN outcome;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_cash_seat_move_execute_before_maintenance_gate(p_move_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  m record; src record; dst record; v_seat integer; v_new_id uuid; v_stack numeric;
  v_hold text; v_agreed boolean;
BEGIN
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'frozen');
  END IF;
  SELECT * INTO m FROM public.cash_seat_moves WHERE id = p_move_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF m.state <> 'pending' THEN RETURN jsonb_build_object('ok', false, 'reason', m.state); END IF;
  IF m.expires_at <= clock_timestamp() THEN
    -- EVERY EXPIRY SAYS WHY (2026-09-09). This one is not "the engine never
    -- came" - it came, and the deadline passed between the decision and this
    -- row. Left unnamed it was indistinguishable from every other expiry.
    UPDATE public.cash_seat_moves
       SET state = 'expired', note = 'expired_before_the_executor_reached_it'
     WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'expired');
  END IF;
  IF m.swap_move_id IS NOT NULL THEN
    RETURN public.fn_cash_seat_swap_execute(m.id);
  END IF;

  SELECT * INTO src FROM public.table_seats
   WHERE table_id = m.from_table_id AND user_id = m.player_id AND left_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = 'player_not_seated' WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'player_not_seated');
  END IF;

  IF coalesce(src.stack, 0) <= 0 THEN
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = 'busted' WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'busted');
  END IF;

  SELECT * INTO dst FROM public.tables WHERE id = m.to_table_id FOR UPDATE;
  IF NOT FOUND OR dst.status NOT IN ('waiting', 'running', 'active') OR dst.lifecycle IN ('breaking', 'closed') THEN
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = 'destination_unavailable' WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_unavailable');
  END IF;

  SELECT gs INTO v_seat FROM generate_series(1, coalesce(dst.max_players, 9)) gs
   WHERE NOT EXISTS (SELECT 1 FROM public.table_seats ts
                      WHERE ts.table_id = dst.id AND ts.seat_number = gs AND ts.left_at IS NULL)
   ORDER BY gs LIMIT 1;
  IF v_seat IS NULL THEN
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = 'destination_full' WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_full');
  END IF;

  v_stack := src.stack;

  v_hold := CASE WHEN m.reason = 'seat_change' THEN 'waiting' ELSE 'moved' END;
  v_agreed := (m.reason = 'seat_change');

  PERFORM set_config('app.cash_seat_move', 'on', true);

  -- PRESENCE FOLLOWS THE PLAYER (2026-09-05). is_sitting_out / sit_out_at used
  -- to be written false/NULL here, so a player sitting out at the feeder was
  -- dealt into the first hand at the new table. Carried now, with the ORIGINAL
  -- sit_out_at, so the 5-minute eviction clock is the same clock.
  BEGIN
    UPDATE public.table_seats
       SET user_id = src.user_id, member_id = src.member_id, stack = v_stack,
           is_sitting_out = coalesce(src.is_sitting_out, false), sit_out_at = src.sit_out_at,
           is_away = coalesce(src.is_away, false),
           joined_at = src.joined_at,
           horse_id = src.horse_id, status = 'active', leave_pending = false,
           auto_rebuy = src.auto_rebuy, time_bank_remaining = src.time_bank_remaining,
           time_bank_uses_remaining = src.time_bank_uses_remaining, club_id = src.club_id,
           entry_hold = v_hold, entry_post_agreed = v_agreed, left_at = NULL
     WHERE table_id = dst.id AND seat_number = v_seat AND left_at IS NOT NULL
     RETURNING id INTO v_new_id;
    IF v_new_id IS NULL THEN
      INSERT INTO public.table_seats
        (table_id, seat_number, user_id, member_id, stack, is_sitting_out, is_away, sit_out_at, joined_at,
         horse_id, status, leave_pending, auto_rebuy, time_bank_remaining, time_bank_uses_remaining,
         club_id, entry_hold, entry_post_agreed)
      VALUES
        (dst.id, v_seat, src.user_id, src.member_id, v_stack,
         coalesce(src.is_sitting_out, false), coalesce(src.is_away, false), src.sit_out_at, src.joined_at,
         src.horse_id, 'active', false, src.auto_rebuy, src.time_bank_remaining, src.time_bank_uses_remaining,
         src.club_id, v_hold, v_agreed)
      RETURNING id INTO v_new_id;
    END IF;
    UPDATE public.table_seats SET stack = 0 WHERE id = src.id;
    UPDATE public.table_seats SET left_at = clock_timestamp(), leave_pending = false, status = 'left'
     WHERE id = src.id;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.cash_seat_move', '', true);
    -- A TRANSIENT FAILURE IS NOT A REFUSAL (2026-09-07). 40P01 deadlock,
    -- 55P03 lock timeout and 40001 serialization all mean "try again", and
    -- cancelling for them also puts the player under the planner's 60 second
    -- back-off. The move stays pending; the next hand boundary retries it,
    -- bounded by its own expires_at.
    IF SQLSTATE IN ('40P01', '55P03', '40001') THEN
      UPDATE public.cash_seat_moves
         SET note = left('retry after ' || SQLSTATE || ': ' || SQLERRM, 200)
       WHERE id = m.id;
      RETURN jsonb_build_object('ok', false, 'reason', 'transient',
                                'retry', true, 'detail', left(SQLERRM, 200));
    END IF;
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = left(SQLERRM, 200) WHERE id = m.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_refused', 'detail', left(SQLERRM, 200));
  END;
  PERFORM set_config('app.cash_seat_move', '', true);

  /* A RE-POINT IS NOT ALLOWED TO COLLIDE (2026-09-10). This UPDATE moves
     the open session from the source table to the destination. If the
     player already holds an OPEN session on the destination - a leftover
     from an earlier stay there that was never closed - the re-point makes
     two rows with (player_id, 'table', dst) both closed_at IS NULL and
     violates cash_player_session_one_open. The whole post-hand leave_pending
     step then throws and the player does not leave. Measured 2026-09-10:
     1,091 of 4,751 seat moves in six hours had the destination already
     carrying an open session, and 34 hands in 83 minutes failed this way.
     The SOURCE session is the live one - it carries the stay clock for the
     seat being moved - so the leftover is closed and the live one re-points. */
  UPDATE public.cash_player_session
     SET closed_at = clock_timestamp(), closed_reason = 'superseded_by_move'
   WHERE player_id = m.player_id AND scope_type = 'table' AND scope_id = dst.id AND closed_at IS NULL;

  UPDATE public.cash_player_session
     SET scope_id = dst.id, table_id = dst.id
   WHERE player_id = m.player_id AND scope_type = 'table' AND scope_id = m.from_table_id AND closed_at IS NULL;

  UPDATE public.tables t SET current_players =
    (SELECT count(*) FROM public.table_seats ts WHERE ts.table_id = t.id AND ts.left_at IS NULL)
   WHERE t.id IN (m.from_table_id, m.to_table_id);
  UPDATE public.cash_seat_moves
     SET state = 'done', executed_at = clock_timestamp(), to_seat_number = v_seat
   WHERE id = m.id;
  INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
  VALUES (m.game_id, m.to_table_id, 'seat_moved',
          jsonb_build_object('player_id', m.player_id, 'from_table_id', m.from_table_id,
                             'to_seat', v_seat, 'stack', v_stack, 'reason', m.reason));

  RETURN jsonb_build_object('ok', true, 'to_table_id', m.to_table_id, 'to_seat_number', v_seat, 'stack', v_stack,
                            'reason', m.reason);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_cash_seat_swap_execute(p_move_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '30s'
AS $function$
BEGIN
 RETURN public.fn_cash_seat_move_execute(p_move_id);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_cash_seat_swap_execute_before_maintenance_gate(p_move_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  m record; pm record; a record; b record; ta record; tb record;
  v_stack_a numeric; v_stack_b numeric; v_now timestamptz := clock_timestamp();
BEGIN
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'frozen');
  END IF;
  PERFORM 1 FROM public.cash_seat_moves
   WHERE id IN (p_move_id, (SELECT swap_move_id FROM public.cash_seat_moves WHERE id = p_move_id))
   ORDER BY id FOR UPDATE;
  SELECT * INTO m FROM public.cash_seat_moves WHERE id = p_move_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF m.state <> 'pending' THEN RETURN jsonb_build_object('ok', false, 'reason', m.state); END IF;
  SELECT * INTO pm FROM public.cash_seat_moves WHERE id = m.swap_move_id;
  IF NOT FOUND OR pm.state <> 'pending' OR pm.expires_at <= v_now OR m.expires_at <= v_now THEN
    -- EACH SIDE NAMES ITS OWN CAUSE (2026-09-09). This used to write
    -- 'swap_partner_gone' on both rows whatever had actually happened, so a
    -- move that timed out on its own deadline blamed the other player, and a
    -- partner that was still pending and still inside its deadline was
    -- recorded as `expired`. A count of expiries was not a count of expiries.
    UPDATE public.cash_seat_moves SET state = CASE WHEN m.expires_at <= v_now THEN 'expired' ELSE 'cancelled' END,
           note = CASE WHEN m.expires_at <= v_now THEN 'own_ttl_expired'
                       WHEN pm.id IS NULL THEN 'swap_partner_gone'
                       WHEN pm.expires_at <= v_now THEN 'swap_partner_expired'
                       ELSE 'swap_partner_gone' END
     WHERE id = m.id;
    IF pm.id IS NOT NULL AND pm.state = 'pending' THEN
      -- The partner is alive: it did not expire, this side did. It is
      -- CANCELLED, and the note says which.
      UPDATE public.cash_seat_moves
         SET state = CASE WHEN pm.expires_at <= v_now THEN 'expired' ELSE 'cancelled' END,
             note = CASE WHEN pm.expires_at <= v_now THEN 'own_ttl_expired' ELSE 'swap_partner_expired' END
       WHERE id = pm.id;
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'swap_partner_gone');
  END IF;

  SELECT * INTO a FROM public.table_seats
   WHERE table_id = m.from_table_id AND user_id = m.player_id AND left_at IS NULL FOR UPDATE;
  SELECT * INTO b FROM public.table_seats
   WHERE table_id = pm.from_table_id AND user_id = pm.player_id AND left_at IS NULL FOR UPDATE;
  IF a.id IS NULL OR b.id IS NULL OR coalesce(a.stack, 0) <= 0 OR coalesce(b.stack, 0) <= 0 THEN
    UPDATE public.cash_seat_moves SET state = 'cancelled',
           note = CASE WHEN a.id IS NULL THEN 'player_not_seated' WHEN coalesce(a.stack, 0) <= 0 THEN 'busted' ELSE 'swap_partner_gone' END
     WHERE id = m.id;
    UPDATE public.cash_seat_moves SET state = 'cancelled',
           note = CASE WHEN b.id IS NULL THEN 'player_not_seated' WHEN coalesce(b.stack, 0) <= 0 THEN 'busted' ELSE 'swap_partner_gone' END
     WHERE id = pm.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'swap_cancelled');
  END IF;
  SELECT * INTO ta FROM public.tables WHERE id = m.to_table_id;
  SELECT * INTO tb FROM public.tables WHERE id = pm.to_table_id;
  -- BOTH DESTINATIONS MUST EXIST AND BE OPEN BY STATUS AS WELL (F4, 2026-09-10).
  -- On a record that was never found `ta.lifecycle IN (...)` is NULL, so a
  -- destination that vanished used to pass this test. The single-move gate
  -- has always read status too; this is the same predicate.
  IF ta.id IS NULL OR tb.id IS NULL
     OR ta.lifecycle IN ('breaking', 'closed') OR tb.lifecycle IN ('breaking', 'closed')
     OR ta.status NOT IN ('waiting', 'running', 'active')
     OR tb.status NOT IN ('waiting', 'running', 'active') THEN
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = 'destination_unavailable' WHERE id IN (m.id, pm.id);
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_unavailable');
  END IF;

  IF m.ready_at IS NULL THEN
    UPDATE public.cash_seat_moves SET ready_at = v_now WHERE id = m.id;
  END IF;
  IF pm.ready_at IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'waiting_partner', 'held', true,
                              'to_table_id', m.to_table_id, 'partner_id', pm.player_id);
  END IF;

  -- Each side carries its OWN sit-out across, for the reason written on
  -- fn_cash_seat_move_execute: neither player asked to be dealt into a hand
  -- they had sat out of.
  v_stack_a := a.stack; v_stack_b := b.stack;
  PERFORM set_config('app.cash_seat_move', 'on', true);
  BEGIN
    UPDATE public.table_seats SET stack = 0 WHERE id IN (a.id, b.id);
    UPDATE public.table_seats SET left_at = v_now, leave_pending = false, status = 'left' WHERE id IN (a.id, b.id);
    UPDATE public.table_seats
       SET user_id = a.user_id, member_id = a.member_id, stack = v_stack_a,
           is_sitting_out = coalesce(a.is_sitting_out, false), sit_out_at = a.sit_out_at,
           is_away = coalesce(a.is_away, false),
           joined_at = a.joined_at, horse_id = a.horse_id, status = 'active', leave_pending = false,
           auto_rebuy = a.auto_rebuy, time_bank_remaining = a.time_bank_remaining,
           time_bank_uses_remaining = a.time_bank_uses_remaining, club_id = a.club_id,
           entry_hold = 'waiting', entry_post_agreed = true, left_at = NULL
     WHERE id = b.id;
    UPDATE public.table_seats
       SET user_id = b.user_id, member_id = b.member_id, stack = v_stack_b,
           is_sitting_out = coalesce(b.is_sitting_out, false), sit_out_at = b.sit_out_at,
           is_away = coalesce(b.is_away, false),
           joined_at = b.joined_at, horse_id = b.horse_id, status = 'active', leave_pending = false,
           auto_rebuy = b.auto_rebuy, time_bank_remaining = b.time_bank_remaining,
           time_bank_uses_remaining = b.time_bank_uses_remaining, club_id = b.club_id,
           entry_hold = 'waiting', entry_post_agreed = true, left_at = NULL
     WHERE id = a.id;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.cash_seat_move', '', true);
    UPDATE public.cash_seat_moves SET state = 'cancelled', note = left(SQLERRM, 200) WHERE id IN (m.id, pm.id);
    RETURN jsonb_build_object('ok', false, 'reason', 'destination_refused', 'detail', left(SQLERRM, 200));
  END;
  PERFORM set_config('app.cash_seat_move', '', true);

  /* A RE-POINT IS NOT ALLOWED TO COLLIDE (2026-09-10) - see the move path
     for the measurement. A swap re-points BOTH players, so both need it. */
  UPDATE public.cash_player_session
     SET closed_at = clock_timestamp(), closed_reason = 'superseded_by_swap'
   WHERE player_id = m.player_id AND scope_type = 'table' AND scope_id = m.to_table_id AND closed_at IS NULL;
  UPDATE public.cash_player_session SET scope_id = m.to_table_id, table_id = m.to_table_id
   WHERE player_id = m.player_id AND scope_type = 'table' AND scope_id = m.from_table_id AND closed_at IS NULL;
  UPDATE public.cash_player_session
     SET closed_at = clock_timestamp(), closed_reason = 'superseded_by_swap'
   WHERE player_id = pm.player_id AND scope_type = 'table' AND scope_id = pm.to_table_id AND closed_at IS NULL;
  UPDATE public.cash_player_session SET scope_id = pm.to_table_id, table_id = pm.to_table_id
   WHERE player_id = pm.player_id AND scope_type = 'table' AND scope_id = pm.from_table_id AND closed_at IS NULL;

  UPDATE public.cash_seat_moves SET state = 'done', executed_at = v_now, to_seat_number = b.seat_number WHERE id = m.id;
  UPDATE public.cash_seat_moves SET state = 'done', executed_at = v_now, to_seat_number = a.seat_number WHERE id = pm.id;
  INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
  VALUES (m.game_id, m.to_table_id, 'seat_moved',
          jsonb_build_object('player_id', m.player_id, 'from_table_id', m.from_table_id, 'to_seat', b.seat_number,
                             'stack', v_stack_a, 'reason', 'seat_change', 'swap', true)),
         (pm.game_id, pm.to_table_id, 'seat_moved',
          jsonb_build_object('player_id', pm.player_id, 'from_table_id', pm.from_table_id, 'to_seat', a.seat_number,
                             'stack', v_stack_b, 'reason', 'seat_change', 'swap', true));
  RETURN jsonb_build_object('ok', true, 'swap', true, 'to_table_id', m.to_table_id, 'to_seat_number', b.seat_number,
                            'stack', v_stack_a,
                            'partner', jsonb_build_object('player_id', pm.player_id, 'from_table_id', pm.from_table_id,
                                                          'to_table_id', pm.to_table_id, 'to_seat_number', a.seat_number,
                                                          'stack', v_stack_b));
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_cash_stakes_label(p_sb numeric, p_bb numeric, p_variant text DEFAULT 'nlh'::text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN lower(coalesce(p_variant, 'nlh')) IN ('flh', 'flo8')
              THEN public.fn_cash_money_text(p_bb) || '/' || public.fn_cash_money_text(p_bb * 2)
              ELSE public.fn_cash_money_text(p_sb) || '/' || public.fn_cash_money_text(p_bb) END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_cash_template_defaults(p_template text, p_variant text)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t text := lower(coalesce(p_template, 'classic'));
  v_v text := lower(coalesce(p_variant, 'nlh'));
  v_family text;
  v_seats integer; v_seats_locked boolean; v_seat_choices integer[];
  v_vpip integer; v_vpip_window integer;
BEGIN
  IF v_t NOT IN ('classic', 'action', 'madness') THEN
    RAISE EXCEPTION 'TEMPLATE_UNKNOWN: %', p_template;
  END IF;

  v_family := CASE
    WHEN v_v IN ('plo4','plo5','plo6','plo8','flo8') THEN 'plo'
    WHEN v_v = 'short_deck' THEN 'shortdeck'
    WHEN v_v = 'pineapple' THEN 'pineapple'
    ELSE 'holdem' END;

  IF v_family = 'plo' THEN
    v_seats := 6; v_seats_locked := true; v_seat_choices := ARRAY[6];
  ELSIF v_family = 'holdem' THEN
    IF v_t = 'classic' THEN v_seats := 9; v_seat_choices := ARRAY[9, 6];
    ELSE v_seats := 6; v_seat_choices := ARRAY[2,3,4,5,6,7,8,9]; END IF;
    v_seats_locked := false;
  ELSE
    v_seats := 6; v_seats_locked := false; v_seat_choices := ARRAY[2,3,4,5,6,7,8];
  END IF;

  -- VPIP floor per template (percent), FLAT ACROSS FAMILIES (Dan 2026-09-05).
  v_vpip := CASE v_t
    WHEN 'classic' THEN 0
    WHEN 'action'  THEN 30
    ELSE                50 END;
  v_vpip_window := 10;

  RETURN jsonb_build_object(
    'template', v_t,
    'variant', v_v,
    'family', v_family,
    'seats', v_seats,
    'seats_locked', v_seats_locked,
    'seat_choices', to_jsonb(v_seat_choices),
    'min_buyin_bb', CASE v_t WHEN 'classic' THEN 40 WHEN 'action' THEN 50 ELSE 100 END,
    'max_buyin_bb', 200,
    'regular_ante', CASE v_t WHEN 'classic' THEN 'none' WHEN 'action' THEN 'sb' ELSE 'bb' END,
    'vpip_floor', v_vpip,
    'vpip_window', v_vpip_window,
    'bombs', jsonb_build_object(
      'enabled', v_t <> 'classic',
      'trigger', CASE v_t WHEN 'action' THEN 'timed_15m' WHEN 'madness' THEN 'every_orbit' ELSE NULL END,
      'ante_bb', CASE v_t WHEN 'action' THEN 2 WHEN 'madness' THEN 3 ELSE NULL END,
      'boards', CASE WHEN v_t = 'classic' THEN NULL ELSE 2 END),
    'straddle', false,
    'stay_clock_min', 10,
    'rejoin_window_min', 120,
    'run_it_n_times', 'opt_in',
    'rake', 'existing'
  );
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_buyin(p_user_id uuid, p_table_id uuid, p_seat_number integer, p_amount numeric, p_auto_rebuy boolean, p_club_id uuid, p_idempotency_key uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
 v_t public.tables%ROWTYPE;
 v_seat_id uuid:=gen_random_uuid();
 v_custody jsonb;
 v_taken integer;
 v_holds integer;
BEGIN
 IF p_idempotency_key IS NULL OR p_user_id IS NULL OR p_table_id IS NULL
    OR p_seat_number IS NULL OR p_seat_number<1 OR p_auto_rebuy IS DISTINCT FROM false
    OR p_amount IS NULL OR p_amount NOT BETWEEN 1 AND 2147483647
    OR p_amount<>trunc(p_amount) THEN
   RAISE EXCEPTION 'invalid_diamond_cash_purchase' USING ERRCODE='22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('table_cap:'||p_user_id,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('table_seat:'||p_table_id,0));
 SELECT t.* INTO v_t FROM public.tables t
   JOIN public.clubs c ON c.id=t.club_id
   JOIN public.ca_arena_settings a ON a.id=1 AND a.club_id=c.id
 WHERE t.id=p_table_id AND c.asset='diamonds' AND c.is_platform IS TRUE
   AND c.union_id IS NULL AND t.union_id IS NULL AND a.cash_games_enabled
 FOR UPDATE OF t;
 IF NOT FOUND THEN
   RAISE EXCEPTION 'diamond_cash_not_open' USING ERRCODE='55000';
 END IF;
 IF NOT public.fn_poker_diamond_plain_cash_table(v_t) THEN
   RAISE EXCEPTION 'diamond_plain_cash_table_required' USING ERRCODE='23514';
 END IF;
 -- Match the shared engine load boundary before reserving any Diamonds.
 IF EXISTS(SELECT 1 FROM (VALUES(v_t.small_blind),(v_t.big_blind),
      (v_t.min_buy_in),(v_t.max_buy_in)) AS amount(value)
      WHERE value IS NULL OR value NOT BETWEEN 1 AND 2147483647
        OR value<>trunc(value))
    OR COALESCE(v_t.ante,0) NOT BETWEEN 0 AND 9007199254740991
    OR COALESCE(v_t.ante,0)<>trunc(COALESCE(v_t.ante,0)) THEN
   RAISE EXCEPTION 'diamond_cash_requires_whole_amounts' USING ERRCODE='23514';
 END IF;
 IF coalesce(v_t.bomb_pot_enabled,false) THEN
   IF coalesce(lower(v_t.bomb_pot_variant),'') NOT IN ('','nlh') THEN
     RAISE EXCEPTION 'diamond_bomb_pot_requires_the_table_game' USING ERRCODE='23514';
   END IF;
   IF NOT EXISTS(SELECT 1 FROM (SELECT CASE
          WHEN coalesce(v_t.bomb_pot_ante_fixed,0)>0 THEN v_t.bomb_pot_ante_fixed
          ELSE v_t.big_blind*coalesce(v_t.bomb_pot_ante_multiplier,2) END AS a) x
        WHERE x.a IS NOT NULL AND x.a BETWEEN 1 AND 2147483647 AND x.a=trunc(x.a)) THEN
     RAISE EXCEPTION 'diamond_bomb_pot_requires_a_whole_ante' USING ERRCODE='23514';
   END IF;
 END IF;
 IF p_club_id IS NOT NULL AND p_club_id<>v_t.club_id THEN
   RAISE EXCEPTION 'diamond_purchase_arena_mismatch' USING ERRCODE='22023';
 END IF;
 IF v_t.max_players IS NULL OR p_seat_number>v_t.max_players THEN
   RAISE EXCEPTION 'TABLE_SIZE: invalid Diamond seat' USING ERRCODE='22023';
 END IF;
 IF EXISTS(SELECT 1 FROM public.blacklists WHERE user_id=p_user_id
     AND club_id=v_t.club_id AND (expires_at IS NULL OR expires_at>now())) THEN
   RAISE EXCEPTION 'Banned from this club' USING ERRCODE='42501';
 END IF;
 IF coalesce(v_t.is_vip_only,false) AND NOT EXISTS(
    SELECT 1 FROM public.profiles p WHERE p.id=p_user_id AND p.is_vip IS TRUE
      AND (p.vip_expires_at IS NULL OR p.vip_expires_at>now())) THEN
   RAISE EXCEPTION 'VIP_ONLY: this table requires VIP membership' USING ERRCODE='42501';
 END IF;
 IF EXISTS(SELECT 1 FROM public.table_seats WHERE table_id=p_table_id AND left_at IS NULL
           AND (user_id=p_user_id OR seat_number=p_seat_number)) THEN
   RAISE EXCEPTION 'Diamond seat or player is already seated' USING ERRCODE='23505';
 END IF;
 SELECT count(*) INTO v_taken FROM public.table_seats
   WHERE table_id=p_table_id AND left_at IS NULL;
 SELECT count(*) INTO v_holds FROM public.table_waitlist
   WHERE table_id=p_table_id AND status='notified' AND user_id<>p_user_id
     AND coalesce(hold_expires_at,notified_at+interval '60 seconds')>now();
 IF v_taken>=v_t.max_players OR v_taken+v_holds>=v_t.max_players THEN
   RAISE EXCEPTION 'SEAT_RESERVED: table capacity is taken or held' USING ERRCODE='55000';
 END IF;
 IF (SELECT count(*) FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
     WHERE s.user_id=p_user_id AND s.left_at IS NULL AND t.tournament_id IS NULL
       AND t.status NOT IN ('closed','deleted'))>=4 THEN
   RAISE EXCEPTION 'TABLE_CAP_REACHED: already seated at four cash tables' USING ERRCODE='55000';
 END IF;

 v_custody:=public.fn_poker_diamond_reserve(p_user_id,'cash_seat',p_table_id,
   'seat:'||v_seat_id,p_amount,p_idempotency_key);
 PERFORM set_config('app.money_path','atomic_table_buyin',true);
 DELETE FROM public.table_seats WHERE table_id=p_table_id
   AND seat_number=p_seat_number AND left_at IS NOT NULL;
 INSERT INTO public.table_seats(id,table_id,seat_number,user_id,stack,status,auto_rebuy,club_id)
   VALUES(v_seat_id,p_table_id,p_seat_number,p_user_id,p_amount,'active',false,v_t.club_id);
 -- The after-insert binder sees the final occupancy stamped by the shared trigger.
 IF NOT EXISTS(SELECT 1 FROM public.poker_diamond_custody c
     JOIN public.table_seats s ON s.id=c.seat_id AND s.joined_at=c.seat_joined_at
       AND s.occupancy_id=c.occupancy_id
     WHERE c.id=(v_custody->>'custody_id')::uuid AND c.state='active'
       AND s.id=v_seat_id AND s.left_at IS NULL AND s.stack=c.balance) THEN
   RAISE EXCEPTION 'diamond_seat_custody_binding_failed' USING ERRCODE='23514';
 END IF;
 UPDATE public.table_waitlist SET status='seated'
   WHERE table_id=p_table_id AND user_id=p_user_id AND status IN ('waiting','notified');
 UPDATE public.tables SET current_players=(
   SELECT count(*) FROM public.table_seats WHERE table_id=p_table_id AND left_at IS NULL)
   WHERE id=p_table_id;
END $function$
;
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_cash_variant(p_variant text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  /* NULL-SAFE ON PURPOSE. `NULL IN (...)` is NULL, not false, so without the
     first clause an unset `game_variant` made the whole plain-cash rule return
     NULL rather than false: a row that is neither admitted nor refused. Every
     caller today happens to treat unknown as refusal, which is exactly the
     kind of accident that holds until one of them writes `IF fn(...) = false`.
     An unset game is not a game. */
  SELECT p_variant IS NOT NULL
     AND p_variant IN ('nlh','plo4','plo5','plo6','plo8','pineapple','short_deck','flh','flo8');
$function$
;
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_open_cash_table(p_name text, p_small_blind integer, p_big_blind integer, p_min_buy_in integer, p_max_buy_in integer, p_max_players integer DEFAULT 6, p_game_variant text DEFAULT 'nlh'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_arena uuid;
  v_table uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '28000';
  END IF;

  -- Platform staff only. The estate already has one answer to this question and
  -- it is fn_is_platform_admin(); never re-derive a role list.
  IF NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'diamond_table_staff_only' USING ERRCODE = '42501';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'diamond_staff_session_required' USING ERRCODE = '28000';
  END IF;

  SELECT c.id INTO v_arena
  FROM public.clubs c
  WHERE c.asset = 'diamonds' AND c.is_platform = true AND c.union_id IS NULL
  LIMIT 1;

  IF v_arena IS NULL THEN
    RAISE EXCEPTION 'diamond_arena_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF p_small_blind IS NULL OR p_big_blind IS NULL
     OR p_min_buy_in IS NULL OR p_max_buy_in IS NULL
     OR p_small_blind <= 0 OR p_big_blind <= 0
     OR p_min_buy_in <= 0 OR p_max_buy_in <= 0
     OR p_small_blind > p_big_blind
     OR p_min_buy_in > p_max_buy_in
     OR p_big_blind > p_min_buy_in
     OR p_max_buy_in > 2147483647
  THEN
    RAISE EXCEPTION 'diamond_table_requires_whole_positive_stakes' USING ERRCODE = '22023';
  END IF;

  IF p_max_players IS NULL OR p_max_players < 2 OR p_max_players > 10 THEN
    RAISE EXCEPTION 'diamond_table_requires_a_real_seat_count' USING ERRCODE = '22023';
  END IF;

  -- The door names the game, and refuses one this arena does not deal rather
  -- than opening a table the engine would then refuse to load.
  IF p_game_variant IS NULL OR NOT public.fn_poker_diamond_cash_variant(p_game_variant) THEN
    RAISE EXCEPTION 'diamond_table_requires_a_supported_game' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.tables (
    club_id, union_id, tournament_id, cluster_id,
    name, game_type, game_variant, status, max_players,
    small_blind, big_blind, ante,
    min_buy_in, max_buy_in,
    rake_percent, rake_cap_bb, bbj_percent,
    is_template, insurance_enabled, bomb_pot_enabled,
    run_it_twice, allow_run_it_twice, run_it_twice_enabled,
    straddle_enabled, auto_utg_straddle, voluntary_straddle,
    seven_deuce_enabled, nit_game, all_in_or_fold, pineapple_holdem, cap_enabled,
    created_by
  ) VALUES (
    v_arena, NULL, NULL, NULL,
    coalesce(nullif(btrim(p_name), ''), 'Diamond Cash'), 'cash', p_game_variant,
    'waiting', p_max_players,
    p_small_blind, p_big_blind, 0,
    p_min_buy_in, p_max_buy_in,
    0, 0, 0,
    false, false, false,
    false, false, false,
    false, false, false,
    false, false, false, false, false,
    v_actor
  )
  RETURNING id INTO v_table;

  -- The row this door just wrote must be one the engine will admit. A door
  -- that can open a table nobody can sit at is worse than no door.
  IF NOT EXISTS (
    SELECT 1 FROM public.tables t
     WHERE t.id = v_table AND public.fn_poker_diamond_plain_cash_table(t)
  ) THEN
    RAISE EXCEPTION 'diamond_table_would_not_be_admitted' USING ERRCODE = '23514';
  END IF;

  -- DIAMOND PHASE 10: on the record - the operator on the row (created_by,
  -- above) and one audit row holding the table as it was opened.
  PERFORM public.fn_poker_diamond_staff_audit('diamond.table_open', 'diamond_table', v_table, NULL,
    (SELECT to_jsonb(t) FROM public.tables t WHERE t.id = v_table),
    jsonb_build_object('door', 'fn_poker_diamond_open_cash_table'));

  RETURN v_table;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_plain_cash_table(p_t tables)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT NOT (
    NOT public.fn_poker_diamond_cash_variant(p_t.game_variant)
    OR p_t.tournament_id IS NOT NULL
    OR p_t.cluster_id IS NOT NULL
    OR coalesce(p_t.is_template,false)
    OR p_t.status NOT IN ('waiting','running','playing','active')
    OR p_t.rake_percent IS DISTINCT FROM 0 OR p_t.rake_cap_bb IS DISTINCT FROM 0
    OR p_t.bbj_percent IS DISTINCT FROM 0
    OR coalesce(p_t.insurance_enabled,false)
    OR p_t.run_it_twice IS NULL OR p_t.allow_run_it_twice IS NULL
    OR coalesce(p_t.seven_deuce_enabled,false) OR coalesce(p_t.nit_game,false)
    OR coalesce(p_t.all_in_or_fold,false) OR coalesce(p_t.pineapple_holdem,false)
    OR coalesce(p_t.cap_enabled,false)
  );
$function$
;
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_seat_keeps_custody()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_ids uuid[];
BEGIN
 IF TG_OP='INSERT' THEN v_ids:=ARRAY[NEW.id];
 ELSIF TG_OP='DELETE' THEN v_ids:=ARRAY[OLD.id];
 ELSE v_ids:=ARRAY[OLD.id,NEW.id]; END IF;
 IF EXISTS (
   SELECT 1 FROM public.poker_diamond_custody c
   WHERE c.seat_id=ANY(v_ids) AND c.state='active' AND c.purpose='cash_seat'
     AND NOT EXISTS(SELECT 1 FROM public.table_seats s
       WHERE s.id=c.seat_id AND s.joined_at=c.seat_joined_at
         AND s.occupancy_id=c.occupancy_id AND s.user_id=c.user_id
         AND s.table_id=c.target_id AND s.club_id=c.arena_id
         AND s.left_at IS NULL AND s.stack=c.balance)
 ) OR EXISTS(
   SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
     JOIN public.clubs a ON a.id=t.club_id
   WHERE s.id=ANY(v_ids) AND a.asset='diamonds' AND s.left_at IS NULL
     AND t.tournament_id IS NULL
     AND NOT EXISTS(SELECT 1 FROM public.poker_diamond_custody c
       WHERE c.seat_id=s.id AND c.seat_joined_at=s.joined_at AND c.occupancy_id=s.occupancy_id
         AND c.user_id=s.user_id AND c.target_id=s.table_id AND c.arena_id=s.club_id
         AND c.purpose='cash_seat' AND c.state='active' AND c.balance=s.stack)
 ) THEN
   RAISE EXCEPTION 'diamond_seat_and_custody_must_commit_together' USING ERRCODE='23514';
 END IF;
 /* A DIAMOND TOURNAMENT SEAT HOLDS AN ENTRY, NOT A BALANCE. The stack is a
    nonredeemable play unit and bears no relation to custody, so nothing in
    this arm compares it to anything. What must be true at every commit is that
    the seat is covered by a live funded entry for THIS event, held against the
    tournament and not against the seat. */
 IF EXISTS(
   SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
     JOIN public.clubs a ON a.id=t.club_id
   WHERE s.id=ANY(v_ids) AND a.asset='diamonds' AND s.left_at IS NULL
     AND t.tournament_id IS NOT NULL
     AND NOT EXISTS(SELECT 1 FROM public.poker_diamond_custody c
       WHERE c.user_id=s.user_id AND c.target_id=t.tournament_id AND c.arena_id=s.club_id
         AND c.purpose='tournament_entry' AND c.state='active' AND c.seat_id IS NULL)
 ) THEN
   RAISE EXCEPTION 'A Diamond Tournament Seat Must Hold Its Funded Entry' USING ERRCODE='P0812';
 END IF;
 RETURN NULL;
END $function$
;
CREATE OR REPLACE FUNCTION public.fn_cash_money_text(p numeric)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE WHEN p = trunc(p) THEN trunc(p)::bigint::text
              ELSE to_char(p, 'FM999999990.00') END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_stamp_seat_occupancy()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.occupancy_id := gen_random_uuid();
  ELSIF OLD.user_id IS DISTINCT FROM NEW.user_id
     OR OLD.table_id IS DISTINCT FROM NEW.table_id
     OR OLD.seat_number IS DISTINCT FROM NEW.seat_number
     OR (OLD.left_at IS NOT NULL AND NEW.left_at IS NULL) THEN
    NEW.occupancy_id := gen_random_uuid();
  ELSIF NEW.occupancy_id IS DISTINCT FROM OLD.occupancy_id THEN
    RAISE EXCEPTION 'SEAT_OCCUPANCY_IMMUTABLE' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$function$
;
CREATE TRIGGER zzz_stamp_seat_occupancy BEFORE INSERT OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_stamp_seat_occupancy();
CREATE CONSTRAINT TRIGGER zzz_diamond_seat_keeps_custody AFTER INSERT OR UPDATE OR DELETE ON table_seats DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_poker_diamond_seat_keeps_custody();
CREATE TABLE admin_audit_log ("id" uuid DEFAULT gen_random_uuid() NOT NULL,
"admin_user_id" uuid,
"action" text NOT NULL,
"target_type" text,
"target_id" text,
"details" jsonb DEFAULT '{}'::jsonb,
"ip_address" text,
"created_at" timestamp with time zone DEFAULT now(),
"before_state" jsonb,
"after_state" jsonb,
"user_agent" text,
"actor_role" text,
"request_id" text);
CREATE FUNCTION fn_is_platform_admin() RETURNS boolean LANGUAGE sql AS $$SELECT coalesce(current_setting('test.admin',true),'true')='true'$$;
CREATE FUNCTION fn_caller_session_is_live() RETURNS boolean LANGUAGE sql AS $$SELECT coalesce(current_setting('test.session',true),'true')='true'$$;
CREATE OR REPLACE FUNCTION public.fn_log_admin_action(p_admin_user_id uuid, p_action text, p_target_type text DEFAULT NULL::text, p_target_id text DEFAULT NULL::text, p_details jsonb DEFAULT '{}'::jsonb, p_before_state jsonb DEFAULT NULL::jsonb, p_after_state jsonb DEFAULT NULL::jsonb, p_ip_address text DEFAULT NULL::text, p_user_agent text DEFAULT NULL::text, p_request_id text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id uuid;
  v_role text;
BEGIN
  IF p_admin_user_id IS NULL THEN
    RAISE EXCEPTION 'admin_user_id required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_action IS NULL OR length(trim(p_action)) = 0 THEN
    RAISE EXCEPTION 'action required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT role INTO v_role FROM public.profiles WHERE id = p_admin_user_id;

  INSERT INTO public.admin_audit_log (
    admin_user_id, action, target_type, target_id,
    details, before_state, after_state,
    ip_address, user_agent, actor_role, request_id
  ) VALUES (
    p_admin_user_id, p_action, p_target_type, p_target_id,
    COALESCE(p_details, '{}'::jsonb), p_before_state, p_after_state,
    p_ip_address, p_user_agent, v_role, p_request_id
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_close_cash_table(p_table_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_t public.tables%ROWTYPE; v_row public.tables%ROWTYPE; v_audit uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE='28000';
  END IF;
  IF NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'diamond_table_staff_only' USING ERRCODE='42501';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'diamond_staff_session_required' USING ERRCODE='28000';
  END IF;
  SELECT t.* INTO v_t FROM public.tables t
    JOIN public.clubs c ON c.id=t.club_id
   WHERE t.id=p_table_id AND c.asset='diamonds' AND c.is_platform IS TRUE
     AND c.union_id IS NULL AND t.union_id IS NULL AND t.tournament_id IS NULL
   FOR UPDATE OF t;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'diamond_table_not_found' USING ERRCODE='P0002';
  END IF;
  IF lower(COALESCE(v_t.status,'')) IN ('closed','completed','cancelled','finished','deleted')
     OR COALESCE(v_t.is_deleted,false) THEN
    RAISE EXCEPTION 'diamond_table_is_closed' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.poker_diamond_custody c
              WHERE c.purpose='cash_seat' AND c.target_id=p_table_id AND c.state<>'released') THEN
    RAISE EXCEPTION 'diamond_table_seat_holds_custody' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM public.table_seats s WHERE s.table_id=p_table_id AND s.left_at IS NULL) THEN
    RAISE EXCEPTION 'diamond_table_has_a_seated_player' USING ERRCODE='55000';
  END IF;
  UPDATE public.tables SET status='closed', current_players=0
   WHERE id=p_table_id
  RETURNING * INTO v_row;
  v_audit := public.fn_poker_diamond_staff_audit('diamond.table_close', 'diamond_table', p_table_id,
    to_jsonb(v_t), to_jsonb(v_row), jsonb_build_object('door', 'fn_poker_diamond_close_cash_table'));
  RETURN jsonb_build_object('ok', true, 'table_id', p_table_id, 'status', v_row.status, 'audit_id', v_audit);
END $function$
;
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_edit_cash_table(p_table_id uuid, p_name text DEFAULT NULL::text, p_small_blind integer DEFAULT NULL::integer, p_big_blind integer DEFAULT NULL::integer, p_min_buy_in integer DEFAULT NULL::integer, p_max_buy_in integer DEFAULT NULL::integer, p_max_players integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_t public.tables%ROWTYPE; v_after public.tables%ROWTYPE; v_row public.tables%ROWTYPE;
  v_name text; v_cap integer; v_audit uuid;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE='28000';
  END IF;
  IF NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'diamond_table_staff_only' USING ERRCODE='42501';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'diamond_staff_session_required' USING ERRCODE='28000';
  END IF;
  SELECT t.* INTO v_t FROM public.tables t
    JOIN public.clubs c ON c.id=t.club_id
   WHERE t.id=p_table_id AND c.asset='diamonds' AND c.is_platform IS TRUE
     AND c.union_id IS NULL AND t.union_id IS NULL AND t.tournament_id IS NULL
   FOR UPDATE OF t;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'diamond_table_not_found' USING ERRCODE='P0002';
  END IF;
  IF lower(COALESCE(v_t.status,'')) IN ('closed','completed','cancelled','finished','deleted')
     OR COALESCE(v_t.is_deleted,false) THEN
    RAISE EXCEPTION 'diamond_table_is_closed' USING ERRCODE='55000';
  END IF;
  IF lower(COALESCE(v_t.status,'')) <> 'waiting' OR COALESCE(v_t.current_players,0) <> 0
     OR EXISTS (SELECT 1 FROM public.table_seats s WHERE s.table_id=p_table_id AND s.left_at IS NULL)
     OR EXISTS (SELECT 1 FROM public.poker_diamond_custody c
                 WHERE c.purpose='cash_seat' AND c.target_id=p_table_id AND c.state<>'released') THEN
    RAISE EXCEPTION 'diamond_table_must_be_empty_to_edit' USING ERRCODE='55000';
  END IF;

  v_after := v_t;
  IF p_name IS NOT NULL THEN
    v_name := replace(replace(btrim(p_name), '<', ''), '>', '');
    IF length(v_name) = 0 THEN
      RAISE EXCEPTION 'diamond_table_requires_a_name' USING ERRCODE='22023';
    END IF;
    v_after.name := left(v_name, 60);
  END IF;
  v_after.small_blind := COALESCE(p_small_blind, v_t.small_blind);
  v_after.big_blind := COALESCE(p_big_blind, v_t.big_blind);
  v_after.min_buy_in := COALESCE(p_min_buy_in, v_t.min_buy_in);
  v_after.max_buy_in := COALESCE(p_max_buy_in, v_t.max_buy_in);
  v_after.max_players := COALESCE(p_max_players, v_t.max_players);

  -- Whole positive Diamonds, the open door's order (small <= big <= min <= max)
  -- and the creation guard's strict blinds.
  IF v_after.small_blind IS NULL OR v_after.big_blind IS NULL
     OR v_after.min_buy_in IS NULL OR v_after.max_buy_in IS NULL
     OR v_after.small_blind <= 0 OR v_after.big_blind <= 0
     OR v_after.min_buy_in <= 0 OR v_after.max_buy_in <= 0
     OR v_after.small_blind <> trunc(v_after.small_blind) OR v_after.big_blind <> trunc(v_after.big_blind)
     OR v_after.min_buy_in <> trunc(v_after.min_buy_in) OR v_after.max_buy_in <> trunc(v_after.max_buy_in)
     OR v_after.small_blind >= v_after.big_blind
     OR v_after.min_buy_in > v_after.max_buy_in
     OR v_after.big_blind > v_after.min_buy_in
     OR v_after.max_buy_in > 2147483647
  THEN
    RAISE EXCEPTION 'diamond_table_requires_whole_positive_stakes' USING ERRCODE='22023';
  END IF;
  -- The open door's seat count inside the creation guard's seat law for the
  -- table's game, and never fewer seats than the table waits for to deal.
  v_cap := CASE lower(COALESCE(v_t.game_variant,'nlh'))
             WHEN 'plo6' THEN 6 WHEN 'plo5' THEN 7 WHEN 'plo4' THEN 8
             WHEN 'plo8' THEN 8 WHEN 'flo8' THEN 8 ELSE 9 END;
  IF v_after.max_players IS NULL OR v_after.max_players < 2 OR v_after.max_players > v_cap
     OR v_after.max_players < COALESCE(v_t.auto_start_players, 2) THEN
    RAISE EXCEPTION 'diamond_table_requires_a_real_seat_count' USING ERRCODE='22023';
  END IF;
  IF NOT public.fn_poker_diamond_plain_cash_table(v_after) THEN
    RAISE EXCEPTION 'diamond_plain_cash_table_required' USING ERRCODE='23514';
  END IF;

  UPDATE public.tables
     SET name=v_after.name, small_blind=v_after.small_blind, big_blind=v_after.big_blind,
         min_buy_in=v_after.min_buy_in, max_buy_in=v_after.max_buy_in, max_players=v_after.max_players
   WHERE id=p_table_id
  RETURNING * INTO v_row;
  -- The row as written must still be one the engine will admit.
  IF NOT public.fn_poker_diamond_plain_cash_table(v_row) THEN
    RAISE EXCEPTION 'diamond_table_would_not_be_admitted' USING ERRCODE='23514';
  END IF;
  v_audit := public.fn_poker_diamond_staff_audit('diamond.table_edit', 'diamond_table', p_table_id,
    to_jsonb(v_t), to_jsonb(v_row), jsonb_build_object('door', 'fn_poker_diamond_edit_cash_table'));
  RETURN jsonb_build_object('ok', true, 'table_id', p_table_id, 'audit_id', v_audit,
    'name', v_row.name, 'small_blind', v_row.small_blind, 'big_blind', v_row.big_blind,
    'min_buy_in', v_row.min_buy_in, 'max_buy_in', v_row.max_buy_in, 'max_players', v_row.max_players);
END $function$
;
CREATE OR REPLACE FUNCTION public.fn_poker_diamond_staff_audit(p_action text, p_target_type text, p_target_id uuid, p_before jsonb, p_after jsonb, p_details jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_changed jsonb;
BEGIN
  -- Only a signed-in platform operator acts through a Diamond configuration
  -- door, so the row can only ever name one.
  IF v_actor IS NULL OR NOT public.fn_is_platform_admin() THEN
    RAISE EXCEPTION 'diamond_staff_audit_requires_platform_staff' USING ERRCODE='42501';
  END IF;
  IF p_action IS NULL OR p_action !~ '^diamond\.[a-z_]+$'
     OR p_target_type IS NULL OR p_target_type NOT IN ('diamond_table','diamond_tournament')
     OR p_target_id IS NULL OR p_after IS NULL THEN
    RAISE EXCEPTION 'diamond_staff_audit_requires_an_action_a_target_and_a_state' USING ERRCODE='22023';
  END IF;
  -- Which columns moved, when there was a row before: every key whose value
  -- differs, the row's own clock aside.
  IF p_before IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(a.key ORDER BY a.key), '[]'::jsonb) INTO v_changed
      FROM jsonb_each(p_after) a
     WHERE a.key <> 'updated_at' AND a.value IS DISTINCT FROM p_before -> a.key;
  END IF;
  RETURN public.fn_log_admin_action(
    v_actor, p_action, p_target_type, p_target_id::text,
    COALESCE(p_details, '{}'::jsonb) || jsonb_build_object('asset', 'diamonds')
      || CASE WHEN v_changed IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('changed', v_changed) END,
    p_before, p_after);
END $function$
;
CREATE OR REPLACE FUNCTION public.fn_stamp_active_seat_game_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.left_at IS NOT NULL THEN
    NEW.active_game_scope := NULL;
  ELSE
    SELECT t.seat_game_scope INTO NEW.active_game_scope FROM public.tables t WHERE t.id=NEW.table_id;
    IF NOT FOUND OR NEW.user_id IS NULL THEN
      RAISE EXCEPTION 'Active seat requires an existing table and player' USING ERRCODE='23514';
    END IF;
    IF NEW.active_game_scope IS NULL THEN
      -- A pre-migration empty table has no cached scope. Initialize only that
      -- parent, inside this admission transaction. Existing occupied tables
      -- never take this UPDATE path. Concurrent initialization is idempotent.
      UPDATE public.tables t SET seat_game_scope = CASE WHEN t.cluster_id IS NULL
        THEN 'table:'||t.id::text ELSE 'cluster:'||t.cluster_id::text END
      WHERE t.id=NEW.table_id AND t.seat_game_scope IS NULL;
      SELECT t.seat_game_scope INTO NEW.active_game_scope FROM public.tables t WHERE t.id=NEW.table_id;
      IF NEW.active_game_scope IS NULL THEN
        RAISE EXCEPTION 'Active seat parent scope initialization failed' USING ERRCODE='23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$function$
;
CREATE TRIGGER zzzz_stamp_active_seat_game_scope BEFORE INSERT OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_stamp_active_seat_game_scope();
CREATE OR REPLACE FUNCTION public.trg_seat_parent_keys_match()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_scope text; v_key text; v_found boolean;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.table_id IS NOT DISTINCT FROM NEW.table_id
     AND OLD.active_game_scope IS NOT DISTINCT FROM NEW.active_game_scope
     AND OLD.active_parent_key IS NOT DISTINCT FROM NEW.active_parent_key THEN
    RETURN NEW; -- an FK re-checks only when a referencing column changes
  END IF;
  IF NEW.table_id IS NULL OR (NEW.active_game_scope IS NULL AND NEW.active_parent_key IS NULL) THEN
    RETURN NEW; -- MATCH SIMPLE
  END IF;
  SELECT t.seat_game_scope, t.seat_admission_key, true INTO v_scope, v_key, v_found
    FROM public.tables t WHERE t.id = NEW.table_id FOR KEY SHARE;
  IF NEW.active_game_scope IS NOT NULL AND (v_found IS DISTINCT FROM true OR v_scope IS DISTINCT FROM NEW.active_game_scope) THEN
    RAISE EXCEPTION 'insert or update on table "table_seats" violates foreign key constraint "active_seat_game_scope_parent"'
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'active_seat_game_scope_parent',
            DETAIL = format('Key (table_id, active_game_scope)=(%s, %s) is not present in table "tables".', NEW.table_id, NEW.active_game_scope);
  END IF;
  IF NEW.active_parent_key IS NOT NULL AND (v_found IS DISTINCT FROM true OR v_key IS DISTINCT FROM NEW.active_parent_key) THEN
    RAISE EXCEPTION 'insert or update on table "table_seats" violates foreign key constraint "live_seat_parent_cannot_close"'
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'live_seat_parent_cannot_close',
            DETAIL = format('Key (table_id, active_parent_key)=(%s, %s) is not present in table "tables".', NEW.table_id, NEW.active_parent_key);
  END IF;
  RETURN NEW;
END $function$
;
CREATE TRIGGER zzzzz_seat_parent_keys_match BEFORE INSERT OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION trg_seat_parent_keys_match();
CREATE OR REPLACE FUNCTION public.fn_stamp_table_game_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.seat_game_scope := CASE WHEN NEW.cluster_id IS NULL
    THEN 'table:'||NEW.id::text ELSE 'cluster:'||NEW.cluster_id::text END;
  RETURN NEW;
END
$function$
;
CREATE TRIGGER zzzz_stamp_table_game_scope BEFORE INSERT OR UPDATE ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_stamp_table_game_scope();
CREATE OR REPLACE FUNCTION public.trg_table_scope_cascade()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF OLD.seat_game_scope IS NOT NULL AND NEW.seat_game_scope IS DISTINCT FROM OLD.seat_game_scope THEN
    UPDATE public.table_seats s SET active_game_scope = NEW.seat_game_scope
     WHERE s.table_id = NEW.id AND s.active_game_scope = OLD.seat_game_scope;
  END IF;
  RETURN NULL;
END $function$
;
CREATE TRIGGER zzzzz_table_scope_cascade AFTER UPDATE ON public.tables FOR EACH ROW WHEN ((old.seat_game_scope IS DISTINCT FROM new.seat_game_scope)) EXECUTE FUNCTION trg_table_scope_cascade();
CREATE TABLE cash_rejoin_constraints ("id" uuid DEFAULT gen_random_uuid() NOT NULL,
"player_id" uuid NOT NULL,
"club_id" uuid NOT NULL,
"variant" text NOT NULL,
"sb" numeric(14,2) NOT NULL,
"bb" numeric(14,2) NOT NULL,
"required_stack" numeric(14,2) NOT NULL,
"left_at" timestamp with time zone DEFAULT now() NOT NULL,
"expires_at" timestamp with time zone NOT NULL,
"source_table_id" uuid,
"barred_until" timestamp with time zone);
CREATE OR REPLACE FUNCTION public.fn_ca_cash_entry_need(p_user_id uuid, p_table_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_min numeric;
  v_max numeric;
  v_tournament uuid;
  v_need numeric;
BEGIN
  SELECT t.min_buy_in, t.max_buy_in, t.tournament_id
    INTO v_min, v_max, v_tournament
    FROM public.tables t WHERE t.id = p_table_id;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  v_need := COALESCE(v_min, 0);
  IF v_tournament IS NULL AND p_user_id IS NOT NULL THEN
    v_need := GREATEST(v_need, COALESCE(public.fn_cash_rejoin_floor(p_user_id, p_table_id), 0));
  END IF;
  IF v_max IS NOT NULL AND v_max > 0 THEN
    v_need := LEAST(v_need, v_max);
  END IF;
  RETURN GREATEST(v_need, 0);
END
$function$
;
CREATE OR REPLACE FUNCTION public.fn_cash_game_barred_seconds(p_game_id uuid, p_user_id uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT ceil(extract(epoch FROM (max(c.barred_until) - now())))::integer
    FROM public.cash_games g
    JOIN public.cash_rejoin_constraints c
      ON c.player_id = p_user_id AND c.club_id = g.club_id AND c.variant = g.variant
     AND c.sb = g.sb AND c.bb = g.bb AND c.barred_until > now()
   WHERE g.id = p_game_id
  HAVING max(c.barred_until) IS NOT NULL;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_cash_game_join(p_game_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  g record; s record; t record; h record;
  v_position integer; v_count integer;
  v_hold_ttl CONSTANT interval := interval '60 seconds';
  v_hold_until timestamptz;
  v_probe_table uuid;
  v_need numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED: sign in to join a game' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND: %', p_game_id; END IF;
  IF NOT g.enabled THEN
    RAISE EXCEPTION 'GAME_CLOSED: this game is not taking players' USING ERRCODE = 'check_violation';
  END IF;
  -- Booted for low VPIP: no seat in this game until the bar lifts (Dan 2026-09-05).
  IF public.fn_cash_game_barred_seconds(g.id, v_uid) IS NOT NULL THEN
    RAISE EXCEPTION 'GAME_BARRED:%', public.fn_cash_game_barred_seconds(g.id, v_uid) USING ERRCODE = 'check_violation';
  END IF;

  -- Already in the game: say where.
  SELECT ts.table_id, ts.seat_number, tb.name, tb.role, tb.main_index
    INTO s
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE ts.user_id = v_uid AND ts.left_at IS NULL AND tb.cluster_id = g.id AND tb.lifecycle <> 'closed'
   LIMIT 1;
  IF FOUND THEN
    UPDATE public.cash_game_waitlist SET status = 'seated', updated_at = now()
     WHERE game_id = g.id AND user_id = v_uid AND status IN ('waiting', 'notified');
    RETURN jsonb_build_object('ok', true, 'action', 'seated', 'table_id', s.table_id,
                              'seat_number', s.seat_number, 'table_name', s.name,
                              'role', s.role, 'main_index', s.main_index);
  END IF;

  -- NO CHAIR IS HELD FOR A PLAYER WHO CANNOT PAY FOR IT (Dan 2026-10-12: "A
  -- player should not be able to hold a seat if they don't have sufficient
  -- chips. That should be checked before the seat is reserved."). The door
  -- used to hold a chair for sixty seconds first and let the buy-in refuse
  -- afterwards, which kept the chair from everyone behind them for nothing.
  -- Any wallet the buy-in could spend counts (fn_ca_cash_wallet_covers), and
  -- the figure is the game's own minimum for this player, rejoin floor
  -- included. Nothing has been written yet, so the refusal leaves no hold and
  -- no place in line.
  SELECT tb.id INTO v_probe_table
    FROM public.tables tb
   WHERE tb.cluster_id = g.id AND coalesce(tb.is_deleted, false) = false
     AND tb.lifecycle <> 'closed'
   ORDER BY (tb.lifecycle IN ('live', 'opening')) DESC, tb.created_at ASC
   LIMIT 1;
  IF v_probe_table IS NOT NULL THEN
    v_need := public.fn_ca_cash_entry_need(v_uid, v_probe_table);
    IF NOT public.fn_ca_cash_wallet_covers(v_uid, v_probe_table, NULL, v_need) THEN
      RAISE EXCEPTION 'INSUFFICIENT_CHIPS:%', v_need
        USING ERRCODE = 'check_violation',
              HINT = 'Add chips through the cashier, then join the game.';
    END IF;
  END IF;

  -- THE DOOR HOLDS THE CHAIR IT HANDS OUT (2026-09-10). A 'seat' answer used
  -- to hold nothing, so two players told about the same last chair both got
  -- it and the second was refused at the buy-in door. The chair is held now
  -- with the same row the open-seat offer writes (notified, 60 s), which the
  -- buy-in gate, the open-seat count and the census already honour.
  --
  -- ASKING TWICE IS ONE HOLD. A caller already holding a live chair in this
  -- game is told the same table again and the hold is refreshed. (Their own
  -- hold is subtracted by fn_cash_game_open_seats, so without this a second
  -- click would move them to another table while the first hold stood.)
  SELECT w.id, w.table_id, tb.name, tb.role, tb.main_index
    INTO h
    FROM public.table_waitlist w JOIN public.tables tb ON tb.id = w.table_id
   WHERE w.user_id = v_uid AND w.status = 'notified' AND w.hold_expires_at > now()
     AND tb.cluster_id = g.id AND coalesce(tb.is_deleted, false) = false
     AND tb.status IN ('waiting', 'running', 'active') AND tb.lifecycle IN ('live', 'opening')
   ORDER BY w.hold_expires_at DESC LIMIT 1;
  IF FOUND THEN
    v_hold_until := now() + v_hold_ttl;
    UPDATE public.table_waitlist SET hold_expires_at = v_hold_until WHERE id = h.id;
    -- ONE LIVE HOLD PER PLAYER PER GAME, on this branch too: any other hold
    -- of theirs in this game lapses now.
    UPDATE public.table_waitlist w SET status = 'expired'
      FROM public.tables tb
     WHERE tb.id = w.table_id AND tb.cluster_id = g.id AND w.id <> h.id
       AND w.user_id = v_uid AND w.status = 'notified';
    UPDATE public.cash_game_waitlist SET status = 'notified', updated_at = now()
     WHERE game_id = g.id AND user_id = v_uid AND status IN ('waiting', 'notified');
    RETURN jsonb_build_object('ok', true, 'action', 'seat', 'table_id', h.table_id, 'table_name', h.name,
                              'role', h.role, 'main_index', h.main_index,
                              -- the chairs open TO THIS CALLER: the one they hold counts
                              'open_seats', public.fn_cash_game_open_seats(h.table_id) + 1,
                              'hold_expires_at', v_hold_until);
  END IF;

  -- The shortest live Main with an unreserved open chair, then the feeder
  -- (opening or live). Never a breaking or closed table. Each candidate is
  -- LOCKED on the key the buy-in gate takes for that table and re-read under
  -- the lock, so two callers in the same instant cannot both be handed the
  -- last chair: the second sees the first's hold and moves to the next
  -- candidate, or to the waitlist.
  FOR t IN
    SELECT tb.id, tb.name, tb.role, tb.main_index,
           (SELECT count(*) FROM public.table_seats ts WHERE ts.table_id = tb.id AND ts.left_at IS NULL) AS seated
      FROM public.tables tb
     WHERE tb.cluster_id = g.id AND coalesce(tb.is_deleted, false) = false
       AND tb.status IN ('waiting', 'running', 'active') AND tb.lifecycle IN ('live', 'opening')
       AND public.fn_cash_game_open_seats(tb.id) > 0
     ORDER BY (tb.role = 'feeder') ASC, seated ASC, tb.main_index ASC NULLS LAST, tb.created_at ASC
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('table_seat:' || t.id::text, 0));
    CONTINUE WHEN public.fn_cash_game_open_seats(t.id) <= 0;
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM public.tables tb WHERE tb.id = t.id
                                 AND tb.status IN ('waiting', 'running', 'active')
                                 AND tb.lifecycle IN ('live', 'opening'));
    v_hold_until := now() + v_hold_ttl;
    -- ONE LIVE HOLD PER PLAYER PER GAME: a hold of theirs on any other table
    -- of this game lapses now.
    UPDATE public.table_waitlist w SET status = 'expired'
      FROM public.tables tb
     WHERE tb.id = w.table_id AND tb.cluster_id = g.id AND w.table_id <> t.id
       AND w.user_id = v_uid AND w.status = 'notified';
    -- The hold: a live row of theirs at this table becomes it (keeping the
    -- place in line it already had), else one is written with position 0 -
    -- a line is 1-based, so 0 says "the join door's hold" without a schema change.
    UPDATE public.table_waitlist
       SET status = 'notified', notified_at = now(), hold_expires_at = v_hold_until
     WHERE table_id = t.id AND user_id = v_uid AND status IN ('waiting', 'notified');
    IF NOT FOUND THEN
      INSERT INTO public.table_waitlist (table_id, user_id, position, status, notified_at, hold_expires_at)
      VALUES (t.id, v_uid, 0, 'notified', now(), v_hold_until);
    END IF;
    UPDATE public.cash_game_waitlist SET status = 'notified', updated_at = now()
     WHERE game_id = g.id AND user_id = v_uid AND status IN ('waiting', 'notified');
    RETURN jsonb_build_object('ok', true, 'action', 'seat', 'table_id', t.id, 'table_name', t.name,
                              'role', t.role, 'main_index', t.main_index,
                              'open_seats', public.fn_cash_game_open_seats(t.id) + 1,
                              'hold_expires_at', v_hold_until);
  END LOOP;

  -- Nothing open anywhere: hold the place. One live row per game per player.
  INSERT INTO public.cash_game_waitlist (game_id, user_id, status)
  VALUES (g.id, v_uid, 'waiting')
  ON CONFLICT DO NOTHING;
  SELECT count(*) + 1 INTO v_position FROM public.cash_game_waitlist w
   WHERE w.game_id = g.id AND w.status IN ('waiting', 'notified')
     AND w.created_at < (SELECT created_at FROM public.cash_game_waitlist x
                          WHERE x.game_id = g.id AND x.user_id = v_uid AND x.status IN ('waiting', 'notified') LIMIT 1);
  SELECT count(*) INTO v_count FROM public.cash_game_waitlist w
   WHERE w.game_id = g.id AND w.status IN ('waiting', 'notified');
  RETURN jsonb_build_object('ok', true, 'action', 'waitlisted', 'position', v_position, 'waiting', v_count,
                            'opening_hold_since', g.opening_hold_since,
                            'tables', (SELECT count(*) FROM public.tables tb WHERE tb.cluster_id = g.id AND tb.lifecycle <> 'closed'
                                          AND coalesce(tb.is_deleted, false) = false));
END;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_cash_game_open_seats(p_table_id uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT GREATEST(0,
           coalesce(t.max_players, 9)
           - (SELECT count(*) FROM public.table_seats ts WHERE ts.table_id = t.id AND ts.left_at IS NULL)
           - (SELECT count(*) FROM public.table_waitlist w
               WHERE w.table_id = t.id AND w.status = 'notified' AND w.hold_expires_at > clock_timestamp())
           - (SELECT count(*) FROM public.cash_seat_moves m
               WHERE m.to_table_id = t.id AND m.state = 'pending' AND m.swap_move_id IS NULL))::integer
    FROM public.tables t WHERE t.id = p_table_id;
$function$
;
CREATE OR REPLACE FUNCTION public.fn_cash_rejoin_floor(p_user_id uuid, p_table_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_barred timestamptz;
  v_floor numeric;
BEGIN
  SELECT max(c.barred_until), max(c.required_stack)
    INTO v_barred, v_floor
    FROM public.tables t
    JOIN public.cash_rejoin_constraints c
      ON c.player_id = p_user_id
     AND c.club_id  = t.club_id
     AND c.variant  = t.game_variant
     AND c.sb       = t.small_blind
     AND c.bb       = t.big_blind
     AND c.expires_at > now()
   WHERE t.id = p_table_id
     AND t.tournament_id IS NULL;
  IF v_barred IS NOT NULL AND v_barred > now() THEN
    RAISE EXCEPTION 'VPIP_BARRED:%', ceil(extract(epoch FROM (v_barred - now())))::integer
      USING ERRCODE = 'check_violation',
            HINT = 'Removed for low VPIP: no seat in this game until the bar lifts.';
  END IF;
  RETURN v_floor;
END;
$function$
;