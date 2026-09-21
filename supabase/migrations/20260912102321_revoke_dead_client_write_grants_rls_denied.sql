-- Revoke client write grants that Row Level Security already denies.
--
-- WHY THIS MIGRATION EXISTS
--
-- A sweep of all 1,196 base tables in `public` found 750 of them granting
-- INSERT/UPDATE/DELETE (usually the whole ALL PRIVILEGES set, including
-- TRUNCATE and PG17's MAINTAIN) to `anon` and `authenticated`. That set
-- includes the money-denominated ones: `tournament_conservation_baseline`,
-- the conservation register `fn_tournament_conservation_delta` reconciles
-- against `wallet_transactions`; `table_pending_addons`, the mid-hand add-on
-- float that is part of the chip supply basis; `union_rake_rollup_days`; and
-- `ca_chip_store_coverage`, which a BEFORE INSERT trigger on `chip_ledger`
-- consults. Those four alone carry roughly 17,000 rows of money-relevant
-- state that, on paper, any unauthenticated caller could delete.
--
-- They are not exploitable today, and the reason is worth stating precisely,
-- because it is also the proof that this migration is safe. Every one of
-- these tables has `relrowsecurity = true` with no permissive policy for any
-- write command. Postgres RLS with no applicable permissive policy denies
-- every row: INSERT raises 42501, and UPDATE/DELETE match nothing. Neither
-- `anon` nor `authenticated` holds BYPASSRLS (only `postgres`, `service_role`
-- and `supabase_admin` do), so neither can escape it. The posture is therefore
-- safe by accident of RLS, not by grant hygiene.
--
-- That accident is one CREATE POLICY away from ending. Policies get added to
-- this database routinely, and a policy written to solve a read problem on,
-- say, `tournament_conservation_baseline` would silently arm a latent DELETE
-- grant on the conservation register at the same moment. Defence in depth says
-- the grant should not be there to arm.
--
-- WHY THIS IS PROVABLY SAFE RATHER THAN PROBABLY SAFE
--
-- The revoke set was not chosen by reading names. Each candidate was probed
-- directly against production: inside a rolled-back savepoint, an INSERT was
-- attempted on every candidate table as `anon` and again as `authenticated`.
-- 854 probes ran; not one row was written. The 415 tables below are the ones
-- where Postgres answered 42501 -- the privilege/RLS denial -- for both roles.
-- A grant that has never permitted a successful write cannot have a live
-- client depending on it, so removing it cannot break a client path.
--
-- Twelve further tables that are dead by the same classification were
-- deliberately EXCLUDED: charity_events_schedule, club_shop_items,
-- poker_events, poker_series, poker_tour_series_events, table_seats,
-- tour_stop_events, tournament_series, tournaments, union_clubs, unions and
-- venue_daily_tournaments. On those, a BEFORE INSERT trigger or a CHECK
-- constraint raised before RLS was reached, so the probe demonstrated denial
-- by a different mechanism than the one being relied on here. They are almost
-- certainly equally dead, but "almost certainly" is not the standard this
-- migration is held to, and they are left for a pass of their own.
--
-- SELECT IS NOT TOUCHED. Category membership here is about write policies
-- only; several of these tables do carry SELECT policies and are legitimately
-- read by clients. REFERENCES and TRIGGER are also left alone: neither `anon`
-- nor `authenticated` holds CREATE on any schema, so neither privilege can be
-- exercised, and they are inert rather than dangerous.
--
-- THE TWO FUNCTION REVOKES ARE A SEPARATE AND LIVE PROBLEM
--
-- `fn_social_reward_award` and `fn_training_reward_award` are SECURITY
-- DEFINER, owned by `postgres`, and carry EXECUTE for `anon`. Both take
-- `p_user_id` as a parameter and neither checks it against the caller, so an
-- unauthenticated POST to /rest/v1/rpc/... mints diamonds through
-- `award_diamonds_v2` for any user id the caller names. `award_diamonds_v2`
-- bounds the damage with per-user daily and monthly caps and a 2,500,000
-- platform budget, so this is allowance theft and budget drain rather than
-- unlimited minting -- but it is reachable right now by anyone.
--
-- Revoking EXECUTE from `anon` and `authenticated` does not disturb the real
-- callers. All eight are the `trgfn_award_*` trigger functions, every one of
-- them SECURITY DEFINER owned by `postgres`, so the EXECUTE check inside them
-- resolves against `postgres` and not against the end user. Nothing under
-- src/, server/, supabase/functions/ or scripts/ references either name.
--
-- GRANT and REVOKE are not in pgrst_ddl_watch's event list, so this migration
-- does not trigger a PostgREST schema reload; it carries no DDL that would.

BEGIN;

-- 415 tables where an INSERT as anon AND as authenticated was proven to fail
-- with 42501 against production. SELECT, REFERENCES and TRIGGER are retained.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, MAINTAIN ON TABLE
    public._pps_backfill_state, public.abuse_logs, public.action_audit_logs,
    public.action_log, public.active_tables, public.ad_advertiser,
    public.ad_campaign, public.ad_catalog, public.ad_event_retention_policy,
    public.ad_placement, public.ad_rate_card, public.admin_audit_log,
    public.anti_cheat_events, public.api_idempotency, public.arcade_duels,
    public.arcade_games, public.arcade_jackpot, public.arena_matches,
    public.arena_orbs, public.bad_beat_jackpots, public.bot_profiles,
    public.ca_break_scorecards, public.ca_bridge_rate,
    public.ca_broke_seat_sightings, public.ca_chip_baseline,
    public.ca_chip_store_coverage, public.ca_club_player_daily,
    public.ca_club_tournament_daily, public.ca_club_tournament_player_daily,
    public.ca_ddl_events, public.ca_detector_runs,
    public.ca_financial_epochs, public.ca_freeze_circulation_marks,
    public.ca_frozen_pool_baseline_changes, public.ca_hand_flags,
    public.ca_hand_player_stat_repair_state, public.ca_hand_transfers,
    public.ca_ledger_maintenance_kinds, public.ca_ledger_write_failures,
    public.ca_operator_player_notes, public.ca_operator_player_tags,
    public.ca_pgrst_reload_log, public.ca_player_restrictions,
    public.ca_rake_schedule, public.ca_rake_tier,
    public.ca_rakeback_baseline, public.ca_restriction_observations,
    public.ca_stat_distribution, public.ca_treasury_baseline,
    public.card_slide_usage, public.cash_games, public.cashout_requests,
    public.chat_filter_words, public.chat_moderation_actions,
    public.chat_mutes, public.chip_escrow, public.chip_escrow_holds,
    public.clawbot_audit_log, public.clawbot_task_state,
    public.clip_usage_log, public.club_arena_audit_logs,
    public.club_arena_messages, public.club_creation_bonuses,
    public.club_creation_requests, public.club_diamond_wallets,
    public.club_financial_summary, public.club_game_seats,
    public.club_join_idempotency, public.club_level_thresholds,
    public.club_live_games, public.club_member_daily_stats,
    public.club_member_table_state, public.club_rake_daily_user,
    public.club_rake_rollup_complete, public.club_shop_inventory,
    public.club_shop_purchases, public.club_stats_rebuild_log,
    public.club_wallets, public.commander_activity_log,
    public.commander_admin_pins, public.commander_admin_settings,
    public.commander_analytics_daily, public.commander_audit_logs,
    public.commander_buyin_transactions, public.commander_cash_transactions,
    public.commander_checkins, public.commander_comp_balances,
    public.commander_day_closes, public.commander_dealer_bookings,
    public.commander_equipment_rental_orders,
    public.commander_escrow_transactions,
    public.commander_freeroll_qualifications, public.commander_freerolls,
    public.commander_game_types, public.commander_games,
    public.commander_high_hands, public.commander_home_ban_appeals,
    public.commander_home_group_weekly_snapshots,
    public.commander_home_invite_tokens,
    public.commander_leaderboard_entries, public.commander_leads,
    public.commander_league_standings, public.commander_leagues,
    public.commander_member_comp_log, public.commander_members,
    public.commander_membership_plans, public.commander_notification_log,
    public.commander_onboarding_leads, public.commander_pilot_venues,
    public.commander_player_reputation,
    public.commander_player_reputation_scores, public.commander_print_jobs,
    public.commander_rate_limits, public.commander_room_presets,
    public.commander_seat_preferences, public.commander_seats,
    public.commander_sessions, public.commander_shift_handoffs,
    public.commander_staff_shifts, public.commander_subscriptions,
    public.commander_system_health, public.commander_system_log,
    public.commander_table_ratings, public.commander_tables,
    public.commander_tax_events, public.commander_time_clock,
    public.commander_time_sessions,
    public.commander_tournament_leaderboards, public.commander_venue_photos,
    public.commander_venue_posts, public.commander_venue_settings,
    public.commander_waitlist_history, public.commission_rate_audit,
    public.content_asset_use, public.content_schedule,
    public.content_settings, public.content_sources, public.content_stats,
    public.cosmetic_catalog, public.credit_assignments,
    public.credit_invoices, public.credit_payments,
    public.cron_execution_log, public.daemon_state, public.daily_challenges,
    public.daily_spins, public.data_audit_log,
    public.deep_stack_delete_attempts, public.deploy_alerts,
    public.deprecated_tables, public.diamond_arena_events,
    public.diamond_ledger, public.diamond_wallets, public.disputes,
    public.engine_leader, public.engine_maintenance_break,
    public.engine_maintenance_break_log, public.engine_recovery_events,
    public.engine_state_snapshot, public.engine_table_leases,
    public.engine_tournament_leases, public.execution_audit_logs,
    public.fct_portfolio, public.feature_purchases, public.fee_requeue_log,
    public.financial_alerts, public.financial_health_checks,
    public.flash_pool_players, public.flash_pools,
    public.game_action_idempotency_keys, public.game_formats,
    public.game_live_history, public.game_registry, public.game_tables,
    public.games, public.gdpr_deletion_requests, public.geeves_analytics,
    public.geeves_answer_ratings, public.geeves_knowledge_cache,
    public.geeves_messages, public.geeves_missed_questions,
    public.grok_explanation_cache, public.gto_agg_progress,
    public.gto_scenarios, public.hand_audit_decisions,
    public.hand_histories, public.hand_history,
    public.hand_history_retention_policy, public.hendon_scrape_log,
    public.horse_brain_telemetry, public.horse_daily_audit,
    public.horse_daily_nets, public.horse_daily_play,
    public.horse_decision_latency, public.horse_error_log,
    public.horse_hand_reviews, public.horse_job_runs,
    public.horse_league_results, public.horse_mind_pairs,
    public.horse_mind_stats, public.horse_mind_stats_scoped,
    public.horse_opponent_reads, public.horse_post_modes,
    public.horse_relationships, public.horse_review_rollup,
    public.horse_self_tune_log, public.horse_session_analytics,
    public.horse_session_stats, public.horse_solver_agreement,
    public.horse_thread_state, public.horse_threat_intel,
    public.horse_tournament_daily, public.iap_products,
    public.idempotency_keys, public.insurance_offer_events,
    public.insurance_transactions, public.jarvis_response_cache,
    public.kyc_events, public.leaderboard_entries, public.leak_review_state,
    public.live_game_confirmations, public.live_games,
    public.live_help_analytics, public.live_help_reactions,
    public.lucky_wheel_segments, public.member_fee_rollup,
    public.member_fee_rollup_state, public.memory_achievement_definitions,
    public.memory_charts_gold, public.memory_daily_challenges,
    public.money_flow_checkpoint, public.news_articles,
    public.news_push_log, public.newsletter_campaigns,
    public.notification_prompt_log, public.orb1_idempotency_keys,
    public.orbs, public.orders, public.page_claims,
    public.page_notifications, public.pending_calls,
    public.pending_fee_distributions, public.personas,
    public.pgrst_reload_watchdog_log, public.pipeline_runs,
    public.platform_policies, public.player_agent_assignments,
    public.player_position_stats, public.poker_clips, public.poker_hands,
    public.poker_news, public.poker_reels, public.poker_venues,
    public.poker_videos, public.post_briefs, public.posted_clips,
    public.posted_sports_clips, public.poy_leaderboard,
    public.privileged_function_lock, public.probe_heartbeats,
    public.promo_code_redemptions, public.promo_codes,
    public.promo_codes_used, public.promo_distributions,
    public.promo_vault_catalog, public.promo_vault_inventory,
    public.promo_vault_records, public.promo_wagering_ledger,
    public.promotion_leaderboards, public.promotions,
    public.purchase_history, public.push_dispatch_runs, public.push_outbox,
    public.pwa_prompt_log, public.rabbit_hunt_offers,
    public.rabbit_hunt_reveals, public.rake_attributions,
    public.rake_distribution_legs, public.rake_history,
    public.rake_rate_audit, public.rake_records,
    public.rakeback_distributions, public.rakeback_period_payouts,
    public.rakeback_periods, public.rakeback_stats_applied,
    public.referral_milestone_claims, public.referral_redemptions,
    public.responsible_gaming_limits, public.responsible_gaming_sessions,
    public.reward_claims, public.reward_definitions, public.role_changes,
    public.sandbox_results, public.sandbox_weekly_spots,
    public.scrape_evidence, public.scrape_source_registry,
    public.scraper_metrics, public.scraper_watchdog_state,
    public.seed_reveals, public.seeded_content, public.sentry_error_log,
    public.settlement_idempotency_keys, public.settlement_invoices,
    public.settlement_journal, public.settlement_locks,
    public.settlement_periods, public.seven_deuce_bounties,
    public.share_streak_rewards, public.signup_abuse_log,
    public.signup_errors, public.signup_errors_archive, public.slug_history,
    public.social_conversation_participants, public.social_conversations,
    public.social_message_reads, public.social_pages_orphan_archive,
    public.spin_bonus_pools, public.spin_payout_ladder,
    public.spin_reserve_ledger, public.spin_unpaid_backpay_log,
    public.sports_clips, public.sso_bridge_tokens,
    public.stack_depth_configs, public.staff_claim_tokens,
    public.sticker_assets, public.stories, public.sub_agents,
    public.system_cache, public.system_logs, public.table_activity,
    public.table_addon_idempotency, public.table_cashout_history,
    public.table_pending_addons, public.table_sessions,
    public.theme_asset_unlocks, public.theme_unlocks, public.toke_entries,
    public.topic_cooldowns, public.tour_event_details, public.tour_events,
    public.tour_schedule_registry, public.tour_scrape_registry,
    public.tour_source_registry, public.tournament_conservation_baseline,
    public.tournament_payout_backfill_log,
    public.tournament_place_collisions,
    public.tournament_place_overpay_charges,
    public.tournament_place_renumbers,
    public.tournament_players_position_repair_20260901,
    public.tournament_rake_settlements, public.tournament_registrations,
    public.tournament_reminders_sent, public.tournament_results,
    public.tournament_schedule_spawns, public.tournament_schedules,
    public.tournament_survivor_rank_backfill, public.training_achievements,
    public.training_challenge_definitions, public.training_daily_challenges,
    public.training_drills, public.training_levels,
    public.training_question_cache, public.training_tournaments,
    public.training_user_progress, public.trivia_category_health,
    public.trivia_quality_audits, public.trivia_regression_runs,
    public.union_admins, public.union_announcements,
    public.union_club_terms, public.union_creators,
    public.union_invoice_counters, public.union_pnl_settlements,
    public.union_presettlements, public.union_rake_ledger_checkpoint,
    public.union_rake_paid_daily_user, public.union_rake_rollup_days,
    public.union_rake_weekly, public.union_rakeback_log,
    public.union_settlement_floor, public.union_settlement_rounds,
    public.union_wallets, public.user_badges, public.user_bonus_progress,
    public.user_daily_rewards, public.user_daily_streaks,
    public.user_diamond_balance, public.user_diamonds,
    public.user_lucky_wheel_spins, public.user_tos_acceptances,
    public.v_backtest_summary, public.venue_aliases, public.venue_claims,
    public.venue_directory_enrichment_log,
    public.venue_duplicate_retirement_log, public.venue_game_snapshots,
    public.venue_live_history, public.venue_location_integrity_log,
    public.venue_location_integrity_state, public.venue_managers,
    public.venue_news, public.venue_tournament_schedules,
    public.video_clips, public.video_library_videos,
    public.villain_archetypes, public.vip_feature_usage_monthly,
    public.vip_plan_switches, public.vip_points, public.vip_points_carry,
    public.vip_points_ledger, public.vip_pricing, public.vip_subscriptions,
    public.wallet_audit_backfill_log, public.wheel_free_segments,
    public.wheel_free_spins
  FROM anon, authenticated;

-- Anon-reachable diamond minting. Internal callers are all SECURITY DEFINER
-- trigger functions owned by postgres and are unaffected.
REVOKE EXECUTE ON FUNCTION
    public.fn_social_reward_award(uuid, text, text, text),
    public.fn_training_reward_award(uuid, text, text, text)
  FROM anon, authenticated;

COMMIT;
