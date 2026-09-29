-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260506162954 "column_revoke_phone_email_with_explicit_safe_grants"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e6dd3e1c49e270f6e61b59c09e62137d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- CORRECT pattern: revoke table-level SELECT, then grant SELECT on every
-- column EXCEPT phone and email. Per Supabase column-level security docs:
-- "If you have both, and you revoke the column-level privilege, the
--  table-level privilege will still be in effect."
--
-- We had only revoked column-level (which had no effect because table-level
-- grant covers all columns). Now drop table-level SELECT for authenticated
-- and anon, then explicitly grant SELECT on the safe columns only.
-- service_role keeps full table-level access.
-- ═══════════════════════════════════════════════════════════════════════════

-- Drop table-level SELECT for the public-facing roles
REVOKE SELECT ON TABLE public.profiles FROM authenticated;
REVOKE SELECT ON TABLE public.profiles FROM anon;
REVOKE SELECT ON TABLE public.profiles FROM PUBLIC;

-- Grant SELECT on every safe column (everything EXCEPT phone, email)
-- to authenticated. anon stays without any direct table SELECT (it goes
-- through the get_public_profile_by_username RPC for the /u/[username] page).
GRANT SELECT (
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
) ON TABLE public.profiles TO authenticated;
