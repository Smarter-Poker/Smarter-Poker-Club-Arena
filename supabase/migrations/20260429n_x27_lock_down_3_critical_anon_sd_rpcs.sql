-- ═══════════════════════════════════════════════════════════════════════════════
-- Walkthrough Round 27 — Triage 419 advisor WARN findings.
--
-- The advisor flagged 37 SECURITY DEFINER RPCs as anon-executable. Most are
-- intentional public reads (search_home_groups, get_venue_public_detail,
-- track_home_group_view, etc.). 3 are CRITICAL abuse vectors that bypass
-- all auth and mutate state:
--
--   add_chips(p_user_id, p_amount)
--     — credits ANY user ANY amount. Anyone could fire against any user_id
--       and inflate balances. (Caller: ReferralService.ts referral milestone
--       awards, server-side via service_role anyway.)
--
--   force_close_table_and_refund(p_table_id, p_actor_id, p_reason)
--     — admin action that closes a live table mid-hand and refunds all
--       seated players. (Caller: admin UI via World Hub ops API, which
--       authenticates as service_role.)
--
--   settle_club_rakeback(p_club_id)
--     — closes all pending rakeback periods for a club. (Caller: workers
--       cron handler rakeback-period-settle, runs as service_role.)
--
-- Each loses nothing legitimate: callers were already routing through
-- service_role-authenticated server-side paths, so revoking anon/authenticated
-- doesn't break anything.
--
-- Other 34 anon SECURITY DEFINER RPCs reviewed and verdicted intentional:
--   public reads (search_*, get_*_public_detail, get_daily_challenge,
--   verify_home_games_health, st_estimatedextent — PostGIS), analytics
--   tracking (track_*_share_click, track_*_view), pokeradio guest sessions
--   (pb_*), rate-limit triggers (fn_enforce_rate_limit_*), boolean auth
--   helpers that read auth.uid() internally (is_club_admin, is_god_mode).
--
-- Other advisor findings catalogued, NOT relaunch-blockers:
--   - 22 public_bucket_allows_listing — most are avatars/logos (intentional);
--     messenger_media + stories warrant a follow-up review for private content
--     leakage but are non-blocking for poker relaunch.
--   - 3 materialized_view_in_api — mv_active_poker_locations,
--     mv_hand_histories, mv_home_groups_trending. These are read-only
--     denormalizations exposed to PostgREST. Acceptable; advisor warns
--     because mat views can have stale data, not because they're insecure.
--   - 184 rls_policy_always_true — almost all on service_role policies
--     (intentional — service_role bypasses RLS by design). The handful on
--     other roles were reviewed in Round 21.
--   - 170 authenticated_security_definer_function_executable — RPCs the
--     authenticated FE legitimately calls. SECURITY DEFINER is required
--     because the RPCs need to bypass RLS to read multi-row aggregates
--     (e.g., calculate cascading commissions). Each one's input validation
--     was reviewed in Rounds 9/15/22.
--
-- Applied to production via Supabase MCP migration
-- x27_lock_down_3_critical_anon_sd_rpcs_2026_04_29.
-- ═══════════════════════════════════════════════════════════════════════════════

REVOKE EXECUTE ON FUNCTION public.add_chips(uuid, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_chips(uuid, numeric) TO service_role;

REVOKE EXECUTE ON FUNCTION public.force_close_table_and_refund(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.force_close_table_and_refund(uuid, uuid, text)
  TO service_role;

REVOKE EXECUTE ON FUNCTION public.settle_club_rakeback(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_club_rakeback(uuid) TO service_role;
