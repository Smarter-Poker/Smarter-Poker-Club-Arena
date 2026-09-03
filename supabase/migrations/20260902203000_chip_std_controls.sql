-- ═══════════════════════════════════════════════════════════════════════════════
--  CHIP ACCOUNTING STANDARD, LANE E: THE LOW-RISK CONTROLS
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- docs/CHIP-ACCOUNTING-STANDARD.md sections 2.7, 3.3 (R6, R8, R9, R10) and 3.4
-- (layers 4 and 6). Dan's rule for this lane, binding: nothing here may refuse
-- or block live play or a legitimate payout. Every object below either records
-- something, reports something, or is a switch that only a human throws.
--
-- ── 1. THE KILL SWITCH IS A TABLE A HUMAN WRITES ───────────────────────────
--
-- fn_settle_tournament_obligation already consults
-- to_regclass('public.ca_payout_freeze') and refuses every settle with
-- refused_reason = 'payout_frozen' while a row with scope = 'tournament_payouts'
-- and cleared_at IS NULL exists. Until now the table did not exist, so the
-- branch was dead code. This creates it EMPTY.
--
-- Nothing in this migration, and nothing scheduled by it, inserts into it. The
-- standard's layer 6 ("a trial-balance break > 1,000 chips freezes payouts")
-- is deliberately NOT built: an automatic opener is exactly the mechanism that
-- can refuse a legitimate payout on a false alarm, and the threshold is Dan's
-- to set (standard section 6 item 2). The only writer is
-- fn_ca_open_payout_freeze, which a person calls. tests/law/
-- PayoutFreezeIsHumanOnly.law.test.ts pins that this file contains no other
-- INSERT into the table.
--
-- ── 2. FOUR EYES ON A MANUAL ADJUSTMENT (R6) ───────────────────────────────
--
-- Today's double payments were authored, approved and applied by one agent in
-- one sitting. ca_manual_adjustments records a proposal by one actor and an
-- approval by a DIFFERENT one; CHECK (approver <> actor) makes self-approval a
-- constraint violation, not a policy. fn_settle_tournament_obligation already
-- accepts p_adjustment_id; wiring it to require an approved row is Lane A3's
-- follow-up (that function is theirs today) and is written up in the
-- changelog, not done here.
--
-- ── 3. THE TRIAL BALANCE NAMES THE ACCOUNT (R8, R9) ────────────────────────
--
-- fn_ca_supply_snapshot has reported one number per hour ("supply unexplained
-- +512") since 2026-08-30. fn_ca_trial_balance(p_since) reports one row per
-- account in the chart: what the balance column moved between the snapshot
-- at/after p_since and the latest one, what the ledger says moved for that
-- account, the difference, and which application_name / db_role wrote the
-- ledger rows touching it. settlement_suspense is an account with no balance
-- (it must net to zero) so its row is R9 as a number.
--
-- Measured before this was written (24h window 2026-09-01 20:05 to 2026-09-02
-- 19:05 UTC): player_wallets, club_wallets, spin_reserve, agent_wallets exact;
-- club_treasuries -45,000.50 vs -45,000.37; union_banks 21,336.79 vs
-- 21,295.85; bbj_pools 3,241.47 vs 3,230.49; and three STRUCTURAL gaps that
-- Lane B's escrow closes and that this lane only names: table_stack (+28,395
-- vs +34,467: tournament money is journaled against the felt because the
-- ledger writer's default counterparty is table_stack), tournament_liability
-- (-6,014 vs -207,893: buy-ins never credit prize_liability, spins debit it)
-- and settlement_suspense (+177,085 in 24h, all spin prizes parked there).
--
-- fn_ca_trial_balance_watch() runs hourly (pg_cron 'ca-trial-balance-hourly',
-- minute 20, fifteen minutes after the snapshot at minute 5) and files ONE
-- INFO incident per account per UTC day whose |difference| > 100, dedupe key
-- tb:<account>:<date>. Info never pages (fn_ca_raise_drift_incident short-
-- circuits notify for info) and this lane never files critical.
--
-- ── 4. THE DIRECT-WRITE LOG IS A VIEW, NOT A TRIGGER (R10, log-only) ───────
--
-- R10 asks for REVOKE UPDATE on balance columns. That can refuse a live path
-- and is not built (Dan's rule). The log-only half asks which writes reach
-- club_members.chip_balance with no declared money path. Checked before
-- building: fn_club_members_ledger_writer already journals every such write
-- as category 'adjustment' with description 'auto-audited club_members.
-- chip_balance delta ...', and fn_ca_chip_ledger_enrich already stamps
-- actor_service = application_name and db_role = current_user on every ledger
-- row. So the evidence is already captured and ca_direct_balance_writes is a
-- VIEW over chip_ledger, which puts no new trigger on a hot table. What the
-- view cannot show: app.money_path (not journaled) and session_user (the
-- definer flattens current_user to postgres). Both are in the changelog.
--
-- 24h count before this was written: 20,077 rows from 'PostgREST 14.5',
-- 9 from 'pg_cron', 1 from 'mgmt-api'. Sampled 300: 293 are tournament
-- buy-ins (wallet_transactions category tournament_buyin written beside them),
-- 4 bounty credits, 3 rebuys. The registration path debits the wallet without
-- declaring app.ledger_category, which is the single biggest reason the
-- tournament_liability row above does not reconcile.
--
-- ── WHAT IS NOT HERE ───────────────────────────────────────────────────────
--
-- No REVOKE on balance columns (R10 proper), no automatic freeze opener, no
-- retirement of chip_escrow_holds / chip_supply_snapshots /
-- atomic_tournament_register / fn_tournament_atomic_register, no alert-board
-- owner/auto-resolve/SLA rework. Each is listed for Dan in the changelog.
--
-- DDL: one transaction, applied once with apply_migration. No hot table is
-- touched: three new tables, one view, seven functions, one cron job.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. ca_payout_freeze
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE public.ca_payout_freeze (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  scope            text        NOT NULL,
  reason           text        NOT NULL,
  opened_by        uuid,
  opened_by_label  text,
  opened_at        timestamptz NOT NULL DEFAULT now(),
  cleared_by       uuid,
  cleared_by_label text,
  cleared_at       timestamptz,
  CONSTRAINT ca_payout_freeze_scope_check
    CHECK (scope IN ('tournament_payouts')),
  CONSTRAINT ca_payout_freeze_reason_check
    CHECK (length(btrim(reason)) >= 10),
  CONSTRAINT ca_payout_freeze_clear_after_open
    CHECK (cleared_at IS NULL OR cleared_at >= opened_at)
);

COMMENT ON TABLE public.ca_payout_freeze IS
  'Kill switch consulted by fn_settle_tournament_obligation: an open row (cleared_at IS NULL) '
  'with scope tournament_payouts refuses every settle with payout_frozen. Written ONLY by '
  'fn_ca_open_payout_freeze / fn_ca_clear_payout_freeze, which a human calls. Nothing opens it '
  'automatically (Lane E, 2026-09-02; tests/law/PayoutFreezeIsHumanOnly.law.test.ts).';

-- One open freeze per scope: opening twice is idempotent, not a second row.
-- The settle function probes (scope, cleared_at IS NULL) on every call, so
-- this partial index is also what keeps that probe an index hit.
CREATE UNIQUE INDEX ca_payout_freeze_one_open_per_scope
  ON public.ca_payout_freeze (scope) WHERE cleared_at IS NULL;

ALTER TABLE public.ca_payout_freeze ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_payout_freeze FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.ca_payout_freeze FROM service_role;
GRANT SELECT ON public.ca_payout_freeze TO service_role;

-- Management check, same idiom as fn_ca_incident_dashboard: a caller with a
-- JWT must be an incident recipient, a club owner, a union owner or an
-- admin/god profile. A service_role caller has no auth.uid() and passes; the
-- EXECUTE grants below already keep browser roles out entirely.
CREATE OR REPLACE FUNCTION public.fn_ca_caller_is_management()
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_ok  boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN true;
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.ca_incident_recipients r WHERE r.user_id = v_uid AND r.active
    UNION ALL
    SELECT 1 FROM public.club_members cm WHERE cm.user_id = v_uid AND cm.role = 'owner'
    UNION ALL
    SELECT 1 FROM public.unions u WHERE u.owner_id = v_uid
    UNION ALL
    SELECT 1 FROM public.profiles p WHERE p.id = v_uid AND p.role IN ('admin','god')
  ) INTO v_ok;
  RETURN COALESCE(v_ok, false);
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_caller_is_management() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_caller_is_management() TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_open_payout_freeze(
  p_scope        text,
  p_reason       text,
  p_actor_label  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_scope text := lower(btrim(COALESCE(p_scope, '')));
  v_uid   uuid := auth.uid();
  v_label text := COALESCE(NULLIF(btrim(p_actor_label), ''),
                           NULLIF(current_setting('application_name', true), ''),
                           session_user::text);
  v_row   public.ca_payout_freeze%ROWTYPE;
BEGIN
  IF NOT public.fn_ca_caller_is_management() THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'not_management');
  END IF;
  IF v_scope NOT IN ('tournament_payouts') THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'unknown_scope');
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 10 THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'reason_too_short');
  END IF;

  SELECT * INTO v_row FROM public.ca_payout_freeze
   WHERE scope = v_scope AND cleared_at IS NULL
   FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'already_open', true, 'freeze_id', v_row.id,
      'scope', v_row.scope, 'opened_at', v_row.opened_at, 'opened_by', v_row.opened_by,
      'opened_by_label', v_row.opened_by_label, 'reason', v_row.reason);
  END IF;

  INSERT INTO public.ca_payout_freeze (scope, reason, opened_by, opened_by_label)
  VALUES (v_scope, btrim(p_reason), v_uid, v_label)
  RETURNING * INTO v_row;

  -- The board row is the audit trail: warning, one per freeze, resolved on clear.
  PERFORM public.fn_raise_server_financial_alert(
    'warning', 'ca_payout_freeze',
    format('Tournament payouts FROZEN by %s: %s', v_label, btrim(p_reason)),
    jsonb_build_object('freeze_id', v_row.id, 'scope', v_scope, 'opened_by', v_uid,
                       'opened_by_label', v_label, 'opened_at', v_row.opened_at),
    'freeze:' || v_row.id::text);

  RETURN jsonb_build_object('ok', true, 'already_open', false, 'freeze_id', v_row.id,
    'scope', v_row.scope, 'opened_at', v_row.opened_at, 'opened_by', v_uid,
    'opened_by_label', v_label, 'reason', v_row.reason);
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_open_payout_freeze(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_open_payout_freeze(text, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_clear_payout_freeze(
  p_id           uuid,
  p_actor_label  text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_label text := COALESCE(NULLIF(btrim(p_actor_label), ''),
                           NULLIF(current_setting('application_name', true), ''),
                           session_user::text);
  v_row   public.ca_payout_freeze%ROWTYPE;
BEGIN
  IF NOT public.fn_ca_caller_is_management() THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'not_management');
  END IF;
  IF p_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'id_required');
  END IF;

  UPDATE public.ca_payout_freeze
     SET cleared_at = now(), cleared_by = v_uid, cleared_by_label = v_label
   WHERE id = p_id AND cleared_at IS NULL
   RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'not_open', 'freeze_id', p_id);
  END IF;

  UPDATE public.financial_alerts
     SET resolved = true, resolved_at = now(), resolved_by = v_uid
   WHERE source = 'ca_payout_freeze'
     AND resolved IS NOT TRUE
     AND context ->> 'dedupe_key' = 'freeze:' || p_id::text;

  PERFORM public.fn_raise_server_financial_alert(
    'info', 'ca_payout_freeze',
    format('Tournament payouts UNFROZEN by %s after %s (opened by %s: %s)',
           v_label, (now() - v_row.opened_at)::text, COALESCE(v_row.opened_by_label, '?'), v_row.reason),
    jsonb_build_object('freeze_id', v_row.id, 'scope', v_row.scope, 'cleared_by', v_uid,
                       'cleared_by_label', v_label, 'opened_at', v_row.opened_at,
                       'cleared_at', v_row.cleared_at),
    'freeze-cleared:' || v_row.id::text);

  RETURN jsonb_build_object('ok', true, 'freeze_id', v_row.id, 'scope', v_row.scope,
    'opened_at', v_row.opened_at, 'cleared_at', v_row.cleared_at, 'cleared_by', v_uid,
    'cleared_by_label', v_label);
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_clear_payout_freeze(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_clear_payout_freeze(uuid, text) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. ca_manual_adjustments (R6, four eyes)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE public.ca_manual_adjustments (
  id             uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  actor          uuid           NOT NULL,
  approver       uuid,
  reason         text           NOT NULL,
  amount         numeric(15,2)  NOT NULL,
  target_kind    text           NOT NULL,
  target_id      uuid,
  tournament_id  uuid,
  status         text           NOT NULL DEFAULT 'proposed',
  created_at     timestamptz    NOT NULL DEFAULT now(),
  approved_at    timestamptz,
  rejected_by    uuid,
  rejected_at    timestamptz,
  decision_note  text,
  actor_label    text,
  approver_label text,
  CONSTRAINT ca_manual_adjustments_reason_check
    CHECK (length(btrim(reason)) >= 20),
  CONSTRAINT ca_manual_adjustments_amount_check
    CHECK (amount <> 0 AND amount = round(amount, 2)),
  CONSTRAINT ca_manual_adjustments_target_kind_check
    CHECK (target_kind IN ('player_wallet','promo_wallet','club_treasury','union_bank',
                           'union_wallet','agent_wallet','club_wallet','bbj_pool',
                           'spin_reserve','prize_liability','bounty_liability')),
  CONSTRAINT ca_manual_adjustments_status_check
    CHECK (status IN ('proposed','approved','settled','rejected')),
  CONSTRAINT ca_manual_adjustments_four_eyes
    CHECK (approver IS NULL OR approver <> actor),
  CONSTRAINT ca_manual_adjustments_approved_has_approver
    CHECK (status NOT IN ('approved','settled') OR (approver IS NOT NULL AND approved_at IS NOT NULL)),
  CONSTRAINT ca_manual_adjustments_rejected_has_rejecter
    CHECK (status <> 'rejected' OR (rejected_by IS NOT NULL AND rejected_at IS NOT NULL))
);

COMMENT ON TABLE public.ca_manual_adjustments IS
  'R6 four-eyes register for any manual money movement. One actor proposes, a DIFFERENT '
  'approver approves (CHECK approver <> actor). amount > 0 credits the target, < 0 debits it. '
  'fn_settle_tournament_obligation.p_adjustment_id is meant to require an approved row here '
  '(Lane A3 follow-up). No row here moves money by itself.';

CREATE INDEX ca_manual_adjustments_status_idx
  ON public.ca_manual_adjustments (status, created_at DESC);

ALTER TABLE public.ca_manual_adjustments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_manual_adjustments FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.ca_manual_adjustments FROM service_role;
GRANT SELECT ON public.ca_manual_adjustments TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_propose_manual_adjustment(
  p_reason        text,
  p_amount        numeric,
  p_target_kind   text,
  p_target_id     uuid    DEFAULT NULL,
  p_tournament_id uuid    DEFAULT NULL,
  p_actor         uuid    DEFAULT NULL,
  p_actor_label   text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := COALESCE(p_actor, auth.uid());
  v_label text := COALESCE(NULLIF(btrim(p_actor_label), ''),
                           NULLIF(current_setting('application_name', true), ''),
                           session_user::text);
  v_row   public.ca_manual_adjustments%ROWTYPE;
BEGIN
  IF NOT public.fn_ca_caller_is_management() THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'not_management');
  END IF;
  IF v_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'actor_required');
  END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 20 THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'reason_too_short');
  END IF;
  IF p_amount IS NULL OR round(p_amount, 2) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'amount_required');
  END IF;
  IF p_target_kind IS NULL OR p_target_kind NOT IN
     ('player_wallet','promo_wallet','club_treasury','union_bank','union_wallet','agent_wallet',
      'club_wallet','bbj_pool','spin_reserve','prize_liability','bounty_liability') THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'unknown_target_kind');
  END IF;

  INSERT INTO public.ca_manual_adjustments
    (actor, actor_label, reason, amount, target_kind, target_id, tournament_id)
  VALUES (v_actor, v_label, btrim(p_reason), round(p_amount, 2), p_target_kind, p_target_id, p_tournament_id)
  RETURNING * INTO v_row;

  PERFORM public.fn_raise_server_financial_alert(
    'info', 'ca_manual_adjustments',
    format('Manual adjustment PROPOSED by %s: %s chips to %s (%s)',
           v_label, v_row.amount, p_target_kind, btrim(p_reason)),
    jsonb_build_object('adjustment_id', v_row.id, 'actor', v_actor, 'actor_label', v_label,
                       'amount', v_row.amount, 'target_kind', p_target_kind,
                       'target_id', p_target_id, 'tournament_id', p_tournament_id),
    'adj:' || v_row.id::text);

  RETURN jsonb_build_object('ok', true, 'adjustment_id', v_row.id, 'status', v_row.status,
    'actor', v_actor, 'amount', v_row.amount, 'target_kind', p_target_kind);
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_propose_manual_adjustment(text, numeric, text, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_propose_manual_adjustment(text, numeric, text, uuid, uuid, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_approve_manual_adjustment(
  p_id             uuid,
  p_approver       uuid DEFAULT NULL,
  p_approver_label text DEFAULT NULL,
  p_note           text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_approver uuid := COALESCE(p_approver, auth.uid());
  v_label    text := COALESCE(NULLIF(btrim(p_approver_label), ''),
                              NULLIF(current_setting('application_name', true), ''),
                              session_user::text);
  v_row      public.ca_manual_adjustments%ROWTYPE;
BEGIN
  IF NOT public.fn_ca_caller_is_management() THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'not_management');
  END IF;
  IF v_approver IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'approver_required');
  END IF;

  SELECT * INTO v_row FROM public.ca_manual_adjustments WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'not_found', 'adjustment_id', p_id);
  END IF;
  IF v_row.status <> 'proposed' THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'not_proposed',
      'adjustment_id', p_id, 'status', v_row.status);
  END IF;

  -- Four eyes. The CHECK would refuse this too; saying why is the point.
  IF v_approver = v_row.actor THEN
    PERFORM public.fn_raise_server_financial_alert(
      'warning', 'ca_manual_adjustments',
      format('Self-approval REFUSED: %s proposed adjustment %s and tried to approve it', v_label, p_id),
      jsonb_build_object('adjustment_id', p_id, 'actor', v_row.actor, 'approver', v_approver,
                         'approver_label', v_label),
      'adj-self-approval:' || p_id::text);
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'four_eyes_violated',
      'adjustment_id', p_id, 'actor', v_row.actor);
  END IF;

  UPDATE public.ca_manual_adjustments
     SET status = 'approved', approver = v_approver, approver_label = v_label,
         approved_at = now(), decision_note = NULLIF(btrim(p_note), '')
   WHERE id = p_id
   RETURNING * INTO v_row;

  PERFORM public.fn_raise_server_financial_alert(
    'info', 'ca_manual_adjustments',
    format('Manual adjustment APPROVED by %s (proposed by %s): %s to %s',
           v_label, COALESCE(v_row.actor_label, v_row.actor::text), v_row.amount, v_row.target_kind),
    jsonb_build_object('adjustment_id', p_id, 'actor', v_row.actor, 'approver', v_approver,
                       'approver_label', v_label, 'amount', v_row.amount,
                       'target_kind', v_row.target_kind, 'target_id', v_row.target_id),
    'adj-approved:' || p_id::text);

  RETURN jsonb_build_object('ok', true, 'adjustment_id', p_id, 'status', v_row.status,
    'actor', v_row.actor, 'approver', v_approver, 'approved_at', v_row.approved_at);
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_approve_manual_adjustment(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_approve_manual_adjustment(uuid, uuid, text, text) TO service_role;

-- A proposal can be withdrawn by its author or rejected by anyone in
-- management; neither touches approver, so the four-eyes CHECK is untouched.
CREATE OR REPLACE FUNCTION public.fn_ca_reject_manual_adjustment(
  p_id             uuid,
  p_note           text,
  p_rejecter       uuid DEFAULT NULL,
  p_rejecter_label text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rejecter uuid := COALESCE(p_rejecter, auth.uid());
  v_label    text := COALESCE(NULLIF(btrim(p_rejecter_label), ''),
                              NULLIF(current_setting('application_name', true), ''),
                              session_user::text);
  v_row      public.ca_manual_adjustments%ROWTYPE;
BEGIN
  IF NOT public.fn_ca_caller_is_management() THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'not_management');
  END IF;
  IF v_rejecter IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'rejecter_required');
  END IF;

  UPDATE public.ca_manual_adjustments
     SET status = 'rejected', rejected_by = v_rejecter, rejected_at = now(),
         decision_note = NULLIF(btrim(p_note), '')
   WHERE id = p_id AND status = 'proposed'
   RETURNING * INTO v_row;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'not_proposed', 'adjustment_id', p_id);
  END IF;

  UPDATE public.financial_alerts
     SET resolved = true, resolved_at = now(), resolved_by = v_rejecter
   WHERE source = 'ca_manual_adjustments'
     AND resolved IS NOT TRUE
     AND context ->> 'dedupe_key' = 'adj:' || p_id::text;

  RETURN jsonb_build_object('ok', true, 'adjustment_id', p_id, 'status', v_row.status,
    'rejected_by', v_rejecter, 'rejected_at', v_row.rejected_at);
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_reject_manual_adjustment(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_reject_manual_adjustment(uuid, text, uuid, text) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. fn_ca_trial_balance (R8) and its hourly watch (R9 rides in the
--    settlement_suspense row)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Account -> balance column (ca_supply_snapshots) -> chip_ledger from/to types.
-- The mapping is the whole function; it is repeated as a table in the
-- changelog so it can be argued with.
--
--   player_wallets         member_wallets         player_wallet
--   promo_wallets          member_promo           promo_wallet
--   table_stack            felt                   table_stack
--   tournament_liability   tournament_liability   prize_liability, bounty_liability, refund_payable
--   bbj_pools              bbj_pools              bbj_pool
--   spin_reserve           spin_pools             spin_reserve
--   club_treasuries        treasuries             club_treasury
--   club_chip_pools        chip_pools             (none: clubs.chip_pool has no ledger type)
--   union_banks            union_wallets          union_bank, union_wallet, insurance_bank
--   agent_wallets          agent_wallets          agent_wallet
--   club_wallets           club_wallets           club_wallet
--   leaderboard_liability  leaderboard_liability  opening_setup, leaderboard_round
--   settlement_suspense    (no balance; 0)        settlement_suspense
--   total_supply           total                  mint minus burn (fn_ca_noncirculating_chip_stores)
--
-- Unmapped ledger types, deliberately: escrow (chip_escrow, cashier only, not
-- in the snapshot), rakeback_payable, credit_facility, credit_receivable
-- (none used in the last 7 days). system_mint / system_burn / issuance_reserve
-- / chip_retirement are issuance, which is the total_supply row.
--
-- Rows with category = 'correction' posted via fn_ca_post_correction move no
-- balance and are excluded, exactly as fn_ca_supply_snapshot excludes them.

CREATE OR REPLACE FUNCTION public.fn_ca_trial_balance(
  p_since timestamptz DEFAULT now() - interval '75 minutes'
)
RETURNS TABLE (
  account        text,
  balance_delta  numeric,
  ledger_net     numeric,
  difference     numeric,
  writers        text,
  window_start   timestamptz,
  window_end     timestamptz
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s0 public.ca_supply_snapshots%ROWTYPE;
  s1 public.ca_supply_snapshots%ROWTYPE;
  v_outside text[] := public.fn_ca_noncirculating_chip_stores();
BEGIN
  SELECT * INTO s0 FROM public.ca_supply_snapshots
   WHERE taken_at >= COALESCE(p_since, now() - interval '75 minutes')
   ORDER BY taken_at ASC LIMIT 1;
  SELECT * INTO s1 FROM public.ca_supply_snapshots ORDER BY taken_at DESC LIMIT 1;

  -- No window (no snapshot at/after p_since, or it IS the latest): report the
  -- chart with NULL deltas rather than a zero that reads as "reconciled".
  IF s0.id IS NULL OR s1.id IS NULL OR s0.id = s1.id THEN
    RETURN QUERY
      SELECT a.account, NULL::numeric, NULL::numeric, NULL::numeric, NULL::text,
             s0.taken_at, s1.taken_at
        FROM (VALUES ('player_wallets'), ('promo_wallets'), ('table_stack'),
                     ('tournament_liability'), ('bbj_pools'), ('spin_reserve'),
                     ('club_treasuries'), ('club_chip_pools'), ('union_banks'),
                     ('agent_wallets'), ('club_wallets'), ('leaderboard_liability'),
                     ('settlement_suspense'), ('total_supply')) AS a(account);
    RETURN;
  END IF;

  RETURN QUERY
  WITH acct(account, ledger_types, bal_delta) AS (
    VALUES
      ('player_wallets',        ARRAY['player_wallet'],                                  s1.member_wallets        - s0.member_wallets),
      ('promo_wallets',         ARRAY['promo_wallet'],                                   s1.member_promo          - s0.member_promo),
      ('table_stack',           ARRAY['table_stack'],                                    s1.felt                  - s0.felt),
      ('tournament_liability',  ARRAY['prize_liability','bounty_liability','refund_payable'],
                                                                                         s1.tournament_liability  - s0.tournament_liability),
      ('bbj_pools',             ARRAY['bbj_pool'],                                       s1.bbj_pools             - s0.bbj_pools),
      ('spin_reserve',          ARRAY['spin_reserve'],                                   s1.spin_pools            - s0.spin_pools),
      ('club_treasuries',       ARRAY['club_treasury'],                                  s1.treasuries            - s0.treasuries),
      ('club_chip_pools',       ARRAY[]::text[],                                         s1.chip_pools            - s0.chip_pools),
      ('union_banks',           ARRAY['union_bank','union_wallet','insurance_bank'],     s1.union_wallets         - s0.union_wallets),
      ('agent_wallets',         ARRAY['agent_wallet'],                                   s1.agent_wallets         - s0.agent_wallets),
      ('club_wallets',          ARRAY['club_wallet'],                                    s1.club_wallets          - s0.club_wallets),
      ('leaderboard_liability', ARRAY['opening_setup','leaderboard_round'],              s1.leaderboard_liability - s0.leaderboard_liability),
      ('settlement_suspense',   ARRAY['settlement_suspense'],                            0::numeric)
  ),
  led AS (
    SELECT l.from_type, l.to_type, l.amount,
           COALESCE(l.actor_service, '?') || '/' || COALESCE(l.db_role, '?') AS writer
      FROM public.chip_ledger l
     WHERE l.created_at >  s0.taken_at
       AND l.created_at <= s1.taken_at
       AND NOT (l.category = 'correction'
                AND l.metadata ->> 'posted_via' = 'fn_ca_post_correction')
  ),
  per_acct AS (
    SELECT a.account, a.bal_delta,
           COALESCE((SELECT sum(led.amount) FROM led WHERE led.to_type   = ANY (a.ledger_types)), 0)
         - COALESCE((SELECT sum(led.amount) FROM led WHERE led.from_type = ANY (a.ledger_types)), 0) AS net,
           (SELECT string_agg(w.writer || ':' || w.n::text, ', ' ORDER BY w.n DESC)
              FROM (SELECT led.writer, count(*) AS n
                      FROM led
                     WHERE led.to_type = ANY (a.ledger_types) OR led.from_type = ANY (a.ledger_types)
                     GROUP BY led.writer
                     ORDER BY count(*) DESC
                     LIMIT 5) w) AS writers
      FROM acct a
  ),
  issuance AS (
    SELECT COALESCE(sum(led.amount) FILTER (WHERE led.from_type = ANY (v_outside)), 0)
         - COALESCE(sum(led.amount) FILTER (WHERE led.to_type   = ANY (v_outside)), 0) AS net,
           (SELECT string_agg(w.writer || ':' || w.n::text, ', ' ORDER BY w.n DESC)
              FROM (SELECT l2.writer, count(*) AS n FROM led l2
                     WHERE l2.from_type = ANY (v_outside) OR l2.to_type = ANY (v_outside)
                     GROUP BY l2.writer ORDER BY count(*) DESC LIMIT 5) w) AS writers
      FROM led
  )
  SELECT p.account,
         round(p.bal_delta, 2),
         round(p.net, 2),
         round(p.bal_delta - p.net, 2),
         p.writers,
         s0.taken_at, s1.taken_at
    FROM per_acct p
  UNION ALL
  SELECT 'total_supply',
         round(s1.total - s0.total, 2),
         round(i.net, 2),
         round((s1.total - s0.total) - i.net, 2),
         i.writers,
         s0.taken_at, s1.taken_at
    FROM issuance i
  ORDER BY 1;
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_trial_balance(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_trial_balance(timestamptz) TO service_role;

-- Hourly watch. INFO only, one incident per account per UTC day, never a push
-- (fn_ca_raise_drift_incident does not notify for info). total_supply is left
-- to fn_ca_supply_snapshot, which already files 'supply-unexplained'.
CREATE OR REPLACE FUNCTION public.fn_ca_trial_balance_watch(
  p_since     timestamptz DEFAULT now() - interval '75 minutes',
  p_threshold numeric     DEFAULT 100
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r       record;
  v_filed integer := 0;
  v_id    uuid;
BEGIN
  FOR r IN
    SELECT * FROM public.fn_ca_trial_balance(p_since)
     WHERE account <> 'total_supply'
       AND difference IS NOT NULL
       AND abs(difference) > COALESCE(p_threshold, 100)
  LOOP
    v_id := public.fn_ca_raise_drift_incident(
      'fn_ca_trial_balance_watch', 'ledger_imbalance', 'info',
      'tb:' || r.account || ':' || to_char(r.window_end AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
      r.difference, r.ledger_net, r.balance_delta,
      'ledger', 'account', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      format('trial balance: %s moved %s in its balance column but %s in the ledger between %s and %s; writers %s',
             r.account, r.balance_delta, r.ledger_net,
             to_char(r.window_start AT TIME ZONE 'UTC', 'HH24:MI'),
             to_char(r.window_end   AT TIME ZONE 'UTC', 'HH24:MI'),
             COALESCE(r.writers, '(no ledger rows)')),
      false,
      jsonb_build_object('account', r.account, 'balance_delta', r.balance_delta,
                         'ledger_net', r.ledger_net, 'difference', r.difference,
                         'writers', r.writers, 'window_start', r.window_start,
                         'window_end', r.window_end));
    IF v_id IS NOT NULL THEN
      v_filed := v_filed + 1;
    END IF;
  END LOOP;
  RETURN v_filed;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_trial_balance_watch failed: %', SQLERRM;
  RETURN -1;
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_trial_balance_watch(timestamptz, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_trial_balance_watch(timestamptz, numeric) TO service_role;

SELECT cron.unschedule('ca-trial-balance-hourly')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-trial-balance-hourly');

SELECT cron.schedule(
  'ca-trial-balance-hourly',
  '20 * * * *',
  $cron$SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-trial-balance'))
      THEN public.fn_ca_trial_balance_watch()
      ELSE NULL END$cron$
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. ca_direct_balance_writes: the undeclared wallet writes, as a view
-- ─────────────────────────────────────────────────────────────────────────────

CREATE VIEW public.ca_direct_balance_writes
WITH (security_invoker = true) AS
SELECT l.created_at                                                             AS at,
       'club_members'::text                                                     AS table_name,
       CASE WHEN l.to_type = 'player_wallet' THEN l.to_entity_id ELSE l.from_entity_id END AS user_id,
       CASE WHEN l.to_type = 'player_wallet' THEN l.amount ELSE -l.amount END   AS delta,
       l.actor_service                                                          AS application_name,
       l.db_role,
       l.club_id,
       l.tournament_id,
       l.id                                                                     AS ledger_id,
       l.description
  FROM public.chip_ledger l
 WHERE l.category = 'adjustment'
   AND l.description LIKE 'auto-audited club_members.chip_balance delta%'
   AND l.description NOT LIKE '%rejected)';

COMMENT ON VIEW public.ca_direct_balance_writes IS
  'R10 log-only: every club_members.chip_balance write that reached fn_club_members_ledger_writer '
  'with no app.ledger_category declared (journaled as adjustment). application_name and db_role '
  'come from fn_ca_chip_ledger_enrich. Not observable here: app.money_path, session_user. '
  'Refuses nothing. Lane E, 2026-09-02.';

REVOKE ALL ON public.ca_direct_balance_writes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ca_direct_balance_writes TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Post-apply assertions: the switch is closed and empty, the register is
-- empty, the job is scheduled, the settle function still finds the table.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE v_n integer;
BEGIN
  IF to_regclass('public.ca_payout_freeze') IS NULL THEN
    RAISE EXCEPTION 'ca_payout_freeze missing';
  END IF;
  SELECT count(*) INTO v_n FROM public.ca_payout_freeze;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'ca_payout_freeze must be created EMPTY, has % rows', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.ca_manual_adjustments;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'ca_manual_adjustments must be created empty, has % rows', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'ca-trial-balance-hourly';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'ca-trial-balance-hourly not scheduled exactly once (%)', v_n;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.proname = 'fn_settle_tournament_obligation'
                    AND p.prosrc LIKE '%ca_payout_freeze%') THEN
    RAISE EXCEPTION 'fn_settle_tournament_obligation no longer consults ca_payout_freeze';
  END IF;
  SELECT count(*) INTO v_n FROM public.fn_ca_trial_balance(now() - interval '3 hours');
  IF v_n <> 14 THEN
    RAISE EXCEPTION 'fn_ca_trial_balance returned % rows, expected 14', v_n;
  END IF;
END $$;

COMMIT;
