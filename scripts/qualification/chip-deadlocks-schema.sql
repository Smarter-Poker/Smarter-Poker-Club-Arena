-- scripts/qualification/chip-deadlocks-schema.sql
--
-- The tables the chip deadlock reproductions write, in production's exact column
-- shape (names, types, NOT NULL, defaults, generated columns) with every primary
-- and unique index (the ON CONFLICT targets). Captured read-only from production
-- on 2026-10-01 (pg_attribute, pg_attrdef, pg_get_indexdef). Left out on purpose,
-- because none of them takes a lock in the cycles reproduced here: foreign keys,
-- check constraints, row level security, grants, and every trigger except the
-- four the live doors file installs.
SET client_min_messages = warning;
DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $r$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS smarter_private;
-- No PostgREST request here: auth.role() and auth.uid() are NULL, as they are for
-- psql, pg_cron and a migration. fn_caller_is_engine() (loaded live) reads that as
-- the trusted service context, exactly as it does in production.
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULL::text $$;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE OR REPLACE FUNCTION smarter_private.f06_new_lifecycle() RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;
CREATE OR REPLACE FUNCTION public.uuid_generate_v4() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
CREATE SEQUENCE IF NOT EXISTS public.hand_id_seq;

CREATE TABLE public.accounting_agreement_history (
  "id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  "entity_type" text NOT NULL,
  "entity_key" text NOT NULL,
  "club_id" uuid,
  "subject_user_id" uuid,
  "event_type" text NOT NULL,
  "observed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  "transaction_id" bigint DEFAULT txid_current() NOT NULL,
  "actor_id" uuid,
  "before_terms" jsonb,
  "after_terms" jsonb,
  "union_id" uuid
);
CREATE TABLE public.accounting_cash_accrual_batches (
  "rake_record_id" uuid NOT NULL,
  "hand_id" uuid NOT NULL,
  "earned_at" timestamp with time zone NOT NULL,
  "source_fingerprint" text NOT NULL,
  "status" text NOT NULL,
  "plan" jsonb,
  "recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
CREATE TABLE public.accounting_cash_accrual_cutover (
  "singleton" boolean DEFAULT true NOT NULL,
  "starts_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
CREATE TABLE public.accounting_cash_bank_receipts (
  "rake_record_id" uuid NOT NULL,
  "union_id" uuid,
  "club_id" uuid NOT NULL,
  "union_transaction_id" uuid,
  "club_ledger_id" uuid,
  "banked_at" timestamp with time zone NOT NULL,
  "amount" numeric NOT NULL
);
CREATE TABLE public.accounting_cash_rake_sources (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "rake_record_id" uuid NOT NULL,
  "player_id" uuid NOT NULL,
  "club_id" uuid NOT NULL,
  "union_id" uuid,
  "coordinator_union_id" uuid,
  "earned_at" timestamp with time zone NOT NULL,
  "rake_credit" numeric NOT NULL,
  "contract" jsonb NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
CREATE TABLE public.accounting_cash_source_receipts (
  "id" uuid NOT NULL,
  "rake_record_id" uuid NOT NULL,
  "attempt" bigint NOT NULL,
  "earned_at" timestamp with time zone NOT NULL,
  "source_fingerprint" text NOT NULL,
  "status" text NOT NULL,
  "reason" text,
  "sqlstate" text,
  "error_detail" text,
  "scope" jsonb NOT NULL,
  "result" jsonb NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
CREATE TABLE public.accounting_cash_source_work (
  "rake_record_id" uuid NOT NULL,
  "receipt_id" uuid NOT NULL,
  "source_fingerprint" text NOT NULL,
  "status" text NOT NULL,
  "attempts" bigint NOT NULL,
  "next_attempt_at" timestamp with time zone NOT NULL
);
CREATE TABLE public.accounting_period_recompute_requests (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "club_id" uuid NOT NULL,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "status" text DEFAULT 'pending'::text NOT NULL,
  "reason" text,
  "requested_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  "last_requested_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  "attempted_at" timestamp with time zone,
  "attempts" bigint DEFAULT 0 NOT NULL,
  "last_result" jsonb DEFAULT '{}'::jsonb NOT NULL
);
CREATE TABLE public.accounting_routed_settlement_runs (
  "union_id" uuid,
  "period_start" timestamp with time zone NOT NULL,
  "period_end" timestamp with time zone NOT NULL,
  "round_no" integer NOT NULL,
  "routing_version" integer DEFAULT 3 NOT NULL,
  "source_fingerprint" text NOT NULL,
  "result" jsonb NOT NULL,
  "completed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  "standalone_club_id" uuid,
  "scope_kind" text GENERATED ALWAYS AS (
CASE
    WHEN (union_id IS NULL) THEN 'club'::text
    ELSE 'union'::text
END) STORED,
  "scope_id" uuid GENERATED ALWAYS AS (COALESCE(union_id, standalone_club_id)) STORED
);
CREATE TABLE public.accounting_tournament_fee_recognitions (
  "tournament_id" uuid NOT NULL,
  "recognized_at" timestamp with time zone NOT NULL,
  "status" text NOT NULL,
  "net_rake" numeric NOT NULL,
  "union_id" uuid,
  "bank_club_id" uuid,
  "union_wallet_transaction_id" uuid,
  "bank_journal_id" uuid,
  "source_fingerprint" text NOT NULL,
  "plan" jsonb NOT NULL
);
CREATE TABLE public.accounting_tournament_fee_sources (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "rake_record_id" uuid NOT NULL,
  "tournament_id" uuid NOT NULL,
  "player_id" uuid NOT NULL,
  "club_id" uuid NOT NULL,
  "union_id" uuid,
  "coordinator_union_id" uuid,
  "game_type" text NOT NULL,
  "registration_id" uuid NOT NULL,
  "source_charge_ledger_id" uuid NOT NULL,
  "source_entitlement_id" uuid NOT NULL,
  "charged_at" timestamp with time zone NOT NULL,
  "rake_credit" numeric NOT NULL,
  "contract" jsonb NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT transaction_timestamp() NOT NULL
);
CREATE TABLE public.accounting_tournament_recognized_sources (
  "source_id" uuid NOT NULL,
  "tournament_id" uuid NOT NULL,
  "recognized_at" timestamp with time zone NOT NULL,
  "disposition" text NOT NULL,
  "rake_credit" numeric NOT NULL
);
CREATE TABLE public.agent_commission_settlements (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "club_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "union_id" uuid,
  "period_start" timestamp with time zone NOT NULL,
  "period_end" timestamp with time zone NOT NULL,
  "amount" numeric NOT NULL,
  "rows_count" integer DEFAULT 0 NOT NULL,
  "paid_at" timestamp with time zone DEFAULT now() NOT NULL,
  "settlement_ref" text
);
CREATE TABLE public.agent_commission_unsettled_rollup (
  "club_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "owed" numeric DEFAULT 0 NOT NULL,
  "rows_behind" bigint DEFAULT 0 NOT NULL,
  "oldest_unsettled" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.agent_commissions (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "club_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "amount" numeric DEFAULT 0,
  "commission_rate" numeric DEFAULT 0.1,
  "source_type" text DEFAULT 'rake'::text,
  "source_id" uuid,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now(),
  "settled_at" timestamp with time zone
);
CREATE TABLE public.agents (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "club_id" uuid NOT NULL,
  "membership_id" uuid,
  "role" text NOT NULL,
  "status" text DEFAULT 'active'::text NOT NULL,
  "parent_agent_id" uuid,
  "commission_rate" numeric(5,4) NOT NULL,
  "player_rakeback_rate" numeric(5,4) NOT NULL,
  "credit_limit" numeric(15,2) DEFAULT 0 NOT NULL,
  "credit_used" numeric(15,2) DEFAULT 0 NOT NULL,
  "is_prepaid" boolean DEFAULT false NOT NULL,
  "business_balance" numeric(15,2) DEFAULT 0 NOT NULL,
  "player_balance" numeric(15,2) DEFAULT 0 NOT NULL,
  "promo_balance" numeric(15,2) DEFAULT 0 NOT NULL,
  "total_players" integer DEFAULT 0 NOT NULL,
  "active_player_count" integer DEFAULT 0 NOT NULL,
  "sub_agent_count" integer DEFAULT 0 NOT NULL,
  "weekly_rake_generated" numeric(15,2) DEFAULT 0 NOT NULL,
  "lifetime_earnings" numeric(15,2) DEFAULT 0 NOT NULL,
  "joined_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_active_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "auto_rakeback_enabled" boolean DEFAULT true,
  "rakeback_percentage" numeric(5,4) DEFAULT 0.0000,
  "agent_wallet_balance" numeric(18,2) DEFAULT 0,
  "player_wallet_balance" numeric(18,4) DEFAULT 0,
  "promo_wallet_balance" numeric(18,2) DEFAULT 0,
  "lifetime_rake_generated" numeric(18,4) DEFAULT 0,
  "credit_control_revision" bigint DEFAULT 0 NOT NULL
);
CREATE TABLE public.ca_club_commission_daily (
  "club_id" uuid NOT NULL,
  "stat_date" date NOT NULL,
  "amount" numeric DEFAULT 0 NOT NULL,
  "rows_counted" bigint DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.ca_club_rake_daily (
  "club_id" uuid NOT NULL,
  "stat_date" date NOT NULL,
  "hands" bigint DEFAULT 0 NOT NULL,
  "rake" numeric DEFAULT 0 NOT NULL,
  "bbj" numeric DEFAULT 0 NOT NULL,
  "pot" numeric DEFAULT 0 NOT NULL,
  "source_rows" bigint DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.chip_ledger (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "performed_by" uuid,
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
  "row_hash" text
);
CREATE TABLE public.club_members (
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
  "departure_reason" text
);
CREATE TABLE public.club_wallet_transactions (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "club_id" uuid NOT NULL,
  "type" text NOT NULL,
  "amount" numeric(20,4) NOT NULL,
  "balance_after" numeric(20,4) NOT NULL,
  "related_id" uuid,
  "actor_id" uuid,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.club_wallets (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "club_id" uuid NOT NULL,
  "chip_balance" numeric(20,2) DEFAULT 0 NOT NULL,
  "period_rake_collected" numeric(20,4) DEFAULT 0 NOT NULL,
  "period_commission_paid" numeric(20,4) DEFAULT 0 NOT NULL,
  "period_bbj_contribution" numeric(20,4) DEFAULT 0 NOT NULL,
  "period_started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "lifetime_rake_collected" numeric(20,4) DEFAULT 0 NOT NULL,
  "lifetime_commission_paid" numeric(20,4) DEFAULT 0 NOT NULL,
  "lifetime_bbj_contribution" numeric(20,4) DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "insurance_balance" numeric(20,2) DEFAULT 0 NOT NULL
);
CREATE TABLE public.clubs (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
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
  "is_platform" boolean DEFAULT false NOT NULL
);
CREATE TABLE public.financial_alerts (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "severity" text NOT NULL,
  "source" text NOT NULL,
  "message" text NOT NULL,
  "context" jsonb DEFAULT '{}'::jsonb,
  "resolved" boolean DEFAULT false NOT NULL,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_by" uuid,
  "resolution" text
);
CREATE TABLE public.hand_history (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "winner_name" text,
  "pot_size" numeric(12,2),
  "created_at" timestamp with time zone DEFAULT now(),
  "table_id" uuid,
  "tournament_id" uuid,
  "hand_number" integer,
  "game_variant" text DEFAULT 'nlh'::text,
  "small_blind" numeric(12,2) DEFAULT 0,
  "big_blind" numeric(12,2) DEFAULT 0,
  "rake_amount" numeric(12,2) DEFAULT 0,
  "community_cards" text[],
  "winners" jsonb,
  "players" jsonb DEFAULT '[]'::jsonb,
  "actions" jsonb DEFAULT '[]'::jsonb,
  "summary" text,
  "bbj_amount" numeric(12,2) DEFAULT 0 NOT NULL,
  "source" text DEFAULT 'manual'::text,
  "hand_name" text,
  "seed" text,
  "version" text DEFAULT 'v1'::text,
  "started_at" timestamp with time zone DEFAULT now(),
  "ended_at" timestamp with time zone,
  "hole_cards" jsonb,
  "board" jsonb,
  "reported" boolean DEFAULT false NOT NULL,
  "reported_at" timestamp with time zone,
  "button_seat" smallint,
  "has_human" boolean,
  "community_cards2" text[],
  "pots" jsonb,
  "showdown" jsonb,
  "rit_boards" jsonb,
  "community_cards3" text[],
  "bomb_pot" jsonb,
  "daily_mission_events" jsonb,
  "winners_by_board" jsonb,
  "kill_pot" jsonb
);
CREATE TABLE public.horse_mind_pairs (
  "attacker_id" text NOT NULL,
  "victim_id" text NOT NULL,
  "n3" integer DEFAULT 0 NOT NULL,
  "opp3" integer DEFAULT 0 NOT NULL,
  "n_r" integer DEFAULT 0 NOT NULL,
  "opp_r" integer DEFAULT 0 NOT NULL,
  "opps" integer GENERATED ALWAYS AS ((opp3 + opp_r)) STORED,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.horse_mind_stats (
  "user_id" text NOT NULL,
  "hands" integer DEFAULT 0 NOT NULL,
  "vpip" integer DEFAULT 0 NOT NULL,
  "pfr" integer DEFAULT 0 NOT NULL,
  "three_bet" integer DEFAULT 0 NOT NULL,
  "aggr" integer DEFAULT 0 NOT NULL,
  "passive" integer DEFAULT 0 NOT NULL,
  "folds" integer DEFAULT 0 NOT NULL,
  "faced_aggr" integer DEFAULT 0 NOT NULL,
  "r_hands" real DEFAULT 0 NOT NULL,
  "r_folds" real DEFAULT 0 NOT NULL,
  "r_faced_aggr" real DEFAULT 0 NOT NULL,
  "r_aggr" real DEFAULT 0 NOT NULL,
  "r_passive" real DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "cbet_opps" integer DEFAULT 0 NOT NULL,
  "cbet_folds" integer DEFAULT 0 NOT NULL,
  "f3b_opps" integer DEFAULT 0 NOT NULL,
  "f3b_folds" integer DEFAULT 0 NOT NULL,
  "bigbet_sd" integer DEFAULT 0 NOT NULL,
  "bigbet_sd_strong" integer DEFAULT 0 NOT NULL,
  "post_aggr" integer DEFAULT 0 NOT NULL,
  "post_passive" integer DEFAULT 0 NOT NULL,
  "river_bet_opps" integer DEFAULT 0 NOT NULL,
  "river_bet_folds" integer DEFAULT 0 NOT NULL,
  "checks" integer DEFAULT 0 NOT NULL,
  "r_checks" real DEFAULT 0 NOT NULL,
  "snap_bet_sd" integer DEFAULT 0 NOT NULL,
  "snap_bet_sd_strong" integer DEFAULT 0 NOT NULL,
  "tank_bet_sd" integer DEFAULT 0 NOT NULL,
  "tank_bet_sd_strong" integer DEFAULT 0 NOT NULL
);
CREATE TABLE public.horse_mind_stats_scoped (
  "user_id" text NOT NULL,
  "scope" text NOT NULL,
  "hands" integer DEFAULT 0 NOT NULL,
  "vpip" integer DEFAULT 0 NOT NULL,
  "pfr" integer DEFAULT 0 NOT NULL,
  "three_bet" integer DEFAULT 0 NOT NULL,
  "aggr" integer DEFAULT 0 NOT NULL,
  "passive" integer DEFAULT 0 NOT NULL,
  "folds" integer DEFAULT 0 NOT NULL,
  "faced_aggr" integer DEFAULT 0 NOT NULL,
  "cbet_opps" integer DEFAULT 0 NOT NULL,
  "cbet_folds" integer DEFAULT 0 NOT NULL,
  "f3b_opps" integer DEFAULT 0 NOT NULL,
  "f3b_folds" integer DEFAULT 0 NOT NULL,
  "bigbet_sd" integer DEFAULT 0 NOT NULL,
  "bigbet_sd_strong" integer DEFAULT 0 NOT NULL,
  "river_bet_opps" integer DEFAULT 0 NOT NULL,
  "river_bet_folds" integer DEFAULT 0 NOT NULL,
  "checks" integer DEFAULT 0 NOT NULL,
  "post_aggr" integer DEFAULT 0 NOT NULL,
  "post_passive" integer DEFAULT 0 NOT NULL,
  "snap_bet_sd" integer DEFAULT 0 NOT NULL,
  "snap_bet_sd_strong" integer DEFAULT 0 NOT NULL,
  "tank_bet_sd" integer DEFAULT 0 NOT NULL,
  "tank_bet_sd_strong" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.player_stats (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "club_id" uuid,
  "hands_played" integer DEFAULT 0,
  "total_winnings" numeric(15,2) DEFAULT 0 NOT NULL,
  "total_losses" numeric(15,2) DEFAULT 0,
  "total_rake" numeric(15,2) DEFAULT 0 NOT NULL,
  "vpip" numeric(5,2) DEFAULT 0,
  "pfr" numeric(5,2) DEFAULT 0,
  "updated_at" timestamp with time zone DEFAULT now(),
  "tournaments_played" integer DEFAULT 0,
  "tournaments_won" integer DEFAULT 0,
  "hands_dealt" bigint DEFAULT 0 NOT NULL,
  "sum_big_blind" numeric DEFAULT 0 NOT NULL
);
CREATE TABLE public.profiles (
  "id" uuid NOT NULL,
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
  "diamond_arena_preferences" jsonb,
  "memory_games_preferences" jsonb,
  "news_preferences" jsonb,
  "video_library_preferences" jsonb,
  "memory_elo" integer,
  "arena_avatar_url" text,
  "equipped_frame" text,
  "equipped_aura" text,
  "use_avatar_as_profile_pic" boolean DEFAULT false,
  "status_text" text,
  "player_tags" text[] DEFAULT '{}'::text[]
);
CREATE TABLE public.rake_attributions (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "hand_id" uuid NOT NULL,
  "player_id" uuid NOT NULL,
  "rake_amount" numeric NOT NULL,
  "agent_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "rake_record_id" uuid,
  "table_id" uuid,
  "club_id" uuid,
  "gross_contribution" numeric,
  "returned_uncalled" numeric DEFAULT 0 NOT NULL,
  "eligible_contribution" numeric,
  "contribution_weight" numeric,
  "weighted_rake_credit" numeric,
  "bbj_attributed_contribution" numeric DEFAULT 0 NOT NULL,
  "rake_method" text
);
CREATE TABLE public.rake_distribution_legs (
  "leg_key" uuid NOT NULL,
  "leg" text NOT NULL,
  "club_id" uuid,
  "union_id" uuid,
  "amount" numeric,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.rake_records (
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
  "terminal_closed_at" timestamp with time zone
);
CREATE TABLE public.rakeback_stats_applied (
  "rake_record_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "hands" integer,
  "rake" numeric,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.tables (
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
  "f06_lifecycle" bigint DEFAULT smarter_private.f06_new_lifecycle() NOT NULL,
  "dealing_halted_at" timestamp with time zone,
  "dealing_halted_reason" text,
  "kill_mode" text DEFAULT 'off'::text NOT NULL,
  "kill_threshold_bb" smallint DEFAULT 10 NOT NULL,
  "dealing_halt_observed_at" timestamp with time zone
);
CREATE TABLE public.tournaments (
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
  "max_players" integer,
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
  "blind_level_state" jsonb,
  "payout_math_version" smallint DEFAULT 1 NOT NULL,
  "payout_unit_cents" integer DEFAULT 1 NOT NULL,
  "format_contract" text,
  "restart_source_id" uuid
);
CREATE TABLE public.union_clubs (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "union_id" uuid NOT NULL,
  "club_id" uuid NOT NULL,
  "joined_at" timestamp with time zone DEFAULT now(),
  "club_commission_rate" numeric(5,4) DEFAULT 0.9000,
  "rate_cash" numeric,
  "rate_mtt" numeric,
  "rate_sng" numeric,
  "rate_spin" numeric,
  "rate_satellite" numeric
);
CREATE TABLE public.union_rakeback_log (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "union_id" uuid NOT NULL,
  "period_start" timestamp with time zone NOT NULL,
  "period_end" timestamp with time zone NOT NULL,
  "total_rakeback" numeric DEFAULT 0,
  "executed_at" timestamp with time zone DEFAULT now()
);
CREATE TABLE public.union_wallet_transactions (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "union_id" uuid NOT NULL,
  "wallet" text NOT NULL,
  "direction" text NOT NULL,
  "amount" numeric(20,4) NOT NULL,
  "balance_after" numeric(20,4),
  "tx_type" text NOT NULL,
  "club_id" uuid,
  "period_id" uuid,
  "notes" text,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.union_wallets (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "union_id" uuid NOT NULL,
  "chip_balance" numeric(20,2) DEFAULT 0 NOT NULL,
  "rake_wallet" numeric(20,2) DEFAULT 0,
  "bbj_wallet" numeric(20,2) DEFAULT 0,
  "promo_wallet" numeric(20,2) DEFAULT 0,
  "insurance_wallet" numeric(20,2) DEFAULT 0,
  "total_rake_collected" numeric(20,2) DEFAULT 0,
  "total_settlements" numeric DEFAULT 0,
  "updated_at" timestamp with time zone DEFAULT now(),
  "created_at" timestamp with time zone DEFAULT now(),
  "spin_reserve_wallet" numeric(20,2) DEFAULT 0 NOT NULL
);
CREATE TABLE public.vip_points (
  "user_id" uuid NOT NULL,
  "current_points" bigint DEFAULT 0 NOT NULL,
  "lifetime_points" bigint DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.vip_points_carry (
  "user_id" uuid NOT NULL,
  "carry" numeric(14,4) DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE public.vip_points_ledger (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "points" bigint NOT NULL,
  "reason" text,
  "source_type" text DEFAULT 'rake'::text NOT NULL,
  "source_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "credit" numeric(14,4)
);
CREATE UNIQUE INDEX accounting_agreement_history_pkey ON public.accounting_agreement_history USING btree (id);
CREATE UNIQUE INDEX accounting_cash_accrual_batches_hand_id_key ON public.accounting_cash_accrual_batches USING btree (hand_id);
CREATE UNIQUE INDEX accounting_cash_accrual_batches_pkey ON public.accounting_cash_accrual_batches USING btree (rake_record_id);
CREATE UNIQUE INDEX accounting_cash_accrual_cutover_pkey ON public.accounting_cash_accrual_cutover USING btree (singleton);
CREATE UNIQUE INDEX accounting_cash_bank_receipts_club_ledger_id_key ON public.accounting_cash_bank_receipts USING btree (club_ledger_id);
CREATE UNIQUE INDEX accounting_cash_bank_receipts_pkey ON public.accounting_cash_bank_receipts USING btree (rake_record_id);
CREATE UNIQUE INDEX accounting_cash_bank_receipts_union_transaction_id_key ON public.accounting_cash_bank_receipts USING btree (union_transaction_id);
CREATE UNIQUE INDEX accounting_cash_rake_sources_pkey ON public.accounting_cash_rake_sources USING btree (id);
CREATE UNIQUE INDEX accounting_cash_rake_sources_rake_record_id_player_id_key ON public.accounting_cash_rake_sources USING btree (rake_record_id, player_id);
CREATE UNIQUE INDEX accounting_cash_source_receipts_pkey ON public.accounting_cash_source_receipts USING btree (id);
CREATE UNIQUE INDEX accounting_cash_source_receipts_rake_record_id_attempt_key ON public.accounting_cash_source_receipts USING btree (rake_record_id, attempt);
CREATE UNIQUE INDEX accounting_cash_source_work_pkey ON public.accounting_cash_source_work USING btree (rake_record_id);
CREATE UNIQUE INDEX accounting_period_recompute_r_club_id_period_start_period_e_key ON public.accounting_period_recompute_requests USING btree (club_id, period_start, period_end);
CREATE UNIQUE INDEX accounting_period_recompute_requests_pkey ON public.accounting_period_recompute_requests USING btree (id);
CREATE UNIQUE INDEX accounting_routed_settlement_runs_pkey ON public.accounting_routed_settlement_runs USING btree (scope_kind, scope_id, period_start, period_end, round_no);
CREATE UNIQUE INDEX accounting_tournament_fee_recog_union_wallet_transaction_id_key ON public.accounting_tournament_fee_recognitions USING btree (union_wallet_transaction_id);
CREATE UNIQUE INDEX accounting_tournament_fee_recognitions_bank_journal_id_key ON public.accounting_tournament_fee_recognitions USING btree (bank_journal_id);
CREATE UNIQUE INDEX accounting_tournament_fee_recognitions_pkey ON public.accounting_tournament_fee_recognitions USING btree (tournament_id);
CREATE UNIQUE INDEX accounting_tournament_fee_sources_pkey ON public.accounting_tournament_fee_sources USING btree (id);
CREATE UNIQUE INDEX accounting_tournament_fee_sources_rake_record_id_player_id_key ON public.accounting_tournament_fee_sources USING btree (rake_record_id, player_id);
CREATE UNIQUE INDEX accounting_tournament_fee_sources_source_entitlement_id_key ON public.accounting_tournament_fee_sources USING btree (source_entitlement_id);
CREATE UNIQUE INDEX accounting_tournament_recognized_sources_pkey ON public.accounting_tournament_recognized_sources USING btree (source_id);
CREATE UNIQUE INDEX agent_commission_settlements_club_id_user_id_period_start_p_key ON public.agent_commission_settlements USING btree (club_id, user_id, period_start, period_end);
CREATE UNIQUE INDEX agent_commission_settlements_pkey ON public.agent_commission_settlements USING btree (id);
CREATE UNIQUE INDEX agent_commission_unsettled_rollup_pkey ON public.agent_commission_unsettled_rollup USING btree (club_id, user_id);
CREATE UNIQUE INDEX agent_commissions_pkey ON public.agent_commissions USING btree (id);
CREATE UNIQUE INDEX uq_agent_commissions_source ON public.agent_commissions USING btree (user_id, source_id, source_type) WHERE (source_id IS NOT NULL);
CREATE UNIQUE INDEX agents_agreement_club_and_id ON public.agents USING btree (club_id, id);
CREATE UNIQUE INDEX agents_club_id_user_id_key ON public.agents USING btree (club_id, user_id);
CREATE UNIQUE INDEX agents_pkey ON public.agents USING btree (id);
CREATE UNIQUE INDEX ca_club_commission_daily_pkey ON public.ca_club_commission_daily USING btree (club_id, stat_date);
CREATE UNIQUE INDEX ca_club_rake_daily_pkey ON public.ca_club_rake_daily USING btree (club_id, stat_date);
CREATE UNIQUE INDEX chip_ledger_chain_seq_key ON public.chip_ledger USING btree (chain_seq);
CREATE UNIQUE INDEX chip_ledger_pkey ON public.chip_ledger USING btree (id);
CREATE UNIQUE INDEX ux_chip_ledger_idempotency_key ON public.chip_ledger USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);
CREATE UNIQUE INDEX club_members_pkey ON public.club_members USING btree (club_id, user_id);
CREATE UNIQUE INDEX club_wallet_transactions_pkey ON public.club_wallet_transactions USING btree (id);
CREATE UNIQUE INDEX club_wallets_club_id_key ON public.club_wallets USING btree (club_id);
CREATE UNIQUE INDEX club_wallets_pkey ON public.club_wallets USING btree (id);
CREATE UNIQUE INDEX ca_clubs_one_platform_club ON public.clubs USING btree (is_platform) WHERE is_platform;
CREATE UNIQUE INDEX clubs_club_id_key ON public.clubs USING btree (club_id);
CREATE UNIQUE INDEX clubs_pkey ON public.clubs USING btree (id);
CREATE UNIQUE INDEX idx_clubs_code ON public.clubs USING btree (code);
CREATE UNIQUE INDEX idx_clubs_name_lower ON public.clubs USING btree (lower(name));
CREATE UNIQUE INDEX idx_clubs_slug ON public.clubs USING btree (slug) WHERE (slug IS NOT NULL);
CREATE UNIQUE INDEX poker_arena_one_diamond_identity ON public.clubs USING btree (asset) WHERE (asset = 'diamonds'::text);
CREATE UNIQUE INDEX financial_alerts_pkey ON public.financial_alerts USING btree (id);
CREATE UNIQUE INDEX hand_history_pkey ON public.hand_history USING btree (id);
CREATE UNIQUE INDEX uq_hand_history_global_hand_number ON public.hand_history USING btree (hand_number) WHERE (hand_number >= 1000000);
CREATE UNIQUE INDEX horse_mind_pairs_pkey ON public.horse_mind_pairs USING btree (attacker_id, victim_id);
CREATE UNIQUE INDEX horse_mind_stats_pkey ON public.horse_mind_stats USING btree (user_id);
CREATE UNIQUE INDEX horse_mind_stats_scoped_pkey ON public.horse_mind_stats_scoped USING btree (user_id, scope);
CREATE UNIQUE INDEX player_stats_pkey ON public.player_stats USING btree (id);
CREATE UNIQUE INDEX player_stats_user_id_club_id_key ON public.player_stats USING btree (user_id, club_id);
CREATE UNIQUE INDEX idx_profiles_referral_code ON public.profiles USING btree (referral_code) WHERE (referral_code IS NOT NULL);
CREATE UNIQUE INDEX idx_profiles_username_lower ON public.profiles USING btree (lower(username)) WHERE (username IS NOT NULL);
CREATE UNIQUE INDEX one_god_account_only ON public.profiles USING btree (role) WHERE (role = 'god'::text);
CREATE UNIQUE INDEX profiles_pkey ON public.profiles USING btree (id);
CREATE UNIQUE INDEX profiles_username_lower_key ON public.profiles USING btree (lower(username)) WHERE ((username IS NOT NULL) AND (username <> ''::text));
CREATE UNIQUE INDEX uniq_profiles_verified_phone ON public.profiles USING btree (phone) WHERE ((phone_verified = true) AND (phone IS NOT NULL) AND (phone <> ''::text));
CREATE UNIQUE INDEX uq_profiles_player_number ON public.profiles USING btree (player_number) WHERE (player_number IS NOT NULL);
CREATE UNIQUE INDEX rake_attributions_pkey ON public.rake_attributions USING btree (id);
CREATE UNIQUE INDEX uq_rake_attributions_hand_player ON public.rake_attributions USING btree (hand_id, player_id);
CREATE UNIQUE INDEX rake_distribution_legs_pkey ON public.rake_distribution_legs USING btree (leg_key, leg);
CREATE UNIQUE INDEX rake_records_pkey ON public.rake_records USING btree (id);
CREATE UNIQUE INDEX uq_rake_records_hand_id ON public.rake_records USING btree (hand_id) WHERE (hand_id IS NOT NULL);
CREATE UNIQUE INDEX rakeback_stats_applied_pkey ON public.rakeback_stats_applied USING btree (rake_record_id, user_id);
CREATE UNIQUE INDEX table_game_scope_parent_key ON public.tables USING btree (id, seat_game_scope);
CREATE UNIQUE INDEX table_seat_admission_parent_key ON public.tables USING btree (id, seat_admission_key);
CREATE UNIQUE INDEX tables_pkey ON public.tables USING btree (id);
CREATE UNIQUE INDEX tournaments_one_restart_per_source ON public.tournaments USING btree (restart_source_id) WHERE (restart_source_id IS NOT NULL);
CREATE UNIQUE INDEX tournaments_pkey ON public.tournaments USING btree (id);
CREATE UNIQUE INDEX uq_scheduled_tournament_one_live_per_occurrence ON public.tournaments USING btree (club_id, tournament_type, name, start_time) WHERE ((status = ANY (ARRAY['ANNOUNCED'::text, 'REGISTERING'::text])) AND (tournament_type = ANY (ARRAY['MTT'::text, 'XMTT'::text])));
CREATE UNIQUE INDEX union_clubs_pkey ON public.union_clubs USING btree (id);
CREATE UNIQUE INDEX union_clubs_union_id_club_id_key ON public.union_clubs USING btree (union_id, club_id);
CREATE UNIQUE INDEX union_rakeback_log_pkey ON public.union_rakeback_log USING btree (id);
CREATE UNIQUE INDEX union_rakeback_log_union_id_period_start_period_end_key ON public.union_rakeback_log USING btree (union_id, period_start, period_end);
CREATE UNIQUE INDEX union_wallet_transactions_pkey ON public.union_wallet_transactions USING btree (id);
CREATE UNIQUE INDEX uq_union_wallet_tx_op ON public.union_wallet_transactions USING btree (union_id, tx_type, period_id) WHERE (period_id IS NOT NULL);
CREATE UNIQUE INDEX union_wallets_pkey ON public.union_wallets USING btree (id);
CREATE UNIQUE INDEX union_wallets_union_id_key ON public.union_wallets USING btree (union_id);
CREATE UNIQUE INDEX vip_points_pkey ON public.vip_points USING btree (user_id);
CREATE UNIQUE INDEX vip_points_carry_pkey ON public.vip_points_carry USING btree (user_id);
CREATE UNIQUE INDEX vip_points_ledger_pkey ON public.vip_points_ledger USING btree (id);
CREATE UNIQUE INDEX vip_points_ledger_user_id_source_type_source_id_key ON public.vip_points_ledger USING btree (user_id, source_type, source_id);
RESET client_min_messages;
