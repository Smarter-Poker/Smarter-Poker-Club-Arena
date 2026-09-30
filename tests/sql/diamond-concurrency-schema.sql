-- ============================================================================
-- THE TABLES THE DIAMOND MONEY DOORS WRITE, IN PRODUCTION'S SHAPE
-- ============================================================================
--
-- Phase 11, line 2. A race is decided by the rows it writes: a unique index
-- is what makes the second of two identical requests wait for the first, a
-- constraint trigger is what refuses an unbound custody row at commit, and a
-- trigger chain is what keeps the register in step with every wallet. So the
-- tables the concurrency cases write must carry production's columns,
-- constraints, indexes and triggers, not the historical base's.
--
-- Every statement below was generated from production's own catalogue, read
-- read-only (pg_get_indexdef, pg_get_constraintdef, pg_get_triggerdef,
-- format_type, pg_get_expr), as the difference between production and this
-- fixture's base. Nothing is authored. The block at the foot renders each
-- table's full shape back out of this catalogue - every column with its type,
-- nullability and default, every constraint, index and trigger with its
-- enabled state, and the row-security flags - and refuses to finish unless
-- its md5 equals the signature production rendered for the same table.
--
-- Row-level security POLICIES are not part of the shape: every door here is
-- SECURITY DEFINER and runs as its owner, which no policy restricts.
-- ============================================================================
SET check_function_bodies = off;
SET search_path = public, extensions, pg_catalog;

