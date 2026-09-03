# Phantom-Column Findings — 2026-07-29

> STATUS: ✅ FULLY DRAINED (2026-07-29). All 61 findings below are fixed;
> `node scripts/ci/check-phantom-columns.mjs` reports 0. The CI step is now
> BLOCKING (the `--warn` flag was removed in `.github/workflows/ci.yml`), so any
> newly-introduced phantom column fails the build. One finding required a schema
> change — `tournaments.final_table_triggered` was added (migration
> `20260729_tournaments_final_table_triggered_flag.sql`); the rest were resolved
> by correcting/aliasing the column name, dropping an absent column, or degrading
> a schema-mismatched query. This document is retained as the historical record.

The phantom-column CI gate (`scripts/ci/check-phantom-columns.mjs`) found
`.select()` calls that name columns absent from the real table. A single bad
column 42703-errors the WHOLE query, so the feature silently shows nothing. Fix
each: correct the name, alias the real column (`alias:real`), add a migration +
regenerate the manifest, or (view-projected/dynamic) allowlist under
`phantomColumns` in `scripts/ci/supabase-invariants.allowlist.json`.

Total: 61 phantom columns across 22 tables — ALL DRAINED.

## audit_trail

Real columns: id, actor_id, actor_role, action, target_type, target_id, club_id, agent_id, amount, currency, before_state, after_state, reason, ip_address, user_agent, request_id, created_at

- `details` — src/components/admin/ArenaLedger.tsx:80, src/components/admin/AuditLog.tsx:58, src/pages/AdminDashboardPage.tsx:879, src/pages/AdminDashboardPage.tsx:1020

## bbj_payouts

Real columns: id, pool_id, hand_id, table_id, hand_number, winner_user_id, loser_user_id, total_amount, winner_share, loser_share, table_share, table_player_count, metadata, created_at

- `table_players_share` — src/services/BBJService.ts:476

## bbj_winners

Real columns: id, club_id, pool_id, loser_id, winner_id, loser_hand, winner_hand, loser_payout, winner_payout, table_share_payout, total_payout, pool_amount_at_hit, stakes_tier, table_id, hand_number, awarded_at, winner_display_name, loser_display_name

- `loser_name` — src/components/bbj/BBJDisplay.tsx:687

## cashout_requests

Real columns: id, club_id, player_id, agent_id, amount, status, player_note, agent_note, created_at, updated_at, acknowledged_at, completed_at, cancelled_at

- `user_id` — src/services/NotificationService.ts:308

## chip_transactions

Real columns: id, club_id, from_user_id, to_user_id, amount, transaction_type, notes, related_cashout_id, metadata, created_at, balance_after, clawed_back, reversible_until, is_reversed

- `type` — src/pages/AgentDashboardPage.tsx:254

## club_announcements

Real columns: id, club_id, author_id, title, content, priority, is_pinned, expires_at, created_at, message, type, is_active, created_by

- `pinned` — src/pages/AdminDashboardPage.tsx:1143

## club_members

Real columns: club_id, user_id, role, agent_id, joined_at, parent_agent_id, invited_by, notes, last_active_at, created_at, updated_at, is_bot, status, chip_balance, diamonds, is_active, orange_ball_status, rank_level, credit_limit, credit_used, nickname, last_active, tier, trust_score, sessions_played, promo_balance, chips_won, chips_lost, commission_rate, rakeback_rate, hands_played, total_rake_paid, biggest_pot, locked_chips, player_rakeback_pct, held_chips, display_name, is_prepaid, promo_received_total, promo_wagered, promo_playthrough_required, missions_completed, reputation_xp

- `balance` — src/components/admin/ClubMemberManagement.tsx:70
- `id` — src/pages/AdminDashboardPage.tsx:1876, src/pages/AdminDashboardPage.tsx:2161, src/pages/HomePage.tsx:951
- `is_banned` — src/components/admin/ClubMemberManagement.tsx:70
- `referred_by` — src/pages/AgentDashboardPage.tsx:183
- `total_rake` — src/components/admin/ClubMemberManagement.tsx:70

## diamond_ledger

Real columns: id, user_id, delta, type, balance_after, created_at

