-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424002353 "20260421101000_bug27_to_35_vip_gamification_horse_cleanup"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ae2b2399b41456cfbaf987a688b93281 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG-27 through BUG-35: VIP/Diamonds, Gamification, and Horse cluster
-- cleanup. Mix of real fixes and stubs depending on schema reality.
--
-- Real fixes (schema drift correctable):
--   BUG-27: fn_get_vip_subscription — is_active + expires_at renames
--   BUG-28: schedule_horse_leave     — table_seats.updated_at removed
--
-- Stubs (tables/columns gone; rebuild needed for real feature):
--   BUG-29: add_vip_points(uuid,int,varchar,text)  — vip_points_ledger gone
--   BUG-30: add_vip_points(uuid,int)               — profiles.vip_points gone
--   BUG-31: award_purchase_diamonds                 — purchase_history drift
--   BUG-32: fn_purchase_vip_card                    — vip_subscriptions drift
--   BUG-33: check_bankroll_achievements             — bankroll_* tables gone
--   BUG-34: update_achievement_progress             — achievements/user_achievements gone
--   BUG-35: update_bankroll_streak                  — bankroll_streaks gone
--   BUG-36: get_horse_action                        — get_horse_personality(integer) gone

-- ═══ BUG-27 fn_get_vip_subscription — REAL FIX ═════════════════════
-- Schema drift only. Keep external TABLE signature (expires_at) but
-- read current_period_end internally. is_active = true → status filter.
CREATE OR REPLACE FUNCTION public.fn_get_vip_subscription(p_user_id uuid)
 RETURNS TABLE(tier text, expires_at timestamptz, days_remaining integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    vs.tier,
    vs.current_period_end AS expires_at,
    EXTRACT(DAY FROM (vs.current_period_end - NOW()))::int AS days_remaining
  FROM vip_subscriptions vs
  WHERE vs.user_id = p_user_id
    AND vs.status IN ('active','trialing')
    AND vs.current_period_end > NOW()
  ORDER BY
    CASE vs.tier WHEN 'gold' THEN 3 WHEN 'silver' THEN 2 ELSE 1 END DESC,
    vs.current_period_end DESC
  LIMIT 1;
END;
$function$;

-- ═══ BUG-28 schedule_horse_leave — REAL FIX ════════════════════════
--
