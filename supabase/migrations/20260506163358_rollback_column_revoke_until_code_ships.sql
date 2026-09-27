-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260506163358 "rollback_column_revoke_until_code_ships"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e37f450945ad364566c320565198d17a of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- TEMPORARY ROLLBACK: column REVOKE on phone/email was applied before the
-- code adapters were committed/pushed. Live pages still doing select('*')
-- on profiles (settings, profile-edit fetch, gate self-fetcher, hub/user
-- cross-tab refresh, useProfilePrefetch, cacheWarmer) are getting 401s.
--
-- Restoring table-level SELECT for authenticated. The prior anon harvest
-- block (privacy_block_anon_profile_harvest_via_rpc migration) is NOT
-- affected by this — anon's REVOKE ALL stays in place because that's a
-- different grant layer.
--
-- Re-application of column-level REVOKE will happen after the code edits
-- (SAFE_PROFILE_COLUMNS + get_my_full_profile RPC switches in 6 files)
-- are committed, pushed, and live on smarter.poker.
-- ═══════════════════════════════════════════════════════════════════════════

-- Restore the table-level SELECT grant for authenticated.
-- This implicitly covers all columns including phone, email — back to prior behavior.
GRANT SELECT ON TABLE public.profiles TO authenticated;

-- Drop the column-level grants we made (they become redundant once the
-- table-level grant is back). Cleaner DB state for future operations.
REVOKE SELECT (
  id, full_name, display_name, first_name, last_name, username, bio, city, state, alias,
  avatar_url, role, status, is_vip, is_horse, is_admin, is_online, player_number,
  diamonds, diamond_balance, diamond_multiplier, level, tier, skill_tier, login_streak,
  streak_days, settings, preferences, social_page_id, favorite_venue, home_poker_club,
  referred_by, friends_count, hendon_total_cashes, hendon_total_earnings, email_verified,
  phone_verified, onboarding_complete, last_login, last_login_date, last_seen, created_at,
  updated_at, training_view_mode, last_trivia_date, trivia_streak, trivia_high_score,
  total_hands_played, notification_token, referral_code, horse_status, horse_profile,
  sounds_enabled, vibrations_enabled, show_stack_bb, birth_year, favorite_hand_type,
  card_back_preference, country, website, twitter, instagram, hendon_url, favorite_game,
  favorite_hand, home_casino, cover_photo_url, favorite_hand_plo, app_settings,
  display_name_preference, cover_photo_position, tiktok, telegram, birthday,
  hendon_biggest_cash, use_real_name, streak_count, access_tier, vip_tier, vip_expires_at,
  last_active, poker_near_me_preferences, can_review, deleted_reviews_count, kyc_status,
  kyc_provider, kyc_inquiry_id, kyc_completed_at, kyc_rejection_reason, age_verified,
  age_verified_at, jurisdiction_country, mfa_required, hub_preferences, friend_preferences,
  store_preferences, messenger_preferences, reels_preferences, over_18_attested_at,
  jurisdiction_region, jurisdiction_acknowledged_at, home_games_onboarded_at,
  social_profile_completed
) ON TABLE public.profiles FROM authenticated;
