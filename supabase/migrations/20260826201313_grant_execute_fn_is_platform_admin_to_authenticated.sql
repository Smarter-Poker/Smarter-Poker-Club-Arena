-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826201313; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════
-- TIER 2 (additive: one GRANT, no DDL, no data)
--
-- SEVERITY 1 PRODUCTION OUTAGE.
--
-- 44 tables in public carry a SELECT policy that calls
-- public.fn_is_platform_admin(), and `authenticated` has never had EXECUTE on
-- it. Postgres does not short-circuit the OR in those policies, so the
-- function is evaluated even for a row the caller plainly owns. Verified by
-- probe on 2026-08-26, inside a rolled-back transaction, as the `authenticated`
-- role with request.jwt.claims set to a real profiles row:
--
--   SELECT count(*) FROM user_notifications WHERE user_id = <own id>
--     -> ERROR: permission denied for function fn_is_platform_admin
--   SELECT count(*) FROM direct_messages    WHERE sender_id = <own id>
--     -> ERROR: permission denied for function fn_is_platform_admin
--   SELECT count(*) FROM user_bookmarks
--     -> ERROR: permission denied for function fn_is_platform_admin
--
-- So every logged-in player reading their OWN notifications, direct messages,
-- bookmarks, purchase history, devices, notification preferences, disputes,
-- saved hands or promo redemptions is currently getting a hard permission
-- error. Not an empty list -- an error.
--
-- The 44 tables:
--   _audit_phase40_results, abuse_logs, admin_audit_log,
--   bbj_payout_recipients, bbj_payouts, commander_activity_log,
--   commander_leads, commander_onboarding_leads, commander_player_reputation,
--   commander_player_reputation_scores, commander_rate_limits,
--   commander_system_log, cron_execution_log, direct_messages, disputes,
--   friend_requests, gdpr_deletion_requests, hand_players, hendon_scrape_log,
--   horse_analytics, horse_error_log, live_game_confirmations,
--   live_help_analytics, live_help_reactions, notification_preferences,
--   notification_prompt_log, pending_calls, promo_codes_used,
--   purchase_history, pwa_prompt_log, qr_code_scans, rake_history,
--   rakeback_distributions, sandbox_bookmarks, sandbox_saved_hands,
--   settlement_invoices, settlement_locks, signup_abuse_log, system_cache,
--   system_logs, union_rakeback_log, user_bookmarks, user_devices,
--   user_notifications
--
-- WHY THE GRANT IS SAFE.
--   The whole function is:
--
--     IF auth.uid() IS NULL THEN RETURN false; END IF;
--     SELECT role INTO v_role FROM public.profiles WHERE id = auth.uid();
--     RETURN v_role IN ('admin','superadmin','god');
--
--   STABLE, SECURITY DEFINER, search_path pinned to public, owned by postgres.
--   It takes no arguments and reads only the CALLER'S OWN profile row. The
--   only thing a caller can learn from it is whether they themselves are an
--   admin, which they already know. It grants no data access on its own --
--   every policy that calls it still applies its own predicate.
--
--   This restores 44 broken policies. It widens nothing.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── PRE-FLIGHT ────────────────────────────────────────────────────────
DO $$
DECLARE
  v_count int;
  v_secdef boolean;
  v_src text;
  v_nargs int;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'fn_is_platform_admin';

  IF v_count <> 1 THEN
    RAISE EXCEPTION
      'PRE-FLIGHT: expected exactly 1 fn_is_platform_admin, found %. An overload makes this GRANT ambiguous.',
      v_count;
  END IF;

  SELECT p.prosecdef, p.prosrc, p.pronargs INTO v_secdef, v_src, v_nargs
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'fn_is_platform_admin';

  IF v_nargs <> 0 THEN
    RAISE EXCEPTION 'PRE-FLIGHT: fn_is_platform_admin now takes % argument(s). Re-review before granting.', v_nargs;
  END IF;

  IF NOT v_secdef THEN
    RAISE EXCEPTION 'PRE-FLIGHT: fn_is_platform_admin is no longer SECURITY DEFINER. Re-review before granting.';
  END IF;

  -- The safety argument rests on it reading only auth.uid()'s own row and
  -- returning a boolean about the caller. If that ever changes, this
  -- migration must not be the thing that silently widened access.
  IF v_src NOT LIKE '%auth.uid()%' OR v_src NOT LIKE '%superadmin%' THEN
    RAISE EXCEPTION
      'PRE-FLIGHT: fn_is_platform_admin body is not the expected caller-role check. Refusing to grant.';
  END IF;
END $$;

-- ─── CHANGE ────────────────────────────────────────────────────────────
GRANT EXECUTE ON FUNCTION public.fn_is_platform_admin() TO authenticated;

-- anon is deliberately NOT granted. Every policy calling this function is
-- scoped to signed-in users, and the function returns false for a null
-- auth.uid() anyway, so anon has nothing to gain and no reason to reach it.

-- ─── POST-APPLY ASSERTIONS ─────────────────────────────────────────────
DO $$
DECLARE
  v_ok boolean;
  v_anon boolean;
BEGIN
  SELECT has_function_privilege('authenticated', 'public.fn_is_platform_admin()', 'EXECUTE') INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'POST-APPLY: authenticated still cannot execute fn_is_platform_admin. Grant did not take.';
  END IF;

  SELECT has_function_privilege('anon', 'public.fn_is_platform_admin()', 'EXECUTE') INTO v_anon;
  IF v_anon THEN
    RAISE EXCEPTION 'POST-APPLY: anon gained EXECUTE, which this migration did not intend.';
  END IF;

  RAISE NOTICE 'POST-APPLY OK: authenticated can execute fn_is_platform_admin; anon cannot.';
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK -- re-breaks 44 tables for every signed-in user. Do not run this
-- unless you have first removed fn_is_platform_admin from those policies.
--
--   BEGIN;
--   REVOKE EXECUTE ON FUNCTION public.fn_is_platform_admin() FROM authenticated;
--   COMMIT;
-- ═══════════════════════════════════════════════════════════════════════