- `amount` — src/pages/admin/AnalyticsDashboard.tsx:158, src/pages/admin/AnalyticsDashboard.tsx:181
- `description` — src/pages/admin/AnalyticsDashboard.tsx:158
- `transaction_type` — src/pages/admin/AnalyticsDashboard.tsx:158

## hand_history

Real columns: id, winner_name, pot_size, created_at, table_id, tournament_id, hand_number, game_variant, small_blind, big_blind, rake_amount, community_cards, winners, players, actions, summary, bbj_amount, source, hand_name, seed, version, started_at, ended_at, hole_cards, board

- `raw_events` — server/src/transport/ChannelWebSocketServer.ts:315

## hands

Real columns: id, table_id, club_id, hand_number, game_variant, stakes, pot, rake, community_cards, board, winner_ids, players, actions, current_player_id, player_cards, player_bets, current_bet, min_raise, street, status, dealer_position, started_at, ended_at, created_at

- `pot_size` — src/services/TableService.ts:583

## messages

Real columns: id, sender_id, recipient_id, club_id, content, is_read, created_at, conversation_id, receiver_id, is_forwarded, metadata, is_edited, edited_at, is_pinned, message_type, deleted_at, reply_to_message_id

- `audio_url` — src/services/MessagingService.ts:786
- `image_url` — src/services/MessagingService.ts:786

## notifications

Real columns: id, user_id, type, title, message, data, read, created_at, updated_at, is_read, action_url, metadata, actor_id, link

- `body` — src/components/notifications/NotificationCenter.tsx:71, src/pages/NotificationCenter.tsx:66
- `club_id` — src/pages/ClubCarouselPage.tsx:223, src/pages/ClubCarouselPage.tsx:354

## player_stats

Real columns: id, user_id, club_id, hands_played, total_winnings, total_losses, total_rake, vpip, pfr, updated_at, tournaments_played, tournaments_won

- `agg_factor` — src/services/LeaderboardService.ts:288
- `aggression_factor` — src/components/stats/AdvancedStatsSummary.tsx:149, src/pages/PlayerStatsPage.tsx:306, src/pages/PlayerStatsPage.tsx:428
- `avg_session_length` — src/pages/PlayerStatsPage.tsx:306, src/pages/PlayerStatsPage.tsx:428
- `bb_per_100` — src/components/stats/AdvancedStatsSummary.tsx:149, src/pages/PlayerStatsPage.tsx:306, src/pages/PlayerStatsPage.tsx:428
- `biggest_pot_lost` — src/pages/PlayerStatsPage.tsx:306, src/pages/PlayerStatsPage.tsx:428
- `biggest_pot_won` — src/pages/PlayerStatsPage.tsx:306, src/pages/PlayerStatsPage.tsx:428
- `cbet_flop` — src/components/stats/AdvancedStatsSummary.tsx:149, src/pages/PlayerStatsPage.tsx:306, src/pages/PlayerStatsPage.tsx:428
- `cbet_turn` — src/pages/PlayerStatsPage.tsx:306, src/pages/PlayerStatsPage.tsx:428
- `fold_to_three_bet` — src/components/stats/AdvancedStatsSummary.tsx:149, src/pages/PlayerStatsPage.tsx:306, src/pages/PlayerStatsPage.tsx:428
- `friends_count` — src/services/AchievementTriggerService.ts:242
- `hands_lost` — src/pages/PlayerStatsPage.tsx:306, src/pages/PlayerStatsPage.tsx:428
- `hands_won` — src/components/stats/AdvancedStatsSummary.tsx:149, src/pages/PlayerStatsPage.tsx:306, src/pages/PlayerStatsPage.tsx:428
- `hours_played` — src/components/stats/AdvancedStatsSummary.tsx:149, src/pages/PlayerStatsPage.tsx:306, src/pages/PlayerStatsPage.tsx:428
- `showdowns_total` — src/components/stats/AdvancedStatsSummary.tsx:149, src/pages/PlayerStatsPage.tsx:306, src/pages/PlayerStatsPage.tsx:428
- `showdowns_won` — src/components/stats/AdvancedStatsSummary.tsx:149, src/pages/PlayerStatsPage.tsx:306, src/pages/PlayerStatsPage.tsx:428
- `three_bet` — src/services/LeaderboardService.ts:288
- `three_bet_percent` — src/components/stats/AdvancedStatsSummary.tsx:149, src/pages/PlayerStatsPage.tsx:306, src/pages/PlayerStatsPage.tsx:428
- `total_hands` — src/components/stats/AdvancedStatsSummary.tsx:149, src/pages/PlayerStatsPage.tsx:306, src/pages/PlayerStatsPage.tsx:428
- `total_profit` — src/components/stats/AdvancedStatsSummary.tsx:149, src/pages/PlayerStatsPage.tsx:306, src/pages/PlayerStatsPage.tsx:428
- `total_wins` — src/services/AchievementTriggerService.ts:242, src/services/AchievementTriggerService.ts:293
- `tournament_roi` — src/services/LeaderboardService.ts:288
- `tournament_wins` — src/services/AchievementTriggerService.ts:242, src/services/AchievementTriggerService.ts:293
- `wsd` — src/services/LeaderboardService.ts:288
- `wtsd` — src/services/LeaderboardService.ts:288

