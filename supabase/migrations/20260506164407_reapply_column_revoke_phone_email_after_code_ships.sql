-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260506164407 "reapply_column_revoke_phone_email_after_code_ships"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3201e1bd573523452f9da98db48d408a of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- Re-apply the column-level SELECT lockdown on phone and email.
--
-- Now safe because the code adapters shipped in commit 778e923:
--   - 5 select('*') call sites converted to either SAFE_PROFILE_COLUMNS
--     or rpc('get_my_full_profile')
--   - profile-edit raw fetch from /rest/v1/profiles?select=* moved to
--     /rest/v1/rpc/get_my_full_profile
--   - gate self-fetcher (was selecting phone explicitly) moved to RPC
--   - horses admin removed 'email' from a join select
--
-- After this migration:
--   • authenticated users CANNOT read phone/email from any other user
--   • authenticated users CANNOT read their OWN phone/email from direct
--     table SELECTs — must go through get_my_full_profile() RPC
--   • profile-edit save (PATCH with Prefer: return=minimal) still works:
--     UPDATE column grants are separate from SELECT
--   • service_role retains full access (server-side APIs unaffected)
--   • anon was already locked out by the prior privacy migration
-- ═══════════════════════════════════════════════════════════════════════════

-- Drop table-level SELECT for authenticated. Per Supabase docs, column-level
-- REVOKE alone has no effect when table-level grant is in place.
REVOKE SELECT ON TABLE public.profiles FROM authenticated;

-- Grant SELECT on every safe column (everything EXCEPT phone, email).
-- New columns added in the future will NOT be auto-granted — that's
-- intentional: each new column should be reviewed for privacy before
-- adding it here.
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
