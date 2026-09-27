-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260424001857 "20260421100000_bug26_stub_dead_agent_rake_commission_functions"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 14341164c51b892c477b2c57bd818e2c of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- BUG-26: Stub 18 broken agent/rake/commission functions referencing
-- tables that no longer exist: agent_settlements, player_weekly_snapshots,
-- commission_structures, rake_attributions, commission_payouts,
-- commission_records, club_settlements, union_bbj_ledger.
--
-- Several of these have working overloads already — we only stub the
-- broken overloads. Working ones are left untouched.
--
-- Working overloads preserved (NOT stubbed):
--   atomic_pay_player_rakeback(uuid, numeric)     → void
--   calculate_agent_spread(uuid)                  → json
--   deduct_agent_balance(uuid, numeric)           → void
--   get_player_rake_total(uuid)                   → numeric
--   increment_rake_generated(uuid, uuid, numeric) → void

-- ─── atomic_pay_agent_settlement ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.atomic_pay_agent_settlement(
  p_settlement_id uuid, p_agent_id uuid, p_amount numeric, p_period_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN RETURN; END; $f$;
COMMENT ON FUNCTION public.atomic_pay_agent_settlement(uuid,uuid,numeric,uuid)
  IS 'STUB: agent_settlements table removed. No-op for backward compat.';

-- ─── atomic_pay_player_rakeback(4-arg — broken overload) ──────────
CREATE OR REPLACE FUNCTION public.atomic_pay_player_rakeback(
  p_snapshot_id uuid, p_player_id uuid, p_amount numeric, p_period_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN RETURN; END; $f$;
COMMENT ON FUNCTION public.atomic_pay_player_rakeback(uuid,uuid,numeric,uuid)
  IS 'STUB: player_weekly_snapshots table removed. Use (user_id, amount) overload.';

-- ─── calculate_agent_settlement ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.calculate_agent_settlement(p_period_id uuid, p_agent_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN
  RETURN jsonb_build_object('success', false, 'error', 'not_implemented',
    'note', 'agent_settlements table removed.');
END; $f$;

-- ─── calculate_agent_spread(2-arg — broken overload) ──────────────
CREATE OR REPLACE FUNCTION public.calculate_agent_spread(p_agent_id uuid, p_period_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN
  RETURN jsonb_build_object('success', false, 'error', 'not_implemented',
    'note', 'commission_structures and rake_attributions tables removed. Use single-arg overload.');
END; $f$;

-- ─── deduct_agent_balance(3-arg — broken overload) ────────────────
CREATE OR REPLACE FUNCTION public.deduct_agent_balance(
  p_agent_id uuid, p_amount numeric, p_reason text DEFAULT 'Transfer'::text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN
  -- STUB: original body referenced a nonexistent "balance" column on the
  -- target table. Use the (agent_id, amount) overload for real deductions.
  RETURN false;
END; $f$;

-- ─── execute_commission_payout ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.execute_commission_payout(p_payout_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN RETURN; END; $f$;
COMMENT ON FUNCTION public.execute_commission_payout(uuid)
  IS 'STUB: commission_payouts table removed.';

-- ─── fn_calculate_rakeback ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_calculate_rakeback(
  p_user_id uuid, p_period_start timestamptz, p_period_end timestamptz
) RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN
  -- STUB: profiles.vip_level column dropped + rakeback_periods.updated_at
  -- column drift.
  RETURN json_build_object('success', false, 'error', 'not_implemented',
    'rakeback', 0);
END; $f$;

-- ─── fn_get_agent_commission_summary ──────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_get_agent_commission_summary(p_agent_id uuid)
 RETURNS TABLE(total_earned bigint, this_week bigint, this_month bigint,
               pending_payout bigint, last_payout timestamptz)
 LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN
  -- STUB: underlying commission table "amount" column drift. Return zeros.
  RETURN QUERY SELECT 0::bigint, 0::bigint, 0::bigint, 0::bigint, NULL::timestamptz;
END; $f$;

-- ─── fn_pay_commission_atomic ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_pay_commission_atomic(
  p_club_id uuid, p_agent_id uuid, p_commission_record_id uuid,
  p_amount numeric, p_period_id uuid DEFAULT NULL::uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN
  RETURN jsonb_build_object('success', false, 'error', 'not_implemented',
    'note', 'agent_commissions.status column drift; current commission rails.');
END; $f$;

-- ─── generate_period_commissions ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.generate_period_commissions(p_period_id uuid)
 RETURNS TABLE(agent_id uuid, period_id uuid, gross_rake numeric,
               commission_earned numeric, paid_to_downlines numeric,
               net_payout numeric, status text)
 LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN RETURN; END; $f$;
COMMENT ON FUNCTION public.generate_period_commissions(uuid)
  IS 'STUB: commission_payouts table removed.';

-- ─── generate_period_settlement ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.generate_period_settlement(
  p_club_id uuid, p_settled_by uuid,
  p_start_at timestamptz DEFAULT NULL::timestamptz,
  p_end_at   timestamptz DEFAULT now()
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN
  RETURN jsonb_build_object('success', false, 'error', 'not_implemented',
    'note', 'commission_records.updated_at column drift.');
END; $f$;

-- ─── generate_period_settlements ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.generate_period_settlements(p_period_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN
  RETURN jsonb_build_object('success', false, 'error', 'not_implemented',
    'note', 'club_settlements and agent_settlements tables removed.');
END; $f$;

-- ─── get_agent_dashboard ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_agent_dashboard(p_agent_user_id uuid, p_club_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN
  RETURN jsonb_build_object('success', false, 'error', 'not_implemented',
    'note', 'Agent dashboard uses dropped id-column schema.');
END; $f$;

-- ─── get_player_rake_total(2-arg — broken overload) ───────────────
CREATE OR REPLACE FUNCTION public.get_player_rake_total(
  p_player_id uuid, p_period_id uuid DEFAULT NULL::uuid
) RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN
  -- STUB: rake_attributions table removed. Use single-arg overload.
  RETURN 0;
END; $f$;

-- ─── increment_rake_generated (2-arg overloads — both broken) ─────
CREATE OR REPLACE FUNCTION public.increment_rake_generated(p_club_id uuid, p_amount numeric)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN RETURN; END; $f$;
COMMENT ON FUNCTION public.increment_rake_generated(uuid,numeric)
  IS 'STUB: rake_generated column drift. Use (club_id, user_id, amount) overload.';

CREATE OR REPLACE FUNCTION public.increment_rake_generated(p_entity_id uuid, p_entity_type text, p_amount numeric)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN RETURN; END; $f$;
COMMENT ON FUNCTION public.increment_rake_generated(uuid,text,numeric)
  IS 'STUB: rake_generated column drift.';

-- ─── record_hand_rake_attribution ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_hand_rake_attribution(
  p_hand_id uuid, p_table_id uuid, p_club_id uuid, p_attributions jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN RETURN; END; $f$;
COMMENT ON FUNCTION public.record_hand_rake_attribution(uuid,uuid,uuid,jsonb)
  IS 'STUB: rake_attributions table removed.';

-- ─── transfer_promo_union_to_agent ────────────────────────────────
CREATE OR REPLACE FUNCTION public.transfer_promo_union_to_agent(
  p_union_id uuid, p_club_id uuid, p_agent_user_id uuid, p_amount numeric,
  p_note text DEFAULT NULL::text,
  p_performed_by uuid DEFAULT NULL::uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN
  RETURN jsonb_build_object('success', false, 'error', 'not_implemented',
    'note', 'union_bbj_ledger table removed.');
END; $f$;