## profiles

Real columns: id, full_name, display_name, first_name, last_name, username, email, phone, bio, city, state, alias, avatar_url, role, status, is_vip, is_horse, is_admin, is_online, player_number, diamonds, diamond_balance, diamond_multiplier, level, tier, skill_tier, login_streak, streak_days, settings, preferences, social_page_id, favorite_venue, home_poker_club, referred_by, friends_count, hendon_total_cashes, hendon_total_earnings, email_verified, phone_verified, onboarding_complete, last_login, last_login_date, last_seen, created_at, updated_at, training_view_mode, last_trivia_date, trivia_streak, trivia_high_score, total_hands_played, notification_token, referral_code, horse_status, horse_profile, sounds_enabled, vibrations_enabled, show_stack_bb, birth_year, favorite_hand_type, card_back_preference, country, website, twitter, instagram, hendon_url, favorite_game, favorite_hand, home_casino, cover_photo_url, favorite_hand_plo, app_settings, display_name_preference, cover_photo_position, tiktok, telegram, birthday, hendon_biggest_cash, use_real_name, streak_count, access_tier, vip_tier, vip_expires_at, last_active, poker_near_me_preferences, can_review, deleted_reviews_count, kyc_status, kyc_provider, kyc_inquiry_id, kyc_completed_at, kyc_rejection_reason, age_verified, age_verified_at, jurisdiction_country, mfa_required, hub_preferences, friend_preferences, store_preferences, messenger_preferences, reels_preferences, over_18_attested_at, jurisdiction_region, jurisdiction_acknowledged_at, home_games_onboarded_at, social_profile_completed, is_farming_flagged

- `status_text` — src/services/PlayerStatusService.ts:84, src/services/PlayerStatusService.ts:130

## settlement_locks

Real columns: id, club_id, lock_type, locked_at, unlock_at, unlocked_at, is_active, lock_reason, settlement_period_id, metadata, created_at

- `lock_end` — src/utils/settlementLock.ts:90
- `lock_start` — src/utils/settlementLock.ts:90
- `reason` — src/utils/settlementLock.ts:90

## spin_tournaments

Real columns: id, club_id, buy_in, player_count, max_players, prize_pool, multiplier, multipliers, status, start_at, created_at

- `buy_in_amount` — src/components/tournament/SpinAndGoLobby.tsx:114

## tables

