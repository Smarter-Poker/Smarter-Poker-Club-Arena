-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424003240 "20260421102000_bug28_35_vip_gamification_horse_cleanup_resumed"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 79fc0ae1eb0e36f490e6b22c1eff558d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG-28 through BUG-35: resume VIP/Gamification/Horse cleanup
-- (BUG-27 fn_get_vip_subscription landed cleanly in the previous
-- migration before interrupt; this migration covers 28..35.)
--
-- Stubs over real fixes for functions whose backing tables are gone
-- entirely. Real fix where we can — schedule_horse_leave just needs
-- table_seats.updated_at reference dropped.

-- ═══ BUG-28 schedule_horse_leave — REAL FIX ═══════════════════════
-- table_seats has NO updated_at column. Drop the assignment.
CREATE OR REPLACE FUNCTION public.schedule_horse_leave(
  p_table_id uuid,
  p_horse_id uuid,
  p_leave_after_hands integer DEFAULT 10
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  UPDATE table_seats
     SET scheduled_leave_hands = p_leave_after_hands,
         leave_pending         = true
   WHERE table_id = p_table_id
     AND horse_id = p_horse_id
     AND left_at IS NULL;
END;
$function$;

-- ═══ BUG-29 add_vip_points(4-arg) — STUB ═══════════════════════════
-- vip_points_ledger table doesn't exist
CREATE OR REPLACE FUNCTION public.add_vip_points(
  p_user_id uuid,
  p_amount  integer,
  p_type    varchar,
  p_desc    text DEFAULT NULL::text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN
  -- STUB: vip_points_ledger table removed. VIP is now handled by
  -- vip_subscriptions + tier rollups; no ledger of discrete points.
  RETURN;
END; $f$;
COMMENT ON FUNCTION public.add_vip_points(uuid,integer,varchar,text)
  IS 'STUB: vip_points_ledger table removed.';

-- ═══ BUG-30 add_vip_points(2-arg) — STUB ═══════════════════════════
-- profiles.vip_points column doesn't exist (profiles only has is_vip,
-- vip_tier, vip_expires_at)
CREATE OR REPLACE FUNCTION public.add_vip_points(
  p_user_id uuid,
  p_points  integer
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN
  -- STUB: profiles.vip_points column removed. No-op.
  RETURN;
END; $f$;
COMMENT ON FUNCTION public.add_vip_points(uuid,integer)
  IS 'STUB: profiles.vip_points column removed.';

-- ═══ BUG-31 award_purchase_diamonds — STUB ═════════════════════════
-- purchase_history has current cols: id, user_id, product_id,
-- product_name, amount, currency, payment_method, stripe_session_id,
-- status, metadata, created_at. Function's INSERT references
-- purchase_type, amount_paid, diamonds_awarded — none exist.
CREATE OR REPLACE FUNCTION public.award_purchase_diamonds(
  p_user_id           uuid,
  p_amount            integer,
  p_stripe_session_id text,
  p_amount_paid       numeric
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN
  -- STUB: purchase_history column drift. If diamond awards on Stripe
  -- purchase need to happen here again, the body needs a rewrite against
  -- the current schema. Today, the Stripe webhook handler updates
  -- diamond_wallets directly.
  RETURN;
END; $f$;
COMMENT ON FUNCTION public.award_purchase_diamonds(uuid,integer,text,numeric)
  IS 'STUB: purchase_history schema drift (purchase_type/amount_paid/diamonds_awarded missing).';

-- ═══ BUG-32 fn_purchase_vip_card — STUB ════════════════════════════
-- vip_subscriptions.expires_at → current_period_end rename, but
-- additional drifts make a clean rewrite risky: INSERT references
-- duration_days + diamond_cost columns that also don't exist, AND
-- there's a NOT NULL plan column with no default. Clean rewrite needs
-- product decisions on what to do with duration/plan/diamond-cost,
-- so stubbing here. If fn_purchase_vip_card is actively called, the
-- caller gets a safe not_implemented response vs a 500.
CREATE OR REPLACE FUNCTION public.fn_purchase_vip_card(
  p_user_id        uuid,
  p_tier           text,
  p_duration_days  integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $f$
BEGIN
  RETURN jsonb_build_object(
    'success', false,
    'error',   'not_implemented',
    'note',    'fn_purchase_vip_card disabled — vip_subscriptions schema drifted (expires_at/duration_days/diamond_cost cols + NOT NULL plan). Use the Stripe subscription flow.'
  );
END; $f$;

-- ═══ BUG-33 check_bankroll_achievements — STUB ═════════════════════
-- bankroll_streaks + bankroll_achievements tables removed
CREATE OR REPLACE FUNCTION public.check_bankroll_achievements(p_user_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN RETURN; END; $f$;
COMMENT ON FUNCTION public.check_bankroll_achievements(uuid)
  IS 'STUB: bankroll_streaks + bankroll_achievements tables removed.';

-- ═══ BUG-34 update_achievement_progress — STUB ═════════════════════
-- achievements + user_achievements tables removed
CREATE OR REPLACE FUNCTION public.update_achievement_progress(
  p_user_id        uuid,
  p_achievement_id uuid,
  p_progress_delta integer DEFAULT 1
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN
  RETURN jsonb_build_object('success', false, 'error', 'not_implemented',
    'note', 'achievements/user_achievements tables removed.');
END; $f$;

-- ═══ BUG-35 update_bankroll_streak — STUB ══════════════════════════
-- bankroll_streaks table removed
CREATE OR REPLACE FUNCTION public.update_bankroll_streak(
  p_user_id    uuid,
  p_net_amount numeric
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN RETURN; END; $f$;
COMMENT ON FUNCTION public.update_bankroll_streak(uuid,numeric)
  IS 'STUB: bankroll_streaks table removed.';

-- ═══ BUG-36 get_horse_action — STUB ════════════════════════════════
-- Calls get_horse_personality(integer) which doesn't exist in any schema
CREATE OR REPLACE FUNCTION public.get_horse_action(
  p_author_id        integer,
  p_strategy_actions jsonb
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN
  -- STUB: get_horse_personality(integer) function missing. Return a
  -- safe default action ("check") so calling code doesn't NULL-crash.
  RETURN 'check';
END; $f$;
COMMENT ON FUNCTION public.get_horse_action(integer,jsonb)
  IS 'STUB: get_horse_personality(integer) function missing.';