CREATE SEQUENCE IF NOT EXISTS public.poker_diamond_tournament_ledger_id_seq;
CREATE TABLE public.diamond_wallet_transfers (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  sender_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  request_id text NOT NULL,
  amount integer NOT NULL,
  message text,
  sender_journal_id uuid NOT NULL,
  recipient_journal_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE public.diamond_wallet_transfers ADD CONSTRAINT diamond_wallet_transfers_amount_check CHECK ((amount > 0));
ALTER TABLE public.diamond_wallet_transfers ADD CONSTRAINT diamond_wallet_transfers_check CHECK ((sender_id <> recipient_id));
ALTER TABLE public.diamond_wallet_transfers ADD CONSTRAINT diamond_wallet_transfers_pkey PRIMARY KEY (id);
ALTER TABLE public.diamond_wallet_transfers ADD CONSTRAINT diamond_wallet_transfers_sender_id_request_id_key UNIQUE (sender_id, request_id);
ALTER TABLE public.diamond_wallet_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diamond_wallet_transfers NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.feature_purchases DROP CONSTRAINT IF EXISTS feature_purchases_source_check CASCADE;
ALTER TABLE public.feature_purchases ADD CONSTRAINT feature_purchases_source_check CHECK ((source = ANY (ARRAY['purchase'::text, 'daily_bonus'::text, 'promo_vault'::text, 'shop'::text, 'admin'::text, 'diamond_wheel'::text])));
ALTER TABLE public.poker_diamond_custody ADD COLUMN seat_id uuid;
ALTER TABLE public.poker_diamond_custody ADD COLUMN seat_joined_at timestamp with time zone;
ALTER TABLE public.poker_diamond_custody ADD COLUMN occupancy_id uuid;
ALTER TABLE public.poker_diamond_custody ADD CONSTRAINT poker_diamond_seat_identity_complete CHECK ((((seat_id IS NULL) AND (seat_joined_at IS NULL) AND (occupancy_id IS NULL)) OR ((purpose = 'cash_seat'::text) AND (seat_id IS NOT NULL) AND (seat_joined_at IS NOT NULL) AND (occupancy_id IS NOT NULL))));
ALTER TABLE public.poker_diamond_movements ALTER COLUMN wallet_journal_id DROP NOT NULL;
ALTER TABLE public.poker_diamond_movements DROP CONSTRAINT IF EXISTS poker_diamond_movements_amount_check CASCADE;
ALTER TABLE public.poker_diamond_movements ADD CONSTRAINT poker_diamond_movements_amount_check CHECK (((((amount >= 1) AND (amount <= 2147483647)) AND (wallet_journal_id IS NOT NULL)) OR ((action = 'release'::text) AND (amount = 0) AND (wallet_journal_id IS NULL))));
ALTER TABLE public.poker_diamond_lot_reservations ADD COLUMN consumed bigint DEFAULT 0 NOT NULL;
ALTER TABLE public.poker_diamond_lot_reservations ADD CONSTRAINT poker_diamond_lot_reservations_check CHECK (((consumed >= 0) AND (consumed <= amount)));
CREATE TABLE public.seat_cashout_receipts (
  occupancy_id uuid NOT NULL,
  user_id uuid NOT NULL,
  table_id uuid NOT NULL,
  seat_id uuid NOT NULL,
  seat_number integer NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
ALTER TABLE public.seat_cashout_receipts ADD CONSTRAINT seat_cashout_receipts_pkey PRIMARY KEY (occupancy_id);
ALTER TABLE public.seat_cashout_receipts ADD CONSTRAINT seat_cashout_receipts_receipt_check CHECK ((jsonb_typeof(receipt) = 'object'::text));
ALTER TABLE public.seat_cashout_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seat_cashout_receipts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.table_seats ADD COLUMN occupancy_id uuid DEFAULT gen_random_uuid() NOT NULL;
ALTER TABLE public.table_seats ADD COLUMN active_game_scope text;
ALTER TABLE public.table_seats ADD COLUMN active_parent_key text;
ALTER TABLE public.table_seats ADD CONSTRAINT active_seat_requires_game_scope CHECK ((((left_at IS NULL) AND (active_game_scope IS NOT NULL) AND (user_id IS NOT NULL) AND (table_id IS NOT NULL)) OR ((left_at IS NOT NULL) AND (active_game_scope IS NULL))));
ALTER TABLE public.table_seats ADD CONSTRAINT active_seat_requires_open_parent CHECK ((((left_at IS NULL) AND (active_parent_key IS NOT NULL) AND (active_parent_key <> 'closed'::text)) OR ((left_at IS NOT NULL) AND (active_parent_key IS NULL))));
ALTER TABLE public.table_seats ADD CONSTRAINT one_committed_seat_per_game_player UNIQUE (user_id, active_game_scope) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE public.tables ADD COLUMN observer_show_cards boolean DEFAULT false NOT NULL;
ALTER TABLE public.tables ADD COLUMN seat_game_scope text;
ALTER TABLE public.tables ADD COLUMN seat_admission_key text;
ALTER TABLE public.tables ADD COLUMN f06_lifecycle bigint DEFAULT smarter_private.f06_new_lifecycle() NOT NULL;
ALTER TABLE public.tables ADD COLUMN dealing_halted_at timestamp with time zone;
ALTER TABLE public.tables ADD COLUMN dealing_halted_reason text;
ALTER TABLE public.tables ADD COLUMN kill_mode text DEFAULT 'off'::text NOT NULL;
ALTER TABLE public.tables ADD COLUMN kill_threshold_bb smallint DEFAULT 10 NOT NULL;
ALTER TABLE public.tables ADD COLUMN dealing_halt_observed_at timestamp with time zone;
ALTER TABLE public.tables DROP CONSTRAINT IF EXISTS tables_cash_needs_a_game CASCADE;
ALTER TABLE public.tables ADD CONSTRAINT table_game_scope_is_derived CHECK (((seat_game_scope IS NULL) OR (seat_game_scope =
CASE
    WHEN (cluster_id IS NULL) THEN ('table:'::text || (id)::text)
    ELSE ('cluster:'::text || (cluster_id)::text)
END)));
ALTER TABLE public.tables ADD CONSTRAINT table_game_scope_parent_key UNIQUE (id, seat_game_scope);
ALTER TABLE public.tables ADD CONSTRAINT table_seat_admission_is_derived CHECK (((seat_admission_key IS NULL) OR (seat_admission_key =
CASE
    WHEN ((lower(COALESCE(status, ''::text)) = ANY (ARRAY['closed'::text, 'completed'::text, 'cancelled'::text, 'finished'::text])) OR (lifecycle = 'closed'::text) OR COALESCE(is_deleted, false) OR COALESCE(is_template, false)) THEN 'closed'::text
    WHEN (tournament_id IS NOT NULL) THEN ('tournament:'::text || (tournament_id)::text)
    ELSE 'cash'::text
END)));
ALTER TABLE public.tables ADD CONSTRAINT table_seat_admission_parent_key UNIQUE (id, seat_admission_key);
ALTER TABLE public.tables ADD CONSTRAINT tables_cash_needs_a_game CHECK (((tournament_id IS NOT NULL) OR (cluster_id IS NOT NULL) OR (status = ANY (ARRAY['closed'::text, 'deleted'::text])) OR COALESCE(is_deleted, false) OR (club_id IS NULL) OR (game_variant IS NULL) OR (COALESCE(small_blind, (0)::numeric) <= (0)::numeric) OR (COALESCE(big_blind, (0)::numeric) <= COALESCE(small_blind, (0)::numeric)) OR (club_id = '002c2d27-9584-4e52-835a-bb2be148fc81'::uuid)));
ALTER TABLE public.tables ADD CONSTRAINT tables_dealing_halt_is_explained CHECK ((((dealing_halted_at IS NULL) AND (dealing_halted_reason IS NULL)) OR ((dealing_halted_at IS NOT NULL) AND (dealing_halted_reason IS NOT NULL) AND (dealing_halted_reason = ANY (ARRAY['lightning_pending_on'::text, 'lightning'::text])))));
ALTER TABLE public.tables ADD CONSTRAINT tables_kill_mode_check CHECK ((kill_mode = ANY (ARRAY['off'::text, 'half'::text, 'full'::text]))) NOT VALID;
ALTER TABLE public.tables ADD CONSTRAINT tables_kill_threshold_bb_check CHECK ((kill_threshold_bb = ANY (ARRAY[8, 10, 12, 15]))) NOT VALID;
ALTER TABLE public.tables ADD CONSTRAINT tables_name_is_not_a_javascript_accident CHECK (((name IS NULL) OR ((name !~ 'undefined'::text) AND (name !~ 'NaN'::text) AND (name !~ '\[object'::text)))) NOT VALID;
ALTER TABLE public.tables ADD CONSTRAINT tables_stakes_is_not_a_javascript_accident CHECK (((stakes IS NULL) OR ((stakes !~ 'undefined'::text) AND (stakes !~ 'NaN'::text) AND (stakes !~ '\[object'::text) AND (stakes <> 'null/null'::text)))) NOT VALID;
ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS tournaments_spin_has_no_fee CASCADE;
ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS tournaments_spin_no_extra_rake CASCADE;
ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS tournaments_status_check CASCADE;
ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_spin_has_no_fee CHECK (((created_at < '2026-08-21 00:00:00+00'::timestamp with time zone) OR (((lower(COALESCE(variant, ''::text)) <> 'spin'::text) AND (upper(COALESCE(tournament_type, ''::text)) <> 'SPIN'::text)) OR (COALESCE(buy_in_fee, (0)::numeric) = (0)::numeric)))) NOT VALID;
ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_spin_no_extra_rake CHECK (((created_at < '2026-08-21 00:00:00+00'::timestamp with time zone) OR ((variant IS DISTINCT FROM 'spin'::text) AND (upper(COALESCE(tournament_type, ''::text)) <> 'SPIN'::text)) OR (COALESCE(buy_in_fee, (0)::numeric) = (0)::numeric))) NOT VALID;
ALTER TABLE public.tournaments ADD CONSTRAINT tournaments_status_check CHECK ((status = ANY (ARRAY['ANNOUNCED'::text, 'REGISTERING'::text, 'LATE_REG'::text, 'RUNNING'::text, 'COMPLETING'::text, 'COMPLETED'::text, 'CANCELLED'::text, 'BAGGED'::text])));
ALTER TABLE public.poker_diamond_tournament_ledger DROP CONSTRAINT IF EXISTS poker_diamond_tournament_ledger_kind_check CASCADE;
ALTER TABLE public.poker_diamond_tournament_ledger DROP CONSTRAINT IF EXISTS poker_diamond_tournament_ledger_outflow CASCADE;
ALTER TABLE public.poker_diamond_tournament_ledger ADD CONSTRAINT poker_diamond_tournament_ledger_kind_check CHECK ((kind = ANY (ARRAY['entry'::text, 'rebuy'::text, 'reentry'::text, 'addon'::text, 'prize'::text, 'bounty'::text, 'fee'::text, 'refund'::text, 'spin_underwrite'::text, 'spin_surplus'::text])));
ALTER TABLE public.poker_diamond_tournament_ledger ADD CONSTRAINT poker_diamond_tournament_ledger_outflow CHECK ((((kind = ANY (ARRAY['prize'::text, 'bounty'::text, 'refund'::text])) AND (user_id IS NOT NULL)) OR ((kind = 'fee'::text) AND (user_id IS NULL) AND (prize_part = 0) AND (bounty_part = 0)) OR (kind = ANY (ARRAY['entry'::text, 'rebuy'::text, 'reentry'::text, 'addon'::text])) OR ((kind = ANY (ARRAY['spin_underwrite'::text, 'spin_surplus'::text])) AND (user_id IS NOT NULL) AND (custody_id IS NOT NULL) AND (wallet_journal_id IS NOT NULL) AND (prize_part = amount) AND (bounty_part = 0) AND (fee_part = 0))));
DROP INDEX IF EXISTS public.idx_profiles_referral_code;
CREATE UNIQUE INDEX idx_profiles_referral_code ON public.profiles USING btree (referral_code) WHERE (referral_code IS NOT NULL);
CREATE UNIQUE INDEX poker_diamond_custody_occupancy ON public.poker_diamond_custody USING btree (occupancy_id) WHERE (occupancy_id IS NOT NULL);
CREATE INDEX poker_diamond_custody_seat ON public.poker_diamond_custody USING btree (seat_id) WHERE (seat_id IS NOT NULL);
CREATE UNIQUE INDEX table_seats_occupancy_id_unique ON public.table_seats USING btree (occupancy_id);
CREATE INDEX idx_tables_cluster_closed_status_drift ON public.tables USING btree (cluster_id) WHERE ((lifecycle = 'closed'::text) AND (status <> 'closed'::text));
CREATE INDEX idx_tables_cluster_open ON public.tables USING btree (cluster_id, role, main_index, created_at) WHERE (lifecycle <> 'closed'::text);
CREATE INDEX idx_tables_live_tournament_by_id ON public.tables USING btree (id) WHERE ((tournament_id IS NOT NULL) AND (status <> 'closed'::text));
CREATE INDEX idx_tournaments_updated_at ON public.tournaments USING btree (updated_at DESC);
CREATE INDEX idx_tournament_players_live_by_id ON public.tournament_players USING btree (id) WHERE (status = ANY (ARRAY['registered'::text, 'playing'::text]));
CREATE INDEX idx_poker_diamond_tournament_ledger_arena_id_fk ON public.poker_diamond_tournament_ledger USING btree (arena_id);
CREATE TRIGGER profile_account_changed AFTER UPDATE OF username, display_name, alias, first_name, last_name, full_name, display_name_preference, use_real_name, bio, player_tags, login_streak, vip_tier, settings, diamonds ON public.profiles FOR EACH ROW WHEN (((((((((((((((((old.username IS DISTINCT FROM new.username) OR (old.display_name IS DISTINCT FROM new.display_name)) OR (old.alias IS DISTINCT FROM new.alias)) OR (old.first_name IS DISTINCT FROM new.first_name)) OR (old.last_name IS DISTINCT FROM new.last_name)) OR (old.full_name IS DISTINCT FROM new.full_name)) OR (old.display_name_preference IS DISTINCT FROM new.display_name_preference)) OR (old.use_real_name IS DISTINCT FROM new.use_real_name)) OR (old.bio IS DISTINCT FROM new.bio)) OR (old.player_tags IS DISTINCT FROM new.player_tags)) OR (old.login_streak IS DISTINCT FROM new.login_streak)) OR (old.vip_tier IS DISTINCT FROM new.vip_tier)) OR ((old.settings -> 'theme'::text) IS DISTINCT FROM (new.settings -> 'theme'::text))) OR ((old.settings -> 'achievementNotifications'::text) IS DISTINCT FROM (new.settings -> 'achievementNotifications'::text))) OR ((old.settings -> 'settlementAlerts'::text) IS DISTINCT FROM (new.settings -> 'settlementAlerts'::text))) OR (old.diamonds IS DISTINCT FROM new.diamonds))) EXECUTE FUNCTION fn_publish_profile_account_change();
CREATE TRIGGER profile_appearance_changed AFTER UPDATE OF avatar_url, arena_avatar_url, use_avatar_as_profile_pic, is_vip, vip_expires_at, equipped_frame, equipped_aura ON public.profiles FOR EACH ROW WHEN ((((((((old.avatar_url IS DISTINCT FROM new.avatar_url) OR (old.arena_avatar_url IS DISTINCT FROM new.arena_avatar_url)) OR (old.use_avatar_as_profile_pic IS DISTINCT FROM new.use_avatar_as_profile_pic)) OR (old.is_vip IS DISTINCT FROM new.is_vip)) OR (old.vip_expires_at IS DISTINCT FROM new.vip_expires_at)) OR (old.equipped_frame IS DISTINCT FROM new.equipped_frame)) OR (old.equipped_aura IS DISTINCT FROM new.equipped_aura))) EXECUTE FUNCTION fn_publish_profile_appearance_change();
CREATE TRIGGER trg_a_closed_account_cannot_rewrite_itself BEFORE UPDATE ON public.profiles FOR EACH ROW WHEN ((old.status = 'deleted'::text)) EXECUTE FUNCTION fn_a_closed_account_cannot_rewrite_itself();
CREATE TRIGGER trg_only_close_account_closes_an_account BEFORE UPDATE ON public.profiles FOR EACH ROW WHEN (((new.status = 'deleted'::text) AND (old.status IS DISTINCT FROM 'deleted'::text))) EXECUTE FUNCTION fn_only_close_account_closes_an_account();
CREATE TRIGGER zz_diamond_spin_wallet_reserve BEFORE DELETE OR UPDATE OF diamonds ON public.profiles FOR EACH ROW EXECUTE FUNCTION fn_diamond_spin_wallet_reserve();
CREATE TRIGGER zzzz_guard_horse_profile_authority BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION fn_guard_horse_profile_authority();
CREATE TRIGGER ab_ca_diamond_transfer_names_its_counterparty BEFORE INSERT ON public.diamond_transactions FOR EACH ROW EXECUTE FUNCTION fn_ca_diamond_transfer_names_its_counterparty();
CREATE TRIGGER wallet_transfers_append_only BEFORE DELETE OR UPDATE ON public.diamond_wallet_transfers FOR EACH ROW EXECUTE FUNCTION fn_ca_journal_append_only();
CREATE CONSTRAINT TRIGGER zzz_diamond_entry_custody_is_the_entry AFTER INSERT OR UPDATE ON public.poker_diamond_custody DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_poker_diamond_entry_custody_is_the_entry();
DROP TRIGGER IF EXISTS trg_stamp_seat_horse_id ON public.table_seats;
DROP TRIGGER IF EXISTS zy_tournament_live_seat_exit_requires_authority ON public.table_seats;
CREATE TRIGGER a00_f06_source_seat BEFORE INSERT OR DELETE OR UPDATE OF table_id, user_id, seat_number, left_at ON public.table_seats FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard();
CREATE TRIGGER poker_bind_diamond_seat AFTER INSERT ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_poker_bind_diamond_seat();
CREATE TRIGGER trg_stamp_seat_horse_id BEFORE INSERT OR UPDATE OF user_id, horse_id ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_stamp_seat_horse_id();
CREATE TRIGGER trg_table_seats_lightning_anchor_delete_guard BEFORE DELETE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_table_seats_lightning_anchor_guard();
CREATE TRIGGER trg_table_seats_lightning_anchor_guard BEFORE UPDATE ON public.table_seats FOR EACH ROW WHEN (((old.stack IS DISTINCT FROM new.stack) OR (old.left_at IS DISTINCT FROM new.left_at) OR (old.user_id IS DISTINCT FROM new.user_id))) EXECUTE FUNCTION fn_table_seats_lightning_anchor_guard();
CREATE CONSTRAINT TRIGGER trg_table_seats_lightning_pool_follows_seat AFTER UPDATE ON public.table_seats DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((old.left_at IS DISTINCT FROM new.left_at) OR (old.user_id IS DISTINCT FROM new.user_id) OR (old.is_sitting_out IS DISTINCT FROM new.is_sitting_out) OR (old.leave_pending IS DISTINCT FROM new.leave_pending) OR ((COALESCE(old.stack, (0)::numeric) > (0)::numeric) IS DISTINCT FROM (COALESCE(new.stack, (0)::numeric) > (0)::numeric)))) EXECUTE FUNCTION fn_table_seats_lightning_pool_follows_seat();
CREATE CONSTRAINT TRIGGER trg_table_seats_lightning_pool_on_insert AFTER INSERT ON public.table_seats DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (((new.left_at IS NULL) AND (new.user_id IS NOT NULL) AND (COALESCE(new.stack, (0)::numeric) > (0)::numeric) AND (COALESCE(new.is_sitting_out, false) = false) AND (COALESCE(new.leave_pending, false) = false))) EXECUTE FUNCTION fn_table_seats_lightning_pool_follows_seat();
CREATE TRIGGER union_pnl_original_inventory AFTER INSERT OR DELETE OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_union_pnl_inventory_observe();
CREATE TRIGGER union_pnl_original_inventory_no_truncate BEFORE TRUNCATE ON public.table_seats FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_observe();
CREATE CONSTRAINT TRIGGER zz_close_session_when_seat_vacated AFTER UPDATE OF left_at ON public.table_seats DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trg_fn_close_session_when_seat_vacated();
CREATE CONSTRAINT TRIGGER zzz_diamond_seat_keeps_custody AFTER INSERT OR DELETE OR UPDATE ON public.table_seats DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_poker_diamond_seat_keeps_custody();
CREATE TRIGGER zzz_stamp_seat_occupancy BEFORE INSERT OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_stamp_seat_occupancy();
CREATE TRIGGER zzzz_stamp_active_seat_game_scope BEFORE INSERT OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_stamp_active_seat_game_scope();
CREATE TRIGGER zzzzz_require_live_seat_parent BEFORE INSERT OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION fn_require_live_seat_parent();
CREATE TRIGGER zzzzz_seat_parent_keys_match BEFORE INSERT OR UPDATE ON public.table_seats FOR EACH ROW EXECUTE FUNCTION trg_seat_parent_keys_match();
CREATE CONSTRAINT TRIGGER zzzzzz_tournament_felt_may_not_exceed_supply AFTER INSERT OR UPDATE OF stack, left_at ON public.table_seats DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_ca_tournament_felt_may_not_exceed_supply();
CREATE TRIGGER a00_f06_lifecycle BEFORE INSERT OR DELETE OR UPDATE OF id, tournament_id, status, lifecycle, is_deleted, f06_lifecycle ON public.tables FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_table_guard();
CREATE TRIGGER tournament_table_inherits_committed_blinds BEFORE INSERT ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_tournament_table_inherits_committed_blinds();
CREATE TRIGGER union_pnl_original_inventory AFTER INSERT OR DELETE OR UPDATE ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_union_pnl_inventory_observe();
CREATE TRIGGER union_pnl_original_inventory_no_truncate BEFORE TRUNCATE ON public.tables FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_observe();
CREATE TRIGGER zz_cancel_cash_seat_moves_on_table_close AFTER UPDATE OF status, seat_admission_key ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_cancel_cash_seat_moves_on_table_close();
CREATE TRIGGER zz_close_sessions_when_table_closes AFTER UPDATE OF status, is_deleted ON public.tables FOR EACH ROW EXECUTE FUNCTION trg_fn_close_sessions_when_table_closes();
CREATE TRIGGER zz_tables_kill_pot_guard BEFORE INSERT OR UPDATE OF kill_mode, kill_threshold_bb, game_variant, game_type, tournament_id, bomb_pot_enabled, big_blind, club_id ON public.tables FOR EACH ROW WHEN ((new.kill_mode IS DISTINCT FROM 'off'::text)) EXECUTE FUNCTION fn_tables_kill_pot_guard();
CREATE TRIGGER zzzz_stamp_table_game_scope BEFORE INSERT OR UPDATE ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_stamp_table_game_scope();
CREATE TRIGGER zzzz_stamp_table_seat_admission BEFORE INSERT OR UPDATE ON public.tables FOR EACH ROW EXECUTE FUNCTION fn_stamp_table_seat_admission();
CREATE TRIGGER zzzzz_table_parent_keys_guard BEFORE UPDATE ON public.tables FOR EACH ROW WHEN ((old.seat_admission_key IS DISTINCT FROM new.seat_admission_key)) EXECUTE FUNCTION trg_table_parent_keys_guard();
CREATE TRIGGER zzzzz_table_scope_cascade AFTER UPDATE ON public.tables FOR EACH ROW WHEN ((old.seat_game_scope IS DISTINCT FROM new.seat_game_scope)) EXECUTE FUNCTION trg_table_scope_cascade();
CREATE TRIGGER zzzzzz_tables_stakes_follows_its_own_blinds BEFORE UPDATE OF small_blind, big_blind, stakes ON public.tables FOR EACH ROW WHEN (((new.tournament_id IS NOT NULL) AND ((old.small_blind IS DISTINCT FROM new.small_blind) OR (old.big_blind IS DISTINCT FROM new.big_blind) OR (old.stakes IS DISTINCT FROM new.stakes)))) EXECUTE FUNCTION fn_tables_stakes_follows_its_own_blinds();
DROP TRIGGER IF EXISTS aa_guard_tournament_completing_claim ON public.tournaments;
DROP TRIGGER IF EXISTS aaa_guard_atomic_satellite_completion ON public.tournaments;
DROP TRIGGER IF EXISTS zzzz_freeze_finalized_tournament_prize_pool ON public.tournaments;
DROP TRIGGER IF EXISTS zzzz_tournament_pool_finalization_window_guard ON public.tournaments;
DROP TRIGGER IF EXISTS zzzz_tournaments_atomic_place_completion_guard ON public.tournaments;
DROP TRIGGER IF EXISTS zzzzz_tournaments_atomic_final_table_deal_completion_guard ON public.tournaments;
DROP TRIGGER IF EXISTS zzzzzz_tournaments_financial_certificate ON public.tournaments;
CREATE TRIGGER aa_guard_tournament_completing_claim BEFORE UPDATE OF status ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_guard_tournament_completing_claim();
ALTER TABLE public.tournaments DISABLE TRIGGER aa_guard_tournament_completing_claim;
CREATE TRIGGER aaa_guard_atomic_satellite_completion BEFORE UPDATE OF status ON public.tournaments FOR EACH ROW EXECUTE FUNCTION trg_guard_atomic_satellite_completion();
ALTER TABLE public.tournaments DISABLE TRIGGER aaa_guard_atomic_satellite_completion;
CREATE TRIGGER trg_clear_seats_on_game_end AFTER UPDATE OF status ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_clear_seats_on_game_end();
CREATE TRIGGER trg_release_seats_on_tournament_finish AFTER UPDATE OF status ON public.tournaments FOR EACH ROW EXECUTE FUNCTION fn_release_seats_on_tournament_finish();
CREATE TRIGGER trg_tournaments_record_conclusion AFTER UPDATE OF status ON public.tournaments FOR EACH ROW WHEN (((new.status = ANY (ARRAY['COMPLETED'::text, 'CANCELLED'::text])) AND (new.status IS DISTINCT FROM old.status))) EXECUTE FUNCTION fn_tournament_record_conclusion();
CREATE TRIGGER union_pnl_original_inventory_no_truncate BEFORE TRUNCATE ON public.tournaments FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_observe();
CREATE TRIGGER zzzz_freeze_finalized_tournament_prize_pool BEFORE UPDATE OF prize_pool, guaranteed_prize, prize_pool_finalized, payout_structure, spin_multiplier ON public.tournaments FOR EACH ROW EXECUTE FUNCTION trg_freeze_finalized_tournament_prize_pool();
ALTER TABLE public.tournaments DISABLE TRIGGER zzzz_freeze_finalized_tournament_prize_pool;
CREATE TRIGGER zzzz_tournament_pool_finalization_window_guard BEFORE UPDATE OF prize_pool_finalized ON public.tournaments FOR EACH ROW EXECUTE FUNCTION trg_tournament_pool_finalization_window_guard();
ALTER TABLE public.tournaments DISABLE TRIGGER zzzz_tournament_pool_finalization_window_guard;
CREATE TRIGGER zzzz_tournaments_atomic_place_completion_guard BEFORE UPDATE ON public.tournaments FOR EACH ROW WHEN (((new.status = 'COMPLETED'::text) AND (old.status IS DISTINCT FROM 'COMPLETED'::text))) EXECUTE FUNCTION trg_tournament_atomic_place_completion_guard();
ALTER TABLE public.tournaments DISABLE TRIGGER zzzz_tournaments_atomic_place_completion_guard;
CREATE TRIGGER zzzzz_tournaments_atomic_final_table_deal_completion_guard BEFORE UPDATE OF status ON public.tournaments FOR EACH ROW WHEN (((new.status = 'COMPLETED'::text) AND (old.status IS DISTINCT FROM 'COMPLETED'::text))) EXECUTE FUNCTION trg_atomic_final_table_deal_completion_guard();
ALTER TABLE public.tournaments DISABLE TRIGGER zzzzz_tournaments_atomic_final_table_deal_completion_guard;
CREATE TRIGGER zzzzzz_tournaments_financial_certificate BEFORE UPDATE OF status ON public.tournaments FOR EACH ROW WHEN (((new.status = 'COMPLETED'::text) AND (old.status IS DISTINCT FROM 'COMPLETED'::text))) EXECUTE FUNCTION fn_guard_tournament_completed_certificate();
ALTER TABLE public.tournaments DISABLE TRIGGER zzzzzz_tournaments_financial_certificate;
CREATE TRIGGER a00_f06_source_roster BEFORE INSERT OR DELETE OR UPDATE OF table_id, user_id, seat_number, status ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION smarter_private.f06_source_guard();
CREATE CONSTRAINT TRIGGER a_player_is_not_eliminated_from_a_game_that_never_started AFTER INSERT OR UPDATE ON public.tournament_players DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN ((new.status = ANY (ARRAY['eliminated'::text, 'winner'::text]))) EXECUTE FUNCTION fn_player_needs_a_started_game();
CREATE CONSTRAINT TRIGGER tournament_elimination_has_a_place AFTER INSERT OR UPDATE OF status, "position" ON public.tournament_players DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_tournament_elimination_has_a_place();
CREATE TRIGGER trg_tournament_players_bagged_custody_fence BEFORE INSERT OR DELETE OR UPDATE OF chips, status, current_bounty, tournament_id ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION fn_tournament_players_bagged_custody_fence();
CREATE TRIGGER union_pnl_original_inventory AFTER INSERT OR DELETE OR UPDATE ON public.tournament_players FOR EACH ROW EXECUTE FUNCTION fn_union_pnl_inventory_observe();
CREATE TRIGGER union_pnl_original_inventory_no_truncate BEFORE TRUNCATE ON public.tournament_players FOR EACH STATEMENT EXECUTE FUNCTION fn_union_pnl_inventory_observe();

-- ============================================================================
-- Every table above, read back out of the catalogue: its columns, defaults,
-- constraints, indexes, triggers (with their enabled state) and row-security
-- flags must render to exactly the signature production rendered when this
-- file was generated. One character of difference and the load stops.
-- Parentheses are the one thing the signature leaves out: PostgreSQL stores a
-- BETWEEN or a ROW(...) IS DISTINCT FROM as a nested expression and renders it
-- with its own brackets, and the same text read back in is stored flattened.
-- The words, operators and literals are production's to the character.
-- ============================================================================
DO $shape$
DECLARE r record; v_sig text; v_seen integer := 0; v_bad integer := 0;
BEGIN
  -- Render exactly as production's catalogue was read: its default search path
  -- (pg_catalog first, then public, then extensions) and UTC.
  PERFORM set_config('search_path', '"$user", public, extensions', true);
  PERFORM set_config('TimeZone', 'UTC', true);
  FOR r IN SELECT * FROM (VALUES
    ('ca_diamond_house','6badda8dbe7e04bb0b749d34bc47d463'),
    ('ca_mint_ledger','8a3582d320e74d9040e7c1c80e108e69'),
    ('diamond_debts','461acff1ba933a591fe4c1006fb756c2'),
    ('diamond_purchase_lots','bf2b6a637a4ecf6472996c1dedfe965a'),
    ('diamond_transactions','e753c769544875644a6483d8da208717'),
    ('diamond_wallet_transfers','9c44311209294a5a14dcde0dc487e907'),
    ('digital_purchase_receipts','5c868e4d9f2e6d43cacca92c49a93141'),
    ('entry_purchase_idempotency_receipts','89eb1ec44408fe4df818cf012dd78e9f'),
    ('feature_pricing','1d82e47f94b05beb919616fbfaf69fb7'),
    ('feature_purchases','461ece04678ebe8f94adaa80ad1f039a'),
    ('friendships','40c69ca90622fa1ea0649179f59a61a2'),
    ('poker_diamond_custody','656214edc5279e2bbb9f8feb56fcaabd'),
    ('poker_diamond_lot_reservations','36b449ef1bb45a20a6a4ef6fcbd92533'),
    ('poker_diamond_movements','609f2387bd5e25300392e88e1d09c81f'),
    ('poker_diamond_tournament_ledger','c8285ceee32ac85d800d6cadbcc1a44d'),
    ('profiles','3b2cbc66a62cec9a50940536b896c4ee'),
    ('seat_cashout_receipts','67684d41af891957b2b50739fbcf4106'),
    ('table_seats','e086ae804bd03521ac5a56678e383d8a'),
    ('table_waitlist','aaae30ff60796cf8abba2739167d1d77'),
    ('tables','a69a812397c178d19bd61b5dce3b9be5'),
    ('tournament_players','5de2bdd5d4d81b51a5cbbc25b38bcdef'),
    ('tournaments','bcba27e4b1be0b65086c5a8b84675fd8'),
    ('wallet_credit_idempotency','15b0fe16bfc770a5a4795ce97bd56033')
  ) AS t(tab, want)
  LOOP
    v_seen := v_seen + 1;
    SELECT md5(string_agg(translate(line, '()', ''), E'\n' ORDER BY translate(line, '()', '') COLLATE "C")) INTO v_sig FROM (
      SELECT 'COL '||a.attname||' '||format_type(a.atttypid,a.atttypmod)
             ||CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
             ||COALESCE(' DEFAULT '||regexp_replace(pg_get_expr(d.adbin,d.adrelid),'\m(public|extensions)\.','','g'),'')
             ||CASE WHEN a.attidentity::text<>'' THEN ' IDENTITY '||a.attidentity::text ELSE '' END
             ||CASE WHEN a.attgenerated::text<>'' THEN ' GENERATED '||a.attgenerated::text ELSE '' END AS line
        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
       WHERE a.attrelid=('public.'||r.tab)::regclass AND a.attnum>0 AND NOT a.attisdropped
      UNION ALL
      SELECT 'CON '||k.conname||' '||regexp_replace(pg_get_constraintdef(k.oid),'\m(public|extensions)\.','','g')
             ||CASE WHEN k.condeferrable THEN ' DEFERRABLE' ELSE '' END
             ||CASE WHEN k.condeferred THEN ' INITIALLY DEFERRED' ELSE '' END
        FROM pg_constraint k WHERE k.conrelid=('public.'||r.tab)::regclass AND k.contype<>'t'
      UNION ALL
      SELECT 'IDX '||i.relname||' '||regexp_replace(pg_get_indexdef(i.oid),'\m(public|extensions)\.','','g')
        FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid WHERE x.indrelid=('public.'||r.tab)::regclass
      UNION ALL
      SELECT 'TRG '||t.tgname||' '||regexp_replace(pg_get_triggerdef(t.oid),'\m(public|extensions)\.','','g')||' '||t.tgenabled::text
        FROM pg_trigger t WHERE t.tgrelid=('public.'||r.tab)::regclass AND NOT t.tgisinternal
      UNION ALL
      SELECT 'REL rls='||CASE WHEN c.relrowsecurity THEN 'True' ELSE 'False' END
             ||' force='||CASE WHEN c.relforcerowsecurity THEN 'True' ELSE 'False' END
        FROM pg_class c WHERE c.oid=('public.'||r.tab)::regclass
    ) s;
    IF v_sig IS DISTINCT FROM r.want THEN
      RAISE WARNING 'public.% renders to shape % but production''s is %', r.tab, v_sig, r.want;
      v_bad := v_bad + 1;
    END IF;
  END LOOP;
  IF v_seen <> 23 THEN
    RAISE EXCEPTION 'this file declares 23 production table shapes but checked %', v_seen;
  END IF;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '% of % tables do not have production''s shape', v_bad, v_seen;
  END IF;
  RAISE NOTICE 'PASS: all % tables the money doors write have production''s exact shape: columns, constraints, indexes and triggers', v_seen;
END $shape$;