Real columns: id, club_id, name, game_type, stakes, small_blind, big_blind, min_buy_in, max_buy_in, max_players, current_players, status, is_private, settings, created_at, updated_at, game_variant, enable_straddle, run_it_twice, bomb_pots, auto_muck, ante, time_bank_seconds, allow_rabbit_hunt, allow_run_it_twice, allow_straddle, min_buyin, max_buyin, game_mode, is_vip_only, is_anonymous, ban_chat, label_as_new, is_featured, hide_club_name, is_template, bomb_pot_enabled, double_board, triple_board, pineapple_holdem, seven_deuce_enabled, nit_game, cap_enabled, no_rathole, action_time_seconds, min_buy_in_bb, max_buy_in_bb, ante_bb, career_percent_min, maintain_percent_min, maintain_hands, auto_start_players, game_length_hours, created_by, calltime_enabled, auto_extension, auto_restart, auto_create_table, auto_utg_straddle, voluntary_straddle, insurance_enabled, run_it_mode, rake_percent, rake_cap_bb, agent_downline_limit, buy_in_authorization, restrict_device, restrict_observers, gps_restriction, ip_restriction, pc_emulator_restriction, photo_rotation_verification, short_description, accelerated_mtt, all_in_or_fold, custom_rebuy_reentry_cost, number_of_rebuys_reentries, add_on_multiplier, custom_add_on, add_on_break_length_minutes, ko_bounty, gtd_prize_pool, final_table_deal, big_blind_ante, authorized_to_register, late_registration_level, early_bird_registration, bubble_protection, featured_tournament, min_players_mtt, max_players_mtt, multi_day_mtt, save_start_time, start_time, restart_tournament_every, tournament_schedule, synchronized_breaks, sng_buy_in, blind_structure, payout_structure, starting_chips, blinds_up_minutes, next_step_satellite, sng_custom_buy_in, sng_player_count, is_spins, spins_multiplier, is_deleted, deleted_at, deleted_by, bbj_percent, tournament_id, live_state, union_id, big_blind_ante_enabled, straddle_enabled, straddle_type, max_straddles, run_it_twice_enabled, auto_muck_enabled, show_hand_enabled, disconnect_timeout_seconds, max_consecutive_timeouts, prefer_check_over_fold, time_bank_max_uses, time_bank_enabled, ante_enabled, bomb_pot_frequency, bomb_pot_ante_multiplier, wait_for_big_blind, seven_deuce_amount, hands_dealt, avg_pot

- `total_hands_dealt` — src/pages/AdminDashboardPage.tsx:2165
- `type` — src/services/HorseOrchestrator.ts:1323, src/services/HorseOrchestrator.ts:1924

## tournament_players

Real columns: id, tournament_id, user_id, username, chips, status, position, prize, rebuys, add_on, registered_at, eliminated_at, bounties_collected, bounty_winnings, mystery_bounty_value, current_bounty, table_id, seat_number, chip_count

- `club_id` — src/pages/tournament/TournamentDetails.tsx:436

## tournaments

Real columns: id, name, description, game_type, variant, buy_in_amount, buy_in_fee, guaranteed_prize, start_time, status, current_players, max_players, late_reg_mins, starting_chips, blind_structure, payout_structure, created_at, updated_at, club_id, started_at, ended_at, current_level, prize_pool, is_rebuy, add_on_available, rebuy_cost, rebuy_chips, rebuy_levels, addon_cost, addon_chips, min_players, tournament_type, is_bounty, bounty_amount, is_pko, is_mystery_bounty, mystery_bounty_min, mystery_bounty_max, is_xmtt, union_id, is_multi_day, parent_tournament_id, flight_number, day_number, total_days, flight_end_chips_snapshot, survivors_advance_to, is_pinned, spin_multiplier, is_premium_spin, prize_pool_finalized, is_turbo, blind_speed, spin_type, total_rake, late_reg_levels, addon_levels, is_reentry, satellite_target, max_rebuys, max_reentries, level_started_at, addon_period_triggered, satellite_target_id

- `buy_in` — src/pages/XMTTPage.tsx:96, src/pages/XMTTPage.tsx:121
- `final_table_triggered` — src/services/TournamentTimerService.ts:243
- `registered_count` — src/pages/XMTTPage.tsx:96, src/pages/XMTTPage.tsx:121
- `type` — src/pages/XMTTPage.tsx:96, src/pages/XMTTPage.tsx:121

## unions

Real columns: id, name, description, owner_id, avatar_url, is_public, member_count, club_count, total_rake, settings, created_at, updated_at, union_code, main_bbj_balance, backup_bbj_balance, promo_fund_balance, code, insurance_balance, chip_balance, rake_wallet, bbj_wallet, promo_wallet, auto_settlement, level, player_level, hierarchy_level, total_players, total_admins, total_super_agents, total_agents, hierarchy_units, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next

- `status` — src/pages/UnionGamesPage.tsx:133

## vip_monthly_usage

Real columns: id, user_id, month, hands_played, tournaments_entered, rake_contributed, vip_points_earned, created_at, updated_at

- `feature` — src/services/VIPService.ts:266
- `usage_count` — src/services/VIPService.ts:266

## wallets

Real columns: id, user_id, wallet_type, balance, locked_balance, updated_at, created_at

- `currency` — src/pages/SettingsPage.tsx:464
- `play_balance` — src/components/admin/PlayerSearch.tsx:115
