DO $r$DECLARE n text;BEGIN FOREACH n IN ARRAY ARRAY['service_role','authenticated','anon','supabase_auth_admin','dashboard_user'] LOOP IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=n) THEN EXECUTE format('CREATE ROLE %I',n); END IF;END LOOP;END$r$;
CREATE SCHEMA auth; CREATE SCHEMA extensions; CREATE SCHEMA smarter_private; CREATE EXTENSION pgcrypto WITH SCHEMA extensions; CREATE EXTENSION "uuid-ossp"; CREATE SEQUENCE smarter_private.f06_lifecycle_seq; CREATE SEQUENCE hand_id_seq; CREATE SEQUENCE chip_ledger_chain_seq;
CREATE OR REPLACE FUNCTION smarter_private.f06_new_lifecycle() RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path TO 'pg_catalog' AS $function$ SELECT nextval('smarter_private.f06_lifecycle_seq') $function$;
CREATE TABLE auth.users("instance_id" uuid,"id" uuid NOT NULL,"aud" character varying(255),"role" character varying(255),"email" character varying(255),"encrypted_password" character varying(255),"email_confirmed_at" timestamp with time zone,"invited_at" timestamp with time zone,"confirmation_token" character varying(255),"confirmation_sent_at" timestamp with time zone,"recovery_token" character varying(255),"recovery_sent_at" timestamp with time zone,"email_change_token_new" character varying(255),"email_change" character varying(255),"email_change_sent_at" timestamp with time zone,"last_sign_in_at" timestamp with time zone,"raw_app_meta_data" jsonb,"raw_user_meta_data" jsonb,"is_super_admin" boolean,"created_at" timestamp with time zone,"updated_at" timestamp with time zone,"phone" text DEFAULT NULL::character varying,"phone_confirmed_at" timestamp with time zone,"phone_change" text DEFAULT ''::character varying,"phone_change_token" character varying(255) DEFAULT ''::character varying,"phone_change_sent_at" timestamp with time zone,"confirmed_at" timestamp with time zone GENERATED ALWAYS AS (LEAST(email_confirmed_at, phone_confirmed_at)) STORED,"email_change_token_current" character varying(255) DEFAULT ''::character varying,"email_change_confirm_status" smallint DEFAULT 0,"banned_until" timestamp with time zone,"reauthentication_token" character varying(255) DEFAULT ''::character varying,"reauthentication_sent_at" timestamp with time zone,"is_sso_user" boolean DEFAULT false NOT NULL,"deleted_at" timestamp with time zone,"is_anonymous" boolean DEFAULT false NOT NULL);
CREATE TABLE public.accounting_cash_bank_receipts("rake_record_id" uuid NOT NULL,"union_id" uuid,"club_id" uuid NOT NULL,"union_transaction_id" uuid,"club_ledger_id" uuid,"banked_at" timestamp with time zone NOT NULL,"amount" numeric NOT NULL);
CREATE TABLE public.agents("id" uuid DEFAULT gen_random_uuid() NOT NULL,"user_id" uuid NOT NULL,"club_id" uuid NOT NULL,"membership_id" uuid,"role" text NOT NULL,"status" text DEFAULT 'active'::text NOT NULL,"parent_agent_id" uuid,"commission_rate" numeric(5,4) NOT NULL,"player_rakeback_rate" numeric(5,4) NOT NULL,"credit_limit" numeric(15,2) DEFAULT 0 NOT NULL,"credit_used" numeric(15,2) DEFAULT 0 NOT NULL,"is_prepaid" boolean DEFAULT false NOT NULL,"business_balance" numeric(15,2) DEFAULT 0 NOT NULL,"player_balance" numeric(15,2) DEFAULT 0 NOT NULL,"promo_balance" numeric(15,2) DEFAULT 0 NOT NULL,"total_players" integer DEFAULT 0 NOT NULL,"active_player_count" integer DEFAULT 0 NOT NULL,"sub_agent_count" integer DEFAULT 0 NOT NULL,"weekly_rake_generated" numeric(15,2) DEFAULT 0 NOT NULL,"lifetime_earnings" numeric(15,2) DEFAULT 0 NOT NULL,"joined_at" timestamp with time zone DEFAULT now() NOT NULL,"last_active_at" timestamp with time zone,"created_at" timestamp with time zone DEFAULT now() NOT NULL,"updated_at" timestamp with time zone DEFAULT now() NOT NULL,"auto_rakeback_enabled" boolean DEFAULT true,"rakeback_percentage" numeric(5,4) DEFAULT 0.0000,"agent_wallet_balance" numeric(18,2) DEFAULT 0,"player_wallet_balance" numeric(18,4) DEFAULT 0,"promo_wallet_balance" numeric(18,2) DEFAULT 0,"lifetime_rake_generated" numeric(18,4) DEFAULT 0,"credit_control_revision" bigint DEFAULT 0 NOT NULL);
CREATE TABLE public.ca_chip_store_coverage("store" text NOT NULL,"treatment" text NOT NULL,"counted_by" text,"notes" text,"added_at" timestamp with time zone DEFAULT now() NOT NULL);
CREATE TABLE public.ca_emergency_refund_provenance("asset" text NOT NULL,"refund_key" text NOT NULL,"source_owner" text NOT NULL,"source_id" uuid NOT NULL,"user_id" uuid NOT NULL,"original_debit_id" uuid NOT NULL,"amount" numeric NOT NULL,"journal_id" uuid,"state" text NOT NULL,"created_at" timestamp with time zone DEFAULT transaction_timestamp() NOT NULL);
CREATE TABLE public.ca_emergency_stops("path" text NOT NULL,"stopped" boolean DEFAULT false NOT NULL,"version" bigint DEFAULT 0 NOT NULL,"reason" text,"actor_id" uuid,"updated_at" timestamp with time zone DEFAULT transaction_timestamp() NOT NULL);
CREATE TABLE public.ca_financial_epochs("id" integer GENERATED ALWAYS AS IDENTITY NOT NULL,"name" text NOT NULL,"description" text,"started_at" timestamp with time zone DEFAULT now() NOT NULL,"ended_at" timestamp with time zone,"is_current" boolean DEFAULT false NOT NULL);
CREATE TABLE public.ca_ledger_invariant_findings("txid" xid8 NOT NULL,"account_key" text NOT NULL,"found_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,"balance_delta" numeric NOT NULL,"ledger_net" numeric NOT NULL,"mode" text NOT NULL,"actor_service" text,"db_role" text,"statement" text);
CREATE TABLE public.ca_ledger_invariant_mode("singleton" boolean DEFAULT true NOT NULL,"mode" text NOT NULL,"changed_at" timestamp with time zone DEFAULT now() NOT NULL,"reason" text NOT NULL);
CREATE TABLE public.ca_ledger_invariant_store_mode("store" text NOT NULL,"mode" text NOT NULL,"changed_at" timestamp with time zone DEFAULT now() NOT NULL,"reason" text NOT NULL);
CREATE TABLE public.ca_ledger_mutation_log("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,"at" timestamp with time zone DEFAULT now() NOT NULL,"source_table" text NOT NULL,"operation" text NOT NULL,"db_role" text NOT NULL,"application" text,"reason" text NOT NULL,"old_row" jsonb NOT NULL,"new_row" jsonb);
CREATE TABLE public.ca_mint_ledger("id" uuid DEFAULT gen_random_uuid() NOT NULL,"op_id" text NOT NULL,"action" text NOT NULL,"asset" text NOT NULL,"holder_type" text NOT NULL,"holder_id" uuid NOT NULL,"holder_label" text,"amount" numeric(20,2) NOT NULL,"balance_before" numeric(20,2) NOT NULL,"balance_after" numeric(20,2) NOT NULL,"supply_after" numeric(20,2) NOT NULL,"reason" text NOT NULL,"performed_by" uuid,"performed_by_label" text,"db_role" text DEFAULT CURRENT_USER NOT NULL,"created_at" timestamp with time zone DEFAULT now() NOT NULL,"chip_ledger_id" uuid,"diamond_tx_id" uuid,"origin" text GENERATED ALWAYS AS (
CASE
    WHEN (op_id ~~ 'ledger:%'::text) THEN 'journal'::text
    WHEN (op_id ~~ 'register-opening-baseline:%'::text) THEN 'baseline'::text
    WHEN (op_id ~~ 'register-opening-baseline-correction:%'::text) THEN 'baseline'::text
    WHEN (op_id ~~ 'baseline:%'::text) THEN 'baseline'::text
    WHEN (op_id ~~ 'diamond-mint:%'::text) THEN 'diamond-mint'::text
    WHEN (op_id ~~ 'club-opening-grant:%'::text) THEN 'opening-grant'::text
    WHEN (op_id ~~ 'seat_credit_erased:%'::text) THEN 'restoration'::text
    WHEN (op_id ~~ 'seed:%'::text) THEN 'seed'::text
    WHEN (op_id ~~ 'deletion:%'::text) THEN 'deletion'::text
    WHEN (op_id ~~ 'diamond-journal:purchase:%'::text) THEN 'purchase'::text
    WHEN (op_id ~~ 'diamond-journal:reward:%'::text) THEN 'reward'::text
    WHEN (op_id ~~ 'diamond-journal:promotion:%'::text) THEN 'promotion'::text
    WHEN (op_id ~~ 'diamond-journal:refund:%'::text) THEN 'refund'::text
    WHEN (op_id ~~ 'diamond-journal:spend:%'::text) THEN 'spend'::text
    WHEN (op_id ~~ 'diamond-journal:bridge:%'::text) THEN 'bridge'::text
    WHEN (op_id ~~ 'diamond-journal:adjustment:%'::text) THEN 'adjustment'::text
    WHEN (op_id ~~ 'diamond-journal:arena:%'::text) THEN 'arena'::text
    WHEN (op_id ~~ 'diamond-journal:%'::text) THEN 'unclassified'::text
    ELSE 'operator'::text
END) STORED);
CREATE TABLE public.ca_mint_policy("id" integer NOT NULL,"per_operation_cap_chips" numeric NOT NULL,"rolling_24h_cap_chips" numeric NOT NULL,"per_operation_cap_diamonds" numeric NOT NULL,"rolling_24h_cap_diamonds" numeric NOT NULL,"note" text,"updated_at" timestamp with time zone DEFAULT now() NOT NULL,"updated_by" uuid);
CREATE TABLE public.ca_operator_policy("id" boolean DEFAULT true NOT NULL,"approvals_enabled" boolean DEFAULT false NOT NULL,"allow_self_approve_when_alone" boolean DEFAULT true NOT NULL,"enforce_named_roles" boolean DEFAULT false NOT NULL,"mint_threshold" numeric DEFAULT 0 NOT NULL,"fund_threshold" numeric DEFAULT 0 NOT NULL,"cashout_threshold" numeric DEFAULT 0 NOT NULL,"approval_ttl_minutes" integer DEFAULT 1440 NOT NULL,"updated_by" uuid,"updated_at" timestamp with time zone DEFAULT now() NOT NULL,"restrictions_enforced" boolean DEFAULT false NOT NULL);
CREATE TABLE public.ca_player_restrictions("id" uuid DEFAULT gen_random_uuid() NOT NULL,"user_id" uuid NOT NULL,"scope" text NOT NULL,"reason_code" text NOT NULL,"reason_note" text,"status" text DEFAULT 'active'::text NOT NULL,"applied_by" uuid,"applied_at" timestamp with time zone DEFAULT now() NOT NULL,"expires_at" timestamp with time zone,"approval_id" uuid,"lifted_by" uuid,"lifted_at" timestamp with time zone,"lift_note" text,"created_at" timestamp with time zone DEFAULT now() NOT NULL);
CREATE TABLE public.ca_restriction_observations("id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,"user_id" uuid NOT NULL,"scope" text NOT NULL,"restriction_id" uuid,"observed_at" timestamp with time zone DEFAULT now() NOT NULL,"table_name" text NOT NULL,"op" text NOT NULL,"would_refuse" boolean DEFAULT true NOT NULL,"detail" jsonb);
CREATE TABLE public.ca_test_account_ledger_actor_archive("ledger_id" uuid NOT NULL,"actor_id" uuid NOT NULL,"actor_email" text NOT NULL,"ledger_row" jsonb NOT NULL,"archived_at" timestamp with time zone DEFAULT now() NOT NULL,"archive_reason" text DEFAULT 'guarded_certification_account_deletion'::text NOT NULL);
CREATE TABLE public.cash_games("id" uuid DEFAULT gen_random_uuid() NOT NULL,"club_id" uuid NOT NULL,"union_id" uuid,"name" text NOT NULL,"template_name" text NOT NULL,"variant" text NOT NULL,"sb" numeric(14,2) NOT NULL,"bb" numeric(14,2) NOT NULL,"handedness" integer NOT NULL,"ruleset_snapshot" jsonb NOT NULL,"enabled" boolean DEFAULT true NOT NULL,"state" text DEFAULT 'live'::text NOT NULL,"cap_mains" integer DEFAULT 8 NOT NULL,"allow_second_feeder" boolean DEFAULT false NOT NULL,"created_by" uuid,"created_at" timestamp with time zone DEFAULT now() NOT NULL,"updated_at" timestamp with time zone DEFAULT now() NOT NULL,"must_move" boolean DEFAULT true NOT NULL,"closed_at" timestamp with time zone,"closed_by" uuid,"opening_hold_since" timestamp with time zone,"last_tick_at" timestamp with time zone,"last_tick_actions" jsonb,"opening_hold_rested_until" timestamp with time zone,"cluster_mode" text DEFAULT 'must_move'::text NOT NULL,"lightning_enabled" boolean DEFAULT false NOT NULL,"cluster_epoch" integer DEFAULT 0 NOT NULL,"lightning_off_condition_since" timestamp with time zone);
CREATE TABLE public.cashier_rpc_operation_intents("operation_id" uuid NOT NULL,"actor_user_id" uuid NOT NULL,"action" text NOT NULL,"club_id" uuid,"operation_intent" jsonb NOT NULL,"intent_fingerprint" text NOT NULL,"receipt" jsonb,"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,"completed_at" timestamp with time zone);
CREATE TABLE public.chip_ledger("id" uuid DEFAULT gen_random_uuid() NOT NULL,"performed_by" uuid,"from_type" text NOT NULL,"from_entity_id" uuid,"from_label" text,"to_type" text NOT NULL,"to_entity_id" uuid,"to_label" text,"amount" numeric(15,2) NOT NULL,"category" text DEFAULT 'transfer'::text NOT NULL,"description" text,"notes" text,"club_id" uuid,"union_id" uuid,"table_id" uuid,"hand_id" uuid,"tournament_id" uuid,"created_at" timestamp with time zone DEFAULT now() NOT NULL,"idempotency_key" text,"correlation_id" uuid,"causation_id" uuid,"settlement_id" text,"epoch_id" integer,"actor_service" text,"db_role" text,"pre_from_balance" numeric,"post_from_balance" numeric,"pre_to_balance" numeric,"post_to_balance" numeric,"status" text DEFAULT 'posted'::text NOT NULL,"metadata" jsonb,"chain_seq" bigint,"prev_hash" text,"row_hash" text);
CREATE TABLE public.chip_ledger_idem("idempotency_key" text NOT NULL,"leg_id" uuid NOT NULL,"created_at" timestamp with time zone DEFAULT now() NOT NULL);
CREATE TABLE public.chip_transactions("id" uuid DEFAULT gen_random_uuid() NOT NULL,"club_id" uuid NOT NULL,"from_user_id" uuid,"to_user_id" uuid,"amount" numeric(14,2) NOT NULL,"transaction_type" text NOT NULL,"notes" text,"related_cashout_id" uuid,"metadata" jsonb DEFAULT '{}'::jsonb,"created_at" timestamp with time zone DEFAULT now(),"balance_after" numeric(14,2),"clawed_back" boolean DEFAULT false,"reversible_until" timestamp with time zone,"is_reversed" boolean DEFAULT false,"table_id" uuid);
CREATE TABLE public.club_members("club_id" uuid NOT NULL,"user_id" uuid NOT NULL,"role" text DEFAULT 'player'::text,"agent_id" uuid,"joined_at" timestamp with time zone DEFAULT now(),"parent_agent_id" uuid,"invited_by" uuid,"notes" text,"last_active_at" timestamp with time zone,"created_at" timestamp with time zone DEFAULT now(),"updated_at" timestamp with time zone DEFAULT now(),"is_bot" boolean DEFAULT false,"status" text DEFAULT 'active'::text,"chip_balance" numeric(20,2) DEFAULT 0 NOT NULL,"diamonds" integer DEFAULT 0 NOT NULL,"is_active" boolean DEFAULT true,"orange_ball_status" text DEFAULT 'inactive'::text,"rank_level" integer DEFAULT 1,"credit_limit" numeric(15,2) DEFAULT 0,"credit_used" numeric(15,2) DEFAULT 0,"nickname" text,"last_active" timestamp with time zone DEFAULT now(),"tier" text DEFAULT 'bronze'::text,"trust_score" integer DEFAULT 50,"sessions_played" integer DEFAULT 0,"promo_balance" numeric(14,2) DEFAULT 0,"chips_won" bigint DEFAULT 0,"chips_lost" bigint DEFAULT 0,"commission_rate" numeric(5,2) DEFAULT 0,"rakeback_rate" numeric(5,2) DEFAULT 0,"hands_played" integer DEFAULT 0,"total_rake_paid" bigint DEFAULT 0,"biggest_pot" bigint DEFAULT 0,"locked_chips" integer DEFAULT 0,"player_rakeback_pct" numeric(5,4) DEFAULT 0.0000,"held_chips" numeric DEFAULT 0,"display_name" text,"is_prepaid" boolean DEFAULT true,"promo_received_total" numeric(14,2) DEFAULT 0,"promo_wagered" numeric(14,2) DEFAULT 0,"promo_playthrough_required" numeric(14,2) DEFAULT 0,"missions_completed" integer DEFAULT 0,"membership_lifecycle_status" text DEFAULT 'active'::text NOT NULL,"departed_at" timestamp with time zone,"departed_by" uuid,"departure_reason" text);
CREATE TABLE public.clubs("id" uuid DEFAULT uuid_generate_v4() NOT NULL,"name" text NOT NULL,"description" text,"owner_id" uuid,"created_at" timestamp with time zone DEFAULT now(),"is_union" boolean DEFAULT false,"club_id" integer DEFAULT (((10000)::double precision + floor((random() * (90000)::double precision))))::integer,"avatar_url" text,"is_public" boolean DEFAULT true,"requires_approval" boolean DEFAULT false,"gps_restricted" boolean DEFAULT false,"settings" jsonb DEFAULT '{"rake_cap": 15, "max_buy_in_bb": 200, "min_buy_in_bb": 40, "allow_straddle": true, "time_bank_seconds": 30, "allow_run_it_twice": true, "default_rake_percent": 5}'::jsonb,"updated_at" timestamp with time zone DEFAULT now(),"union_id" uuid,"color_theme" text DEFAULT 'royal-blue'::text,"slug" text,"chip_treasury" numeric(18,2) DEFAULT 100000,"total_rake" numeric(18,2) DEFAULT 0 NOT NULL,"online_count" integer DEFAULT 0,"game_types" text[] DEFAULT ARRAY['NLH'::text],"member_count" integer DEFAULT 0,"table_count" integer DEFAULT 0,"promo_balance" numeric(14,2) DEFAULT 0,"code" text,"rake_percent" numeric(5,2) DEFAULT 5.0,"rake_cap_bb" numeric(8,2) DEFAULT 3.0,"max_tables" integer DEFAULT 20,"max_members" integer DEFAULT 500,"status" text DEFAULT 'active'::text,"hands_played" bigint DEFAULT 0,"logo_url" text,"banner_url" text,"game_variants" text[] DEFAULT ARRAY['nlh'::text],"settlement_locked" boolean DEFAULT false,"settlement_locked_until" timestamp with time zone,"auto_settlement_enabled" boolean DEFAULT true,"auto_settlement_day" text DEFAULT 'monday'::text,"auto_settlement_hour" integer DEFAULT 10,"club_commission_rate" numeric(5,4) DEFAULT 0.9000,"insurance_balance" numeric(14,2) DEFAULT 0,"bbj_enabled" boolean,"player_level" integer DEFAULT 1,"hierarchy_level" integer DEFAULT 1,"level" integer DEFAULT 1,"player_threshold_current" integer DEFAULT 0,"player_threshold_next" integer DEFAULT 30,"hierarchy_units" numeric(10,2) DEFAULT 0,"hierarchy_units_rounded_up" integer DEFAULT 0,"hierarchy_threshold_current" integer DEFAULT 0,"hierarchy_threshold_next" integer DEFAULT 2,"tags" text[] DEFAULT '{}'::text[],"average_rating" numeric(3,2) DEFAULT 0,"game_type" text DEFAULT 'Texas Holdem'::text,"settlement_lock_until" timestamp with time zone,"card_image_url" text,"active_players" integer DEFAULT 0,"default_rake_percent" numeric(5,2) DEFAULT '-1'::integer,"rake_cap" numeric(18,4) DEFAULT '-1'::integer,"min_buyin_bb" integer DEFAULT 20,"max_buyin_bb" integer DEFAULT 200,"allow_straddle" boolean DEFAULT true,"allow_run_it_twice" boolean DEFAULT true,"allow_rabbit_hunt" boolean DEFAULT false,"logo" text,"is_private" boolean DEFAULT false,"min_buy_in" numeric(18,4) DEFAULT 0,"max_buy_in" numeric(18,4) DEFAULT 0,"default_game_type" text DEFAULT 'NLHE'::text,"allow_insurance" boolean DEFAULT false,"auto_approve_agents" boolean DEFAULT false,"auto_settlement" boolean DEFAULT false,"active_tables" integer DEFAULT 0,"admin_count" integer DEFAULT 0,"super_agent_count" integer DEFAULT 0,"agent_count" integer DEFAULT 0,"chip_pool" numeric(18,2) DEFAULT 0 NOT NULL,"bbj_rake_enabled" boolean DEFAULT true,"spins_enabled" boolean DEFAULT false,"spins_preseed_amount" integer DEFAULT 0,"spins_wallet_funding" text DEFAULT 'PROMO'::text,"ticker_enabled" boolean DEFAULT true NOT NULL,"guarantee_treasury_floor" numeric DEFAULT 0 NOT NULL,"guarantee_enforcement_enabled" boolean DEFAULT true NOT NULL,"tagline" text,"opening_checklist_started_at" timestamp with time zone,"lobby_message" text,"lobby_message_updated_at" timestamp with time zone,"message_revision" bigint DEFAULT 1 NOT NULL,"lifecycle_status" text DEFAULT 'active'::text NOT NULL,"retired_at" timestamp with time zone,"retired_by" uuid,"retirement_reason" text,"asset" text DEFAULT 'chips'::text NOT NULL,"is_platform" boolean DEFAULT false NOT NULL);
CREATE TABLE public.engine_maintenance_break("id" boolean DEFAULT true NOT NULL,"phase" text NOT NULL,"announced_at" timestamp with time zone DEFAULT now() NOT NULL,"break_started_at" timestamp with time zone,"break_ends_at" timestamp with time zone,"reason" text DEFAULT 'Scheduled Engine Maintenance'::text NOT NULL,"declared_by" text,"updated_at" timestamp with time zone DEFAULT now() NOT NULL,"enforce_freeze" boolean DEFAULT false NOT NULL,"ownership_token" uuid NOT NULL);
CREATE TABLE public.engine_maintenance_thaws("freeze_started_at" timestamp with time zone NOT NULL,"thawed_at" timestamp with time zone DEFAULT now() NOT NULL,"frozen_seconds" numeric NOT NULL,"shifted" jsonb NOT NULL,"thawed_by" text,"announced_at" timestamp with time zone,"ownership_token" uuid,"contract_version" integer,"release_target_at" timestamp with time zone,"release_generation" integer DEFAULT 0 NOT NULL);
CREATE TABLE public.profiles("id" uuid NOT NULL,"full_name" text,"display_name" text,"first_name" text,"last_name" text,"username" text,"email" text,"phone" text,"bio" text,"city" text,"state" text,"alias" text,"avatar_url" text,"role" text DEFAULT 'user'::text,"status" text DEFAULT 'active'::text,"is_vip" boolean DEFAULT false,"is_horse" boolean DEFAULT false,"is_admin" boolean DEFAULT false,"is_online" boolean DEFAULT false,"player_number" text,"diamonds" integer DEFAULT 0 NOT NULL,"diamond_balance" integer DEFAULT 0,"diamond_multiplier" numeric(3,2) DEFAULT 1.00,"level" integer DEFAULT 1,"tier" text DEFAULT 'Newcomer'::text,"skill_tier" text DEFAULT 'Newcomer'::text,"login_streak" integer DEFAULT 0,"streak_days" integer DEFAULT 0,"settings" jsonb DEFAULT '{}'::jsonb,"preferences" jsonb DEFAULT '{}'::jsonb,"social_page_id" uuid,"favorite_venue" uuid,"home_poker_club" uuid,"referred_by" uuid,"friends_count" integer DEFAULT 0,"hendon_total_cashes" integer DEFAULT 0,"hendon_total_earnings" numeric DEFAULT 0,"email_verified" boolean DEFAULT false,"phone_verified" boolean DEFAULT false,"onboarding_complete" boolean DEFAULT false,"last_login" timestamp with time zone DEFAULT now(),"last_login_date" date DEFAULT CURRENT_DATE,"last_seen" timestamp with time zone DEFAULT now(),"created_at" timestamp with time zone DEFAULT now(),"updated_at" timestamp with time zone DEFAULT now(),"training_view_mode" text DEFAULT 'grid'::text,"last_trivia_date" date,"trivia_streak" integer DEFAULT 0,"trivia_high_score" integer DEFAULT 0,"total_hands_played" integer DEFAULT 0,"notification_token" text,"referral_code" text,"horse_status" character varying DEFAULT 'available'::character varying,"horse_profile" jsonb DEFAULT '{}'::jsonb,"sounds_enabled" boolean DEFAULT true,"vibrations_enabled" boolean DEFAULT true,"show_stack_bb" boolean DEFAULT false,"birth_year" integer,"favorite_hand_type" text DEFAULT 'holdem'::text,"card_back_preference" text DEFAULT 'white'::text,"country" text,"website" text,"twitter" text,"instagram" text,"hendon_url" text,"favorite_game" text,"favorite_hand" text,"home_casino" text,"cover_photo_url" text,"favorite_hand_plo" text,"app_settings" jsonb DEFAULT '{}'::jsonb,"display_name_preference" text DEFAULT 'full_name'::text,"cover_photo_position" text DEFAULT '50% 50%'::text,"tiktok" text,"telegram" text,"birthday" date,"hendon_biggest_cash" numeric,"use_real_name" boolean DEFAULT false,"streak_count" integer DEFAULT 0,"access_tier" text DEFAULT 'Full_Access'::text,"vip_tier" text,"vip_expires_at" timestamp with time zone,"last_active" timestamp with time zone DEFAULT now(),"poker_near_me_preferences" jsonb DEFAULT '{"geofenceAlerts": true, "locationEnabled": true, "showNewcomerFriendly": true}'::jsonb,"can_review" boolean DEFAULT true,"deleted_reviews_count" integer DEFAULT 0,"kyc_status" text DEFAULT 'NONE'::text NOT NULL,"kyc_provider" text,"kyc_inquiry_id" text,"kyc_completed_at" timestamp with time zone,"kyc_rejection_reason" text,"age_verified" boolean DEFAULT false NOT NULL,"age_verified_at" timestamp with time zone,"jurisdiction_country" text,"mfa_required" boolean DEFAULT false NOT NULL,"hub_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,"friend_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,"store_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,"messenger_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,"reels_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,"over_18_attested_at" timestamp with time zone,"jurisdiction_region" text,"jurisdiction_acknowledged_at" timestamp with time zone,"home_games_onboarded_at" timestamp with time zone,"social_profile_completed" boolean DEFAULT false NOT NULL,"is_farming_flagged" boolean DEFAULT false,"stripe_customer_id" text,"club_arena_tos_accepted_at" timestamp with time zone,"bankroll_preferences" jsonb,"memory_games_preferences" jsonb,"news_preferences" jsonb,"video_library_preferences" jsonb,"memory_elo" integer,"arena_avatar_url" text,"equipped_frame" text,"equipped_aura" text,"use_avatar_as_profile_pic" boolean DEFAULT false,"status_text" text,"player_tags" text[] DEFAULT '{}'::text[],"vip_lifetime_card_purchase_id" uuid,"lifetime_vip_since" timestamp with time zone,"trivia_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,"trivia_preferences_revision" bigint DEFAULT 0 NOT NULL);
CREATE TABLE public.rake_records("id" uuid DEFAULT gen_random_uuid() NOT NULL,"hand_id" uuid,"table_id" uuid,"club_id" uuid,"rake_amount" numeric(18,4) DEFAULT 0 NOT NULL,"bbj_contribution" numeric(18,4) DEFAULT 0,"pot_size" numeric(18,4),"num_players" integer,"created_at" timestamp with time zone DEFAULT now(),"player_contributions" jsonb,"global_hand_id" bigint DEFAULT nextval('hand_id_seq'::regclass),"is_tournament" boolean DEFAULT false NOT NULL,"tournament_id" uuid,"source" text DEFAULT 'cash_game'::text,"metadata" jsonb,"rake_method" text DEFAULT 'DEALT_EQUAL'::text NOT NULL,"returned_uncalled" jsonb,"terminal_closed_at" timestamp with time zone,"seat_count_in_force" integer,"max_rake_cap_in_force" numeric(18,4));
CREATE TABLE public.tables("id" uuid DEFAULT gen_random_uuid() NOT NULL,"club_id" uuid,"name" text NOT NULL,"game_type" text DEFAULT 'nlhe'::text,"stakes" text,"small_blind" numeric(15,2) DEFAULT 1,"big_blind" numeric(15,2) DEFAULT 2,"min_buy_in" numeric(15,2) DEFAULT 40,"max_buy_in" numeric(15,2) DEFAULT 200,"max_players" integer DEFAULT 9,"current_players" integer DEFAULT 0,"status" text DEFAULT 'waiting'::text,"is_private" boolean DEFAULT false,"settings" jsonb DEFAULT '{}'::jsonb,"created_at" timestamp with time zone DEFAULT now(),"updated_at" timestamp with time zone DEFAULT now(),"game_variant" text DEFAULT 'nlh'::text,"enable_straddle" boolean DEFAULT true,"run_it_twice" boolean DEFAULT true,"auto_muck" boolean DEFAULT true,"ante" numeric(15,2) DEFAULT 0,"allow_rabbit_hunt" boolean DEFAULT true,"allow_run_it_twice" boolean DEFAULT true,"allow_straddle" boolean DEFAULT true,"game_mode" character varying(10) DEFAULT 'regular'::character varying,"is_vip_only" boolean DEFAULT false,"is_anonymous" boolean DEFAULT false,"ban_chat" boolean DEFAULT false,"label_as_new" boolean DEFAULT false,"is_featured" boolean DEFAULT false,"hide_club_name" boolean DEFAULT false,"is_template" boolean DEFAULT false,"bomb_pot_enabled" boolean DEFAULT false,"double_board" boolean DEFAULT false,"triple_board" boolean DEFAULT false,"pineapple_holdem" boolean DEFAULT false,"seven_deuce_enabled" boolean DEFAULT false,"nit_game" boolean DEFAULT false,"cap_enabled" boolean DEFAULT false,"no_rathole" boolean DEFAULT false,"action_time_seconds" integer DEFAULT 15,"ante_bb" numeric(10,2) DEFAULT 0,"career_percent_min" integer DEFAULT 0,"maintain_percent_min" integer DEFAULT 0,"maintain_hands" integer DEFAULT 10,"auto_start_players" integer DEFAULT 2,"game_length_hours" integer DEFAULT 12,"created_by" uuid,"calltime_enabled" boolean DEFAULT false,"auto_extension" boolean DEFAULT false,"auto_restart" boolean DEFAULT false,"auto_create_table" boolean DEFAULT false,"auto_utg_straddle" boolean DEFAULT false,"voluntary_straddle" boolean DEFAULT false,"insurance_enabled" boolean DEFAULT false,"run_it_mode" character varying(20) DEFAULT 'none'::character varying,"rake_percent" numeric(5,2) DEFAULT '-1'::integer,"rake_cap_bb" numeric(5,2) DEFAULT '-1'::integer,"agent_downline_limit" integer,"buy_in_authorization" boolean DEFAULT false,"restrict_device" boolean DEFAULT true,"restrict_observers" boolean DEFAULT false,"gps_restriction" boolean DEFAULT true,"ip_restriction" boolean DEFAULT false,"pc_emulator_restriction" boolean DEFAULT false,"photo_rotation_verification" boolean DEFAULT false,"short_description" text DEFAULT ''::text,"accelerated_mtt" boolean DEFAULT false,"all_in_or_fold" boolean DEFAULT false,"custom_rebuy_reentry_cost" boolean DEFAULT false,"number_of_rebuys_reentries" integer DEFAULT 3,"add_on_multiplier" numeric(3,1) DEFAULT 1.0,"custom_add_on" boolean DEFAULT false,"add_on_break_length_minutes" integer DEFAULT 1,"ko_bounty" boolean DEFAULT false,"gtd_prize_pool" boolean DEFAULT false,"final_table_deal" boolean DEFAULT false,"big_blind_ante" boolean DEFAULT false,"authorized_to_register" boolean DEFAULT false,"late_registration_level" integer DEFAULT 6,"early_bird_registration" boolean DEFAULT false,"bubble_protection" boolean DEFAULT false,"featured_tournament" boolean DEFAULT false,"min_players_mtt" integer DEFAULT 30,"max_players_mtt" integer DEFAULT 300,"multi_day_mtt" boolean DEFAULT false,"save_start_time" boolean DEFAULT false,"start_time" timestamp with time zone,"restart_tournament_every" boolean DEFAULT false,"tournament_schedule" boolean DEFAULT false,"synchronized_breaks" boolean DEFAULT true,"sng_buy_in" numeric(10,2) DEFAULT 0,"blind_structure" character varying(20) DEFAULT 'standard'::character varying,"payout_structure" character varying(50) DEFAULT 'winner_takes_all'::character varying,"starting_chips" integer DEFAULT 1500,"blinds_up_minutes" integer DEFAULT 10,"next_step_satellite" boolean DEFAULT false,"sng_custom_buy_in" boolean DEFAULT false,"sng_player_count" integer DEFAULT 9,"is_spins" boolean DEFAULT false,"spins_multiplier" integer,"is_deleted" boolean DEFAULT false,"deleted_at" timestamp with time zone,"deleted_by" uuid,"bbj_percent" numeric(5,2) DEFAULT 100,"tournament_id" uuid,"live_state" jsonb,"union_id" uuid,"big_blind_ante_enabled" boolean DEFAULT false,"straddle_enabled" boolean DEFAULT false,"straddle_type" text DEFAULT 'utg'::text,"max_straddles" integer DEFAULT 1,"run_it_twice_enabled" boolean DEFAULT false,"auto_muck_enabled" boolean DEFAULT true,"show_hand_enabled" boolean DEFAULT true,"disconnect_timeout_seconds" integer DEFAULT 30,"max_consecutive_timeouts" integer DEFAULT 3,"prefer_check_over_fold" boolean DEFAULT true,"time_bank_max_uses" integer DEFAULT 4,"time_bank_enabled" boolean DEFAULT true,"ante_enabled" boolean DEFAULT false,"bomb_pot_frequency" integer DEFAULT 0,"bomb_pot_ante_multiplier" integer DEFAULT 2,"wait_for_big_blind" boolean DEFAULT true NOT NULL,"seven_deuce_amount" numeric DEFAULT 2 NOT NULL,"hands_dealt" bigint DEFAULT 0 NOT NULL,"avg_pot" numeric(14,2) DEFAULT 0 NOT NULL,"bomb_pot_double_board" boolean DEFAULT false NOT NULL,"cap_bb" numeric(10,2),"bomb_pot_board_count" smallint DEFAULT 1 NOT NULL,"bomb_pot_trigger_mode" text DEFAULT 'every_n_hands'::text NOT NULL,"bomb_pot_interval_seconds" integer,"bomb_pot_min_players" smallint DEFAULT 3 NOT NULL,"bomb_pot_ante_fixed" numeric,"first_button_seat" integer,"bomb_pot_variant" text,"bomb_pot_next_due_at" timestamp with time zone,"bomb_pot_sched_state" jsonb,"bomb_pot_manual_pending" boolean DEFAULT false NOT NULL,"bomb_pot_button_policy" text DEFAULT 'regular'::text NOT NULL,"bomb_pot_announce_seconds" integer,"min_buy_in_bb" integer GENERATED ALWAYS AS (
CASE
    WHEN ((tournament_id IS NULL) AND (COALESCE(big_blind, (0)::numeric) > (0)::numeric) AND (min_buy_in IS NOT NULL)) THEN (ceil((min_buy_in / big_blind)))::integer
    ELSE NULL::integer
END) STORED,"max_buy_in_bb" integer GENERATED ALWAYS AS (
CASE
    WHEN ((tournament_id IS NULL) AND (COALESCE(big_blind, (0)::numeric) > (0)::numeric) AND (max_buy_in IS NOT NULL)) THEN (floor((max_buy_in / big_blind)))::integer
    ELSE NULL::integer
END) STORED,"min_buyin" integer GENERATED ALWAYS AS (
CASE
    WHEN ((tournament_id IS NULL) AND (COALESCE(big_blind, (0)::numeric) > (0)::numeric) AND (min_buy_in IS NOT NULL)) THEN (ceil((min_buy_in / big_blind)))::integer
    ELSE NULL::integer
END) STORED,"max_buyin" integer GENERATED ALWAYS AS (
CASE
    WHEN ((tournament_id IS NULL) AND (COALESCE(big_blind, (0)::numeric) > (0)::numeric) AND (max_buy_in IS NOT NULL)) THEN (floor((max_buy_in / big_blind)))::integer
    ELSE NULL::integer
END) STORED,"cluster_id" uuid,"role" text,"main_index" integer,"lifecycle" text,"opened_at" timestamp with time zone,"live_at" timestamp with time zone,"break_started_at" timestamp with time zone,"break_eligible_since" timestamp with time zone,"promote_pending" boolean DEFAULT false NOT NULL,"observer_show_cards" boolean DEFAULT false NOT NULL,"terminal_closed_at" timestamp with time zone,"seat_game_scope" text,"seat_admission_key" text,"f06_lifecycle" bigint DEFAULT smarter_private.f06_new_lifecycle() NOT NULL,"dealing_halted_at" timestamp with time zone,"dealing_halted_reason" text,"kill_mode" text DEFAULT 'off'::text NOT NULL,"kill_threshold_bb" smallint DEFAULT 10 NOT NULL,"dealing_halt_observed_at" timestamp with time zone);
CREATE TABLE public.tournament_rake_settlements("tournament_id" uuid NOT NULL,"club_id" uuid,"union_id" uuid,"amount" numeric(15,2) DEFAULT 0 NOT NULL,"destination" text DEFAULT 'pending'::text NOT NULL,"source" text DEFAULT 'engine'::text NOT NULL,"created_at" timestamp with time zone DEFAULT now() NOT NULL,"settled_at" timestamp with time zone,"attributed_at" timestamp with time zone,"attribution_error" text,"attributed_users" integer,"terminal_closed_at" timestamp with time zone);
CREATE TABLE public.tournaments("id" uuid DEFAULT gen_random_uuid() NOT NULL,"name" text NOT NULL,"description" text,"game_type" text DEFAULT 'NLH'::text NOT NULL,"variant" text,"buy_in_amount" numeric(15,2) NOT NULL,"buy_in_fee" numeric(15,2) NOT NULL,"guaranteed_prize" numeric(15,2) DEFAULT 0,"start_time" timestamp with time zone NOT NULL,"status" text DEFAULT 'ANNOUNCED'::text NOT NULL,"current_players" integer DEFAULT 0,"max_players" integer,"late_reg_mins" integer DEFAULT 60,"starting_chips" integer DEFAULT 10000,"blind_structure" text DEFAULT 'Standard'::text,"payout_structure" text DEFAULT 'Standard'::text,"created_at" timestamp with time zone DEFAULT now(),"updated_at" timestamp with time zone DEFAULT now(),"club_id" uuid,"started_at" timestamp with time zone,"ended_at" timestamp with time zone,"current_level" integer DEFAULT 0,"prize_pool" numeric(18,2) DEFAULT 0,"is_rebuy" boolean DEFAULT false,"add_on_available" boolean DEFAULT false,"rebuy_cost" numeric(15,2) DEFAULT 0,"rebuy_chips" integer DEFAULT 0,"rebuy_levels" integer DEFAULT 4,"addon_cost" numeric(15,2) DEFAULT 0,"addon_chips" integer DEFAULT 0,"min_players" integer DEFAULT 3,"tournament_type" text DEFAULT 'MTT'::text,"is_bounty" boolean DEFAULT false,"bounty_amount" numeric(15,2) DEFAULT 0,"is_pko" boolean DEFAULT false,"is_mystery_bounty" boolean DEFAULT false,"mystery_bounty_min" numeric(15,2) DEFAULT 0,"mystery_bounty_max" numeric(15,2) DEFAULT 0,"is_xmtt" boolean DEFAULT false,"union_id" uuid,"is_multi_day" boolean DEFAULT false,"parent_tournament_id" uuid,"flight_number" integer,"day_number" integer DEFAULT 1,"total_days" integer DEFAULT 1,"flight_end_chips_snapshot" jsonb,"survivors_advance_to" uuid,"is_pinned" boolean DEFAULT false,"spin_multiplier" numeric DEFAULT 0,"is_premium_spin" boolean DEFAULT false,"prize_pool_finalized" boolean DEFAULT false,"is_turbo" boolean DEFAULT false,"blind_speed" text DEFAULT 'standard'::text,"spin_type" text DEFAULT 'standard'::text,"total_rake" numeric(18,2) DEFAULT 0 NOT NULL,"late_reg_levels" integer DEFAULT 0,"addon_levels" integer DEFAULT 1,"is_reentry" boolean DEFAULT false,"satellite_target" uuid,"max_rebuys" integer DEFAULT 0,"max_reentries" integer DEFAULT 0,"level_started_at" timestamp with time zone,"addon_period_triggered" boolean DEFAULT false,"satellite_target_id" uuid,"final_table_triggered" boolean DEFAULT false NOT NULL,"bounty_pool" numeric(18,2) DEFAULT 0 NOT NULL,"bounty_pool_paid" numeric DEFAULT 0 NOT NULL,"on_break" boolean DEFAULT false NOT NULL,"break_started_at" timestamp with time zone,"break_ends_at" timestamp with time zone,"is_private" boolean DEFAULT false NOT NULL,"spin_locked_tiers" jsonb,"short_description" text,"is_vip_only" boolean DEFAULT false NOT NULL,"ban_chat" boolean NOT NULL,"all_in_or_fold" boolean DEFAULT false NOT NULL,"label_as_new" boolean DEFAULT false NOT NULL,"hide_club_name" boolean DEFAULT false NOT NULL,"action_time_seconds" integer DEFAULT 15 NOT NULL,"table_size" integer DEFAULT 9 NOT NULL,"accelerated_mtt" boolean DEFAULT false NOT NULL,"addon_break_minutes" integer DEFAULT 1 NOT NULL,"big_blind_ante" boolean DEFAULT false NOT NULL,"authorized_to_register" boolean DEFAULT false NOT NULL,"early_bird_enabled" boolean DEFAULT false NOT NULL,"early_bird_chips" integer DEFAULT 0 NOT NULL,"bubble_protection" boolean DEFAULT false NOT NULL,"final_table_deal_enabled" boolean DEFAULT false NOT NULL,"restart_every_minutes" integer,"synchronized_breaks" boolean DEFAULT true NOT NULL,"satellite_seats" integer,"schedule_id" uuid,"mystery_bounty_activation" text DEFAULT 'at_the_money'::text NOT NULL,"mystery_bounty_activation_value" numeric,"mystery_bounty_profile" text DEFAULT 'classic'::text NOT NULL,"mystery_bounty_top_percent" numeric DEFAULT 20 NOT NULL,"mystery_bounty_regular_pool_percent" numeric DEFAULT 50 NOT NULL,"mystery_bounty_pool_percent" numeric DEFAULT 50 NOT NULL,"mystery_bounty_stage" text DEFAULT 'pending'::text NOT NULL,"mystery_bounty_activated_at" timestamp with time zone,"mystery_bounty_activated_players" integer,"mystery_bounty_pool_cents" bigint,"allow_rabbit_hunt" boolean DEFAULT true NOT NULL,"spin_reveal_lag_ms" integer,"addon_period_started_at" timestamp with time zone,"addon_period_ends_at" timestamp with time zone,"payout_percent" smallint DEFAULT 10 NOT NULL,"free_buy" boolean DEFAULT false NOT NULL,"addon_from_start" boolean DEFAULT false NOT NULL,"spin_reveal_at" timestamp with time zone,"mystery_bounty_activation_generation" bigint DEFAULT 0 NOT NULL,"entry_contract_locked" boolean DEFAULT false NOT NULL,"blind_level_state" jsonb,"payout_math_version" smallint DEFAULT 1 NOT NULL,"payout_unit_cents" integer DEFAULT 1 NOT NULL,"format_contract" text,"restart_source_id" uuid);
CREATE TABLE public.union_wallet_transactions("id" uuid DEFAULT gen_random_uuid() NOT NULL,"union_id" uuid NOT NULL,"wallet" text NOT NULL,"direction" text NOT NULL,"amount" numeric(20,4) NOT NULL,"balance_after" numeric(20,4),"tx_type" text NOT NULL,"club_id" uuid,"period_id" uuid,"notes" text,"created_by" uuid,"created_at" timestamp with time zone DEFAULT now() NOT NULL);
CREATE TABLE public.unions("id" uuid DEFAULT gen_random_uuid() NOT NULL,"name" text NOT NULL,"description" text,"owner_id" uuid NOT NULL,"avatar_url" text,"is_public" boolean DEFAULT true,"member_count" integer DEFAULT 0,"club_count" integer DEFAULT 0,"total_rake" numeric(15,2) DEFAULT 0 NOT NULL,"settings" jsonb DEFAULT '{"shared_player_pool": true, "revenue_share_percent": 10, "cross_club_tournaments": true}'::jsonb,"created_at" timestamp with time zone DEFAULT now(),"updated_at" timestamp with time zone DEFAULT now(),"union_code" integer,"main_bbj_balance" numeric(14,2) DEFAULT 0,"backup_bbj_balance" numeric(14,2) DEFAULT 0,"promo_fund_balance" numeric(14,2) DEFAULT 0,"code" text,"insurance_balance" numeric(14,2) DEFAULT 0,"chip_balance" numeric(20,4) DEFAULT 0 NOT NULL,"rake_wallet" numeric(20,4) DEFAULT 0 NOT NULL,"bbj_wallet" numeric(20,4) DEFAULT 0 NOT NULL,"promo_wallet" numeric(20,4) DEFAULT 0 NOT NULL,"auto_settlement" boolean DEFAULT false,"level" integer DEFAULT 1,"player_level" integer DEFAULT 1,"hierarchy_level" integer DEFAULT 1,"total_players" integer DEFAULT 0,"total_admins" integer DEFAULT 0,"total_super_agents" integer DEFAULT 0,"total_agents" integer DEFAULT 0,"hierarchy_units" numeric(10,2) DEFAULT 0,"hierarchy_units_rounded_up" integer DEFAULT 0,"player_threshold_current" integer DEFAULT 30,"player_threshold_next" integer DEFAULT 34,"hierarchy_threshold_current" integer DEFAULT 2,"hierarchy_threshold_next" integer DEFAULT 2,"promo_funded_from_bbj" numeric DEFAULT 0 NOT NULL,"promo_funded_from_bank" numeric DEFAULT 0 NOT NULL,"slug" text NOT NULL);
CREATE TABLE public.vip_lifetime_purchases("id" uuid DEFAULT gen_random_uuid() NOT NULL,"user_id" uuid NOT NULL,"price_usd" numeric(10,2) NOT NULL,"status" text DEFAULT 'pending'::text NOT NULL,"stripe_checkout_session_id" text,"stripe_payment_intent_id" text,"metadata" jsonb DEFAULT '{}'::jsonb,"created_at" timestamp with time zone DEFAULT now() NOT NULL,"completed_at" timestamp with time zone,"previous_is_vip" boolean,"previous_vip_tier" text,"previous_vip_expires_at" timestamp with time zone,"refunded_amount_cents" integer DEFAULT 0 NOT NULL,"dispute_id" text,"dispute_status" text,"reversal_reason" text,"entitlement_acquired_at" timestamp with time zone,"reversed_at" timestamp with time zone,"updated_at" timestamp with time zone DEFAULT now() NOT NULL);
CREATE TABLE public.wallet_credit_idempotency("key" text NOT NULL,"user_id" uuid,"amount" numeric,"created_at" timestamp with time zone DEFAULT now() NOT NULL);
CREATE OR REPLACE FUNCTION public.fn_ca_house_board_allows_automation(p_club_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- DERIVED FIRST: the platform club is the house board, and always will be, without anybody
  -- remembering to add it to a list. This is the half that cannot rot.
  SELECT COALESCE((SELECT c.is_platform FROM public.clubs c WHERE c.id = p_club_id), false)
     -- LEGACY, AND IT IS DEBT: four chip house boards that predate clubs.is_platform and carry no
     -- flag of their own. Give them one and these four lines delete themselves.
     OR p_club_id = ANY (ARRAY[
          'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid,   -- Club JAQK
          'a0000000-0000-0000-0000-000000000001'::uuid,   -- SHARK CLUB
          'fade0000-0000-0000-0000-000000000001'::uuid,   -- Midway Union
          '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid    -- Deep Stack Society
        ]);
$function$;
CREATE OR REPLACE FUNCTION public.fn_cash_stake_band(p_bb numeric)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
           WHEN p_bb IS NULL THEN NULL
           WHEN p_bb <= 0.5 THEN 'micro'
           WHEN p_bb <= 2   THEN 'low'
           WHEN p_bb <= 6   THEN 'mid'
           ELSE                  'high'
         END;
$function$;
ALTER TABLE auth.users ADD CONSTRAINT "users_email_change_confirm_status_check" CHECK (((email_change_confirm_status >= 0) AND (email_change_confirm_status <= 2)));
ALTER TABLE auth.users ADD CONSTRAINT "users_phone_key" UNIQUE (phone);
ALTER TABLE auth.users ADD CONSTRAINT "users_pkey" PRIMARY KEY (id);
ALTER TABLE public.accounting_cash_bank_receipts ADD CONSTRAINT "accounting_cash_bank_receipts_amount_check" CHECK (((amount > (0)::numeric) AND (amount = round(amount, 2)) AND ((amount)::text <> ALL (ARRAY['NaN'::text, 'Infinity'::text, '-Infinity'::text]))));
ALTER TABLE public.accounting_cash_bank_receipts ADD CONSTRAINT "accounting_cash_bank_receipts_check" CHECK ((((union_id IS NOT NULL) AND (union_transaction_id IS NOT NULL) AND (club_ledger_id IS NULL)) OR ((union_id IS NULL) AND (union_transaction_id IS NULL) AND (club_ledger_id IS NOT NULL))));
ALTER TABLE public.accounting_cash_bank_receipts ADD CONSTRAINT "accounting_cash_bank_receipts_club_ledger_id_key" UNIQUE (club_ledger_id);
ALTER TABLE public.accounting_cash_bank_receipts ADD CONSTRAINT "accounting_cash_bank_receipts_pkey" PRIMARY KEY (rake_record_id);
ALTER TABLE public.accounting_cash_bank_receipts ADD CONSTRAINT "accounting_cash_bank_receipts_union_transaction_id_key" UNIQUE (union_transaction_id);
ALTER TABLE public.agents ADD CONSTRAINT "agents_agent_wallet_balance_nonneg" CHECK ((agent_wallet_balance >= (0)::numeric));
ALTER TABLE public.agents ADD CONSTRAINT "agents_club_id_user_id_key" UNIQUE (club_id, user_id);
ALTER TABLE public.agents ADD CONSTRAINT "agents_commission_rate_check" CHECK (((commission_rate >= (0)::numeric) AND (commission_rate <= 0.70)));
ALTER TABLE public.agents ADD CONSTRAINT "agents_credit_control_revision_nonnegative" CHECK ((credit_control_revision >= 0));
ALTER TABLE public.agents ADD CONSTRAINT "agents_credit_used_check" CHECK ((credit_used >= (0)::numeric));
ALTER TABLE public.agents ADD CONSTRAINT "agents_pkey" PRIMARY KEY (id);
ALTER TABLE public.agents ADD CONSTRAINT "agents_player_rakeback_rate_check" CHECK (((player_rakeback_rate >= (0)::numeric) AND (player_rakeback_rate <= 0.50)));
ALTER TABLE public.agents ADD CONSTRAINT "agents_promo_wallet_balance_nonneg" CHECK ((promo_wallet_balance >= (0)::numeric));
ALTER TABLE public.agents ADD CONSTRAINT "agents_role_check" CHECK ((role = ANY (ARRAY['super_agent'::text, 'agent'::text, 'sub_agent'::text])));
ALTER TABLE public.agents ADD CONSTRAINT "agents_status_check" CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'frozen'::text])));
ALTER TABLE public.agents ADD CONSTRAINT "check_credit" CHECK (((credit_used <= credit_limit) OR (is_prepaid = true)));
ALTER TABLE public.agents ADD CONSTRAINT "chk_player_wallet_balance_is_two_decimal_places" CHECK (((player_wallet_balance IS NULL) OR (player_wallet_balance = round(player_wallet_balance, 2))));
ALTER TABLE public.ca_chip_store_coverage ADD CONSTRAINT "ca_chip_store_coverage_pkey" PRIMARY KEY (store);
ALTER TABLE public.ca_chip_store_coverage ADD CONSTRAINT "ca_chip_store_coverage_treatment_check" CHECK ((treatment = ANY (ARRAY['counted'::text, 'noncirculating'::text, 'uncounted'::text])));
ALTER TABLE public.ca_emergency_refund_provenance ADD CONSTRAINT "ca_emergency_refund_provenance_amount_check" CHECK ((amount > (0)::numeric));
ALTER TABLE public.ca_emergency_refund_provenance ADD CONSTRAINT "ca_emergency_refund_provenance_asset_check" CHECK ((asset = ANY (ARRAY['chips'::text, 'diamonds'::text])));
ALTER TABLE public.ca_emergency_refund_provenance ADD CONSTRAINT "ca_emergency_refund_provenance_asset_journal_id_key" UNIQUE (asset, journal_id);
ALTER TABLE public.ca_emergency_refund_provenance ADD CONSTRAINT "ca_emergency_refund_provenance_pkey" PRIMARY KEY (asset, refund_key, user_id);
ALTER TABLE public.ca_emergency_refund_provenance ADD CONSTRAINT "ca_emergency_refund_provenance_state_check" CHECK ((state = ANY (ARRAY['planned'::text, 'consumed'::text])));
ALTER TABLE public.ca_emergency_stops ADD CONSTRAINT "ca_emergency_stops_path_check" CHECK ((path = ANY (ARRAY['tournament_registration'::text, 'positive_issuance'::text, 'cashout'::text])));
ALTER TABLE public.ca_emergency_stops ADD CONSTRAINT "ca_emergency_stops_pkey" PRIMARY KEY (path);
ALTER TABLE public.ca_emergency_stops ADD CONSTRAINT "ca_emergency_stops_version_check" CHECK ((version >= 0));
ALTER TABLE public.ca_financial_epochs ADD CONSTRAINT "ca_financial_epochs_name_key" UNIQUE (name);
ALTER TABLE public.ca_financial_epochs ADD CONSTRAINT "ca_financial_epochs_pkey" PRIMARY KEY (id);
ALTER TABLE public.ca_ledger_invariant_findings ADD CONSTRAINT "ca_ledger_invariant_findings_pkey" PRIMARY KEY (txid, account_key);
ALTER TABLE public.ca_ledger_invariant_mode ADD CONSTRAINT "ca_ledger_invariant_mode_mode_check" CHECK ((mode = ANY (ARRAY['observe'::text, 'refuse'::text])));
ALTER TABLE public.ca_ledger_invariant_mode ADD CONSTRAINT "ca_ledger_invariant_mode_pkey" PRIMARY KEY (singleton);
ALTER TABLE public.ca_ledger_invariant_mode ADD CONSTRAINT "ca_ledger_invariant_mode_singleton_check" CHECK (singleton);
ALTER TABLE public.ca_ledger_invariant_store_mode ADD CONSTRAINT "ca_ledger_invariant_store_mode_mode_check" CHECK ((mode = ANY (ARRAY['observe'::text, 'refuse'::text])));
ALTER TABLE public.ca_ledger_invariant_store_mode ADD CONSTRAINT "ca_ledger_invariant_store_mode_pkey" PRIMARY KEY (store);
ALTER TABLE public.ca_ledger_mutation_log ADD CONSTRAINT "ca_ledger_mutation_log_pkey" PRIMARY KEY (id);
ALTER TABLE public.ca_mint_ledger ADD CONSTRAINT "ca_mint_ledger_action_check" CHECK ((action = ANY (ARRAY['mint'::text, 'burn'::text])));
ALTER TABLE public.ca_mint_ledger ADD CONSTRAINT "ca_mint_ledger_amount_check" CHECK ((amount > (0)::numeric));
ALTER TABLE public.ca_mint_ledger ADD CONSTRAINT "ca_mint_ledger_asset_check" CHECK ((asset = ANY (ARRAY['chips'::text, 'diamonds'::text])));
ALTER TABLE public.ca_mint_ledger ADD CONSTRAINT "ca_mint_ledger_holder_type_check" CHECK ((holder_type = ANY (ARRAY['club'::text, 'union'::text, 'player'::text, 'house'::text, 'circulation'::text])));
ALTER TABLE public.ca_mint_ledger ADD CONSTRAINT "ca_mint_ledger_op_id_key" UNIQUE (op_id);
ALTER TABLE public.ca_mint_ledger ADD CONSTRAINT "ca_mint_ledger_pkey" PRIMARY KEY (id);
ALTER TABLE public.ca_mint_ledger ADD CONSTRAINT "ca_mint_ledger_reason_check" CHECK ((length(btrim(reason)) >= 10));
ALTER TABLE public.ca_mint_policy ADD CONSTRAINT "ca_mint_policy_id_check" CHECK ((id = 1));
ALTER TABLE public.ca_mint_policy ADD CONSTRAINT "ca_mint_policy_per_operation_cap_chips_check" CHECK ((per_operation_cap_chips > (0)::numeric));
ALTER TABLE public.ca_mint_policy ADD CONSTRAINT "ca_mint_policy_per_operation_cap_diamonds_check" CHECK ((per_operation_cap_diamonds > (0)::numeric));
ALTER TABLE public.ca_mint_policy ADD CONSTRAINT "ca_mint_policy_pkey" PRIMARY KEY (id);
ALTER TABLE public.ca_mint_policy ADD CONSTRAINT "ca_mint_policy_rolling_24h_cap_chips_check" CHECK ((rolling_24h_cap_chips > (0)::numeric));
ALTER TABLE public.ca_mint_policy ADD CONSTRAINT "ca_mint_policy_rolling_24h_cap_diamonds_check" CHECK ((rolling_24h_cap_diamonds > (0)::numeric));
ALTER TABLE public.ca_operator_policy ADD CONSTRAINT "ca_operator_policy_approval_ttl_minutes_check" CHECK ((approval_ttl_minutes > 0));
ALTER TABLE public.ca_operator_policy ADD CONSTRAINT "ca_operator_policy_id_check" CHECK (id);
ALTER TABLE public.ca_operator_policy ADD CONSTRAINT "ca_operator_policy_pkey" PRIMARY KEY (id);
ALTER TABLE public.ca_player_restrictions ADD CONSTRAINT "ca_player_restrictions_expiry_after_start" CHECK (((expires_at IS NULL) OR (expires_at > applied_at)));
ALTER TABLE public.ca_player_restrictions ADD CONSTRAINT "ca_player_restrictions_lift_is_attributed" CHECK (((status <> 'lifted'::text) OR ((lifted_at IS NOT NULL) AND (lifted_by IS NOT NULL))));
ALTER TABLE public.ca_player_restrictions ADD CONSTRAINT "ca_player_restrictions_other_needs_a_note" CHECK (((reason_code <> 'other'::text) OR (COALESCE(btrim(reason_note), ''::text) <> ''::text)));
ALTER TABLE public.ca_player_restrictions ADD CONSTRAINT "ca_player_restrictions_pkey" PRIMARY KEY (id);
ALTER TABLE public.ca_player_restrictions ADD CONSTRAINT "ca_player_restrictions_reason_known" CHECK ((reason_code = ANY (ARRAY['collusion_suspected'::text, 'chip_dumping_suspected'::text, 'multi_accounting'::text, 'bot_or_rta_suspected'::text, 'abuse_or_harassment'::text, 'payment_dispute'::text, 'kyc_incomplete'::text, 'responsible_gaming'::text, 'self_requested'::text, 'security_compromise'::text, 'terms_violation'::text, 'other'::text])));
ALTER TABLE public.ca_player_restrictions ADD CONSTRAINT "ca_player_restrictions_scope_known" CHECK ((scope = ANY (ARRAY['account'::text, 'cash'::text, 'tournaments'::text, 'transfers'::text, 'social'::text])));
ALTER TABLE public.ca_player_restrictions ADD CONSTRAINT "ca_player_restrictions_status_known" CHECK ((status = ANY (ARRAY['active'::text, 'lifted'::text, 'expired'::text])));
ALTER TABLE public.ca_restriction_observations ADD CONSTRAINT "ca_restriction_observations_pkey" PRIMARY KEY (id);
ALTER TABLE public.ca_test_account_ledger_actor_archive ADD CONSTRAINT "ca_test_account_ledger_actor_archive_archive_reason_check" CHECK ((archive_reason = 'guarded_certification_account_deletion'::text));
ALTER TABLE public.ca_test_account_ledger_actor_archive ADD CONSTRAINT "ca_test_account_ledger_actor_archive_pkey" PRIMARY KEY (ledger_id);
ALTER TABLE public.cash_games ADD CONSTRAINT "cash_games_cap_mains_check" CHECK (((cap_mains >= 1) AND (cap_mains <= 32)));
ALTER TABLE public.cash_games ADD CONSTRAINT "cash_games_check" CHECK ((bb > sb));
ALTER TABLE public.cash_games ADD CONSTRAINT "cash_games_cluster_epoch_nonneg" CHECK ((cluster_epoch >= 0));
ALTER TABLE public.cash_games ADD CONSTRAINT "cash_games_cluster_mode_check" CHECK ((cluster_mode = ANY (ARRAY['created'::text, 'opening'::text, 'must_move'::text, 'pending_on'::text, 'lightning'::text, 'pending_off'::text, 'draining'::text, 'paused'::text, 'frozen'::text, 'dead'::text])));
ALTER TABLE public.cash_games ADD CONSTRAINT "cash_games_handedness_check" CHECK (((handedness >= 2) AND (handedness <= 9)));
ALTER TABLE public.cash_games ADD CONSTRAINT "cash_games_pkey" PRIMARY KEY (id);
ALTER TABLE public.cash_games ADD CONSTRAINT "cash_games_sb_check" CHECK ((sb > (0)::numeric));
ALTER TABLE public.cash_games ADD CONSTRAINT "cash_games_state_check" CHECK ((state = ANY (ARRAY['live'::text, 'dormant'::text])));
ALTER TABLE public.cash_games ADD CONSTRAINT "cash_games_template_name_check" CHECK ((template_name = ANY (ARRAY['classic'::text, 'action'::text, 'madness'::text])));
ALTER TABLE public.cash_games ADD CONSTRAINT "cash_games_variant_check" CHECK ((variant = ANY (ARRAY['nlh'::text, 'plo4'::text, 'plo5'::text, 'plo6'::text, 'plo8'::text, 'flo8'::text, 'flh'::text, 'short_deck'::text, 'pineapple'::text])));
ALTER TABLE public.cashier_rpc_operation_intents ADD CONSTRAINT "cashier_rpc_operation_intents_check" CHECK ((intent_fingerprint = md5((operation_intent)::text)));
ALTER TABLE public.cashier_rpc_operation_intents ADD CONSTRAINT "cashier_rpc_operation_intents_operation_intent_check" CHECK ((jsonb_typeof(operation_intent) = 'object'::text));
ALTER TABLE public.cashier_rpc_operation_intents ADD CONSTRAINT "cashier_rpc_operation_intents_pkey" PRIMARY KEY (operation_id);
ALTER TABLE public.chip_ledger ADD CONSTRAINT "chip_ledger_a_union_wallet_side_names_its_column" CHECK ((((from_type IS DISTINCT FROM 'union_wallet'::text) OR (from_label IS NOT NULL) OR (COALESCE(to_label, ''::text) ~~ '%promo%'::text) OR ((COALESCE(category, ''::text) = 'correction'::text) AND (COALESCE((metadata ->> 'posted_via'::text), ''::text) = 'fn_ca_post_correction'::text))) AND ((to_type IS DISTINCT FROM 'union_wallet'::text) OR (to_label IS NOT NULL) OR (COALESCE(from_label, ''::text) ~~ '%promo%'::text) OR ((COALESCE(category, ''::text) = 'correction'::text) AND (COALESCE((metadata ->> 'posted_via'::text), ''::text) = 'fn_ca_post_correction'::text))))) NOT VALID;
ALTER TABLE public.chip_ledger ADD CONSTRAINT "chip_ledger_amount_check" CHECK ((amount > (0)::numeric));
ALTER TABLE public.chip_ledger ADD CONSTRAINT "chip_ledger_category_check" CHECK ((category = ANY (ARRAY['buyin'::text, 'cashout'::text, 'rake'::text, 'commission'::text, 'transfer'::text, 'player_funding'::text, 'agent_funding'::text, 'mint'::text, 'burn'::text, 'legacy_seed_reconcile'::text, 'rakeback'::text, 'settlement'::text, 'tournament_buyin'::text, 'tournament_prize'::text, 'bounty'::text, 'adjustment'::text, 'refund'::text, 'addon'::text, 'rebuy'::text, 'table_cashout'::text, 'tournament_refund'::text, 'bbj_contribution'::text, 'bbj_payout'::text, 'promo'::text, 'promo_release'::text, 'promo_send'::text, 'credit_draw'::text, 'credit_repayment'::text, 'insurance'::text, 'spin_entry'::text, 'spin_prize'::text, 'overlay'::text, 'correction'::text, 'reversal'::text, 'escrow_hold'::text, 'escrow_release'::text, 'treasury_transfer'::text, 'horse_funding'::text, 'fee'::text, 'eco'::text, 'pnl_settlement'::text, 'union_send'::text, 'cashier_send'::text, 'cashier_claim_back'::text, 'ticket_issue'::text, 'ticket_redeem'::text, 'club_opening_allocation'::text, 'leaderboard_payout'::text, 'club_bank_send'::text, 'club_bank_claim'::text, 'agent_send'::text, 'agent_claim'::text, 'union_settlement'::text, 'wheel_prize'::text, 'plinko_prize'::text, 'crash_prize'::text, 'crossing_prize'::text, 'mines_prize'::text]))) NOT VALID;
ALTER TABLE public.chip_ledger ADD CONSTRAINT "chip_ledger_exact_scale" CHECK ((amount = round(amount, 2))) NOT VALID;
ALTER TABLE public.chip_ledger ADD CONSTRAINT "chip_ledger_from_type_check" CHECK ((from_type = ANY (ARRAY['player_wallet'::text, 'club_treasury'::text, 'union_bank'::text, 'agent_wallet'::text, 'system_mint'::text, 'system_burn'::text, 'table_stack'::text, 'promo_wallet'::text, 'club_wallet'::text, 'union_wallet'::text, 'bbj_pool'::text, 'spin_reserve'::text, 'insurance_bank'::text, 'escrow'::text, 'prize_liability'::text, 'bounty_liability'::text, 'rakeback_payable'::text, 'refund_payable'::text, 'settlement_suspense'::text, 'issuance_reserve'::text, 'chip_retirement'::text, 'credit_facility'::text, 'credit_receivable'::text, 'opening_setup'::text, 'leaderboard_round'::text]))) NOT VALID;
ALTER TABLE public.chip_ledger ADD CONSTRAINT "chip_ledger_no_diamond_category_check" CHECK (((category !~* '^diamond'::text) AND (category !~* '_diamond'::text)));
ALTER TABLE public.chip_ledger ADD CONSTRAINT "chip_ledger_pkey" PRIMARY KEY (id);
ALTER TABLE public.chip_ledger ADD CONSTRAINT "chip_ledger_positive_amount" CHECK ((amount > (0)::numeric));
ALTER TABLE public.chip_ledger ADD CONSTRAINT "chip_ledger_status_check" CHECK ((status = ANY (ARRAY['posted'::text, 'correction'::text, 'reversal'::text])));
ALTER TABLE public.chip_ledger ADD CONSTRAINT "chip_ledger_to_type_check" CHECK ((to_type = ANY (ARRAY['player_wallet'::text, 'club_treasury'::text, 'union_bank'::text, 'agent_wallet'::text, 'system_mint'::text, 'system_burn'::text, 'table_stack'::text, 'promo_wallet'::text, 'club_wallet'::text, 'union_wallet'::text, 'bbj_pool'::text, 'spin_reserve'::text, 'insurance_bank'::text, 'escrow'::text, 'prize_liability'::text, 'bounty_liability'::text, 'rakeback_payable'::text, 'refund_payable'::text, 'settlement_suspense'::text, 'issuance_reserve'::text, 'chip_retirement'::text, 'credit_facility'::text, 'credit_receivable'::text, 'opening_setup'::text, 'leaderboard_round'::text]))) NOT VALID;
ALTER TABLE public.chip_ledger ADD CONSTRAINT "chk_post_from_balance_is_two_decimal_places" CHECK (((post_from_balance IS NULL) OR (post_from_balance = round(post_from_balance, 2))));
ALTER TABLE public.chip_ledger ADD CONSTRAINT "chk_post_to_balance_is_two_decimal_places" CHECK (((post_to_balance IS NULL) OR (post_to_balance = round(post_to_balance, 2))));
ALTER TABLE public.chip_ledger ADD CONSTRAINT "chk_pre_from_balance_is_two_decimal_places" CHECK (((pre_from_balance IS NULL) OR (pre_from_balance = round(pre_from_balance, 2))));
ALTER TABLE public.chip_ledger ADD CONSTRAINT "chk_pre_to_balance_is_two_decimal_places" CHECK (((pre_to_balance IS NULL) OR (pre_to_balance = round(pre_to_balance, 2))));
ALTER TABLE public.chip_ledger ADD CONSTRAINT "ck_whole_cents" CHECK (((created_at < '2026-09-07 22:00:00+00'::timestamp with time zone) OR (amount = round(amount, 2)))) NOT VALID;
ALTER TABLE public.chip_ledger_idem ADD CONSTRAINT "chip_ledger_idem_pkey" PRIMARY KEY (idempotency_key);
ALTER TABLE public.chip_transactions ADD CONSTRAINT "chip_transactions_pkey" PRIMARY KEY (id);
ALTER TABLE public.club_members ADD CONSTRAINT "chk_held_chips_is_two_decimal_places" CHECK (((held_chips IS NULL) OR (held_chips = round(held_chips, 2))));
ALTER TABLE public.club_members ADD CONSTRAINT "club_members_bot_house_only" CHECK (((NOT COALESCE(is_bot, false)) OR fn_ca_house_board_allows_automation(club_id)));
ALTER TABLE public.club_members ADD CONSTRAINT "club_members_chip_balance_nonneg" CHECK ((chip_balance >= (0)::numeric));
ALTER TABLE public.club_members ADD CONSTRAINT "club_members_membership_lifecycle_check" CHECK ((membership_lifecycle_status = ANY (ARRAY['active'::text, 'departed'::text])));
ALTER TABLE public.club_members ADD CONSTRAINT "club_members_pkey" PRIMARY KEY (club_id, user_id);
ALTER TABLE public.club_members ADD CONSTRAINT "club_members_promo_balance_nonneg" CHECK ((promo_balance >= (0)::numeric));
ALTER TABLE public.club_members ADD CONSTRAINT "club_members_role_check" CHECK ((role = ANY (ARRAY['owner'::text, 'co_owner'::text, 'admin'::text, 'super_agent'::text, 'agent'::text, 'sub_agent'::text, 'player'::text])));
ALTER TABLE public.clubs ADD CONSTRAINT "clubs_asset_known" CHECK ((asset = ANY (ARRAY['chips'::text, 'diamonds'::text])));
ALTER TABLE public.clubs ADD CONSTRAINT "clubs_chip_pool_nonneg" CHECK ((chip_pool >= (0)::numeric));
ALTER TABLE public.clubs ADD CONSTRAINT "clubs_chip_treasury_nonneg" CHECK ((chip_treasury >= (0)::numeric));
ALTER TABLE public.clubs ADD CONSTRAINT "clubs_club_id_key" UNIQUE (club_id);
ALTER TABLE public.clubs ADD CONSTRAINT "clubs_default_rake_percent_range" CHECK (((default_rake_percent IS NULL) OR (default_rake_percent = ('-1'::integer)::numeric) OR ((default_rake_percent >= (0)::numeric) AND (default_rake_percent <= (10)::numeric)))) NOT VALID;
ALTER TABLE public.clubs ADD CONSTRAINT "clubs_description_character_limit" CHECK ((char_length(COALESCE(description, ''::text)) <= 500));
ALTER TABLE public.clubs ADD CONSTRAINT "clubs_insurance_balance_nonneg" CHECK ((insurance_balance >= (0)::numeric));
ALTER TABLE public.clubs ADD CONSTRAINT "clubs_lifecycle_status_check" CHECK ((lifecycle_status = ANY (ARRAY['active'::text, 'retired'::text])));
ALTER TABLE public.clubs ADD CONSTRAINT "clubs_lobby_message_character_limit" CHECK ((char_length(COALESCE(lobby_message, ''::text)) <= 240));
ALTER TABLE public.clubs ADD CONSTRAINT "clubs_message_revision_positive" CHECK ((message_revision > 0));
ALTER TABLE public.clubs ADD CONSTRAINT "clubs_name_not_blank" CHECK ((btrim(name) <> ''::text));
ALTER TABLE public.clubs ADD CONSTRAINT "clubs_pkey" PRIMARY KEY (id);
ALTER TABLE public.clubs ADD CONSTRAINT "clubs_promo_balance_nonneg" CHECK ((promo_balance >= (0)::numeric));
ALTER TABLE public.clubs ADD CONSTRAINT "clubs_rake_cap_range" CHECK (((rake_cap IS NULL) OR (rake_cap = ('-1'::integer)::numeric) OR ((rake_cap >= (0)::numeric) AND (rake_cap <= (10)::numeric)))) NOT VALID;
ALTER TABLE public.clubs ADD CONSTRAINT "clubs_tagline_character_limit" CHECK ((char_length(COALESCE(tagline, ''::text)) <= 72));
ALTER TABLE public.clubs ADD CONSTRAINT "clubs_tagline_length" CHECK (((tagline IS NULL) OR (char_length(tagline) <= 72)));
ALTER TABLE public.clubs ADD CONSTRAINT "poker_arena_diamond_identity" CHECK ((((asset = 'chips'::text) AND (NOT is_platform)) OR ((asset = 'diamonds'::text) AND is_platform AND (union_id IS NULL) AND (NOT COALESCE(is_union, false)) AND (COALESCE(chip_treasury, (0)::numeric) = (0)::numeric) AND (COALESCE(chip_pool, (0)::numeric) = (0)::numeric) AND (COALESCE(promo_balance, (0)::numeric) = (0)::numeric) AND (COALESCE(insurance_balance, (0)::numeric) = (0)::numeric))));
ALTER TABLE public.engine_maintenance_break ADD CONSTRAINT "counting_down_has_an_end" CHECK (((phase <> 'counting_down'::text) OR (break_ends_at IS NOT NULL)));
ALTER TABLE public.engine_maintenance_break ADD CONSTRAINT "engine_maintenance_break_id_check" CHECK (id);
ALTER TABLE public.engine_maintenance_break ADD CONSTRAINT "engine_maintenance_break_phase_check" CHECK ((phase = ANY (ARRAY['last_hand'::text, 'counting_down'::text])));
ALTER TABLE public.engine_maintenance_break ADD CONSTRAINT "engine_maintenance_break_pkey" PRIMARY KEY (id);
ALTER TABLE public.engine_maintenance_thaws ADD CONSTRAINT "engine_maintenance_thaws_pkey" PRIMARY KEY (freeze_started_at);
ALTER TABLE public.profiles ADD CONSTRAINT "profiles_diamonds_nonnegative" CHECK ((diamonds >= 0));
ALTER TABLE public.profiles ADD CONSTRAINT "profiles_kyc_provider_check" CHECK (((kyc_provider IS NULL) OR (kyc_provider = ANY (ARRAY['persona'::text, 'veriff'::text, 'jumio'::text, 'onfido'::text, 'stub'::text]))));
ALTER TABLE public.profiles ADD CONSTRAINT "profiles_kyc_status_check" CHECK ((kyc_status = ANY (ARRAY['NONE'::text, 'PENDING'::text, 'APPROVED'::text, 'REJECTED'::text, 'EXPIRED'::text])));
ALTER TABLE public.profiles ADD CONSTRAINT "profiles_pkey" PRIMARY KEY (id);
ALTER TABLE public.profiles ADD CONSTRAINT "profiles_trivia_preferences_revision_nonnegative" CHECK ((trivia_preferences_revision >= 0));
ALTER TABLE public.rake_records ADD CONSTRAINT "chk_rake_amount_is_two_decimal_places" CHECK (((rake_amount IS NULL) OR (rake_amount = round(rake_amount, 2))));
ALTER TABLE public.rake_records ADD CONSTRAINT "ck_whole_cents" CHECK (((created_at < '2026-09-07 22:00:00+00'::timestamp with time zone) OR ((rake_amount = round(rake_amount, 2)) AND (bbj_contribution = round(bbj_contribution, 2))))) NOT VALID;
ALTER TABLE public.rake_records ADD CONSTRAINT "rake_records_pkey" PRIMARY KEY (id);
ALTER TABLE public.rake_records ADD CONSTRAINT "rake_records_rake_method_check" CHECK ((rake_method = ANY (ARRAY['DEALT_EQUAL'::text, 'WEIGHTED_CONTRIBUTED'::text])));
ALTER TABLE public.tables ADD CONSTRAINT "table_game_scope_is_derived" CHECK (((seat_game_scope IS NULL) OR (seat_game_scope =
CASE
    WHEN (cluster_id IS NULL) THEN ('table:'::text || (id)::text)
    ELSE ('cluster:'::text || (cluster_id)::text)
END)));
ALTER TABLE public.tables ADD CONSTRAINT "table_game_scope_parent_key" UNIQUE (id, seat_game_scope);
ALTER TABLE public.tables ADD CONSTRAINT "table_seat_admission_is_derived" CHECK (((seat_admission_key IS NULL) OR (seat_admission_key =
CASE
    WHEN ((lower(COALESCE(status, ''::text)) = ANY (ARRAY['closed'::text, 'completed'::text, 'cancelled'::text, 'finished'::text])) OR (lifecycle = 'closed'::text) OR COALESCE(is_deleted, false) OR COALESCE(is_template, false)) THEN 'closed'::text
    WHEN (tournament_id IS NOT NULL) THEN ('tournament:'::text || (tournament_id)::text)
    ELSE 'cash'::text
END)));
ALTER TABLE public.tables ADD CONSTRAINT "table_seat_admission_parent_key" UNIQUE (id, seat_admission_key);
ALTER TABLE public.tables ADD CONSTRAINT "tables_bomb_pot_board_count_check" CHECK (((bomb_pot_board_count >= 1) AND (bomb_pot_board_count <= 3)));
ALTER TABLE public.tables ADD CONSTRAINT "tables_bomb_pot_button_policy_check" CHECK ((bomb_pot_button_policy = ANY (ARRAY['regular'::text, 'separate'::text])));
ALTER TABLE public.tables ADD CONSTRAINT "tables_bomb_pot_trigger_mode_check" CHECK ((bomb_pot_trigger_mode = ANY (ARRAY['every_n_hands'::text, 'once_per_orbit'::text, 'timed'::text, 'bomb_pot_only'::text])));
ALTER TABLE public.tables ADD CONSTRAINT "tables_bomb_pot_variant_check" CHECK (((bomb_pot_variant IS NULL) OR ((bomb_pot_variant = ANY (ARRAY['nlh'::text, 'plo4'::text, 'plo5'::text, 'plo6'::text, 'flh'::text, 'flo8'::text])) AND ((lower(COALESCE(game_variant, 'nlh'::text)) = ANY (ARRAY['flh'::text, 'flo8'::text])) = (bomb_pot_variant = ANY (ARRAY['flh'::text, 'flo8'::text]))))));
ALTER TABLE public.tables ADD CONSTRAINT "tables_cash_needs_a_game" CHECK (((tournament_id IS NOT NULL) OR (cluster_id IS NOT NULL) OR (status = ANY (ARRAY['closed'::text, 'deleted'::text])) OR COALESCE(is_deleted, false) OR (club_id IS NULL) OR (game_variant IS NULL) OR (COALESCE(small_blind, (0)::numeric) <= (0)::numeric) OR (COALESCE(big_blind, (0)::numeric) <= COALESCE(small_blind, (0)::numeric)) OR (club_id = '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid)));
ALTER TABLE public.tables ADD CONSTRAINT "tables_dealing_halt_is_explained" CHECK ((((dealing_halted_at IS NULL) AND (dealing_halted_reason IS NULL)) OR ((dealing_halted_at IS NOT NULL) AND (dealing_halted_reason IS NOT NULL) AND (dealing_halted_reason = ANY (ARRAY['lightning_pending_on'::text, 'lightning'::text])))));
ALTER TABLE public.tables ADD CONSTRAINT "tables_game_type_is_format" CHECK ((game_type = ANY (ARRAY['cash'::text, 'tournament'::text])));
ALTER TABLE public.tables ADD CONSTRAINT "tables_kill_mode_check" CHECK ((kill_mode = ANY (ARRAY['off'::text, 'half'::text, 'full'::text]))) NOT VALID;
ALTER TABLE public.tables ADD CONSTRAINT "tables_kill_threshold_bb_check" CHECK ((kill_threshold_bb = ANY (ARRAY[8, 10, 12, 15]))) NOT VALID;
ALTER TABLE public.tables ADD CONSTRAINT "tables_lifecycle_check" CHECK ((lifecycle = ANY (ARRAY['opening'::text, 'live'::text, 'breaking'::text, 'closed'::text])));
ALTER TABLE public.tables ADD CONSTRAINT "tables_main_index_check" CHECK ((main_index >= 1));
ALTER TABLE public.tables ADD CONSTRAINT "tables_name_is_not_a_javascript_accident" CHECK (((name IS NULL) OR ((name !~ 'undefined'::text) AND (name !~ 'NaN'::text) AND (name !~ '\[object'::text)))) NOT VALID;
ALTER TABLE public.tables ADD CONSTRAINT "tables_pkey" PRIMARY KEY (id);
ALTER TABLE public.tables ADD CONSTRAINT "tables_rake_cap_bb_range" CHECK (((rake_cap_bb IS NULL) OR (rake_cap_bb = ('-1'::integer)::numeric) OR ((rake_cap_bb >= (0)::numeric) AND (rake_cap_bb <= (10)::numeric)))) NOT VALID;
ALTER TABLE public.tables ADD CONSTRAINT "tables_rake_percent_range" CHECK (((rake_percent IS NULL) OR (rake_percent = ('-1'::integer)::numeric) OR ((rake_percent >= (0)::numeric) AND (rake_percent <= (10)::numeric)))) NOT VALID;
ALTER TABLE public.tables ADD CONSTRAINT "tables_role_check" CHECK ((role = ANY (ARRAY['main'::text, 'feeder'::text])));
ALTER TABLE public.tables ADD CONSTRAINT "tables_stakes_is_not_a_javascript_accident" CHECK (((stakes IS NULL) OR ((stakes !~ 'undefined'::text) AND (stakes !~ 'NaN'::text) AND (stakes !~ '\[object'::text) AND (stakes <> 'null/null'::text)))) NOT VALID;
ALTER TABLE public.tables ADD CONSTRAINT "tables_status_check" CHECK ((status = ANY (ARRAY['waiting'::text, 'active'::text, 'running'::text, 'paused'::text, 'closed'::text])));
ALTER TABLE public.tables ADD CONSTRAINT "tables_straddle_type_check" CHECK ((straddle_type = 'utg'::text));
ALTER TABLE public.tables ADD CONSTRAINT "tables_terminal_closed_shape" CHECK (((terminal_closed_at IS NULL) OR ((lower(COALESCE(status, ''::text)) = 'closed'::text) AND (lower(COALESCE(lifecycle, ''::text)) = 'closed'::text) AND (NOT (current_players IS DISTINCT FROM 0)))));
ALTER TABLE public.tournament_rake_settlements ADD CONSTRAINT "tournament_rake_settlements_pkey" PRIMARY KEY (tournament_id);
ALTER TABLE public.tournaments ADD CONSTRAINT "tournament_prize_math_contract_valid" CHECK ((((payout_math_version = 1) AND (payout_unit_cents = 1)) OR ((payout_math_version = 2) AND (payout_unit_cents = ANY (ARRAY[1, 100])) AND (upper(COALESCE(tournament_type, ''::text)) = 'MTT'::text) AND ((COALESCE(max_players, 0) > 2) OR (NOT (format_contract IS DISTINCT FROM 'mtt-v2'::text))) AND (lower(COALESCE(variant, ''::text)) <> ALL (ARRAY['spin'::text, 'sng'::text, 'satellite'::text])) AND (NOT COALESCE(is_premium_spin, false)) AND (satellite_target_id IS NULL) AND (satellite_target IS NULL))));
ALTER TABLE public.tournaments ADD CONSTRAINT "tournaments_final_table_requires_mtt_check" CHECK (((final_table_triggered IS NOT TRUE) OR ((format_contract = ANY (ARRAY['mtt-v1'::text, 'mtt-v2'::text])) IS TRUE)));
ALTER TABLE public.tournaments ADD CONSTRAINT "tournaments_format_contract_known" CHECK (((format_contract IS NULL) OR (format_contract = ANY (ARRAY['mtt-v1'::text, 'mtt-v2'::text, 'seat-first-satellite-v1'::text, 'sng-v1'::text, 'spin-v1'::text]))));
ALTER TABLE public.tournaments ADD CONSTRAINT "tournaments_free_buy_entry_is_free" CHECK (((NOT free_buy) OR ((COALESCE(buy_in_amount, (0)::numeric) = (0)::numeric) AND (COALESCE(buy_in_fee, (0)::numeric) = (0)::numeric))));
ALTER TABLE public.tournaments ADD CONSTRAINT "tournaments_heads_up_rake_within_5_pct" CHECK (((max_players IS NULL) OR (max_players > 2) OR (COALESCE(buy_in_fee, (0)::numeric) <= (round(((COALESCE(buy_in_amount, (0)::numeric) + COALESCE(buy_in_fee, (0)::numeric)) * 0.05), 2) + 0.005)))) NOT VALID;
ALTER TABLE public.tournaments ADD CONSTRAINT "tournaments_mystery_activation_chk" CHECK ((mystery_bounty_activation = ANY (ARRAY['at_the_money'::text, 'percent_field'::text, 'player_count'::text])));
ALTER TABLE public.tournaments ADD CONSTRAINT "tournaments_mystery_activation_generation_nonnegative" CHECK ((mystery_bounty_activation_generation >= 0));
ALTER TABLE public.tournaments ADD CONSTRAINT "tournaments_mystery_profile_chk" CHECK ((mystery_bounty_profile = ANY (ARRAY['balanced'::text, 'classic'::text, 'jackpot'::text])));
ALTER TABLE public.tournaments ADD CONSTRAINT "tournaments_mystery_stage_chk" CHECK ((mystery_bounty_stage = ANY (ARRAY['pending'::text, 'active'::text, 'complete'::text])));
ALTER TABLE public.tournaments ADD CONSTRAINT "tournaments_never_pko_and_mystery" CHECK ((NOT (COALESCE(is_pko, false) AND COALESCE(is_mystery_bounty, false))));
ALTER TABLE public.tournaments ADD CONSTRAINT "tournaments_no_pko_mystery_hybrid" CHECK ((NOT (COALESCE(is_pko, false) AND COALESCE(is_mystery_bounty, false))));
ALTER TABLE public.tournaments ADD CONSTRAINT "tournaments_payout_percent_check" CHECK ((payout_percent = ANY (ARRAY[10, 15, 20]))) NOT VALID;
ALTER TABLE public.tournaments ADD CONSTRAINT "tournaments_pkey" PRIMARY KEY (id);
ALTER TABLE public.tournaments ADD CONSTRAINT "tournaments_rake_within_10_pct" CHECK ((COALESCE(buy_in_fee, (0)::numeric) <= (((COALESCE(buy_in_amount, (0)::numeric) + COALESCE(buy_in_fee, (0)::numeric)) * 0.1) + 0.000000001))) NOT VALID;
ALTER TABLE public.tournaments ADD CONSTRAINT "tournaments_recorded_entry_capacity" CHECK ((((NOT (format_contract IS DISTINCT FROM 'mtt-v2'::text)) AND (max_players IS NULL) AND (COALESCE(min_players, 0) >= 3)) OR ((format_contract IS DISTINCT FROM 'mtt-v2'::text) AND COALESCE((max_players > 0), false))));
ALTER TABLE public.tournaments ADD CONSTRAINT "tournaments_spin_has_no_fee" CHECK (((created_at < '2026-08-21 00:00:00+00'::timestamp with time zone) OR (((lower(COALESCE(variant, ''::text)) <> 'spin'::text) AND (upper(COALESCE(tournament_type, ''::text)) <> 'SPIN'::text)) OR (COALESCE(buy_in_fee, (0)::numeric) = (0)::numeric)))) NOT VALID;
ALTER TABLE public.tournaments ADD CONSTRAINT "tournaments_spin_no_extra_rake" CHECK (((created_at < '2026-08-21 00:00:00+00'::timestamp with time zone) OR ((variant IS DISTINCT FROM 'spin'::text) AND (upper(COALESCE(tournament_type, ''::text)) <> 'SPIN'::text)) OR (COALESCE(buy_in_fee, (0)::numeric) = (0)::numeric))) NOT VALID;
ALTER TABLE public.tournaments ADD CONSTRAINT "tournaments_status_check" CHECK ((status = ANY (ARRAY['ANNOUNCED'::text, 'REGISTERING'::text, 'LATE_REG'::text, 'RUNNING'::text, 'COMPLETING'::text, 'COMPLETED'::text, 'CANCELLED'::text, 'BAGGED'::text])));
ALTER TABLE public.union_wallet_transactions ADD CONSTRAINT "chk_amount_is_two_decimal_places" CHECK (((amount IS NULL) OR (amount = round(amount, 2))));
ALTER TABLE public.union_wallet_transactions ADD CONSTRAINT "ck_whole_cents" CHECK (((created_at < '2026-09-07 22:00:00+00'::timestamp with time zone) OR (amount = round(amount, 2)))) NOT VALID;
ALTER TABLE public.union_wallet_transactions ADD CONSTRAINT "union_wallet_transactions_amount_check" CHECK ((amount > (0)::numeric));
ALTER TABLE public.union_wallet_transactions ADD CONSTRAINT "union_wallet_transactions_direction_check" CHECK ((direction = ANY (ARRAY['credit'::text, 'debit'::text])));
ALTER TABLE public.union_wallet_transactions ADD CONSTRAINT "union_wallet_transactions_pkey" PRIMARY KEY (id);
ALTER TABLE public.union_wallet_transactions ADD CONSTRAINT "union_wallet_transactions_wallet_check" CHECK ((wallet = ANY (ARRAY['chip_balance'::text, 'rake_wallet'::text, 'bbj_wallet'::text, 'promo_wallet'::text, 'insurance_wallet'::text, 'spin_reserve_wallet'::text])));
ALTER TABLE public.unions ADD CONSTRAINT "chk_chip_balance_is_two_decimal_places" CHECK (((chip_balance IS NULL) OR (chip_balance = round(chip_balance, 2))));
ALTER TABLE public.unions ADD CONSTRAINT "chk_rake_wallet_is_two_decimal_places" CHECK (((rake_wallet IS NULL) OR (rake_wallet = round(rake_wallet, 2))));
ALTER TABLE public.unions ADD CONSTRAINT "unions_code_unique" UNIQUE (code);
ALTER TABLE public.unions ADD CONSTRAINT "unions_pkey" PRIMARY KEY (id);
ALTER TABLE public.vip_lifetime_purchases ADD CONSTRAINT "vip_lifetime_purchases_dispute_status_check" CHECK (((dispute_status IS NULL) OR (dispute_status = ANY (ARRAY['open'::text, 'funds_withdrawn'::text, 'won'::text, 'lost'::text]))));
ALTER TABLE public.vip_lifetime_purchases ADD CONSTRAINT "vip_lifetime_purchases_pkey" PRIMARY KEY (id);
ALTER TABLE public.vip_lifetime_purchases ADD CONSTRAINT "vip_lifetime_purchases_refunded_amount_check" CHECK (((refunded_amount_cents >= 0) AND (refunded_amount_cents <= 49900)));
ALTER TABLE public.vip_lifetime_purchases ADD CONSTRAINT "vip_lifetime_purchases_reversal_reason_check" CHECK (((reversal_reason IS NULL) OR (reversal_reason = ANY (ARRAY['refund'::text, 'dispute'::text]))));
ALTER TABLE public.vip_lifetime_purchases ADD CONSTRAINT "vip_lifetime_purchases_session_key" UNIQUE (stripe_checkout_session_id);
ALTER TABLE public.vip_lifetime_purchases ADD CONSTRAINT "vip_lifetime_purchases_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text, 'failed'::text, 'refunded'::text])));
ALTER TABLE public.wallet_credit_idempotency ADD CONSTRAINT "wallet_credit_idempotency_pkey" PRIMARY KEY (key);
CREATE UNIQUE INDEX agents_agreement_club_and_id ON public.agents USING btree (club_id, id);
CREATE UNIQUE INDEX ca_clubs_one_platform_club ON public.clubs USING btree (is_platform) WHERE is_platform;
CREATE UNIQUE INDEX ca_mint_ledger_chip_ledger_id_key ON public.ca_mint_ledger USING btree (chip_ledger_id) WHERE (chip_ledger_id IS NOT NULL);
CREATE UNIQUE INDEX ca_mint_ledger_diamond_tx_id_key ON public.ca_mint_ledger USING btree (diamond_tx_id) WHERE (diamond_tx_id IS NOT NULL);
CREATE UNIQUE INDEX ca_player_restrictions_one_active_per_scope ON public.ca_player_restrictions USING btree (user_id, scope) WHERE (status = 'active'::text);
CREATE UNIQUE INDEX cash_games_one_per_band_action_madness ON public.cash_games USING btree (club_id, template_name, variant, fn_cash_stake_band(bb)) WHERE (enabled AND (template_name = ANY (ARRAY['action'::text, 'madness'::text])));
CREATE UNIQUE INDEX cash_games_one_per_key ON public.cash_games USING btree (club_id, variant, sb, bb, template_name) WHERE (enabled AND must_move);
CREATE UNIQUE INDEX chip_ledger_chain_seq_key ON public.chip_ledger USING btree (chain_seq);
CREATE UNIQUE INDEX chip_transactions_agent_wallet_op_id_uidx ON public.chip_transactions USING btree (club_id, ((metadata ->> 'op_id'::text))) WHERE ((transaction_type = ANY (ARRAY['agent_wallet_send'::text, 'agent_wallet_claim_back'::text, 'cashout_request_escrow'::text, 'cashout_approved'::text, 'cashout_denied'::text, 'cashout_cancelled'::text])) AND (metadata ? 'op_id'::text));
CREATE UNIQUE INDEX chip_transactions_club_bank_op_id_uidx ON public.chip_transactions USING btree (club_id, ((metadata ->> 'op_id'::text))) WHERE ((transaction_type = ANY (ARRAY['club_bank_send'::text, 'club_bank_reversal'::text])) AND (metadata ? 'op_id'::text));
CREATE UNIQUE INDEX chip_transactions_commission_claim_op_id_uidx ON public.chip_transactions USING btree (club_id, ((metadata ->> 'op_id'::text))) WHERE ((transaction_type = 'commission_claim'::text) AND (metadata ? 'op_id'::text));
CREATE UNIQUE INDEX chip_transactions_staff_ops_op_id_uidx ON public.chip_transactions USING btree (club_id, ((metadata ->> 'op_id'::text))) WHERE ((transaction_type = ANY (ARRAY['admin_removal'::text, 'mint'::text, 'cashout_expired_refund'::text])) AND (metadata ? 'op_id'::text));
CREATE UNIQUE INDEX chip_transactions_ticket_cancel_receipt_uidx ON public.chip_transactions USING btree (((metadata ->> 'ticket_id'::text))) WHERE (transaction_type = 'tournament_ticket_cancel'::text);
CREATE UNIQUE INDEX chip_transactions_ticket_redeem_receipt_uidx ON public.chip_transactions USING btree (((metadata ->> 'ticket_id'::text))) WHERE (transaction_type = 'tournament_ticket_redeem'::text);
CREATE UNIQUE INDEX chip_transactions_wallet_ops_op_id_uidx ON public.chip_transactions USING btree (club_id, ((metadata ->> 'op_id'::text))) WHERE ((transaction_type = ANY (ARRAY['club_bank_claim'::text, 'promo_wallet_send'::text])) AND (metadata ? 'op_id'::text));
CREATE UNIQUE INDEX confirmation_token_idx ON auth.users USING btree (confirmation_token) WHERE ((confirmation_token)::text !~ '^[0-9 ]*$'::text);
CREATE UNIQUE INDEX email_change_token_current_idx ON auth.users USING btree (email_change_token_current) WHERE ((email_change_token_current)::text !~ '^[0-9 ]*$'::text);
CREATE UNIQUE INDEX email_change_token_new_idx ON auth.users USING btree (email_change_token_new) WHERE ((email_change_token_new)::text !~ '^[0-9 ]*$'::text);
CREATE UNIQUE INDEX idx_clubs_code ON public.clubs USING btree (code);
CREATE UNIQUE INDEX idx_clubs_name_lower ON public.clubs USING btree (lower(name));
CREATE UNIQUE INDEX idx_clubs_slug ON public.clubs USING btree (slug) WHERE (slug IS NOT NULL);
CREATE UNIQUE INDEX idx_profiles_referral_code ON public.profiles USING btree (referral_code) WHERE (referral_code IS NOT NULL);
CREATE UNIQUE INDEX idx_profiles_username_lower ON public.profiles USING btree (lower(username)) WHERE (username IS NOT NULL);
CREATE UNIQUE INDEX idx_unions_union_code ON public.unions USING btree (union_code) WHERE (union_code IS NOT NULL);
CREATE UNIQUE INDEX one_god_account_only ON public.profiles USING btree (role) WHERE (role = 'god'::text);
CREATE UNIQUE INDEX poker_arena_one_diamond_identity ON public.clubs USING btree (asset) WHERE (asset = 'diamonds'::text);
CREATE UNIQUE INDEX profiles_username_lower_key ON public.profiles USING btree (lower(username)) WHERE ((username IS NOT NULL) AND (username <> ''::text));
CREATE UNIQUE INDEX reauthentication_token_idx ON auth.users USING btree (reauthentication_token) WHERE ((reauthentication_token)::text !~ '^[0-9 ]*$'::text);
CREATE UNIQUE INDEX recovery_token_idx ON auth.users USING btree (recovery_token) WHERE ((recovery_token)::text !~ '^[0-9 ]*$'::text);
CREATE UNIQUE INDEX tournaments_one_restart_per_source ON public.tournaments USING btree (restart_source_id) WHERE (restart_source_id IS NOT NULL);
CREATE UNIQUE INDEX unions_slug_key ON public.unions USING btree (slug);
CREATE UNIQUE INDEX uniq_profiles_verified_phone ON public.profiles USING btree (phone) WHERE ((phone_verified = true) AND (phone IS NOT NULL) AND (phone <> ''::text));
CREATE UNIQUE INDEX uq_profiles_player_number ON public.profiles USING btree (player_number) WHERE (player_number IS NOT NULL);
CREATE UNIQUE INDEX uq_rake_records_hand_id ON public.rake_records USING btree (hand_id) WHERE (hand_id IS NOT NULL);
CREATE UNIQUE INDEX uq_scheduled_tournament_one_live_per_occurrence ON public.tournaments USING btree (club_id, tournament_type, name, start_time) WHERE ((status = ANY (ARRAY['ANNOUNCED'::text, 'REGISTERING'::text])) AND (tournament_type = ANY (ARRAY['MTT'::text, 'XMTT'::text])));
CREATE UNIQUE INDEX uq_union_wallet_tx_op ON public.union_wallet_transactions USING btree (union_id, tx_type, period_id) WHERE (period_id IS NOT NULL);
CREATE UNIQUE INDEX users_email_partial_key ON auth.users USING btree (email) WHERE (is_sso_user = false);
CREATE UNIQUE INDEX ux_ca_financial_epochs_current ON public.ca_financial_epochs USING btree (is_current) WHERE is_current;
CREATE UNIQUE INDEX ux_chip_ledger_idempotency_key ON public.chip_ledger USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);
CREATE UNIQUE INDEX ux_chip_transactions_idempotency_key ON public.chip_transactions USING btree (((metadata ->> 'idempotency_key'::text))) WHERE (metadata ? 'idempotency_key'::text);
CREATE UNIQUE INDEX vip_lifetime_purchases_one_active_per_user_uidx ON public.vip_lifetime_purchases USING btree (user_id) WHERE (status = ANY (ARRAY['pending'::text, 'completed'::text]));
CREATE UNIQUE INDEX vip_lifetime_purchases_payment_intent_uidx ON public.vip_lifetime_purchases USING btree (stripe_payment_intent_id) WHERE (stripe_payment_intent_id IS NOT NULL);
ALTER TABLE public.accounting_cash_bank_receipts ADD CONSTRAINT "accounting_cash_bank_receipts_club_id_fkey" FOREIGN KEY (club_id) REFERENCES clubs(id);
ALTER TABLE public.accounting_cash_bank_receipts ADD CONSTRAINT "accounting_cash_bank_receipts_club_ledger_id_fkey" FOREIGN KEY (club_ledger_id) REFERENCES chip_ledger(id);
ALTER TABLE public.accounting_cash_bank_receipts ADD CONSTRAINT "accounting_cash_bank_receipts_rake_record_id_fkey" FOREIGN KEY (rake_record_id) REFERENCES rake_records(id);
ALTER TABLE public.accounting_cash_bank_receipts ADD CONSTRAINT "accounting_cash_bank_receipts_union_transaction_id_fkey" FOREIGN KEY (union_transaction_id) REFERENCES union_wallet_transactions(id);
ALTER TABLE public.agents ADD CONSTRAINT "agents_club_id_fkey" FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE;
ALTER TABLE public.agents ADD CONSTRAINT "agents_parent_in_same_club" FOREIGN KEY (club_id, parent_agent_id) REFERENCES agents(club_id, id);
ALTER TABLE public.agents ADD CONSTRAINT "fk_agents_parent" FOREIGN KEY (parent_agent_id) REFERENCES agents(id);
ALTER TABLE public.agents ADD CONSTRAINT "fk_agents_user_id_profiles" FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public.ca_mint_ledger ADD CONSTRAINT "ca_mint_ledger_chip_ledger_id_fkey" FOREIGN KEY (chip_ledger_id) REFERENCES chip_ledger(id) ON DELETE RESTRICT;
ALTER TABLE public.chip_ledger ADD CONSTRAINT "chip_ledger_performed_by_fkey" FOREIGN KEY (performed_by) REFERENCES auth.users(id);
ALTER TABLE public.chip_transactions ADD CONSTRAINT "fk_chip_transactions_club_id_clubs" FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE SET NULL NOT VALID;
ALTER TABLE public.chip_transactions ADD CONSTRAINT "fk_chip_transactions_from_user_id_profiles" FOREIGN KEY (from_user_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public.chip_transactions ADD CONSTRAINT "fk_chip_transactions_to_user_id_profiles" FOREIGN KEY (to_user_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public.club_members ADD CONSTRAINT "club_members_agent_id_fkey" FOREIGN KEY (agent_id) REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE public.club_members ADD CONSTRAINT "club_members_club_id_fkey" FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE;
ALTER TABLE public.club_members ADD CONSTRAINT "club_members_profiles_fkey" FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public.clubs ADD CONSTRAINT "clubs_owner_id_fkey" FOREIGN KEY (owner_id) REFERENCES profiles(id);
ALTER TABLE public.clubs ADD CONSTRAINT "clubs_retired_by_fkey" FOREIGN KEY (retired_by) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.clubs ADD CONSTRAINT "clubs_union_id_fkey" FOREIGN KEY (union_id) REFERENCES unions(id);
ALTER TABLE public.profiles ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.profiles ADD CONSTRAINT "profiles_vip_lifetime_card_purchase_id_fkey" FOREIGN KEY (vip_lifetime_card_purchase_id) REFERENCES vip_lifetime_purchases(id) ON DELETE SET NULL;
ALTER TABLE public.rake_records ADD CONSTRAINT "rake_records_club_id_fkey" FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE SET NULL;
ALTER TABLE public.rake_records ADD CONSTRAINT "rake_records_table_id_fkey" FOREIGN KEY (table_id) REFERENCES tables(id) ON DELETE SET NULL;
ALTER TABLE public.rake_records ADD CONSTRAINT "rake_records_tournament_id_fkey" FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE SET NULL;
ALTER TABLE public.tables ADD CONSTRAINT "fk_tables_club_id" FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE;
ALTER TABLE public.tables ADD CONSTRAINT "tables_cluster_id_fkey" FOREIGN KEY (cluster_id) REFERENCES cash_games(id);
ALTER TABLE public.tables ADD CONSTRAINT "tables_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE public.tables ADD CONSTRAINT "tables_tournament_id_fkey" FOREIGN KEY (tournament_id) REFERENCES tournaments(id);
ALTER TABLE public.tables ADD CONSTRAINT "tables_union_id_fkey" FOREIGN KEY (union_id) REFERENCES unions(id) ON DELETE CASCADE;
ALTER TABLE public.tournament_rake_settlements ADD CONSTRAINT "tournament_rake_settlements_club_id_fkey" FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE SET NULL;
ALTER TABLE public.tournament_rake_settlements ADD CONSTRAINT "tournament_rake_settlements_tournament_id_fkey" FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE;
ALTER TABLE public.tournaments ADD CONSTRAINT "tournaments_club_id_fkey" FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE;
ALTER TABLE public.tournaments ADD CONSTRAINT "tournaments_restart_source_id_fkey" FOREIGN KEY (restart_source_id) REFERENCES tournaments(id) ON UPDATE RESTRICT ON DELETE RESTRICT;
ALTER TABLE public.tournaments ADD CONSTRAINT "tournaments_satellite_target_id_fkey" FOREIGN KEY (satellite_target_id) REFERENCES tournaments(id);
ALTER TABLE public.union_wallet_transactions ADD CONSTRAINT "union_wallet_transactions_club_id_fkey" FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE SET NULL;
ALTER TABLE public.union_wallet_transactions ADD CONSTRAINT "union_wallet_transactions_created_by_fkey" FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.union_wallet_transactions ADD CONSTRAINT "union_wallet_transactions_union_id_fkey" FOREIGN KEY (union_id) REFERENCES unions(id) ON DELETE CASCADE;
ALTER TABLE public.unions ADD CONSTRAINT "fk_unions_owner_id_profiles" FOREIGN KEY (owner_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE public.unions ADD CONSTRAINT "unions_owner_id_fkey" FOREIGN KEY (owner_id) REFERENCES auth.users(id);
ALTER TABLE public.vip_lifetime_purchases ADD CONSTRAINT "vip_lifetime_purchases_user_id_fkey" FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE;
SET check_function_bodies=off;
CREATE OR REPLACE FUNCTION public.fn_ca_balance_has_its_ledger_row()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_ver text := NULLIF(current_setting('ca.ledger_tally_ver', true), '');
  v_checked text := NULLIF(current_setting('ca.ledger_tally_checked', true), '');
  v_mode text;
  t jsonb;
  r record;
  v_b numeric; v_l numeric;
  v_s numeric; v_moved text; v_moved_abs numeric;
BEGIN
  /* Deferred to commit. Every queued event re-enters here, so the tally is
     verified once per version: when nothing has been added since the last
     verification this is one setting read and out. A deferred trigger that
     writes money after us bumps the version and queues its own event, which
     verifies again, so the last word is always on the complete tally. */
  IF v_ver IS NULL OR v_ver = v_checked THEN
    RETURN NULL;
  END IF;

  t := COALESCE(NULLIF(current_setting('ca.ledger_tally', true), '')::jsonb, '{}'::jsonb);

  FOR r IN SELECT key, value FROM jsonb_each(t) LOOP
    v_b := round(COALESCE((r.value ->> 'b')::numeric, 0), 2);
    v_l := round(COALESCE((r.value ->> 'l')::numeric, 0), 2);
    IF v_b = v_l THEN
      CONTINUE;
    END IF;

    /* 2026-10-02: each store is judged by its own mode
       (ca_ledger_invariant_store_mode, keyed by the account-key prefix), so a
       store still being measured records a finding while a proven store
       refuses. A store with no row falls back to the one global row. */
    v_mode := COALESCE(
      (SELECT sm.mode FROM public.ca_ledger_invariant_store_mode sm WHERE sm.store = split_part(r.key, ':', 1)),
      (SELECT m.mode FROM public.ca_ledger_invariant_mode m LIMIT 1),
      'refuse');

    IF v_mode = 'refuse' THEN
      /* 20261002135708: the refusal rolls this transaction back, so it is
         recorded first on the recorder's own connection, which commits on
         its own. The recorder never raises and never changes the refusal. */
      BEGIN
        PERFORM public.fn_ca_ledger_refusal_record(jsonb_build_object(
          'kind',          'balance_moved_without_its_ledger_row',
          'account_key',   r.key,
          'store',         split_part(r.key, ':', 1),
          'balance_delta', v_b,
          'ledger_net',    v_l,
          'mode',          v_mode,
          'first_writer',  left(COALESCE(r.value ->> 'q', '(unknown statement)'), 1000),
          'message',       format('REFUSED: balance_moved_without_its_ledger_row account=%s balance_delta=%s ledger_net=%s', r.key, v_b, v_l)));
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
      RAISE EXCEPTION 'REFUSED: balance_moved_without_its_ledger_row account=% balance_delta=% ledger_net=%',
        r.key, v_b, v_l
        USING ERRCODE = '23514',
              DETAIL  = CASE
                          WHEN v_l = 0 THEN 'the balance column moved and no chip_ledger leg in this transaction accounts for it'
                          WHEN v_b = 0 THEN 'a chip_ledger leg names this account and its balance column did not move in this transaction'
                          ELSE 'the balance column and the chip_ledger legs in this transaction disagree on how much moved'
                        END || '; first written in this transaction by: ' || COALESCE(r.value ->> 'q', '(unknown statement)'),
              HINT    = 'Every chip movement is written by its door as balance + leg in one transaction. If the door stood the autoledger down (app.ledger_autoskip_<table>), its own leg must equal the delta and name the same user, club, union, pool, table, tournament or ticket float. Nothing is corrected here; the transaction is refused whole.';
    END IF;

    INSERT INTO public.ca_ledger_invariant_findings
      (txid, account_key, balance_delta, ledger_net, mode, actor_service, db_role, statement)
    VALUES
      (pg_current_xact_id(), r.key, v_b, v_l, v_mode,
       current_setting('application_name', true), current_user,
       COALESCE(r.value ->> 'q', left(current_query(), 300)))
    ON CONFLICT (txid, account_key) DO UPDATE
      SET balance_delta = EXCLUDED.balance_delta,
          ledger_net    = EXCLUDED.ledger_net,
          found_at      = EXCLUDED.found_at,
          statement     = EXCLUDED.statement;
    RAISE WARNING 'OBSERVED: balance_moved_without_its_ledger_row account=% balance_delta=% ledger_net=% (store mode observe; this transaction would be refused)',
      r.key, v_b, v_l;
  END LOOP;

  /* NO BALANCE MOVES AGAINST SETTLEMENT SUSPENSE (2026-10-02). Every store
     above can balance and the chips still come from nowhere: a journal
     trigger whose writer declared no counterparty posts the store's leg
     against settlement_suspense, which holds no balance and is outside the
     supply count. A transaction that wrote a suspense leg may not move any
     covered balance. A journal-only suspense correction moves none. */
  v_s := round(COALESCE((t -> 'settlement_suspense' ->> 's')::numeric, 0), 2);
  IF v_s <> 0 THEN
    SELECT string_agg(e.key || ' ' || round((e.value ->> 'b')::numeric, 2)::text, ', ' ORDER BY e.key),
           sum(abs(round((e.value ->> 'b')::numeric, 2)))
      INTO v_moved, v_moved_abs
      FROM jsonb_each(t) e
     WHERE e.key <> 'settlement_suspense'
       AND round(COALESCE((e.value ->> 'b')::numeric, 0), 2) <> 0;

    IF v_moved IS NOT NULL THEN
      v_mode := COALESCE(
        (SELECT sm.mode FROM public.ca_ledger_invariant_store_mode sm WHERE sm.store = 'settlement_suspense'),
        (SELECT m.mode FROM public.ca_ledger_invariant_mode m LIMIT 1),
        'refuse');

      IF v_mode = 'refuse' THEN
        /* 20261002135708: recorded first, outside the rollback. */
        BEGIN
          PERFORM public.fn_ca_ledger_refusal_record(jsonb_build_object(
            'kind',          'balance_moved_against_settlement_suspense',
            'account_key',   'settlement_suspense',
            'store',         'settlement_suspense',
            'balance_delta', v_moved_abs,
            'ledger_net',    v_s,
            'mode',          v_mode,
            'moved',         left(v_moved, 2000),
            'first_writer',  left(COALESCE(t -> 'settlement_suspense' ->> 'q', '(unknown statement)'), 1000),
            'message',       format('REFUSED: balance_moved_against_settlement_suspense suspense_legs=%s moved=%s', v_s, left(v_moved, 1500))));
        EXCEPTION WHEN OTHERS THEN
          NULL;
        END;
        RAISE EXCEPTION 'REFUSED: balance_moved_against_settlement_suspense suspense_legs=% moved=%',
          v_s, v_moved
          USING ERRCODE = '23514',
                DETAIL  = 'this transaction wrote a chip_ledger leg against settlement_suspense, which holds no balance and is outside the supply count, and moved a covered chip balance; the suspense leg was first written by: '
                          || COALESCE(t -> 'settlement_suspense' ->> 'q', '(unknown statement)'),
                HINT    = 'A door names where its chips come from and go to: app.ledger_counterparty (+ app.ledger_counterparty_entity) before the balance write, or app.ledger_autoskip_<table> and its own leg. An undeclared journal trigger falls to settlement_suspense, and that is what is refused here. A journal-only correction that moves no balance is not affected.';
      END IF;

      INSERT INTO public.ca_ledger_invariant_findings
        (txid, account_key, balance_delta, ledger_net, mode, actor_service, db_role, statement)
      VALUES
        (pg_current_xact_id(), 'settlement_suspense', v_moved_abs, v_s, v_mode,
         current_setting('application_name', true), current_user,
         left(COALESCE(t -> 'settlement_suspense' ->> 'q', left(current_query(), 300)) || ' | moved: ' || v_moved, 1000))
      ON CONFLICT (txid, account_key) DO UPDATE
        SET balance_delta = EXCLUDED.balance_delta,
            ledger_net    = EXCLUDED.ledger_net,
            found_at      = EXCLUDED.found_at,
            statement     = EXCLUDED.statement;
      RAISE WARNING 'OBSERVED: balance_moved_against_settlement_suspense suspense_legs=% moved=% (mode observe; this transaction would be refused)',
        v_s, v_moved;
    END IF;
  END IF;

  PERFORM set_config('ca.ledger_tally_checked', v_ver, true);
  RETURN NULL;
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
  /* A COUNTERPARTY NAMES ITS COLUMN, AND A NEW DECLARATION FORGETS THE LAST
     ONE'S (2026-10-04). A union wallet holds six balances; the caller whose
     counterparty is one of them names it on app.ledger_counterparty_label
     after this call, and fn_ca_autoledger writes it on that side. */
  PERFORM set_config('app.ledger_counterparty_label', '', true);
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
CREATE OR REPLACE FUNCTION public.fn_ca_deleted_wallet_credit()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_club uuid;
BEGIN
 IF TG_TABLE_NAME='profiles' THEN
  FOR v_club IN SELECT club_id FROM public.club_members WHERE user_id=NEW.id ORDER BY club_id LOOP
   PERFORM public.fn_ca_deleted_wallet_bank_return(v_club,NEW.id,'wallets');
  END LOOP;
  RETURN NEW;
 END IF;
 IF EXISTS (SELECT 1 FROM public.profiles WHERE id=NEW.user_id AND status='deleted') THEN
  PERFORM public.fn_ca_deleted_wallet_bank_return(NEW.club_id,NEW.user_id,CASE WHEN TG_TABLE_NAME='agents' THEN 'agent_wallet' ELSE 'player_wallet' END);
 END IF;
 RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_issuance_leg_is_registered()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_outside text[] := public.fn_ca_noncirculating_chip_stores();
  v_pol public.ca_mint_policy%ROWTYPE;
  v_24h numeric;
BEGIN
  IF NEW.from_type = ANY (v_outside) AND NOT (NEW.to_type = ANY (v_outside))
     AND NEW.category <> 'correction' THEN
    SELECT * INTO v_pol FROM public.ca_mint_policy WHERE id = 1;
    IF NEW.amount > v_pol.per_operation_cap_chips THEN
      RAISE EXCEPTION 'issuance refused: % chips in one leg is over the per-operation ceiling of % (ca_mint_policy; raise it with a reason through fn_ca_mint_policy_set before a deliberate batch)',
        NEW.amount, v_pol.per_operation_cap_chips USING ERRCODE = 'P0403';
    END IF;
    v_24h := public.fn_ca_mint_issued_24h('chips', NEW.id) + NEW.amount;
    IF v_24h > v_pol.rolling_24h_cap_chips THEN
      RAISE EXCEPTION 'issuance refused: this leg would bring the last 24 hours to % chips, over the rolling ceiling of % (ca_mint_policy; raise it with a reason through fn_ca_mint_policy_set before a deliberate batch)',
        v_24h, v_pol.rolling_24h_cap_chips USING ERRCODE = 'P0403';
    END IF;
    -- 2026-10-02: chips enter circulation only under an operation key.
    IF NEW.idempotency_key IS NULL OR btrim(NEW.idempotency_key) = '' THEN
      RAISE EXCEPTION 'REFUSED: issuance_without_an_operation_key (% chips % -> %)', NEW.amount, NEW.from_type, NEW.to_type
        USING ERRCODE = '23514',
              HINT = 'Mint through a door that keys its leg: fn_ca_mint, fn_ca_fund_club, or a declared write with fn_ca_declare_ledger(..., p_idempotency_key).';
    END IF;
  END IF;
  PERFORM public.fn_ca_register_issuance_leg(NEW.id);
  -- 2026-10-02: the house mints and burns only through a door that writes its
  -- own register row with its reason. A hand-declared system_mint has none.
  IF (NEW.from_type IN ('system_mint', 'system_burn') OR NEW.to_type IN ('system_mint', 'system_burn'))
     AND NEW.category <> 'correction'
     AND NOT EXISTS (SELECT 1 FROM public.ca_mint_ledger m
                      WHERE m.chip_ledger_id = NEW.id AND m.op_id NOT LIKE 'ledger:%') THEN
    RAISE EXCEPTION 'REFUSED: house_issuance_without_its_door (% chips % -> %)', NEW.amount, NEW.from_type, NEW.to_type
      USING ERRCODE = '23514',
            HINT = 'House funding goes through fn_ca_fund_club(club, amount, reason, key), which records its reason in ca_mint_ledger.';
  END IF;
  RETURN NULL;
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_restore_erased_seat_credit(p_key text, p_user_id uuid, p_club_id uuid, p_amount numeric, p_table_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_inserted integer; v_after numeric; v_ledger uuid; v_supply numeric; v_label text;
BEGIN
  IF NOT (current_user IN ('postgres', 'service_role')) THEN
    RAISE EXCEPTION 'fn_ca_restore_erased_seat_credit is operator/service only';
  END IF;
  IF p_key IS NULL OR p_user_id IS NULL OR p_club_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'key, user, club and a positive amount are required';
  END IF;

  -- One restoration per erased credit, ever.
  INSERT INTO public.wallet_credit_idempotency (key, user_id, amount)
  VALUES (p_key, p_user_id, p_amount)
  ON CONFLICT (key) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN jsonb_build_object('restored', false, 'reason', 'already_restored', 'key', p_key);
  END IF;

  PERFORM public.fn_ensure_club_wallet(p_user_id, p_club_id);

  /* The chips were destroyed by an un-journalled overwrite of the felt (the
     meter recorded that hour as unexplained negative drift). Giving them back
     is issuance, labelled as such: issuance_reserve -> player_wallet, so the
     meter reads a mint with a reason, not a second unexplained move. */
  PERFORM public.fn_ca_declare_ledger('refund', 'issuance_reserve', NULL, NULL, p_key, NULL);
  UPDATE public.club_members
     SET chip_balance = COALESCE(chip_balance, 0) + p_amount, updated_at = now()
   WHERE user_id = p_user_id AND club_id = p_club_id
   RETURNING chip_balance INTO v_after;
  IF v_after IS NULL THEN
    RAISE EXCEPTION 'no club wallet for player % in club %', p_user_id, p_club_id;
  END IF;

  INSERT INTO public.chip_transactions (club_id, to_user_id, amount, transaction_type, notes, table_id, balance_after, metadata)
  VALUES (p_club_id, p_user_id, p_amount, 'seat_credit_restored', p_reason, p_table_id, v_after,
          jsonb_build_object('restore_key', p_key, 'source', 'issuance_reserve'));

  SELECT id INTO v_ledger FROM public.chip_ledger
   WHERE idempotency_key = p_key ORDER BY created_at DESC LIMIT 1;
  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0) + p_amount
    INTO v_supply FROM public.ca_mint_ledger WHERE asset = 'chips';
  SELECT COALESCE(NULLIF(btrim(p.username), ''), p.full_name, p.id::text)
    INTO v_label FROM public.profiles p WHERE p.id = p_user_id;
  BEGIN
    INSERT INTO public.ca_mint_ledger
      (op_id, action, asset, holder_type, holder_id, holder_label, amount,
       balance_before, balance_after, supply_after, reason, performed_by, performed_by_label, chip_ledger_id)
    VALUES (p_key, 'mint', 'chips', 'player', p_user_id, v_label, p_amount,
            v_after - p_amount, v_after, v_supply, p_reason, NULL, current_user, v_ledger);
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  RETURN jsonb_build_object('restored', true, 'key', p_key, 'user_id', p_user_id,
                            'club_id', p_club_id, 'amount', p_amount, 'balance_after', v_after,
                            'chip_ledger_id', v_ledger);
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_club_members_ledger_writer()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_original_ledger uuid;
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

  /* RAKEBACK IS NOT JOURNALLED FROM HERE (2026-09-21). This trigger takes the
     category from app.ledger_category and the counterparty from
     app.ledger_counterparty, and it knows no period, certificate, payout row,
     settlement run or document. On 2026-09-14 that produced 420 anonymous
     rakeback legs moving 84,041.00 into 420 player wallets with no invoice, no
     receipt and no run to tie them to. Rakeback is paid by
     public.fn_settle_accounting_rakeback_stage, which stands this journal down
     with app.ledger_autoskip_club_members and writes its own leg carrying all
     of those facts. A caller that reaches this line with rakeback declared is
     by construction a caller that has none of them, so it refuses instead of
     minting an anonymous twin. The 420 historical rows are left exactly as
     they are. */
  IF cat = 'rakeback' THEN
    RAISE EXCEPTION 'rakeback_requires_accounting_authority'
      USING ERRCODE = '42501',
            DETAIL  = 'club_members.chip_balance moved under app.ledger_category=rakeback outside public.fn_settle_accounting_rakeback_stage',
            HINT    = 'The weekly accounting authority stands this journal down with app.ledger_autoskip_club_members and writes its own documented, period- and run-identified rakeback leg.';
  END IF;

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
      'auto-audited club_members.chip_balance delta ' || d::text)
    RETURNING id INTO v_original_ledger;
    -- Private original-debit callers read this immediately after their UPDATE.
    PERFORM set_config('app.cash_original_debit_ledger',v_original_ledger::text,true);

  EXCEPTION WHEN OTHERS THEN
      -- A journal failure must abort the enclosing chip movement.
      -- Preserve SQLSTATE so the existing caller can retry the whole operation.
      RAISE;
    END;

  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_ensure_club_wallet(p_user_id uuid, p_club_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.club_members cm
     WHERE cm.user_id = p_user_id AND cm.club_id = p_club_id
       AND cm.status IN ('active', 'approved')
  );
$function$;
CREATE OR REPLACE FUNCTION public.fn_platform_frozen()
 RETURNS boolean
 LANGUAGE sql
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
           SELECT 1
             FROM public.engine_maintenance_break b
            WHERE b.enforce_freeze
              AND b.announced_at < clock_timestamp() + INTERVAL '30 seconds'
              AND (
                (
                  b.phase = 'last_hand'
                  AND b.break_started_at IS NULL
                  AND b.break_ends_at IS NULL
                  AND b.announced_at + INTERVAL '2 minutes' <= clock_timestamp()
                )
                OR (
                  b.phase = 'counting_down'
                  AND b.break_started_at IS NOT NULL
                  AND b.break_ends_at IS NOT NULL
                  AND b.break_started_at >= b.announced_at
                  AND b.break_ends_at > b.break_started_at
                  AND b.break_ends_at < b.announced_at + INTERVAL '15 minutes'
                )
              )
         )
         OR COALESCE(
           public.fn_active_maintenance_release_boundary() > clock_timestamp(),
           false
         );
$function$;
CREATE OR REPLACE FUNCTION public.fn_active_maintenance_release_boundary()
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth', 'pg_temp'
AS $function$
DECLARE
  c_required_steps CONSTANT text[] := ARRAY[
    'sit_out_at','hold_expires_at','addon_period_ends_at','reversible_until',
    'reveal_deadline_at','rebuy_prompt_until','bomb_pot_next_due_at',
    'cash_stay_last_tick_at','cash_rejoin_expires_at','level_started_at',
    'cluster_break_eligible_since','cluster_move_expires_at',
    'reconnect_presence','reconnect_snapshots'
  ];
  v_request_role text := NULLIF(btrim(COALESCE(auth.role(), '')), '');
  v_trusted_database_actor boolean;
  v_release_target timestamptz;
BEGIN
  -- supabase_auth_admin added 2026-09-10: it is GoTrue's own database role
  -- (the signup triggers run as it), never a browser. Without it every signup
  -- wallet trigger raised 42501 here (signup_errors id 9318).
  SELECT session_user IN ('postgres', 'supabase_admin', 'service_role', 'supabase_auth_admin')
         OR COALESCE(r.rolsuper, false)
         -- Supabase CLI session roles may SET ROLE postgres. Trust that
         -- catalog privilege, never a login-name prefix or a JWT workaround.
         OR pg_catalog.pg_has_role(session_user, 'postgres', 'SET')
    INTO v_trusted_database_actor
    FROM (SELECT session_user AS role_name) s
    LEFT JOIN pg_catalog.pg_roles r ON r.rolname = s.role_name;

  IF v_request_role IS NOT NULL
     AND v_request_role NOT IN ('anon', 'authenticated', 'service_role') THEN
    RAISE EXCEPTION 'MAINTENANCE_RELEASE_CERTIFICATE_CALLER_REFUSED'
      USING ERRCODE = '42501';
  END IF;
  IF v_request_role IS NULL AND NOT COALESCE(v_trusted_database_actor, false) THEN
    RAISE EXCEPTION 'MAINTENANCE_RELEASE_CERTIFICATE_CALLER_REQUIRED'
      USING ERRCODE = '42501';
  END IF;

  -- PERF (2026-09-10, swarm A): OFFSET 0 is an optimisation fence. Without it
  -- the planner evaluated `shifted ?& c_required_steps` first on every row of
  -- engine_maintenance_thaws (167 rows, 0 of them contract_version 3) on every
  -- money write that reaches fn_platform_frozen: 229 us -> 32 us per call.
  -- Same four quals, same max(); the jsonb quals now only see rows that already
  -- passed contract_version = 3 AND release_target_at > clock_timestamp().
  SELECT max(t.release_target_at) INTO v_release_target
    FROM (SELECT t.release_target_at, t.shifted
            FROM public.engine_maintenance_thaws t
           WHERE t.contract_version = 3
             AND t.release_target_at > clock_timestamp()
          OFFSET 0) t
   WHERE COALESCE((t.shifted->>'complete')::boolean, false)
     AND t.shifted ?& c_required_steps;
  RETURN v_release_target;
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_assert_emergency_path(p_path text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE active boolean;
BEGIN
 IF p_path IS NULL OR p_path NOT IN('tournament_registration','positive_issuance','cashout')
 THEN RAISE EXCEPTION 'unknown_emergency_path' USING ERRCODE='22023'; END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('ca-emergency-stop:'||p_path,0));
 SELECT stopped INTO active FROM public.ca_emergency_stops WHERE path=p_path FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'emergency_stop_authority_missing' USING ERRCODE='55000'; END IF;
 IF active THEN RAISE EXCEPTION 'emergency_path_stopped:%',p_path USING ERRCODE='P0410'; END IF;
END $function$;
CREATE OR REPLACE FUNCTION public.fn_ca_current_epoch()
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$ SELECT id FROM public.ca_financial_epochs WHERE is_current LIMIT 1 $function$;
CREATE OR REPLACE FUNCTION public.fn_ca_deleted_wallet_bank_return(p_club uuid, p_user uuid, p_source text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET lock_timeout TO '4s'
AS $function$
DECLARE
 v_player numeric:=0; v_agent numeric:=0; v_bank numeric; v_owner uuid;
 v_op uuid; v_amount numeric; v_source text; v_key text; v_saved jsonb:='{}'::jsonb;
 v_keys text[]:=ARRAY['app.ledger_category','app.ledger_counterparty',
 'app.ledger_counterparty_entity','app.ledger_counterparty_label','app.ledger_settlement',
 'app.ledger_idempotency_key','app.ledger_correlation','app.ledger_tournament','app.cash_original_debit_ledger','app.ledger_autoskip_clubs',
 'app.ledger_autoskip_club_members','app.ledger_autoskip_agents'];
BEGIN
 PERFORM 1 FROM public.profiles WHERE id=p_user AND status='deleted' FOR SHARE;
 IF NOT FOUND THEN
  RETURN jsonb_build_object('success',false,'reason','account_not_deleted');
 END IF;
 IF p_source NOT IN ('wallets','player_wallet','agent_wallet') OR p_source IS NULL THEN RAISE EXCEPTION 'unknown_deleted_wallet_source'; END IF;
 -- Agent-first for the explicit two-wallet lifecycle return. A live credit
 -- takes only its already-owned source row, never the other wallet.
 IF p_source IN ('wallets','agent_wallet') THEN
  SELECT greatest(coalesce(agent_wallet_balance,0),0) INTO v_agent
  FROM public.agents WHERE club_id=p_club AND user_id=p_user FOR UPDATE;
 END IF;
 IF p_source IN ('wallets','player_wallet') THEN
  SELECT greatest(coalesce(chip_balance,0)-coalesce(held_chips,0)-coalesce(locked_chips,0),0)
  INTO v_player FROM public.club_members WHERE club_id=p_club AND user_id=p_user FOR UPDATE;
 END IF;
 v_player:=coalesce(v_player,0); v_agent:=coalesce(v_agent,0);
 SELECT chip_treasury,owner_id INTO v_bank,v_owner FROM public.clubs
 WHERE id=p_club AND asset='chips' AND lifecycle_status='active' FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'reason','not_active_chip_club'); END IF;
 IF v_player+v_agent=0 THEN RETURN jsonb_build_object('success',true,'amount',0); END IF;
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'platform_is_frozen'; END IF;
 FOREACH v_key IN ARRAY v_keys LOOP
  v_saved:=v_saved||jsonb_build_object(v_key,coalesce(current_setting(v_key,true),''));
 END LOOP;
 FOREACH v_source IN ARRAY ARRAY['player_wallet','agent_wallet'] LOOP
  v_amount:=CASE WHEN v_source='player_wallet' THEN v_player ELSE v_agent END;
  IF v_amount=0 THEN CONTINUE; END IF;
  v_op:=gen_random_uuid();
  PERFORM set_config('app.ledger_autoskip_club_members','',true);
  PERFORM set_config('app.ledger_autoskip_agents','',true);
  PERFORM public.fn_ca_declare_ledger('club_bank_claim','club_treasury',p_club,NULL,
   'deleted_account_bank_return:'||v_op,ARRAY['clubs']);
  PERFORM set_config('app.ledger_correlation',v_op::text,true);
  PERFORM set_config('app.ledger_settlement','',true);
  PERFORM set_config('app.ledger_tournament','',true);
  IF v_source='player_wallet' THEN
   UPDATE public.club_members SET chip_balance=chip_balance-v_amount,updated_at=now()
   WHERE club_id=p_club AND user_id=p_user;
  ELSE
   UPDATE public.agents SET agent_wallet_balance=agent_wallet_balance-v_amount,updated_at=now()
   WHERE club_id=p_club AND user_id=p_user;
  END IF;
  UPDATE public.clubs SET chip_treasury=coalesce(chip_treasury,0)+v_amount,updated_at=now()
  WHERE id=p_club RETURNING chip_treasury INTO v_bank;
  INSERT INTO public.chip_transactions
   (club_id,from_user_id,to_user_id,amount,transaction_type,notes,metadata,balance_after)
  VALUES(p_club,p_user,v_owner,v_amount,'club_bank_claim','Deleted Account Chips Returned To Club Bank',
   jsonb_build_object('op_id',v_op,'source',v_source,'direction','into_bank',
    'reason','deleted_account','bank_after',v_bank),v_bank);
 END LOOP;
 FOREACH v_key IN ARRAY v_keys LOOP PERFORM set_config(v_key,v_saved->>v_key,true); END LOOP;
 RETURN jsonb_build_object('success',true,'amount',v_player+v_agent,
  'player_chips',v_player,'agent_chips',v_agent,'bank_after',v_bank);
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_ledger_tally_add(p_key text, p_side text, p_delta numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  t jsonb;
  e jsonb;
  v numeric;
BEGIN
  /* The tally lives in a transaction-local setting, so it is undone with the
     transaction and with any subtransaction (a plpgsql EXCEPTION block) that
     rolls back the write it counted. A SET clause on a function restores only
     the variables it names at exit (measured on production 2026-10-01: a
     set_config(..., true) made inside a SET search_path function was still
     set after it returned), so pinning search_path here does not lose the
     tally. Every object is named by schema regardless. */
  IF p_key IS NULL OR p_delta IS NULL OR round(p_delta, 2) = 0 THEN
    RETURN;
  END IF;
  t := COALESCE(NULLIF(current_setting('ca.ledger_tally', true), '')::jsonb, '{}'::jsonb);
  e := COALESCE(t -> p_key, '{"b":0,"l":0}'::jsonb);
  IF NOT (e ? 'q') THEN
    -- The top-level statement that first touched this account in this
    -- transaction: the name of the door, for the refusal and the finding
    -- (CLAUDE.md 10.86: a refusal names its writer).
    e := e || jsonb_build_object('q', left(COALESCE(current_query(), ''), 300));
  END IF;
  v := round(COALESCE((e ->> p_side)::numeric, 0) + p_delta, 2);
  e := jsonb_set(e, ARRAY[p_side], to_jsonb(v), true);
  t := t || jsonb_build_object(p_key, e);
  PERFORM set_config('ca.ledger_tally', t::text, true);
  PERFORM set_config('ca.ledger_tally_ver',
                     (COALESCE(NULLIF(current_setting('ca.ledger_tally_ver', true), ''), '0')::bigint + 1)::text,
                     true);
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_ledger_tally_key(p_type text, p_entity uuid, p_club uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_union uuid;
  v_club uuid;
BEGIN
  /* The account a ledger side belongs to, in the covered set, or NULL when the
     side is not a chip store. The conventions are the ones every live writer
     already meets (measured 2026-10-01, seven days, 1,946,078 legs; extended
     2026-10-02 over the same seven days): a player_wallet leg names the user
     and the club; a union leg names the wallet row (fn_ca_autoledger) or the
     union (a declaring payer); a bbj_pool leg names the pool row; a
     table_stack leg names the table; a promo or agent leg names its holder
     (user, club or union); a club wallet or insurance leg names the
     club_wallets row or the club; a spin_reserve leg names the pool (10 of 10
     entities in seven days); a prize or bounty liability leg names the
     tournament (20,169 of 20,169 entities in a day, every one with an escrow
     row); a ticket escrow leg names the ticket, and every issued ticket is one
     float (fn_ca_ticket_escrow_float). */
  CASE p_type
    WHEN 'player_wallet' THEN
      RETURN 'player_wallet:' || COALESCE(p_entity::text, 'null') || ':' || COALESCE(p_club::text, 'null');
    WHEN 'club_treasury' THEN
      RETURN 'club_treasury:' || COALESCE(p_entity::text, 'null');
    WHEN 'table_stack' THEN
      IF p_entity IS NULL OR public.fn_ca_felt_counts_table(p_entity) THEN
        RETURN 'table_stack';
      END IF;
      RETURN NULL;  -- a tournament or Diamond table is not on the cash felt
    WHEN 'union_bank', 'union_wallet' THEN
      SELECT w.union_id INTO v_union FROM public.union_wallets w WHERE w.id = p_entity;
      RETURN p_type || ':' || COALESCE(v_union, p_entity)::text;
    WHEN 'bbj_pool' THEN
      RETURN 'bbj_pool:' || COALESCE(p_entity::text, 'null');
    -- 2026-10-02: every remaining chip store
    WHEN 'promo_wallet', 'agent_wallet' THEN
      RETURN p_type || ':' || COALESCE(p_entity::text, 'null');
    WHEN 'club_wallet', 'insurance_bank' THEN
      SELECT cw.club_id INTO v_club FROM public.club_wallets cw WHERE cw.id = p_entity;
      RETURN p_type || ':' || COALESCE(COALESCE(v_club, p_entity)::text, 'null');
    WHEN 'spin_reserve' THEN
      RETURN 'spin_reserve:' || COALESCE(p_entity::text, 'null');
    WHEN 'prize_liability', 'bounty_liability' THEN
      IF p_entity IS NOT NULL AND NOT public.fn_ca_tournament_counts(p_entity) THEN
        RETURN NULL;  -- a Diamond event's liability is Diamonds in custody
      END IF;
      RETURN 'tournament_liability:' || COALESCE(p_entity::text, 'null');
    WHEN 'escrow' THEN
      RETURN 'ticket_escrow';
    WHEN 'opening_setup', 'leaderboard_round' THEN
      RETURN p_type || ':' || COALESCE(p_entity::text, 'null');
    ELSE
      RETURN NULL;
  END CASE;
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_mint_issued_24h(p_asset text, p_except_leg uuid DEFAULT NULL::uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(sum(m.amount), 0)
    FROM public.ca_mint_ledger m
   WHERE m.asset = p_asset AND m.action = 'mint'
     AND m.origin <> 'baseline'
     AND m.created_at > now() - interval '24 hours'
     AND (p_except_leg IS NULL OR m.chip_ledger_id IS DISTINCT FROM p_except_leg);
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_noncirculating_chip_stores()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT ARRAY['system_mint', 'system_burn', 'issuance_reserve', 'chip_retirement']::text[];
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_register_issuance_leg(p_ledger_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  l record; v_action text; v_holder_type text; v_holder uuid; v_label text;
  v_before numeric; v_after numeric; v_supply numeric; v_reason text; v_op text;
  v_outside text[] := public.fn_ca_noncirculating_chip_stores();
BEGIN
  SELECT * INTO l FROM public.chip_ledger WHERE id = p_ledger_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.ca_mint_ledger m WHERE m.chip_ledger_id = l.id) THEN
    RETURN false;
  END IF;
  IF l.category = 'correction' AND l.metadata->>'posted_via' = 'fn_ca_post_correction' THEN
    RETURN false;  -- a correction moves no balance (a_correction_is_not_a_mint)
  END IF;
  IF l.from_type = ANY (v_outside) AND NOT (l.to_type = ANY (v_outside)) THEN
    v_action := 'mint'; v_holder := l.to_entity_id;
    v_holder_type := CASE l.to_type
      WHEN 'club_treasury' THEN 'club' WHEN 'club_wallet' THEN 'club'
      WHEN 'union_bank' THEN 'union' WHEN 'union_wallet' THEN 'union'
      WHEN 'player_wallet' THEN 'player' WHEN 'promo_wallet' THEN 'player'
      ELSE 'circulation' END;
  ELSIF l.to_type = ANY (v_outside) AND NOT (l.from_type = ANY (v_outside)) THEN
    v_action := 'burn'; v_holder := l.from_entity_id;
    v_holder_type := CASE l.from_type
      WHEN 'club_treasury' THEN 'club' WHEN 'club_wallet' THEN 'club'
      WHEN 'union_bank' THEN 'union' WHEN 'union_wallet' THEN 'union'
      WHEN 'player_wallet' THEN 'player' WHEN 'promo_wallet' THEN 'player'
      ELSE 'circulation' END;
  ELSE
    RETURN false;  -- store to store, or circulating to circulating
  END IF;
  -- The autoledger stamps a union wallet's row with the union id; a union is
  -- also a row in clubs (is_union), so resolve by what the id actually is.
  IF v_holder_type = 'club' AND EXISTS (SELECT 1 FROM public.clubs c WHERE c.id = v_holder AND COALESCE(c.is_union, false)) THEN
    v_holder_type := 'union';
  END IF;
  IF v_holder IS NULL THEN
    v_holder_type := 'circulation';
  END IF;
  IF v_holder_type = 'circulation' THEN
    v_holder := '00000000-0000-0000-0000-00000000c1c0';  -- the circulation sentinel (the house is ...d1a0)
  END IF;
  v_label := CASE v_holder_type
    WHEN 'club'   THEN (SELECT c.name FROM public.clubs c WHERE c.id = v_holder)
    WHEN 'union'  THEN COALESCE((SELECT u.name FROM public.unions u WHERE u.id = v_holder), (SELECT c.name FROM public.clubs c WHERE c.id = v_holder))
    WHEN 'player' THEN (SELECT COALESCE(NULLIF(btrim(p.username), ''), p.full_name, p.id::text) FROM public.profiles p WHERE p.id = v_holder)
    ELSE 'circulation' END;
  -- A leg written by hand (a linked compensating entry) carries no balances;
  -- the register still wants a pair, so the pair is the amount itself.
  /* A door that wrote its own register row but did not link the leg
     (fn_ca_burn looks the leg up by a shape it does not always match):
     adopt that row rather than write a second one. Same action, holder,
     amount, asset, within five seconds of the leg, not yet linked. */
  UPDATE public.ca_mint_ledger m
     SET chip_ledger_id = l.id
   WHERE m.id = (SELECT m2.id FROM public.ca_mint_ledger m2
                  WHERE m2.chip_ledger_id IS NULL AND m2.asset = 'chips' AND m2.action = v_action
                    AND m2.amount = l.amount AND m2.holder_id = v_holder
                    AND m2.created_at BETWEEN l.created_at - interval '5 seconds' AND l.created_at + interval '5 seconds'
                  ORDER BY m2.created_at LIMIT 1);
  IF FOUND THEN RETURN false; END IF;
  v_before := COALESCE(CASE WHEN v_action = 'mint' THEN l.pre_to_balance ELSE l.pre_from_balance END, 0);
  v_after  := COALESCE(CASE WHEN v_action = 'mint' THEN l.post_to_balance ELSE l.post_from_balance END,
                       v_before + CASE WHEN v_action = 'mint' THEN l.amount ELSE -l.amount END);
  SELECT COALESCE(SUM(CASE WHEN action = 'mint' THEN amount ELSE -amount END), 0)
       + CASE WHEN v_action = 'mint' THEN l.amount ELSE -l.amount END
    INTO v_supply FROM public.ca_mint_ledger WHERE asset = 'chips';
  v_op := 'ledger:' || l.id::text;
  v_reason := left(COALESCE(NULLIF(btrim(l.description), ''), l.category) || ' (' || l.category
              || CASE WHEN l.idempotency_key IS NOT NULL THEN ', key ' || l.idempotency_key ELSE '' END
              || '; registered from the journal leg)', 500);
  IF length(btrim(v_reason)) < 10 THEN v_reason := v_reason || ' - registered from the journal'; END IF;
  INSERT INTO public.ca_mint_ledger
    (op_id, action, asset, holder_type, holder_id, holder_label, amount,
     balance_before, balance_after, supply_after, reason, performed_by, performed_by_label, db_role, chip_ledger_id, created_at)
  VALUES (v_op, v_action, 'chips', v_holder_type, v_holder, v_label, l.amount,
          v_before, v_after, v_supply, v_reason, l.performed_by, COALESCE(l.actor_service, l.db_role), l.db_role, l.id, l.created_at)
  ON CONFLICT (op_id) DO NOTHING;
  RETURN true;
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_tally_pair(p_k_old text, p_v_old numeric, p_k_new text, p_v_new numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  /* One balance column of one row, before and after. A row that changes
     account (a membership changing club, a ticket leaving 'issued') leaves one
     account and arrives in another; both sides are counted. A NULL key is a
     side that does not exist (an INSERT's OLD, a DELETE's NEW, a Diamond
     event), and fn_ca_ledger_tally_add ignores it. */
  IF p_k_old IS NOT DISTINCT FROM p_k_new THEN
    PERFORM public.fn_ca_ledger_tally_add(p_k_new, 'b', COALESCE(p_v_new, 0) - COALESCE(p_v_old, 0));
  ELSE
    PERFORM public.fn_ca_ledger_tally_add(p_k_old, 'b', -COALESCE(p_v_old, 0));
    PERFORM public.fn_ca_ledger_tally_add(p_k_new, 'b', COALESCE(p_v_new, 0));
  END IF;
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_cashier_assert_active_actor(p_club uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_role text;
  v_status text;
BEGIN
  IF auth.role() = 'service_role' THEN RETURN; END IF;
  IF v_actor IS NULL OR p_club IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM public.clubs WHERE id = p_club AND owner_id = v_actor) THEN
    RETURN;
  END IF;

  SELECT role INTO v_role
    FROM public.club_members
   WHERE club_id = p_club
     AND user_id = v_actor
     AND coalesce(status, 'active') IN ('active', 'approved')
   LIMIT 1;

  IF v_role IN ('super_agent', 'agent', 'sub_agent') THEN
    -- Serialize against status changes without taking a row lock ahead of the
    -- retained money core's established wallet/club lock order. The matching
    -- agents trigger below takes this same mutex before status/update/delete.
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'cashier-agent-authority:' || p_club || ':' || v_actor, 0));
    SELECT a.status INTO v_status
      FROM public.agents a
     WHERE a.club_id = p_club AND a.user_id = v_actor;
    IF v_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'cashier_agent_inactive' USING ERRCODE = '42501';
    END IF;
  END IF;
END
$function$;
CREATE OR REPLACE FUNCTION public.fn_freeze_bypass_active()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(current_setting('app.freeze_bypass', TRUE), '') = 'on';
$function$;
CREATE OR REPLACE FUNCTION auth.role()
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$function$;
CREATE OR REPLACE FUNCTION auth.uid()
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_assert_player_action(p_user_id uuid, p_scope text, p_source text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE v_enforced boolean; v_restriction public.ca_player_restrictions;
BEGIN
  IF p_user_id IS NULL THEN RETURN; END IF;
  IF p_scope NOT IN ('account','cash','tournaments','transfers','social') THEN
    RAISE EXCEPTION 'unknown_player_restriction_scope' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text,731));
  SELECT restrictions_enforced INTO v_enforced FROM public.ca_operator_policy WHERE id=true FOR SHARE;
  SELECT * INTO v_restriction FROM public.ca_player_restrictions
    WHERE user_id=p_user_id AND status='active'
      AND (expires_at IS NULL OR expires_at > statement_timestamp())
      AND scope IN ('account',p_scope) ORDER BY applied_at,id LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_enforced IS TRUE THEN
    RAISE EXCEPTION 'PLAYER_RESTRICTED: %',p_scope USING ERRCODE='42501';
  END IF;
  INSERT INTO public.ca_restriction_observations
    (user_id,scope,restriction_id,table_name,op,would_refuse,detail)
    VALUES(p_user_id,p_scope,v_restriction.id,p_source,'ACTION',true,
      jsonb_build_object('reason_code',v_restriction.reason_code,'restriction_scope',v_restriction.scope));
EXCEPTION WHEN insufficient_privilege THEN RAISE;
  WHEN OTHERS THEN
    -- Preserve PHASE4-CONTRACTS section 0: restriction lookup failures fail open.
    -- Session authentication and financial stops have separate fail-closed owners.
    RETURN;
END $function$;
CREATE OR REPLACE FUNCTION public.fn_ca_chip_store_declared()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_missing text;
BEGIN
  SELECT s INTO v_missing FROM (VALUES (NEW.from_type), (NEW.to_type)) v(s)
   WHERE s IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.ca_chip_store_coverage g WHERE g.store = s)
   LIMIT 1;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'REFUSED: chip store % is not declared in ca_chip_store_coverage', v_missing
      USING ERRCODE = '23514',
            DETAIL  = 'A store the supply basis has never heard of would move chips out of the meter '
                   || 'silently, which is exactly the five supply incidents of 2026-09-11.',
            HINT    = 'Declare it first: INSERT INTO public.ca_chip_store_coverage (store, treatment, counted_by, notes) '
                   || 'VALUES (' || quote_literal(v_missing) || ', ''counted''|''noncirculating''|''uncounted'', '
                   || '<which fn_ca_supply_snapshot component holds it>, <why>). '
                   || 'If it is counted, add it to the basis in the same migration.';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_felt_counts_table(p_table uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  /* The felt account is the cash chip felt: a table with no tournament whose
     club is not the Diamond Arena. Exactly fn_ca_supply_snapshot's definition. */
  SELECT EXISTS (
    SELECT 1
      FROM public.tables t
      LEFT JOIN public.clubs c ON c.id = t.club_id
     WHERE t.id = p_table
       AND t.tournament_id IS NULL
       AND COALESCE(c.asset, 'chips') <> 'diamonds');
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_tournament_counts(p_tournament uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  /* Exactly fn_ca_supply_snapshot's tournament_liability scope: an event whose
     club is the Diamond Arena holds Diamonds in custody, never chips. */
  SELECT NOT EXISTS (
    SELECT 1
      FROM public.tournaments t
      JOIN public.clubs c ON c.id = t.club_id
     WHERE t.id = p_tournament
       AND c.asset = 'diamonds');
$function$;
CREATE OR REPLACE FUNCTION public.fn_club_settlement_frozen(p_club_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT c.settlement_locked
       AND (c.settlement_lock_until IS NULL OR c.settlement_lock_until > now())
       FROM clubs c WHERE c.id = p_club_id),
    false);
$function$;
CREATE OR REPLACE FUNCTION public.fn_union_week_start(p_at timestamp with time zone DEFAULT now())
 RETURNS timestamp with time zone
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'extensions'
AS $function$
  SELECT date_trunc('week', (p_at AT TIME ZONE 'America/Los_Angeles'))
           AT TIME ZONE 'America/Los_Angeles';
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_emergency_issuance_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE leg public.chip_ledger%ROWTYPE; parts text[]; week_start timestamptz; week_end timestamptz; retired numeric;
BEGIN
 -- The authoritative supply register covers every journal-origin issuer,
 -- bridge mint, opening grant and operator mint. A refund within circulating
 -- stores creates no mint row. A burn, correction or transfer is not issuance.
 IF NEW.asset IN('chips','diamonds') AND NEW.action='mint' AND NEW.amount>0 THEN
  IF EXISTS(SELECT 1 FROM public.ca_emergency_refund_provenance p WHERE p.asset=NEW.asset AND p.state='consumed'
   AND p.journal_id=COALESCE(NEW.chip_ledger_id,NEW.diamond_tx_id) AND p.amount=NEW.amount) THEN RETURN NEW; END IF;
  -- A standalone club is owed the rake it already retired. This existing
  -- bank restores an immutable week's receipts, rather than discretionary
  -- supply. Prove its exact key, journal direction and closed-week amount;
  -- neither a caller's reason nor an ambient setting can claim exemption.
  parts:=regexp_match(NEW.op_id,'^standalone-rake-bank:([0-9a-f-]{36}):([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)\.\.([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)$');
  IF NEW.asset='chips' AND parts IS NOT NULL AND parts[1]=NEW.holder_id::text AND NEW.holder_type='club' THEN
   SELECT * INTO leg FROM public.chip_ledger WHERE id=NEW.chip_ledger_id;
   week_start:=parts[2]::timestamptz; week_end:=parts[3]::timestamptz;
   IF leg.id IS NOT NULL AND leg.from_type='system_mint' AND leg.to_type='club_treasury'
    AND leg.to_entity_id=NEW.holder_id AND leg.amount=NEW.amount AND leg.idempotency_key=NEW.op_id AND leg.category='mint'
    AND week_start=public.fn_union_week_start(week_start) AND week_end=public.fn_union_week_start(week_start+interval '8 days')
    AND week_end<=public.fn_union_week_start(clock_timestamp())
    AND EXISTS(SELECT 1 FROM public.clubs WHERE id=NEW.holder_id AND is_union IS NOT TRUE) THEN
    SELECT COALESCE((SELECT sum(b.amount) FROM public.accounting_cash_bank_receipts b WHERE b.union_id IS NULL AND b.club_id=NEW.holder_id
     AND b.club_ledger_id IS NOT NULL AND b.banked_at>=week_start AND b.banked_at<week_end),0)
     +COALESCE((SELECT sum(s.amount) FROM public.tournament_rake_settlements s WHERE s.destination='chip_retirement:'||NEW.holder_id::text
      AND s.settled_at>=week_start AND s.settled_at<week_end),0) INTO retired;
    IF retired=NEW.amount THEN RETURN NEW; END IF;
   END IF;
  END IF;
  PERFORM public.fn_ca_assert_emergency_path('positive_issuance');
 END IF;
 RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION public.fn_ca_mint_register_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_reason text := NULLIF(current_setting('app.ledger_maintenance', true), '');
BEGIN
  -- The one permitted update: linking a row to its journal leg.
  IF TG_OP = 'UPDATE'
     AND OLD.chip_ledger_id IS NULL AND NEW.chip_ledger_id IS NOT NULL
     AND NEW.op_id IS NOT DISTINCT FROM OLD.op_id
     AND NEW.action IS NOT DISTINCT FROM OLD.action
     AND NEW.asset IS NOT DISTINCT FROM OLD.asset
     AND NEW.holder_type IS NOT DISTINCT FROM OLD.holder_type
     AND NEW.holder_id IS NOT DISTINCT FROM OLD.holder_id
     AND NEW.amount IS NOT DISTINCT FROM OLD.amount
     AND NEW.balance_before IS NOT DISTINCT FROM OLD.balance_before
     AND NEW.balance_after IS NOT DISTINCT FROM OLD.balance_after
     AND NEW.supply_after IS NOT DISTINCT FROM OLD.supply_after
     AND NEW.reason IS NOT DISTINCT FROM OLD.reason
     AND NEW.performed_by IS NOT DISTINCT FROM OLD.performed_by
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
     AND NEW.diamond_tx_id IS NOT DISTINCT FROM OLD.diamond_tx_id THEN
    RETURN NEW;
  END IF;

  IF v_reason IS NOT NULL THEN
    INSERT INTO public.ca_ledger_mutation_log
      (source_table, operation, db_role, application, reason, old_row, new_row)
    VALUES (TG_TABLE_NAME, TG_OP, current_user,
            current_setting('application_name', true), v_reason,
            to_jsonb(OLD), CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(NEW) END);
    BEGIN
      PERFORM public.fn_ca_raise_drift_incident(
        'fn_ca_mint_register_append_only', 'unauthorized_adjustment', 'warning',
        'register-bypass:' || TG_OP || ':' || split_part(v_reason, ':', 1),
        0, NULL, NULL, 'ledger', 'ca_mint_ledger',
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
        'append-only bypass used on the mint register: ' || TG_OP
          || ' permitted because app.ledger_maintenance was set to "' || v_reason
          || '". The rows are preserved whole in ca_ledger_mutation_log. Confirm the maintenance was intended, then resolve.',
        true,
        jsonb_build_object('operation', TG_OP, 'reason', v_reason, 'db_role', current_user,
                           'application', current_setting('application_name', true)));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  RAISE EXCEPTION
    '% on ca_mint_ledger is forbidden: the mint register is append-only. A retirement offsets an issuance; neither is ever edited or removed. Set app.ledger_maintenance with an incident reference for authorized maintenance.',
    TG_OP USING ERRCODE = 'P0403';
END;
$function$;
CREATE OR REPLACE FUNCTION public.enforce_chip_ledger_performed_by()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_reason text := NULLIF(current_setting('app.ledger_maintenance', true), '');
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.performed_by IS NOT DISTINCT FROM OLD.performed_by THEN
      RETURN NEW;
    END IF;
    IF OLD.performed_by IS NOT NULL
       AND NEW.performed_by IS NULL
       AND v_reason LIKE 'certification-cleanup:%'
       AND EXISTS (
         SELECT 1
           FROM public.ca_test_account_ledger_actor_archive a
          WHERE a.ledger_id = OLD.id
            AND a.actor_id = OLD.performed_by
            AND a.ledger_row = to_jsonb(OLD)
       ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION
      'chip_ledger.performed_by is immutable except after exact archived certification cleanup'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.performed_by IS NULL THEN
    RAISE EXCEPTION 'chip_ledger.performed_by must name a real user'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NEW.performed_by = '00000000-0000-0000-0000-000000000000'::uuid THEN
    RAISE EXCEPTION 'chip_ledger.performed_by must be a real user, got all-zero sentinel'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_tally_ledger_leg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
  /* SETTLEMENT SUSPENSE IS NOT A COUNTERPARTY FOR A BALANCE (2026-10-02).
     Every leg with settlement_suspense on either side is counted, before the
     journal-only exemption below, under a key no store resolves to. The
     commit check refuses a transaction that wrote one and moved any covered
     balance; a journal-only correction moves none and still commits. */
  IF NEW.from_type = 'settlement_suspense' OR NEW.to_type = 'settlement_suspense' THEN
    PERFORM public.fn_ca_ledger_tally_add('settlement_suspense', 's', abs(NEW.amount));
  END IF;
  /* A journal-only restatement (CLAUDE.md 10.9 rule 3, fn_ca_post_correction)
     moves no balance by design and is outside every meter, including this one. */
  IF NEW.category = 'correction' AND NEW.metadata ->> 'posted_via' = 'fn_ca_post_correction' THEN
    RETURN NULL;
  END IF;
  PERFORM public.fn_ca_ledger_tally_add(
    CASE WHEN NEW.to_type = 'escrow' AND NEW.category IN ('escrow_hold', 'escrow_release')
      THEN 'cashout_escrow:' || COALESCE(NEW.to_entity_id::text, 'null')
      ELSE public.fn_ca_ledger_tally_key(NEW.to_type, NEW.to_entity_id, NEW.club_id) END, 'l', NEW.amount);
  PERFORM public.fn_ca_ledger_tally_add(
    CASE WHEN NEW.from_type = 'escrow' AND NEW.category IN ('escrow_hold', 'escrow_release')
      THEN 'cashout_escrow:' || COALESCE(NEW.from_entity_id::text, 'null')
      ELSE public.fn_ca_ledger_tally_key(NEW.from_type, NEW.from_entity_id, NEW.club_id) END, 'l', -NEW.amount);
  RETURN NULL;
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
CREATE OR REPLACE FUNCTION public.fn_refuse_while_frozen()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  col  TEXT;
  changed BOOLEAN := FALSE;
  v_claims TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND TG_NARGS > 0 THEN
    FOREACH col IN ARRAY TG_ARGV LOOP
      IF to_jsonb(NEW) -> col IS DISTINCT FROM to_jsonb(OLD) -> col THEN
        changed := TRUE;
        EXIT;
      END IF;
    END LOOP;
    IF NOT changed THEN
      RETURN NEW;
    END IF;
  END IF;

  -- ONBOARDING NEVER FREEZES (to-do #2563 item 1). A membership row carrying
  -- no chips is identity, not money. This table, INSERT only, zero balance.
  IF TG_TABLE_NAME = 'club_members' AND TG_OP = 'INSERT'
     AND COALESCE((to_jsonb(NEW) ->> 'chip_balance')::numeric, 0) = 0 THEN
    RETURN NEW;
  END IF;

  IF public.fn_freeze_bypass_active() THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- CHIP STANDARD (2026-09-05): A JOURNAL ROW IS THE RECORD OF A WRITE, NOT A
  -- WRITE. When a balance write was permitted (a money table outside this
  -- guard, or a permitted role), its chip_ledger leg is written by the
  -- autoledger inside that same statement, at trigger depth 2 or more.
  -- Refusing the leg while the write stands is the one outcome the standard
  -- cannot allow: 104 BBJ bank moves (9.69 chips) lost their legs this way at :55 and
  -- :00 up to 09-05 06:58 (ca_ledger_write_failures, sqlstate 55006), each one an unexplained movement on the BBJ meter. A direct
  -- INSERT on chip_ledger from a client (depth 1) is still refused.
  IF TG_TABLE_NAME = 'chip_ledger' AND pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  BEGIN
    v_claims := current_setting('request.jwt.claims', TRUE);
    IF v_claims IS NOT NULL AND v_claims <> ''
       AND (v_claims::jsonb ->> 'role') = 'service_role' THEN
      RETURN COALESCE(NEW, OLD);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION
      'PLATFORM_FROZEN: the platform is on a scheduled maintenance break. % on % was refused; it will succeed when play resumes.',
      TG_OP, TG_TABLE_NAME
      USING ERRCODE = '55006',
            HINT = 'Scheduled maintenance breaks run from :55 to :00. Nothing is lost - retry after the break.';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_cashier_operation_intent_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_operation uuid;
  v_owner uuid;
  v_action text;
  v_expected_type text;
BEGIN
  IF NEW.metadata ->> 'op_id' IS NULL THEN RETURN NEW; END IF;
  BEGIN
    v_operation := (NEW.metadata ->> 'op_id')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NEW;
  END;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'cashier-exact-intent:' || v_operation, 0));
  SELECT actor_user_id, action INTO v_owner, v_action
    FROM public.cashier_rpc_operation_intents
   WHERE operation_id = v_operation;
  IF NOT FOUND THEN RETURN NEW; END IF;

  v_expected_type := CASE v_action
    WHEN 'club_bank_send' THEN 'club_bank_send'
    WHEN 'club_bank_claim' THEN 'club_bank_claim'
    WHEN 'club_bank_reversal' THEN 'club_bank_reversal'
    WHEN 'admin_removal' THEN 'admin_removal'
    WHEN 'promo_wallet_send' THEN 'promo_wallet_send'
    WHEN 'club_promo_send' THEN 'club_promo_send'
    WHEN 'agent_wallet_send' THEN 'agent_wallet_send'
    WHEN 'agent_wallet_claim_back' THEN 'agent_wallet_claim_back'
  END;
  IF v_owner IS DISTINCT FROM auth.uid()
     OR v_expected_type IS NULL
     OR NEW.transaction_type IS DISTINCT FROM v_expected_type THEN
    RAISE EXCEPTION 'cashier_retry_key_reused_across_actions' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_refuse_restricted_transfer()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_TABLE_NAME='chip_transactions' THEN
    IF NEW.transaction_type IN ('transfer','peer_transfer','user_transfer') AND NEW.amount>0 THEN
      PERFORM public.fn_ca_assert_player_action(NEW.from_user_id,'transfers',TG_TABLE_NAME);
    END IF;
  ELSIF TG_TABLE_NAME='wallet_transactions' THEN
    IF NEW.type='debit' AND NEW.category='transfer' AND NEW.amount>0 THEN
      PERFORM public.fn_ca_assert_player_action(NEW.user_id,'transfers',TG_TABLE_NAME);
    END IF;
  ELSIF NEW.amount<0 AND NEW.source IN ('wallet_transfer','wallet_diamond_transfer','stream_gift') THEN
    PERFORM public.fn_ca_assert_player_action(NEW.user_id,'transfers',TG_TABLE_NAME);
  END IF;
  RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION public.fn_refuse_operator_move_while_settling()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_claims text;
BEGIN
  -- Only operator movement. Everything a TABLE does is excluded on purpose:
  -- fn_atomic_buyin writes 'mint', so a freeze that caught mints would refuse
  -- buy-ins mid-session, and a settlement freeze is not a maintenance break.
  IF NEW.transaction_type IS NULL OR NEW.transaction_type NOT IN (
       'agent_wallet_send', 'agent_wallet_claim_back', 'agent_wallet_self_stake',
       'club_bank_send', 'club_bank_claim', 'club_bank_reversal',
       'promo_wallet_send', 'commission_claim',
       'admin_adjustment', 'admin_removal'
     ) THEN
    RETURN NEW;
  END IF;

  IF NEW.club_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- The settlement runner and every server-side job move chips as
  -- service_role, and the freeze exists to protect exactly that work.
  BEGIN
    v_claims := current_setting('request.jwt.claims', TRUE);
    IF v_claims IS NOT NULL AND v_claims <> ''
       AND (v_claims::jsonb ->> 'role') = 'service_role' THEN
      RETURN NEW;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  IF coalesce(auth.role(), '') = 'service_role'
     OR session_user IN ('postgres', 'supabase_admin') THEN
    RETURN NEW;
  END IF;

  IF public.fn_club_settlement_frozen(NEW.club_id) THEN
    RAISE EXCEPTION
      'SETTLEMENT_FROZEN: this club is squaring its books. % was refused; it will succeed when the freeze lifts.',
      NEW.transaction_type
      USING ERRCODE = '55006',
            HINT = 'A settlement freeze stops operator transfers, not play. Nothing is lost - retry once the freeze is lifted.';
  END IF;

  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_cashier_balance_actor_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_TABLE_NAME = 'clubs' THEN
    PERFORM public.fn_cashier_assert_active_actor(NEW.id);
  ELSE
    PERFORM public.fn_cashier_assert_active_actor(NEW.club_id);
  END IF;
  RETURN NEW;
END
$function$;
CREATE OR REPLACE FUNCTION public.fn_cashier_operation_mutex_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_correlation text := nullif(current_setting('app.ledger_correlation', true), '');
BEGIN
  IF v_correlation ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'cashier-exact-intent:' || v_correlation::uuid, 0));
  END IF;
  RETURN NULL;
END
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_autoledger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  spec text; col text; acct text;
  o jsonb; nn jsonb;
  d numeric; oldv numeric; newv numeric;
  cat text; cp text; cpid uuid; cplbl text;
  v_club uuid; v_union uuid; v_entity uuid; v_guc_club uuid;
  actor uuid;
  v_st text; v_msg text;
BEGIN
  IF current_setting('app.ledger_autoskip_' || TG_TABLE_NAME, true) = '1' THEN
    RETURN NEW;
  END IF;

  o  := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  nn := to_jsonb(NEW);

  cat := COALESCE(NULLIF(current_setting('app.ledger_category', true), ''), 'adjustment');
  cp  := COALESCE(NULLIF(current_setting('app.ledger_counterparty', true), ''), 'settlement_suspense');
  BEGIN
    cpid := NULLIF(current_setting('app.ledger_counterparty_entity', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN cpid := NULL;
  END;
  /* THE COUNTERPARTY NAMES ITS COLUMN (2026-10-04). A union wallet holds six
     balances and a promo bank lives on three kinds of owner, so the side this
     trigger writes for a declared union_wallet or promo_wallet counterparty
     carries the column the caller declared on app.ledger_counterparty_label.
     A label that cannot belong to the declared counterparty is not written:
     a stale declaration never names the wrong account. */
  cplbl := NULLIF(current_setting('app.ledger_counterparty_label', true), '');
  cplbl := CASE
    WHEN cp = 'union_wallet' AND cplbl LIKE 'union_wallets.%' THEN cplbl
    WHEN cp = 'promo_wallet' AND cplbl IN ('clubs.promo_balance', 'agents.promo_wallet_balance',
                                           'union_wallets.promo_wallet') THEN cplbl
    ELSE NULL END;
  actor := COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid);

  /* THE JOURNAL LEG NAMES THE CLUB THE MONEY LANDED IN (2026-09-20).
     union_wallets and unions are the only autoledgered tables with no
     club_id column - `nn ? 'club_id'` is key EXISTENCE, so a table
     that has the column takes the arm above even when it is NULL. Before
     today every leg journalled from those two was written club-less, and
     fn_chip_drift_since_baseline filters movements on club_id IS NOT
     NULL while counting the balance they explain, so correctly paid
     union-hosted prizes were reported as member drift.
     A payer that knows the club declares it on
     app.ledger_autoledger_club_id, transaction-scoped, and clears it
     beside the autoskips. It is deliberately NOT app.ledger_club_id:
     that name is taken and decides which club a WALLET credit is paid
     into (atomic_credit_wallet_and_log, atomic_deduct_wallet_and_log,
     log_wallet_transaction), so borrowing it would let a rakeback
     close's club leak onto a union leg and would move real money when
     cleared. Read through an exception guard exactly as cpid is above:
     a malformed value must never abort a chip movement. */
  BEGIN
    v_guc_club := NULLIF(current_setting('app.ledger_autoledger_club_id', true), '')::uuid;
  EXCEPTION WHEN OTHERS THEN v_guc_club := NULL;
  END;
  v_club := CASE
    WHEN TG_TABLE_NAME = 'clubs' THEN (nn->>'id')::uuid
    WHEN nn ? 'club_id' THEN NULLIF(nn->>'club_id','')::uuid
    ELSE v_guc_club END;
  v_union := CASE
    WHEN TG_TABLE_NAME = 'unions' THEN (nn->>'id')::uuid
    WHEN nn ? 'union_id' THEN NULLIF(nn->>'union_id','')::uuid
    ELSE NULL END;
  v_entity := CASE
    WHEN TG_TABLE_NAME = 'agents' THEN NULLIF(nn->>'user_id','')::uuid
    WHEN TG_TABLE_NAME = 'club_members' THEN NULLIF(nn->>'user_id','')::uuid
    ELSE COALESCE(NULLIF(nn->>'id','')::uuid, v_club, v_union) END;

  FOR i IN 0 .. TG_NARGS - 1 LOOP
    spec := TG_ARGV[i];
    col  := split_part(spec, '=', 1);
    acct := split_part(spec, '=', 2);
    oldv := COALESCE(NULLIF(o->>col,'')::numeric, 0);
    newv := COALESCE(NULLIF(nn->>col,'')::numeric, 0);
    d := round(newv - oldv, 2);
    CONTINUE WHEN d = 0;

    BEGIN
      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, union_id, description,
         pre_from_balance, post_from_balance, pre_to_balance, post_to_balance)
      VALUES (actor,
        CASE WHEN d > 0 THEN cp   ELSE acct END,
        CASE WHEN d > 0 THEN cpid ELSE v_entity END,
        CASE WHEN d > 0 THEN cplbl ELSE TG_TABLE_NAME || '.' || col END,
        CASE WHEN d > 0 THEN acct ELSE cp END,
        CASE WHEN d > 0 THEN v_entity ELSE cpid END,
        CASE WHEN d > 0 THEN TG_TABLE_NAME || '.' || col ELSE cplbl END,
        abs(d), cat, v_club, v_union,
        'auto-ledgered ' || TG_TABLE_NAME || '.' || col || ' delta ' || d::text,
        CASE WHEN d < 0 THEN oldv END, CASE WHEN d < 0 THEN newv END,
        CASE WHEN d > 0 THEN oldv END, CASE WHEN d > 0 THEN newv END);
    EXCEPTION WHEN OTHERS THEN
      -- A journal failure must abort the enclosing chip movement.
      -- Preserve SQLSTATE so the existing caller can retry the whole operation.
      RAISE;
    END;
  END LOOP;

  RETURN NEW;
END $function$;
CREATE OR REPLACE FUNCTION public.fn_ca_tally_balance_move()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  o jsonb := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  n jsonb := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
  k_old text; k_new text;
  v_old numeric := 0; v_new numeric := 0;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'club_members' THEN
      IF o IS NOT NULL THEN
        k_old := 'player_wallet:' || COALESCE(o ->> 'user_id', 'null') || ':' || COALESCE(o ->> 'club_id', 'null');
        v_old := COALESCE((o ->> 'chip_balance')::numeric, 0);
      END IF;
      IF n IS NOT NULL THEN
        k_new := 'player_wallet:' || COALESCE(n ->> 'user_id', 'null') || ':' || COALESCE(n ->> 'club_id', 'null');
        v_new := COALESCE((n ->> 'chip_balance')::numeric, 0);
      END IF;
    WHEN 'clubs' THEN
      IF o IS NOT NULL THEN
        k_old := 'club_treasury:' || (o ->> 'id');
        v_old := COALESCE((o ->> 'chip_treasury')::numeric, 0) + COALESCE((o ->> 'chip_pool')::numeric, 0);
      END IF;
      IF n IS NOT NULL THEN
        k_new := 'club_treasury:' || (n ->> 'id');
        v_new := COALESCE((n ->> 'chip_treasury')::numeric, 0) + COALESCE((n ->> 'chip_pool')::numeric, 0);
      END IF;
    WHEN 'table_seats' THEN
      /* A seat is on the felt while it is occupied (left_at IS NULL) and its
         table is a cash chip table. A vacated seat's stack has left the felt
         whether or not the row zeroes it, which is exactly what
         fn_log_seat_stack_exit records and what a cash-out leg explains. */
      k_old := 'table_stack'; k_new := 'table_stack';
      IF o IS NOT NULL AND (o ->> 'left_at') IS NULL
         AND public.fn_ca_felt_counts_table((o ->> 'table_id')::uuid) THEN
        v_old := COALESCE((o ->> 'stack')::numeric, 0);
      END IF;
      IF n IS NOT NULL AND (n ->> 'left_at') IS NULL
         AND public.fn_ca_felt_counts_table((n ->> 'table_id')::uuid) THEN
        v_new := COALESCE((n ->> 'stack')::numeric, 0);
      END IF;
    WHEN 'table_pending_addons' THEN
      /* The add-on's leg lands at request time; the chips wait here until the
         hand ends. They are on the felt the whole time (fn_ca_supply_snapshot
         pending_addons, 2026-09-12), so resolving one is not a movement. */
      k_old := 'table_stack'; k_new := 'table_stack';
      IF o IS NOT NULL AND (o ->> 'resolved_at') IS NULL
         AND public.fn_ca_felt_counts_table((o ->> 'table_id')::uuid) THEN
        v_old := COALESCE((o ->> 'amount')::numeric, 0);
      END IF;
      IF n IS NOT NULL AND (n ->> 'resolved_at') IS NULL
         AND public.fn_ca_felt_counts_table((n ->> 'table_id')::uuid) THEN
        v_new := COALESCE((n ->> 'amount')::numeric, 0);
      END IF;
    WHEN 'hand_atomic_commits' THEN
      /* THE FEES A HAND TAKES OFF ITS SEATS STAY ON THE FELT UNTIL THEIR LEGS
         ARE POSTED (20261001231409). The accepted-hand transaction moves the
         seats by inflow - rake - bbj and writes no leg for the fees. Their
         legs - table_stack -> union_wallet or chip_retirement for the rake,
         table_stack -> bbj_pool for the drop, the insurance bank's leg for the
         inflow - are posted by fn_ca_process_hand_post_commit_obligations in
         a LATER transaction, under the club wallet, VIP carry and pool locks
         the commit path must not wait on. So the hand's own receipt carries
         the fees as felt from the moment its envelope is stored until the
         moment that envelope completes - in the same transaction that posts
         the legs. Each transaction balances on its own, and a hand whose
         second half has not run yet reads as fees still on the felt, never as
         chips that vanished. Scoped exactly like the seat: the cash chip felt. */
      k_old := 'table_stack'; k_new := 'table_stack';
      IF o IS NOT NULL AND (o ->> 'post_commit_payload') IS NOT NULL
         AND (o ->> 'post_commit_completed_at') IS NULL
         AND public.fn_ca_felt_counts_table((o ->> 'table_id')::uuid) THEN
        v_old := COALESCE((o -> 'stack_result' ->> 'rake')::numeric, 0)
               + COALESCE((o -> 'stack_result' ->> 'bbj')::numeric, 0)
               - COALESCE((o -> 'stack_result' ->> 'inflow')::numeric, 0);
      END IF;
      IF n IS NOT NULL AND (n ->> 'post_commit_payload') IS NOT NULL
         AND (n ->> 'post_commit_completed_at') IS NULL
         AND public.fn_ca_felt_counts_table((n ->> 'table_id')::uuid) THEN
        v_new := COALESCE((n -> 'stack_result' ->> 'rake')::numeric, 0)
               + COALESCE((n -> 'stack_result' ->> 'bbj')::numeric, 0)
               - COALESCE((n -> 'stack_result' ->> 'inflow')::numeric, 0);
      END IF;
    WHEN 'union_wallets' THEN
      /* Two accounts on one row: the bank (chip_balance) and the five
         operating wallets, both keyed by the union. */
      IF o IS NOT NULL THEN
        PERFORM public.fn_ca_ledger_tally_add('union_bank:' || (o ->> 'union_id'), 'b',
                  -COALESCE((o ->> 'chip_balance')::numeric, 0));
        k_old := 'union_wallet:' || (o ->> 'union_id');
        v_old := COALESCE((o ->> 'rake_wallet')::numeric, 0) + COALESCE((o ->> 'bbj_wallet')::numeric, 0)
               + COALESCE((o ->> 'promo_wallet')::numeric, 0) + COALESCE((o ->> 'insurance_wallet')::numeric, 0)
               + COALESCE((o ->> 'spin_reserve_wallet')::numeric, 0);
      END IF;
      IF n IS NOT NULL THEN
        PERFORM public.fn_ca_ledger_tally_add('union_bank:' || (n ->> 'union_id'), 'b',
                  COALESCE((n ->> 'chip_balance')::numeric, 0));
        k_new := 'union_wallet:' || (n ->> 'union_id');
        v_new := COALESCE((n ->> 'rake_wallet')::numeric, 0) + COALESCE((n ->> 'bbj_wallet')::numeric, 0)
               + COALESCE((n ->> 'promo_wallet')::numeric, 0) + COALESCE((n ->> 'insurance_wallet')::numeric, 0)
               + COALESCE((n ->> 'spin_reserve_wallet')::numeric, 0);
      END IF;
    WHEN 'bbj_pools' THEN
      IF o IS NOT NULL THEN
        k_old := 'bbj_pool:' || (o ->> 'id');
        v_old := COALESCE((o ->> 'main_balance')::numeric, 0) + COALESCE((o ->> 'backup_balance')::numeric, 0)
               + COALESCE((o ->> 'promo_balance')::numeric, 0);
      END IF;
      IF n IS NOT NULL THEN
        k_new := 'bbj_pool:' || (n ->> 'id');
        v_new := COALESCE((n ->> 'main_balance')::numeric, 0) + COALESCE((n ->> 'backup_balance')::numeric, 0)
               + COALESCE((n ->> 'promo_balance')::numeric, 0);
      END IF;
    ELSE
      RAISE EXCEPTION 'fn_ca_tally_balance_move is not configured for %', TG_TABLE_NAME;
  END CASE;

  /* A row that changes account (a seat changing table, a membership changing
     club) leaves one account and arrives in another; both sides are counted. */
  IF k_old IS NOT NULL AND k_new IS NOT NULL AND k_old = k_new THEN
    PERFORM public.fn_ca_ledger_tally_add(k_new, 'b', v_new - v_old);
  ELSE
    IF k_old IS NOT NULL THEN PERFORM public.fn_ca_ledger_tally_add(k_old, 'b', -v_old); END IF;
    IF k_new IS NOT NULL THEN PERFORM public.fn_ca_ledger_tally_add(k_new, 'b', v_new); END IF;
  END IF;
  RETURN NULL;
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_ca_tally_store_move()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  o jsonb := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  n jsonb := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END;
BEGIN
  /* Feeds the same transaction tally as fn_ca_tally_balance_move, for the
     stores that function does not know. On club_members and clubs it counts
     ONLY the promo and insurance accounts: chip_balance, chip_treasury and
     chip_pool stay with the six-store trigger, so nothing is counted twice. */
  CASE TG_TABLE_NAME
    WHEN 'club_members' THEN
      PERFORM public.fn_ca_tally_pair(
        'promo_wallet:' || (o ->> 'user_id'), (o ->> 'promo_balance')::numeric,
        'promo_wallet:' || (n ->> 'user_id'), (n ->> 'promo_balance')::numeric);
    WHEN 'clubs' THEN
      PERFORM public.fn_ca_tally_pair(
        'promo_wallet:' || (o ->> 'id'), (o ->> 'promo_balance')::numeric,
        'promo_wallet:' || (n ->> 'id'), (n ->> 'promo_balance')::numeric);
      PERFORM public.fn_ca_tally_pair(
        'insurance_bank:' || (o ->> 'id'), (o ->> 'insurance_balance')::numeric,
        'insurance_bank:' || (n ->> 'id'), (n ->> 'insurance_balance')::numeric);
    WHEN 'agents' THEN
      /* No column list on this trigger: sync_agent_wallet_columns moves
         agent_wallet_balance when a writer sets business_balance, and a
         column-specific trigger would not see that. */
      PERFORM public.fn_ca_tally_pair(
        'agent_wallet:' || (o ->> 'user_id'), (o ->> 'agent_wallet_balance')::numeric,
        'agent_wallet:' || (n ->> 'user_id'), (n ->> 'agent_wallet_balance')::numeric);
      PERFORM public.fn_ca_tally_pair(
        'promo_wallet:' || (o ->> 'user_id'), (o ->> 'promo_wallet_balance')::numeric,
        'promo_wallet:' || (n ->> 'user_id'), (n ->> 'promo_wallet_balance')::numeric);
    WHEN 'club_wallets' THEN
      PERFORM public.fn_ca_tally_pair(
        'club_wallet:' || (o ->> 'club_id'), (o ->> 'chip_balance')::numeric,
        'club_wallet:' || (n ->> 'club_id'), (n ->> 'chip_balance')::numeric);
      PERFORM public.fn_ca_tally_pair(
        'insurance_bank:' || (o ->> 'club_id'), (o ->> 'insurance_balance')::numeric,
        'insurance_bank:' || (n ->> 'club_id'), (n ->> 'insurance_balance')::numeric);
    WHEN 'spin_bonus_pools' THEN
      PERFORM public.fn_ca_tally_pair(
        'spin_reserve:' || (o ->> 'id'), (o ->> 'balance')::numeric,
        'spin_reserve:' || (n ->> 'id'), (n ->> 'balance')::numeric);
    WHEN 'tournament_escrow' THEN
      /* The event's liability is its escrow: prize + bounty + fee, exactly
         fn_ca_supply_snapshot's tournament_liability. A Diamond event's
         shadow is Diamonds in custody and is not counted. */
      PERFORM public.fn_ca_tally_pair(
        CASE WHEN o IS NOT NULL AND public.fn_ca_tournament_counts((o ->> 'tournament_id')::uuid)
             THEN 'tournament_liability:' || (o ->> 'tournament_id') END,
        COALESCE((o ->> 'prize_balance')::numeric, 0) + COALESCE((o ->> 'bounty_balance')::numeric, 0)
          + COALESCE((o ->> 'fee_balance')::numeric, 0),
        CASE WHEN n IS NOT NULL AND public.fn_ca_tournament_counts((n ->> 'tournament_id')::uuid)
             THEN 'tournament_liability:' || (n ->> 'tournament_id') END,
        COALESCE((n ->> 'prize_balance')::numeric, 0) + COALESCE((n ->> 'bounty_balance')::numeric, 0)
          + COALESCE((n ->> 'fee_balance')::numeric, 0));
    WHEN 'chip_escrow' THEN
      -- Cashout custody is separate from the outstanding tournament ticket float.
      PERFORM public.fn_ca_tally_pair(
        CASE WHEN o IS NOT NULL THEN 'cashout_escrow:' || (o ->> 'id') END,
        CASE WHEN o ->> 'released_at' IS NULL THEN COALESCE((o ->> 'amount')::numeric, 0) ELSE 0 END,
        CASE WHEN n IS NOT NULL THEN 'cashout_escrow:' || (n ->> 'id') END,
        CASE WHEN n ->> 'released_at' IS NULL THEN COALESCE((n ->> 'amount')::numeric, 0) ELSE 0 END);
    WHEN 'tournament_tickets' THEN
      /* fn_ca_ticket_escrow_float: an issued ticket's value is held in escrow
         until it is redeemed or cancelled. */
      PERFORM public.fn_ca_tally_pair(
        CASE WHEN o IS NOT NULL THEN 'ticket_escrow' END,
        CASE WHEN o ->> 'status' = 'issued' THEN COALESCE((o ->> 'value')::numeric, 0) ELSE 0 END,
        CASE WHEN n IS NOT NULL THEN 'ticket_escrow' END,
        CASE WHEN n ->> 'status' = 'issued' THEN COALESCE((n ->> 'value')::numeric, 0) ELSE 0 END);
    WHEN 'unions' THEN
      /* The legacy unions row: its autoledger journals into these accounts
         (trg_ca_autoledger on unions), so its balances are counted in them. */
      PERFORM public.fn_ca_tally_pair(
        'union_bank:' || (o ->> 'id'), (o ->> 'chip_balance')::numeric,
        'union_bank:' || (n ->> 'id'), (n ->> 'chip_balance')::numeric);
      PERFORM public.fn_ca_tally_pair(
        'union_wallet:' || (o ->> 'id'), (o ->> 'rake_wallet')::numeric,
        'union_wallet:' || (n ->> 'id'), (n ->> 'rake_wallet')::numeric);
      PERFORM public.fn_ca_tally_pair(
        'bbj_pool:' || (o ->> 'id'),
        COALESCE((o ->> 'main_bbj_balance')::numeric, 0) + COALESCE((o ->> 'backup_bbj_balance')::numeric, 0),
        'bbj_pool:' || (n ->> 'id'),
        COALESCE((n ->> 'main_bbj_balance')::numeric, 0) + COALESCE((n ->> 'backup_bbj_balance')::numeric, 0));
      PERFORM public.fn_ca_tally_pair(
        'promo_wallet:' || (o ->> 'id'), (o ->> 'promo_fund_balance')::numeric,
        'promo_wallet:' || (n ->> 'id'), (n ->> 'promo_fund_balance')::numeric);
      PERFORM public.fn_ca_tally_pair(
        'insurance_bank:' || (o ->> 'id'), (o ->> 'insurance_balance')::numeric,
        'insurance_bank:' || (n ->> 'id'), (n ->> 'insurance_balance')::numeric);
    WHEN 'club_opening_setups' THEN
      PERFORM public.fn_ca_tally_pair(
        'opening_setup:' || (o ->> 'club_id'), (o ->> 'leaderboard_seed_remaining')::numeric,
        'opening_setup:' || (n ->> 'club_id'), (n ->> 'leaderboard_seed_remaining')::numeric);
    ELSE
      RAISE EXCEPTION 'fn_ca_tally_store_move is not configured for %', TG_TABLE_NAME;
  END CASE;
  RETURN NULL;
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_admin_holds_no_player_wallet()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_is_union boolean;
BEGIN
  IF COALESCE(NEW.role, 'player') <> 'admin' THEN RETURN NEW; END IF;

  SELECT COALESCE(c.is_union, false) INTO v_is_union FROM public.clubs c WHERE c.id = NEW.club_id;
  IF COALESCE(v_is_union, false) THEN RETURN NEW; END IF;

  IF TG_OP = 'UPDATE' AND OLD.role IS DISTINCT FROM NEW.role
     AND (COALESCE(NEW.chip_balance, 0) <> 0
          OR COALESCE(NEW.locked_chips, 0) <> 0
          OR COALESCE(NEW.held_chips, 0) <> 0
          OR COALESCE(NEW.promo_balance, 0) <> 0) THEN
    RAISE EXCEPTION 'Cash Out The Player Wallet Before Making This Member An Admin'
      USING ERRCODE = 'check_violation',
            DETAIL = format('chip_balance %s, locked %s, held %s, promo %s',
                            COALESCE(NEW.chip_balance, 0), COALESCE(NEW.locked_chips, 0),
                            COALESCE(NEW.held_chips, 0), COALESCE(NEW.promo_balance, 0));
  END IF;

  IF COALESCE(NEW.chip_balance, 0) > 0
     AND (TG_OP = 'INSERT' OR COALESCE(NEW.chip_balance, 0) > COALESCE(OLD.chip_balance, 0)) THEN
    RAISE EXCEPTION 'An Admin Does Not Hold A Player Wallet'
      USING ERRCODE = 'check_violation',
            HINT = 'Send To The Agent Wallet Or The Club Bank Instead.';
  END IF;

  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public.fn_block_browser_balance_writes()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_changed text;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_table_name = 'club_members' then
    if new.chip_balance is distinct from old.chip_balance then
      v_changed := 'chip_balance';
    elsif new.held_chips is distinct from old.held_chips then
      v_changed := 'held_chips';
    elsif new.locked_chips is distinct from old.locked_chips then
      v_changed := 'locked_chips';
    elsif new.promo_balance is distinct from old.promo_balance then
      v_changed := 'promo_balance';
    end if;
  elsif tg_table_name = 'clubs' then
    if new.chip_treasury is distinct from old.chip_treasury then
      v_changed := 'chip_treasury';
    elsif new.chip_pool is distinct from old.chip_pool then
      v_changed := 'chip_pool';
    end if;
  end if;

  if v_changed is null then
    return new;
  end if;

  raise exception
    'Direct balance mutation of %.% from the browser is forbidden. Chips move only through the money RPCs.',
    tg_table_name, v_changed
    using errcode = 'insufficient_privilege';
end
$function$;
CREATE OR REPLACE FUNCTION public.fn_guard_retired_club_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_club_id uuid;
  v_old_club_id uuid;
  v_maintenance boolean :=
    auth.uid() IS NULL
    AND coalesce(current_setting('app.club_retirement_maintenance', true), '') = 'on';
BEGIN
  IF v_maintenance THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF TG_TABLE_NAME = 'unions' THEN
      v_club_id := OLD.id;
    ELSIF TG_TABLE_NAME = 'table_seats' THEN
      SELECT t.club_id INTO v_club_id FROM public.tables t WHERE t.id = OLD.table_id;
    ELSIF TG_TABLE_NAME IN ('tournament_players', 'tournament_escrow') THEN
      SELECT t.club_id INTO v_club_id FROM public.tournaments t WHERE t.id = OLD.tournament_id;
    ELSIF TG_TABLE_NAME = 'chip_escrow' THEN
      SELECT cr.club_id INTO v_club_id FROM public.cashout_requests cr WHERE cr.id = OLD.cashout_request_id;
    ELSIF TG_TABLE_NAME = 'credit_invoices' THEN
      SELECT a.club_id INTO v_club_id FROM public.agents a WHERE a.id = OLD.agent_id;
    ELSIF TG_TABLE_NAME = 'tournament_schedule_spawns' THEN
      SELECT s.club_id INTO v_club_id FROM public.tournament_schedules s WHERE s.id = OLD.schedule_id;
    ELSIF TG_TABLE_NAME = 'managed_game_schedules' THEN
      IF OLD.game_kind = 'table' THEN
        SELECT t.club_id INTO v_club_id FROM public.tables t WHERE t.id = OLD.game_id;
      ELSE
        SELECT t.club_id INTO v_club_id FROM public.tournaments t WHERE t.id = OLD.game_id;
      END IF;
    ELSIF TG_TABLE_NAME IN ('wheel_configs','diamond_game_configs') THEN
      IF OLD.host_kind = 'club' THEN v_club_id := OLD.host_id; END IF;
    ELSIF TG_TABLE_NAME = 'wheel_pools' THEN
      SELECT c.host_id INTO v_club_id FROM public.wheel_configs c
       WHERE c.host_id=OLD.host_id AND c.host_kind='club';
    ELSIF TG_TABLE_NAME = 'diamond_game_pools' THEN
      SELECT c.host_id INTO v_club_id FROM public.diamond_game_configs c
       WHERE c.host_id=OLD.host_id AND c.game=OLD.game AND c.host_kind='club';
    ELSE
      v_club_id := OLD.club_id;
    END IF;
  ELSE
    IF TG_TABLE_NAME = 'unions' THEN
      v_club_id := NEW.id;
    ELSIF TG_TABLE_NAME = 'table_seats' THEN
      SELECT t.club_id INTO v_club_id FROM public.tables t WHERE t.id = NEW.table_id;
    ELSIF TG_TABLE_NAME IN ('tournament_players', 'tournament_escrow') THEN
      SELECT t.club_id INTO v_club_id FROM public.tournaments t WHERE t.id = NEW.tournament_id;
    ELSIF TG_TABLE_NAME = 'chip_escrow' THEN
      SELECT cr.club_id INTO v_club_id FROM public.cashout_requests cr WHERE cr.id = NEW.cashout_request_id;
    ELSIF TG_TABLE_NAME = 'credit_invoices' THEN
      SELECT a.club_id INTO v_club_id FROM public.agents a WHERE a.id = NEW.agent_id;
    ELSIF TG_TABLE_NAME = 'tournament_schedule_spawns' THEN
      SELECT s.club_id INTO v_club_id FROM public.tournament_schedules s WHERE s.id = NEW.schedule_id;
    ELSIF TG_TABLE_NAME = 'managed_game_schedules' THEN
      IF NEW.game_kind = 'table' THEN
        SELECT t.club_id INTO v_club_id FROM public.tables t WHERE t.id = NEW.game_id;
      ELSE
        SELECT t.club_id INTO v_club_id FROM public.tournaments t WHERE t.id = NEW.game_id;
      END IF;
    ELSIF TG_TABLE_NAME IN ('wheel_configs','diamond_game_configs') THEN
      IF NEW.host_kind = 'club' THEN v_club_id := NEW.host_id; END IF;
    ELSIF TG_TABLE_NAME = 'wheel_pools' THEN
      SELECT c.host_id INTO v_club_id FROM public.wheel_configs c
       WHERE c.host_id=NEW.host_id AND c.host_kind='club';
    ELSIF TG_TABLE_NAME = 'diamond_game_pools' THEN
      SELECT c.host_id INTO v_club_id FROM public.diamond_game_configs c
       WHERE c.host_id=NEW.host_id AND c.game=NEW.game AND c.host_kind='club';
    ELSE
      v_club_id := NEW.club_id;
    END IF;

    IF TG_OP = 'UPDATE' THEN
      IF TG_TABLE_NAME = 'unions' THEN
        v_old_club_id := OLD.id;
      ELSIF TG_TABLE_NAME = 'table_seats' THEN
        SELECT t.club_id INTO v_old_club_id FROM public.tables t WHERE t.id = OLD.table_id;
      ELSIF TG_TABLE_NAME IN ('tournament_players', 'tournament_escrow') THEN
        SELECT t.club_id INTO v_old_club_id FROM public.tournaments t WHERE t.id = OLD.tournament_id;
      ELSIF TG_TABLE_NAME = 'chip_escrow' THEN
        SELECT cr.club_id INTO v_old_club_id FROM public.cashout_requests cr WHERE cr.id = OLD.cashout_request_id;
      ELSIF TG_TABLE_NAME = 'credit_invoices' THEN
        SELECT a.club_id INTO v_old_club_id FROM public.agents a WHERE a.id = OLD.agent_id;
      ELSIF TG_TABLE_NAME = 'tournament_schedule_spawns' THEN
        SELECT s.club_id INTO v_old_club_id FROM public.tournament_schedules s WHERE s.id = OLD.schedule_id;
      ELSIF TG_TABLE_NAME = 'managed_game_schedules' THEN
        IF OLD.game_kind = 'table' THEN
          SELECT t.club_id INTO v_old_club_id FROM public.tables t WHERE t.id = OLD.game_id;
        ELSE
          SELECT t.club_id INTO v_old_club_id FROM public.tournaments t WHERE t.id = OLD.game_id;
        END IF;
      ELSIF TG_TABLE_NAME IN ('wheel_configs','diamond_game_configs') THEN
        IF OLD.host_kind = 'club' THEN v_old_club_id := OLD.host_id; END IF;
      ELSIF TG_TABLE_NAME = 'wheel_pools' THEN
        SELECT c.host_id INTO v_old_club_id FROM public.wheel_configs c
         WHERE c.host_id=OLD.host_id AND c.host_kind='club';
      ELSIF TG_TABLE_NAME = 'diamond_game_pools' THEN
        SELECT c.host_id INTO v_old_club_id FROM public.diamond_game_configs c
         WHERE c.host_id=OLD.host_id AND c.game=OLD.game AND c.host_kind='club';
      ELSE
        v_old_club_id := OLD.club_id;
      END IF;
    END IF;
  END IF;

  IF TG_TABLE_NAME = 'unions' AND v_club_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('cashier-hierarchy:' || v_club_id::text, 0));
  END IF;

  -- Lock both scopes in UUID order.  A writer that began just before retirement
  -- waits here and then observes the committed retired lifecycle.
  PERFORM 1
    FROM public.clubs c
   WHERE c.id IN (v_club_id, v_old_club_id)
   ORDER BY c.id
   FOR KEY SHARE;

  IF (v_club_id IS NOT NULL OR v_old_club_id IS NOT NULL) AND EXISTS (
    SELECT 1 FROM public.clubs c
     WHERE c.id IN (v_club_id, v_old_club_id) AND c.lifecycle_status = 'retired'
  ) THEN
    RAISE EXCEPTION 'CLUB_RETIRED: gameplay and cashier records are read-only'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_balance_has_its_ledger_row() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_balance_has_its_ledger_row() TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_chip_ledger_enrich() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_chip_ledger_enrich() TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_declare_ledger(text,text,uuid,uuid,text,text[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_declare_ledger(text,text,uuid,uuid,text,text[]) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_deleted_wallet_credit() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_deleted_wallet_credit() TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_issuance_leg_is_registered() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_issuance_leg_is_registered() TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_restore_erased_seat_credit(text,uuid,uuid,numeric,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_restore_erased_seat_credit(text,uuid,uuid,numeric,uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_club_members_ledger_writer() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_club_members_ledger_writer() TO service_role;
REVOKE ALL ON FUNCTION public.fn_ensure_club_wallet(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ensure_club_wallet(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ensure_club_wallet(uuid,uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.fn_platform_frozen() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_platform_frozen() TO anon;
GRANT EXECUTE ON FUNCTION public.fn_platform_frozen() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_platform_frozen() TO service_role;
REVOKE ALL ON FUNCTION public.fn_active_maintenance_release_boundary() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_active_maintenance_release_boundary() TO anon;
GRANT EXECUTE ON FUNCTION public.fn_active_maintenance_release_boundary() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_active_maintenance_release_boundary() TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_assert_emergency_path(text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_assert_emergency_path(text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_current_epoch() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_current_epoch() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_ca_current_epoch() TO anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_current_epoch() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_current_epoch() TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_deleted_wallet_bank_return(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_deleted_wallet_bank_return(uuid,uuid,text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_ledger_tally_add(text,text,numeric) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_ledger_tally_add(text,text,numeric) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_ledger_tally_key(text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_ledger_tally_key(text,uuid,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_mint_issued_24h(text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_mint_issued_24h(text,uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_noncirculating_chip_stores() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_noncirculating_chip_stores() TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_register_issuance_leg(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_register_issuance_leg(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_tally_pair(text,numeric,text,numeric) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_tally_pair(text,numeric,text,numeric) TO service_role;
REVOKE ALL ON FUNCTION public.fn_cashier_assert_active_actor(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_freeze_bypass_active() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_freeze_bypass_active() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_freeze_bypass_active() TO anon;
GRANT EXECUTE ON FUNCTION public.fn_freeze_bypass_active() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_freeze_bypass_active() TO service_role;
REVOKE ALL ON FUNCTION auth.role() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO PUBLIC;
GRANT EXECUTE ON FUNCTION auth.role() TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION auth.role() TO dashboard_user;
REVOKE ALL ON FUNCTION auth.uid() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC;
GRANT EXECUTE ON FUNCTION auth.uid() TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION auth.uid() TO dashboard_user;
REVOKE ALL ON FUNCTION public.fn_ca_assert_player_action(uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_assert_player_action(uuid,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_chip_store_declared() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_chip_store_declared() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_chip_store_declared() TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_felt_counts_table(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_felt_counts_table(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_tournament_counts(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_tournament_counts(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_club_settlement_frozen(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_club_settlement_frozen(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_club_settlement_frozen(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.fn_union_week_start(timestamp with time zone) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_union_week_start(timestamp with time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_union_week_start(timestamp with time zone) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_emergency_issuance_guard() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_emergency_issuance_guard() TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_mint_register_append_only() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_mint_register_append_only() TO service_role;
REVOKE ALL ON FUNCTION public.enforce_chip_ledger_performed_by() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.enforce_chip_ledger_performed_by() TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_tally_ledger_leg() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_tally_ledger_leg() TO service_role;
REVOKE ALL ON FUNCTION public.zz_chip_ledger_key_is_claimed_once() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.zz_chip_ledger_key_is_claimed_once() TO service_role;
REVOKE ALL ON FUNCTION public.fn_refuse_while_frozen() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_refuse_while_frozen() TO service_role;
REVOKE ALL ON FUNCTION public.fn_cashier_operation_intent_guard() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ca_refuse_restricted_transfer() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_refuse_restricted_transfer() TO service_role;
REVOKE ALL ON FUNCTION public.fn_refuse_operator_move_while_settling() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_refuse_operator_move_while_settling() TO service_role;
REVOKE ALL ON FUNCTION public.fn_cashier_balance_actor_guard() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_cashier_operation_mutex_guard() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ca_autoledger() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_autoledger() TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_tally_balance_move() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_tally_balance_move() TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_tally_store_move() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_tally_store_move() TO service_role;
REVOKE ALL ON FUNCTION public.fn_admin_holds_no_player_wallet() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_admin_holds_no_player_wallet() TO service_role;
REVOKE ALL ON FUNCTION public.fn_block_browser_balance_writes() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_block_browser_balance_writes() TO service_role;
REVOKE ALL ON FUNCTION public.fn_guard_retired_club_mutation() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_guard_retired_club_mutation() TO service_role;
INSERT INTO public.ca_mint_policy("id","note","updated_at","updated_by","rolling_24h_cap_chips","per_operation_cap_chips","rolling_24h_cap_diamonds","per_operation_cap_diamonds") SELECT "id","note","updated_at","updated_by","rolling_24h_cap_chips","per_operation_cap_chips","rolling_24h_cap_diamonds","per_operation_cap_diamonds" FROM jsonb_populate_record(NULL::public.ca_mint_policy,$j${"id": 1, "note": "Deliberate batch 2026-10-06, Dan confirmed in chat 10:25 CT (\"ADD 100K FOR EACH HORSE\"): the Mint issues 100,000 Diamonds to each of the 1,000 horses (100M). Ceiling covers the batch plus normal ~2M daily issuance so sign-up grants keep working; return to 2,000,000 after the batch ages out of the 24h window.", "updated_at": "2026-10-06T15:26:41.445567+00:00", "updated_by": null, "rolling_24h_cap_chips": 25000000, "per_operation_cap_chips": 10000000, "rolling_24h_cap_diamonds": 102000000, "per_operation_cap_diamonds": 1000000}$j$::jsonb);
INSERT INTO public.ca_ledger_invariant_mode("mode","reason","singleton","changed_at") SELECT "mode","reason","singleton","changed_at" FROM jsonb_populate_record(NULL::public.ca_ledger_invariant_mode,$j${"mode": "refuse", "reason": "20261002015339: stage 2. Zero findings from 00:05 UTC (after 20261001231409 fixed the one live class) under full traffic; bbj_payout proved in a rolled-back probe; a transaction whose covered balance and chip_ledger legs disagree no longer commits", "singleton": true, "changed_at": "2026-10-02T02:31:54.143466+00:00"}$j$::jsonb);
INSERT INTO public.ca_ledger_invariant_store_mode("mode","store","reason","changed_at") SELECT "mode","store","reason","changed_at" FROM jsonb_populate_record(NULL::public.ca_ledger_invariant_store_mode,$j${"mode": "refuse", "store": "player_wallet", "reason": "20261002015339: refusing since 02:31:54 UTC, carried here unchanged", "changed_at": "2026-10-02T04:14:45.611383+00:00"}$j$::jsonb);
INSERT INTO public.ca_ledger_invariant_store_mode("mode","store","reason","changed_at") SELECT "mode","store","reason","changed_at" FROM jsonb_populate_record(NULL::public.ca_ledger_invariant_store_mode,$j${"mode": "refuse", "store": "club_treasury", "reason": "20261002015339: refusing since 02:31:54 UTC, carried here unchanged", "changed_at": "2026-10-02T04:14:45.611383+00:00"}$j$::jsonb);
INSERT INTO public.ca_ledger_invariant_store_mode("mode","store","reason","changed_at") SELECT "mode","store","reason","changed_at" FROM jsonb_populate_record(NULL::public.ca_ledger_invariant_store_mode,$j${"mode": "refuse", "store": "table_stack", "reason": "20261002015339: refusing since 02:31:54 UTC, carried here unchanged", "changed_at": "2026-10-02T04:14:45.611383+00:00"}$j$::jsonb);
INSERT INTO public.ca_ledger_invariant_store_mode("mode","store","reason","changed_at") SELECT "mode","store","reason","changed_at" FROM jsonb_populate_record(NULL::public.ca_ledger_invariant_store_mode,$j${"mode": "refuse", "store": "union_bank", "reason": "20261002015339: refusing since 02:31:54 UTC, carried here unchanged", "changed_at": "2026-10-02T04:14:45.611383+00:00"}$j$::jsonb);
INSERT INTO public.ca_ledger_invariant_store_mode("mode","store","reason","changed_at") SELECT "mode","store","reason","changed_at" FROM jsonb_populate_record(NULL::public.ca_ledger_invariant_store_mode,$j${"mode": "refuse", "store": "union_wallet", "reason": "20261002015339: refusing since 02:31:54 UTC, carried here unchanged", "changed_at": "2026-10-02T04:14:45.611383+00:00"}$j$::jsonb);
INSERT INTO public.ca_ledger_invariant_store_mode("mode","store","reason","changed_at") SELECT "mode","store","reason","changed_at" FROM jsonb_populate_record(NULL::public.ca_ledger_invariant_store_mode,$j${"mode": "refuse", "store": "bbj_pool", "reason": "20261002015339: refusing since 02:31:54 UTC, carried here unchanged", "changed_at": "2026-10-02T04:14:45.611383+00:00"}$j$::jsonb);
INSERT INTO public.ca_ledger_invariant_store_mode("mode","store","reason","changed_at") SELECT "mode","store","reason","changed_at" FROM jsonb_populate_record(NULL::public.ca_ledger_invariant_store_mode,$j${"mode": "refuse", "store": "promo_wallet", "reason": "20261002042417: stage 2. Zero findings from 04:14:45 UTC under full traffic; the doors with no traffic proved in rolled-back probes; a transaction whose chip store and chip_ledger legs disagree no longer commits", "changed_at": "2026-10-02T05:26:27.409598+00:00"}$j$::jsonb);
INSERT INTO public.ca_ledger_invariant_store_mode("mode","store","reason","changed_at") SELECT "mode","store","reason","changed_at" FROM jsonb_populate_record(NULL::public.ca_ledger_invariant_store_mode,$j${"mode": "refuse", "store": "agent_wallet", "reason": "20261002042417: stage 2. Zero findings from 04:14:45 UTC under full traffic; the doors with no traffic proved in rolled-back probes; a transaction whose chip store and chip_ledger legs disagree no longer commits", "changed_at": "2026-10-02T05:26:27.409598+00:00"}$j$::jsonb);
INSERT INTO public.ca_ledger_invariant_store_mode("mode","store","reason","changed_at") SELECT "mode","store","reason","changed_at" FROM jsonb_populate_record(NULL::public.ca_ledger_invariant_store_mode,$j${"mode": "refuse", "store": "club_wallet", "reason": "20261002042417: stage 2. Zero findings from 04:14:45 UTC under full traffic; the doors with no traffic proved in rolled-back probes; a transaction whose chip store and chip_ledger legs disagree no longer commits", "changed_at": "2026-10-02T05:26:27.409598+00:00"}$j$::jsonb);
INSERT INTO public.ca_ledger_invariant_store_mode("mode","store","reason","changed_at") SELECT "mode","store","reason","changed_at" FROM jsonb_populate_record(NULL::public.ca_ledger_invariant_store_mode,$j${"mode": "refuse", "store": "insurance_bank", "reason": "20261002042417: stage 2. Zero findings from 04:14:45 UTC under full traffic; the doors with no traffic proved in rolled-back probes; a transaction whose chip store and chip_ledger legs disagree no longer commits", "changed_at": "2026-10-02T05:26:27.409598+00:00"}$j$::jsonb);
INSERT INTO public.ca_ledger_invariant_store_mode("mode","store","reason","changed_at") SELECT "mode","store","reason","changed_at" FROM jsonb_populate_record(NULL::public.ca_ledger_invariant_store_mode,$j${"mode": "refuse", "store": "spin_reserve", "reason": "20261002042417: stage 2. Zero findings from 04:14:45 UTC under full traffic; the doors with no traffic proved in rolled-back probes; a transaction whose chip store and chip_ledger legs disagree no longer commits", "changed_at": "2026-10-02T05:26:27.409598+00:00"}$j$::jsonb);
INSERT INTO public.ca_ledger_invariant_store_mode("mode","store","reason","changed_at") SELECT "mode","store","reason","changed_at" FROM jsonb_populate_record(NULL::public.ca_ledger_invariant_store_mode,$j${"mode": "refuse", "store": "tournament_liability", "reason": "20261002042417: stage 2. Zero findings from 04:14:45 UTC under full traffic; the doors with no traffic proved in rolled-back probes; a transaction whose chip store and chip_ledger legs disagree no longer commits", "changed_at": "2026-10-02T05:26:27.409598+00:00"}$j$::jsonb);
INSERT INTO public.ca_ledger_invariant_store_mode("mode","store","reason","changed_at") SELECT "mode","store","reason","changed_at" FROM jsonb_populate_record(NULL::public.ca_ledger_invariant_store_mode,$j${"mode": "refuse", "store": "ticket_escrow", "reason": "20261002042417: stage 2. Zero findings from 04:14:45 UTC under full traffic; the doors with no traffic proved in rolled-back probes; a transaction whose chip store and chip_ledger legs disagree no longer commits", "changed_at": "2026-10-02T05:26:27.409598+00:00"}$j$::jsonb);
INSERT INTO public.ca_ledger_invariant_store_mode("mode","store","reason","changed_at") SELECT "mode","store","reason","changed_at" FROM jsonb_populate_record(NULL::public.ca_ledger_invariant_store_mode,$j${"mode": "refuse", "store": "opening_setup", "reason": "20261002042417: stage 2. Zero findings from 04:14:45 UTC under full traffic; the doors with no traffic proved in rolled-back probes; a transaction whose chip store and chip_ledger legs disagree no longer commits", "changed_at": "2026-10-02T05:26:27.409598+00:00"}$j$::jsonb);
INSERT INTO public.ca_ledger_invariant_store_mode("mode","store","reason","changed_at") SELECT "mode","store","reason","changed_at" FROM jsonb_populate_record(NULL::public.ca_ledger_invariant_store_mode,$j${"mode": "refuse", "store": "leaderboard_round", "reason": "20261002042417: stage 2. Zero findings from 04:14:45 UTC under full traffic; the doors with no traffic proved in rolled-back probes; a transaction whose chip store and chip_ledger legs disagree no longer commits", "changed_at": "2026-10-02T05:26:27.409598+00:00"}$j$::jsonb);
INSERT INTO public.ca_ledger_invariant_store_mode("mode","store","reason","changed_at") SELECT "mode","store","reason","changed_at" FROM jsonb_populate_record(NULL::public.ca_ledger_invariant_store_mode,$j${"mode": "refuse", "store": "settlement_suspense", "reason": "20261002073930: stage 2. Zero settlement_suspense findings from 07:36:04 UTC under live traffic; both modes proved live in rolled-back probes; a transaction that moves a covered balance against settlement_suspense no longer commits", "changed_at": "2026-10-02T08:36:58.667944+00:00"}$j$::jsonb);
INSERT INTO public.ca_ledger_invariant_store_mode("mode","store","reason","changed_at") SELECT "mode","store","reason","changed_at" FROM jsonb_populate_record(NULL::public.ca_ledger_invariant_store_mode,$j${"mode": "refuse", "store": "cashout_escrow", "reason": "The exact cashout escrow row and its canonical hold/release leg must move equally in the original transaction.", "changed_at": "2026-10-06T18:24:58.741575+00:00"}$j$::jsonb);
INSERT INTO public.ca_chip_store_coverage("notes","store","added_at","treatment","counted_by") SELECT "notes","store","added_at","treatment","counted_by" FROM jsonb_populate_record(NULL::public.ca_chip_store_coverage,$j${"notes": "club_members chip_balance and promo_balance", "store": "player_wallet", "added_at": "2026-09-11T16:10:27.128168+00:00", "treatment": "counted", "counted_by": "member_wallets + member_promo"}$j$::jsonb);
INSERT INTO public.ca_chip_store_coverage("notes","store","added_at","treatment","counted_by") SELECT "notes","store","added_at","treatment","counted_by" FROM jsonb_populate_record(NULL::public.ca_chip_store_coverage,$j${"notes": "clubs chip_treasury", "store": "club_treasury", "added_at": "2026-09-11T16:10:27.128168+00:00", "treatment": "counted", "counted_by": "treasuries"}$j$::jsonb);
INSERT INTO public.ca_chip_store_coverage("notes","store","added_at","treatment","counted_by") SELECT "notes","store","added_at","treatment","counted_by" FROM jsonb_populate_record(NULL::public.ca_chip_store_coverage,$j${"notes": "union_wallets chip_balance", "store": "union_bank", "added_at": "2026-09-11T16:10:27.128168+00:00", "treatment": "counted", "counted_by": "union_wallets"}$j$::jsonb);
INSERT INTO public.ca_chip_store_coverage("notes","store","added_at","treatment","counted_by") SELECT "notes","store","added_at","treatment","counted_by" FROM jsonb_populate_record(NULL::public.ca_chip_store_coverage,$j${"notes": "agents agent_wallet_balance and promo_wallet_balance", "store": "agent_wallet", "added_at": "2026-09-11T16:10:27.128168+00:00", "treatment": "counted", "counted_by": "agent_wallets"}$j$::jsonb);
INSERT INTO public.ca_chip_store_coverage("notes","store","added_at","treatment","counted_by") SELECT "notes","store","added_at","treatment","counted_by" FROM jsonb_populate_record(NULL::public.ca_chip_store_coverage,$j${"notes": "table_seats stack on cash tables. Tournament felt is deliberately excluded and carried by tournament_liability instead", "store": "table_stack", "added_at": "2026-09-11T16:10:27.128168+00:00", "treatment": "counted", "counted_by": "felt"}$j$::jsonb);
INSERT INTO public.ca_chip_store_coverage("notes","store","added_at","treatment","counted_by") SELECT "notes","store","added_at","treatment","counted_by" FROM jsonb_populate_record(NULL::public.ca_chip_store_coverage,$j${"notes": "the promo floats, brought inside the total on 2026-09-03", "store": "promo_wallet", "added_at": "2026-09-11T16:10:27.128168+00:00", "treatment": "counted", "counted_by": "club_promo + agent_promo + union promo_wallet"}$j$::jsonb);
INSERT INTO public.ca_chip_store_coverage("notes","store","added_at","treatment","counted_by") SELECT "notes","store","added_at","treatment","counted_by" FROM jsonb_populate_record(NULL::public.ca_chip_store_coverage,$j${"notes": "club_wallets chip_balance", "store": "club_wallet", "added_at": "2026-09-11T16:10:27.128168+00:00", "treatment": "counted", "counted_by": "club_wallets"}$j$::jsonb);
INSERT INTO public.ca_chip_store_coverage("notes","store","added_at","treatment","counted_by") SELECT "notes","store","added_at","treatment","counted_by" FROM jsonb_populate_record(NULL::public.ca_chip_store_coverage,$j${"notes": "the union rake, bbj, promo, insurance and spin reserve wallets", "store": "union_wallet", "added_at": "2026-09-11T16:10:27.128168+00:00", "treatment": "counted", "counted_by": "union_wallets"}$j$::jsonb);
INSERT INTO public.ca_chip_store_coverage("notes","store","added_at","treatment","counted_by") SELECT "notes","store","added_at","treatment","counted_by" FROM jsonb_populate_record(NULL::public.ca_chip_store_coverage,$j${"notes": "main, backup and promo", "store": "bbj_pool", "added_at": "2026-09-11T16:10:27.128168+00:00", "treatment": "counted", "counted_by": "bbj_pools"}$j$::jsonb);
INSERT INTO public.ca_chip_store_coverage("notes","store","added_at","treatment","counted_by") SELECT "notes","store","added_at","treatment","counted_by" FROM jsonb_populate_record(NULL::public.ca_chip_store_coverage,$j${"notes": "spin_bonus_pools balance", "store": "spin_reserve", "added_at": "2026-09-11T16:10:27.128168+00:00", "treatment": "counted", "counted_by": "spin_pools + union spin_reserve_wallet"}$j$::jsonb);
INSERT INTO public.ca_chip_store_coverage("notes","store","added_at","treatment","counted_by") SELECT "notes","store","added_at","treatment","counted_by" FROM jsonb_populate_record(NULL::public.ca_chip_store_coverage,$j${"notes": "clubs insurance_balance", "store": "insurance_bank", "added_at": "2026-09-11T16:10:27.128168+00:00", "treatment": "counted", "counted_by": "club_insurance + union insurance_wallet"}$j$::jsonb);
INSERT INTO public.ca_chip_store_coverage("notes","store","added_at","treatment","counted_by") SELECT "notes","store","added_at","treatment","counted_by" FROM jsonb_populate_record(NULL::public.ca_chip_store_coverage,$j${"notes": "Outstanding tournament tickets. ADDED 2026-09-11: it was in no list at all, which is the whole of the five supply incidents of that morning", "store": "escrow", "added_at": "2026-09-11T16:10:27.128168+00:00", "treatment": "counted", "counted_by": "ticket_escrow"}$j$::jsonb);
INSERT INTO public.ca_chip_store_coverage("notes","store","added_at","treatment","counted_by") SELECT "notes","store","added_at","treatment","counted_by" FROM jsonb_populate_record(NULL::public.ca_chip_store_coverage,$j${"notes": "tournament_escrow prize_balance, or the counters where an event has no escrow row yet", "store": "prize_liability", "added_at": "2026-09-11T16:10:27.128168+00:00", "treatment": "counted", "counted_by": "tournament_liability"}$j$::jsonb);
INSERT INTO public.ca_chip_store_coverage("notes","store","added_at","treatment","counted_by") SELECT "notes","store","added_at","treatment","counted_by" FROM jsonb_populate_record(NULL::public.ca_chip_store_coverage,$j${"notes": "tournament_escrow bounty_balance", "store": "bounty_liability", "added_at": "2026-09-11T16:10:27.128168+00:00", "treatment": "counted", "counted_by": "tournament_liability"}$j$::jsonb);
INSERT INTO public.ca_chip_store_coverage("notes","store","added_at","treatment","counted_by") SELECT "notes","store","added_at","treatment","counted_by" FROM jsonb_populate_record(NULL::public.ca_chip_store_coverage,$j${"notes": "club_opening_setups leaderboard_seed_remaining", "store": "opening_setup", "added_at": "2026-09-11T16:10:27.128168+00:00", "treatment": "counted", "counted_by": "leaderboard_liability"}$j$::jsonb);
INSERT INTO public.ca_chip_store_coverage("notes","store","added_at","treatment","counted_by") SELECT "notes","store","added_at","treatment","counted_by" FROM jsonb_populate_record(NULL::public.ca_chip_store_coverage,$j${"notes": "the same seed, while a round is being settled", "store": "leaderboard_round", "added_at": "2026-09-11T16:10:27.128168+00:00", "treatment": "counted", "counted_by": "leaderboard_liability"}$j$::jsonb);
INSERT INTO public.ca_chip_store_coverage("notes","store","added_at","treatment","counted_by") SELECT "notes","store","added_at","treatment","counted_by" FROM jsonb_populate_record(NULL::public.ca_chip_store_coverage,$j${"notes": "issuance. A move out of it is a mint", "store": "system_mint", "added_at": "2026-09-11T16:10:27.128168+00:00", "treatment": "noncirculating", "counted_by": null}$j$::jsonb);
INSERT INTO public.ca_chip_store_coverage("notes","store","added_at","treatment","counted_by") SELECT "notes","store","added_at","treatment","counted_by" FROM jsonb_populate_record(NULL::public.ca_chip_store_coverage,$j${"notes": "retirement. A move into it is a burn", "store": "system_burn", "added_at": "2026-09-11T16:10:27.128168+00:00", "treatment": "noncirculating", "counted_by": null}$j$::jsonb);
INSERT INTO public.ca_chip_store_coverage("notes","store","added_at","treatment","counted_by") SELECT "notes","store","added_at","treatment","counted_by" FROM jsonb_populate_record(NULL::public.ca_chip_store_coverage,$j${"notes": "issuance held before it enters circulation", "store": "issuance_reserve", "added_at": "2026-09-11T16:10:27.128168+00:00", "treatment": "noncirculating", "counted_by": null}$j$::jsonb);
INSERT INTO public.ca_chip_store_coverage("notes","store","added_at","treatment","counted_by") SELECT "notes","store","added_at","treatment","counted_by" FROM jsonb_populate_record(NULL::public.ca_chip_store_coverage,$j${"notes": "retirement holding", "store": "chip_retirement", "added_at": "2026-09-11T16:10:27.128168+00:00", "treatment": "noncirculating", "counted_by": null}$j$::jsonb);
INSERT INTO public.ca_chip_store_coverage("notes","store","added_at","treatment","counted_by") SELECT "notes","store","added_at","treatment","counted_by" FROM jsonb_populate_record(NULL::public.ca_chip_store_coverage,$j${"notes": "NOT in the basis and NOT verified as a routing label. It holds a large historical net and has not moved in the sixty hours to 2026-09-11 15:00, so it is not implicated in the incidents this migration fixes. Declared uncounted deliberately rather than guessed into the total, where a wrong guess would double count. Any movement now raises a finding, which is the point", "store": "settlement_suspense", "added_at": "2026-09-11T16:10:27.128168+00:00", "treatment": "uncounted", "counted_by": null}$j$::jsonb);
INSERT INTO public.ca_chip_store_coverage("notes","store","added_at","treatment","counted_by") SELECT "notes","store","added_at","treatment","counted_by" FROM jsonb_populate_record(NULL::public.ca_chip_store_coverage,$j${"notes": "never used in the journal to date. Movement raises a finding so its treatment is decided before it carries money", "store": "rakeback_payable", "added_at": "2026-09-11T16:10:27.128168+00:00", "treatment": "uncounted", "counted_by": null}$j$::jsonb);
INSERT INTO public.ca_chip_store_coverage("notes","store","added_at","treatment","counted_by") SELECT "notes","store","added_at","treatment","counted_by" FROM jsonb_populate_record(NULL::public.ca_chip_store_coverage,$j${"notes": "never used in the journal to date. Movement raises a finding so its treatment is decided before it carries money", "store": "refund_payable", "added_at": "2026-09-11T16:10:27.128168+00:00", "treatment": "uncounted", "counted_by": null}$j$::jsonb);
INSERT INTO public.ca_chip_store_coverage("notes","store","added_at","treatment","counted_by") SELECT "notes","store","added_at","treatment","counted_by" FROM jsonb_populate_record(NULL::public.ca_chip_store_coverage,$j${"notes": "never used in the journal to date. Movement raises a finding so its treatment is decided before it carries money", "store": "credit_facility", "added_at": "2026-09-11T16:10:27.128168+00:00", "treatment": "uncounted", "counted_by": null}$j$::jsonb);
INSERT INTO public.ca_chip_store_coverage("notes","store","added_at","treatment","counted_by") SELECT "notes","store","added_at","treatment","counted_by" FROM jsonb_populate_record(NULL::public.ca_chip_store_coverage,$j${"notes": "never used in the journal to date. Movement raises a finding so its treatment is decided before it carries money", "store": "credit_receivable", "added_at": "2026-09-11T16:10:27.128168+00:00", "treatment": "uncounted", "counted_by": null}$j$::jsonb);
INSERT INTO public.ca_financial_epochs("id","name","ended_at","is_current","started_at","description") OVERRIDING SYSTEM VALUE SELECT "id","name","ended_at","is_current","started_at","description" FROM jsonb_populate_record(NULL::public.ca_financial_epochs,$j${"id": 2, "name": "epoch-2-hardened-ledger", "ended_at": null, "is_current": true, "started_at": "2026-08-31T14:35:01.52275+00:00", "description": "Zero-drift hardened ledger (2026-08-31). The Midway Union master reset opens epoch 3."}$j$::jsonb);
INSERT INTO public.ca_emergency_stops("path","reason","stopped","version","actor_id","updated_at") SELECT "path","reason","stopped","version","actor_id","updated_at" FROM jsonb_populate_record(NULL::public.ca_emergency_stops,$j${"path": "positive_issuance", "reason": null, "stopped": false, "version": 0, "actor_id": null, "updated_at": "2026-10-10T05:19:11.779248+00:00"}$j$::jsonb);
INSERT INTO auth.users(id) VALUES('00000000-0000-0000-0000-000000000051');INSERT INTO public.profiles(id,status,username) VALUES('00000000-0000-0000-0000-000000000051','deleted','native_00000000000000000000000000000051');
INSERT INTO auth.users(id) VALUES('00000000-0000-0000-0000-000000000005');INSERT INTO public.profiles(id,status,username) VALUES('00000000-0000-0000-0000-000000000005','deleted','native_00000000000000000000000000000005');
INSERT INTO auth.users(id) VALUES('face0000-0000-0000-0000-000000000001');INSERT INTO public.profiles(id,status,username) VALUES('face0000-0000-0000-0000-000000000001','deleted','native_face0000000000000000000000000001');
INSERT INTO auth.users(id) VALUES('00000000-0000-0000-0000-000000000007');INSERT INTO public.profiles(id,status,username) VALUES('00000000-0000-0000-0000-000000000007','deleted','native_00000000000000000000000000000007');
INSERT INTO auth.users(id) VALUES('00000000-0000-0000-0000-000000000009');INSERT INTO public.profiles(id,status,username) VALUES('00000000-0000-0000-0000-000000000009','deleted','native_00000000000000000000000000000009');
INSERT INTO auth.users(id) VALUES('47965354-0e56-43ef-931c-ddaab82af765');INSERT INTO public.profiles(id,status,username) VALUES('47965354-0e56-43ef-931c-ddaab82af765','active','native_479653540e5643ef931cddaab82af765');
INSERT INTO auth.users(id) VALUES('2d1cd6c3-5700-4af9-a271-d4863fdab20d');INSERT INTO public.profiles(id,status,username) VALUES('2d1cd6c3-5700-4af9-a271-d4863fdab20d','active','native_2d1cd6c357004af9a271d4863fdab20d');
INSERT INTO unions(id,name,owner_id,slug)VALUES('fade0000-0000-0000-0000-000000000001','Native original union','47965354-0e56-43ef-931c-ddaab82af765','native-original-union');
INSERT INTO clubs("id","asset","is_union","owner_id","union_id","lifecycle_status","name","chip_treasury") SELECT "id","asset","is_union","owner_id","union_id","lifecycle_status","name","chip_treasury" FROM jsonb_populate_record(NULL::clubs,$j${"id": "a41434bb-8d0c-400a-8f0d-e8b3d65afed4", "asset": "chips", "is_union": false, "owner_id": "47965354-0e56-43ef-931c-ddaab82af765", "union_id": "fade0000-0000-0000-0000-000000000001", "lifecycle_status": "active", "name": "Native funding a41434bb-8d0c-400a-8f0d-e8b3d65afed4", "chip_treasury": 1000}$j$);
INSERT INTO club_members(user_id,club_id,status,role,chip_balance,held_chips,locked_chips)VALUES('00000000-0000-0000-0000-000000000051','a41434bb-8d0c-400a-8f0d-e8b3d65afed4','approved','player',0,0,0);
INSERT INTO club_members(user_id,club_id,status,role,chip_balance,held_chips,locked_chips)VALUES('00000000-0000-0000-0000-000000000005','a41434bb-8d0c-400a-8f0d-e8b3d65afed4','approved','player',0,0,0);
INSERT INTO club_members(user_id,club_id,status,role,chip_balance,held_chips,locked_chips)VALUES('face0000-0000-0000-0000-000000000001','a41434bb-8d0c-400a-8f0d-e8b3d65afed4','approved','player',0,0,0);
INSERT INTO club_members(user_id,club_id,status,role,chip_balance,held_chips,locked_chips)VALUES('00000000-0000-0000-0000-000000000007','a41434bb-8d0c-400a-8f0d-e8b3d65afed4','approved','player',0,0,0);
INSERT INTO club_members(user_id,club_id,status,role,chip_balance,held_chips,locked_chips)VALUES('00000000-0000-0000-0000-000000000009','a41434bb-8d0c-400a-8f0d-e8b3d65afed4','approved','player',0,0,0);
INSERT INTO clubs("id","asset","is_union","owner_id","union_id","lifecycle_status","name","chip_treasury") SELECT "id","asset","is_union","owner_id","union_id","lifecycle_status","name","chip_treasury" FROM jsonb_populate_record(NULL::clubs,$j${"id": "a0000000-0000-0000-0000-000000000001", "asset": "chips", "is_union": false, "owner_id": "47965354-0e56-43ef-931c-ddaab82af765", "union_id": "fade0000-0000-0000-0000-000000000001", "lifecycle_status": "active", "name": "Native funding a0000000-0000-0000-0000-000000000001", "chip_treasury": 1000}$j$);
INSERT INTO club_members(user_id,club_id,status,role,chip_balance,held_chips,locked_chips)VALUES('00000000-0000-0000-0000-000000000051','a0000000-0000-0000-0000-000000000001','approved','player',0,0,0);
INSERT INTO club_members(user_id,club_id,status,role,chip_balance,held_chips,locked_chips)VALUES('00000000-0000-0000-0000-000000000005','a0000000-0000-0000-0000-000000000001','approved','agent',0,0,0);
INSERT INTO club_members(user_id,club_id,status,role,chip_balance,held_chips,locked_chips)VALUES('face0000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000001','approved','player',0,0,0);
INSERT INTO club_members(user_id,club_id,status,role,chip_balance,held_chips,locked_chips)VALUES('00000000-0000-0000-0000-000000000007','a0000000-0000-0000-0000-000000000001','approved','agent',0,0,0);
INSERT INTO club_members(user_id,club_id,status,role,chip_balance,held_chips,locked_chips)VALUES('00000000-0000-0000-0000-000000000009','a0000000-0000-0000-0000-000000000001','approved','player',0,0,0);
CREATE TRIGGER ca_emergency_positive_issuance BEFORE INSERT ON public.ca_mint_ledger FOR EACH ROW EXECUTE FUNCTION fn_ca_emergency_issuance_guard();
CREATE TRIGGER trg_ca_mint_register_append_only BEFORE DELETE OR UPDATE ON public.ca_mint_ledger FOR EACH ROW EXECUTE FUNCTION fn_ca_mint_register_append_only();
CREATE TRIGGER ab_ca_chip_store_declared BEFORE INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_ca_chip_store_declared();
CREATE TRIGGER trg_ca_chip_ledger_enrich BEFORE INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_ca_chip_ledger_enrich();
CREATE TRIGGER trg_chip_ledger_performed_by BEFORE INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION enforce_chip_ledger_performed_by();
CREATE TRIGGER zy_ca_tally_ledger_leg AFTER INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_ca_tally_ledger_leg();
CREATE CONSTRAINT TRIGGER zz_ca_issuance_leg_is_registered AFTER INSERT ON public.chip_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.from_type = ANY (ARRAY['system_mint'::text, 'system_burn'::text, 'issuance_reserve'::text, 'chip_retirement'::text])) OR (new.to_type = ANY (ARRAY['system_mint'::text, 'system_burn'::text, 'issuance_reserve'::text, 'chip_retirement'::text])))) EXECUTE FUNCTION fn_ca_issuance_leg_is_registered();
CREATE CONSTRAINT TRIGGER zz_ca_ledger_row_has_its_balance AFTER INSERT ON public.chip_ledger DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_ca_balance_has_its_ledger_row();
CREATE TRIGGER zz_chip_ledger_key_is_claimed_once BEFORE INSERT ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION zz_chip_ledger_key_is_claimed_once();
CREATE TRIGGER zz_freeze_guard BEFORE INSERT OR DELETE OR UPDATE ON public.chip_ledger FOR EACH ROW EXECUTE FUNCTION fn_refuse_while_frozen();
CREATE TRIGGER cashier_operation_intent_guard BEFORE INSERT ON public.chip_transactions FOR EACH ROW EXECUTE FUNCTION fn_cashier_operation_intent_guard();
CREATE TRIGGER zz_freeze_guard BEFORE INSERT OR DELETE OR UPDATE ON public.chip_transactions FOR EACH ROW EXECUTE FUNCTION fn_refuse_while_frozen();
CREATE TRIGGER zz_restriction_transfer_guard BEFORE INSERT ON public.chip_transactions FOR EACH ROW EXECUTE FUNCTION fn_ca_refuse_restricted_transfer();
CREATE TRIGGER zz_settlement_freeze_guard BEFORE INSERT ON public.chip_transactions FOR EACH ROW EXECUTE FUNCTION fn_refuse_operator_move_while_settling();
CREATE TRIGGER cashier_member_balance_actor_guard BEFORE UPDATE OF chip_balance ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_cashier_balance_actor_guard();
CREATE TRIGGER cashier_member_operation_mutex BEFORE UPDATE ON public.club_members FOR EACH STATEMENT EXECUTE FUNCTION fn_cashier_operation_mutex_guard();
CREATE TRIGGER trg_club_members_audit_chip_movement AFTER UPDATE OF chip_balance ON public.club_members FOR EACH ROW WHEN ((old.chip_balance IS DISTINCT FROM new.chip_balance)) EXECUTE FUNCTION fn_club_members_ledger_writer();
CREATE TRIGGER zy_ca_tally_balance_move AFTER INSERT OR DELETE OR UPDATE OF chip_balance, user_id, club_id ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_ca_tally_balance_move();
CREATE TRIGGER zy_ca_tally_store_move AFTER INSERT OR DELETE OR UPDATE OF promo_balance, user_id, club_id ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_ca_tally_store_move();
CREATE CONSTRAINT TRIGGER zz_ca_balance_has_its_ledger_row AFTER INSERT OR DELETE OR UPDATE OF chip_balance, user_id, club_id ON public.club_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_ca_balance_has_its_ledger_row();
CREATE CONSTRAINT TRIGGER zz_ca_store_has_its_ledger_row AFTER INSERT OR DELETE OR UPDATE OF promo_balance, user_id, club_id ON public.club_members DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_ca_balance_has_its_ledger_row();
CREATE TRIGGER zz_freeze_guard BEFORE INSERT OR DELETE OR UPDATE ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_refuse_while_frozen('chip_balance');
CREATE TRIGGER zzzz_deleted_member_credit AFTER UPDATE OF chip_balance, held_chips, locked_chips ON public.club_members FOR EACH ROW WHEN (((new.chip_balance > old.chip_balance) OR (new.held_chips < old.held_chips) OR (new.locked_chips < old.locked_chips))) EXECUTE FUNCTION fn_ca_deleted_wallet_credit();
CREATE TRIGGER cashier_club_balance_actor_guard BEFORE UPDATE OF chip_treasury, promo_balance ON public.clubs FOR EACH ROW EXECUTE FUNCTION fn_cashier_balance_actor_guard();
CREATE TRIGGER cashier_club_operation_mutex BEFORE UPDATE ON public.clubs FOR EACH STATEMENT EXECUTE FUNCTION fn_cashier_operation_mutex_guard();
CREATE TRIGGER trg_ca_autoledger AFTER INSERT OR UPDATE OF chip_treasury, chip_pool, promo_balance, insurance_balance ON public.clubs FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger('chip_treasury=club_treasury', 'chip_pool=club_treasury', 'promo_balance=promo_wallet', 'insurance_balance=insurance_bank');
CREATE TRIGGER zy_ca_tally_balance_move AFTER INSERT OR DELETE OR UPDATE OF chip_treasury, chip_pool ON public.clubs FOR EACH ROW EXECUTE FUNCTION fn_ca_tally_balance_move();
CREATE TRIGGER zy_ca_tally_store_move AFTER INSERT OR DELETE OR UPDATE OF promo_balance, insurance_balance ON public.clubs FOR EACH ROW EXECUTE FUNCTION fn_ca_tally_store_move();
CREATE CONSTRAINT TRIGGER zz_ca_balance_has_its_ledger_row AFTER INSERT OR DELETE OR UPDATE OF chip_treasury, chip_pool ON public.clubs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_ca_balance_has_its_ledger_row();
CREATE CONSTRAINT TRIGGER zz_ca_store_has_its_ledger_row AFTER INSERT OR DELETE OR UPDATE OF promo_balance, insurance_balance ON public.clubs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_ca_balance_has_its_ledger_row();
CREATE TRIGGER zz_freeze_guard BEFORE UPDATE ON public.clubs FOR EACH ROW EXECUTE FUNCTION fn_refuse_while_frozen('chip_pool', 'total_rake');
CREATE TRIGGER trg_admin_holds_no_player_wallet BEFORE INSERT OR UPDATE OF role, chip_balance ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_admin_holds_no_player_wallet();
CREATE TRIGGER trg_block_browser_balance_writes BEFORE UPDATE ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_block_browser_balance_writes();
CREATE TRIGGER trg_guard_retired_club_mutation BEFORE INSERT OR DELETE OR UPDATE ON public.club_members FOR EACH ROW EXECUTE FUNCTION fn_guard_retired_club_mutation();
-- Isolated candidate original-economic proof. No money writes or production use.
CREATE OR REPLACE FUNCTION smarter_private.original_erased_cash_base_proof(f jsonb,p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog SET timezone='UTC' AS $proof$
DECLARE e jsonb;prior jsonb;s jsonb;mp jsonb;delta numeric;base numeric;fund jsonb;clubs text[];a jsonb;
BEGIN
 IF f IS NULL OR jsonb_typeof(f) IS DISTINCT FROM 'object' OR p_at IS NULL THEN RETURN jsonb_build_object('status','blocked','reason','missing_original');END IF;
 e:=f->'event';prior:=f->'prior';s:=f->'signed';mp:=f->'participant';a:=f->'atomic';
 IF e->>'source_name' IS DISTINCT FROM 'table_seats' OR e->>'operation' IS DISTINCT FROM 'DELETE'
 OR e->'after_row' IS DISTINCT FROM 'null'::jsonb OR jsonb_typeof(e->'before_row') IS DISTINCT FROM 'object'
 OR jsonb_typeof(prior->'after_row') IS DISTINCT FROM 'object'
 OR (e->'before_row')-'left_at' IS DISTINCT FROM (prior->'after_row')-'left_at'
 OR prior#>'{after_row,left_at}' IS DISTINCT FROM 'null'::jsonb
 OR e#>>'{before_row,left_at}' IS NULL
 OR (e#>>'{before_row,left_at}')::timestamptz NOT BETWEEN '2026-10-06 15:33:00Z' AND '2026-10-06 15:33:10Z'
 OR (prior->>'event_id')::bigint >= (e->>'event_id')::bigint
 OR p_at <= (e->>'observed_at')::timestamptz
 THEN RETURN jsonb_build_object('status','blocked','reason','original_transition_or_boundary_refused');END IF;
 IF s->>'seat_id' IS DISTINCT FROM e->>'row_id' OR s->>'seat_id' IS DISTINCT FROM e#>>'{before_row,id}'
 OR s->>'user_id' IS DISTINCT FROM e#>>'{before_row,user_id}'
 OR s->>'occupancy_id' IS DISTINCT FROM e#>>'{before_row,occupancy_id}'
 OR (s->>'seat_joined_at')::timestamptz IS DISTINCT FROM (e#>>'{before_row,joined_at}')::timestamptz
 OR jsonb_typeof(s->'stack_before') IS DISTINCT FROM 'number' OR jsonb_typeof(s->'stack') IS DISTINCT FROM 'number'
 OR jsonb_typeof(e#>'{before_row,stack}') IS DISTINCT FROM 'number'
 OR (s->>'stack_before')::numeric IS DISTINCT FROM (e#>>'{before_row,stack}')::numeric
 OR (s->>'stack_before')::numeric<=0 OR (s->>'stack')::numeric<0
 OR (s->>'stack_before')::numeric*100<>trunc((s->>'stack_before')::numeric*100)
 OR (s->>'stack')::numeric*100<>trunc((s->>'stack')::numeric*100)
 OR mp->>'seat_id' IS DISTINCT FROM s->>'seat_id' OR mp->>'user_id' IS DISTINCT FROM s->>'user_id'
 OR mp->>'occupancy_id' IS DISTINCT FROM s->>'occupancy_id'
 OR (mp->>'stack_before')::numeric IS DISTINCT FROM (s->>'stack_before')::numeric
 OR mp#>'{funding_lineage,issues}' IS DISTINCT FROM '[]'::jsonb
 OR jsonb_typeof(f->'funding') IS DISTINCT FROM 'array' OR jsonb_array_length(f->'funding')=0
 OR jsonb_typeof(mp->'funding_receipts') IS DISTINCT FROM 'array'
 OR jsonb_array_length(mp->'funding_receipts') IS DISTINCT FROM jsonb_array_length(f->'funding')
 OR (SELECT count(DISTINCT x#>>'{receipt,id}') FROM jsonb_array_elements(f->'funding')x) IS DISTINCT FROM jsonb_array_length(f->'funding')
 OR EXISTS(SELECT FROM jsonb_array_elements(mp->'funding_receipts') r WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(f->'funding') x WHERE x#>>'{receipt,id}'=r->>'id'))
 THEN RETURN jsonb_build_object('status','blocked','reason','original_identity_stack_or_funding_refused');END IF;
 base:=(s->>'stack_before')::numeric;delta:=(s->>'stack')::numeric-base;
 IF a->>'table_id' IS DISTINCT FROM e#>>'{before_row,table_id}'
 OR a#>>'{stack_result,success}' IS DISTINCT FROM 'true'
 OR a#>>'{stack_result,conservation_checked}' IS DISTINCT FROM 'true'
 OR a#>>'{post_commit_result,ok}' IS DISTINCT FROM 'true' OR a->>'post_commit_completed_at' IS NULL
 OR (a->>'post_commit_completed_at')::timestamptz >= p_at
 OR NOT EXISTS(SELECT FROM jsonb_array_elements(a#>'{stack_result,departed}') d
 WHERE d->>'seat_id'=s->>'seat_id' AND d->>'user_id'=s->>'user_id' AND (d->>'delta')::numeric=delta)
 OR jsonb_typeof(f->'late_ledger') IS DISTINCT FROM 'object' OR f#>>'{late_ledger,idempotency_key}' IS DISTINCT FROM f->>'late_key'
 OR (f#>>'{late_ledger,amount}')::numeric IS DISTINCT FROM abs(delta)
 OR f#>>'{late_ledger,category}' IS DISTINCT FROM 'settlement'
 OR f->>'late_key' IS DISTINCT FROM 'late_seat_settle:'||(a#>>'{stack_result,hand_id}')||':'||(s->>'user_id')
 OR (CASE WHEN delta>0 THEN f#>>'{late_ledger,from_type}' IS DISTINCT FROM 'table_stack'
 OR f#>>'{late_ledger,from_entity_id}' IS DISTINCT FROM a->>'table_id'
 OR f#>>'{late_ledger,to_type}' IS DISTINCT FROM 'player_wallet' OR f#>>'{late_ledger,to_entity_id}' IS DISTINCT FROM s->>'user_id'
 ELSE f#>>'{late_ledger,from_type}' IS DISTINCT FROM 'player_wallet' OR f#>>'{late_ledger,from_entity_id}' IS DISTINCT FROM s->>'user_id'
 OR f#>>'{late_ledger,to_type}' IS DISTINCT FROM 'table_stack' OR f#>>'{late_ledger,to_entity_id}' IS DISTINCT FROM a->>'table_id' END)
 OR f#>>'{late_idempotency,user_id}' IS DISTINCT FROM s->>'user_id'
 OR (f#>>'{late_idempotency,amount}')::numeric IS DISTINCT FROM delta
 THEN RETURN jsonb_build_object('status','blocked','reason','completed_original_delta_refused');END IF;
 FOR fund IN SELECT value FROM jsonb_array_elements(f->'funding') LOOP
  IF fund#>>'{receipt,asset}' IS DISTINCT FROM 'chips' OR fund#>>'{receipt,account_type}' IS DISTINCT FROM 'player_wallet'
  OR fund#>>'{receipt,user_id}' IS DISTINCT FROM s->>'user_id' OR fund#>>'{receipt,account_entity_id}' IS DISTINCT FROM s->>'user_id'
  OR fund#>>'{receipt,table_id}' IS DISTINCT FROM a->>'table_id' OR fund#>>'{receipt,occupancy_id}' IS DISTINCT FROM s->>'occupancy_id'
  OR fund#>>'{receipt,source_ledger_id}' IS DISTINCT FROM fund#>>'{ledger,id}'
  OR fund#>>'{receipt,wallet_transaction_id}' IS DISTINCT FROM fund#>>'{debit,id}'
  OR fund#>>'{ledger,from_type}' IS DISTINCT FROM 'player_wallet' OR fund#>>'{ledger,from_entity_id}' IS DISTINCT FROM s->>'user_id'
  OR fund#>>'{debit,type}' IS DISTINCT FROM 'debit' OR fund#>>'{debit,user_id}' IS DISTINCT FROM s->>'user_id'
  OR (fund#>>'{receipt,amount}')::numeric IS NULL OR (fund#>>'{receipt,amount}')::numeric<=0
  OR (fund#>>'{receipt,amount}')::numeric IS DISTINCT FROM (fund#>>'{ledger,amount}')::numeric
  OR (fund#>>'{receipt,amount}')::numeric IS DISTINCT FROM (fund#>>'{debit,amount}')::numeric
  OR fund#>>'{receipt,funding_club_id}' IS DISTINCT FROM fund#>>'{ledger,club_id}'
  THEN RETURN jsonb_build_object('status','blocked','reason','original_debit_refused');END IF;
 END LOOP;
 SELECT array_agg(DISTINCT x#>>'{receipt,funding_club_id}') INTO clubs FROM jsonb_array_elements(f->'funding') x;
 IF cardinality(clubs) IS DISTINCT FROM 1 OR clubs[1] IS NULL OR f#>>'{late_ledger,club_id}' IS DISTINCT FROM clubs[1]
 THEN RETURN jsonb_build_object('status','blocked','reason','original_owner_refused');END IF;
 RETURN jsonb_build_object('status','ready','financial_admission',false,'boundary',p_at,'original_base',base,'preserved_played_delta',delta,
 'holding',jsonb_build_object('kind','original_erased_cash_receivable','source_id',s->>'occupancy_id','user_id',s->>'user_id','club_id',clubs[1],'amount',base),
 'raw_issue_event_id',e->'event_id','missing_force_event_invented',false,'current_membership_used',false);
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format OR numeric_value_out_of_range THEN
 RETURN jsonb_build_object('status','blocked','reason','malformed_original');
END $proof$;
