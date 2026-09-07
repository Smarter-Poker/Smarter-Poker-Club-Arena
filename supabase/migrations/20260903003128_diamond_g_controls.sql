-- ===============================================================================
--  DIAMOND ACCOUNTING STANDARD, LANE G: THE TRIAL BALANCE NAMES THE ACCOUNT
-- ===============================================================================
--
-- docs/DIAMOND-ACCOUNTING-STANDARD.md sections 2.7, 3.1, 3.3 (DR11, DR12,
-- DR13), 3.4 (layers 4 and 6) and section 5 "Lane G". Dan's rule for this
-- lane, binding: nothing here may refuse or block a live diamond movement.
-- Every object below reports something, records something, or is a switch that
-- only a human throws. The two CHECK constraints this file widens can only
-- ACCEPT values that were refused before; neither can refuse anything that was
-- accepted before, and both tables hold 0 rows.
--
-- -- 1. THE TRIAL BALANCE (DR11) ---------------------------------------------
--
-- fn_ca_trial_balance knows fourteen CHIP accounts and no diamond account
-- (audit lane 4, row 11). ca_diamond_snapshots reports one number per hour and
-- that number is currently wrong (it ADDS the mirrors to the canonical store;
-- Lane A owns the fix). fn_ca_diamond_trial_balance(p_since) reports one row
-- per account in standard 3.1 that exists today: what the balance is now, what
-- it moved since the snapshot nearest p_since, what the journal declared, what
-- the Mint issued, the difference, and a note saying what the row can and
-- cannot prove.
--
-- Every account block is guarded twice: by to_regclass for a table another
-- lane has not landed yet, and by an EXCEPTION handler that turns a missing
-- table or column into a row whose note reads 'table absent'. A reporting
-- function that raises is a reporting function nobody runs.
--
-- Two honesty notes are compiled into the output rather than left to a reader:
--
--   * The journal is ONE SIDED. diamond_transactions has (user_id, type,
--     amount) and, since 20260903000735_diamond_std_foundation, a nullable
--     counterparty. Until DR3 is enforced there is no debit row anywhere to
--     match a credit, so journal_net is what the writers DECLARED, not a
--     double entry, and mint_net sits beside it as the ledgered issuance for
--     the same window. difference = balance_delta - journal_net therefore
--     measures undeclared movement, not a broken double entry.
--   * The certification fleet DELETES journal rows hourly through the
--     app.ledger_maintenance bypass (2,718 rows / 635,761 diamonds since
--     2026-09-01, audit lane 1 section 3). Rows deleted inside the window are
--     gone from journal_net, so a difference can be caused by the cleanup as
--     easily as by an unjournalled write. Both are DR11 breaks; neither is
--     resolved by this function.
--
-- -- 2. THE WATCH (DR11, DR12) -----------------------------------------------
--
-- fn_ca_diamond_trial_balance_watch() runs hourly at minute 20 over the last
-- hour and files, per account, DR11:trial_balance_break (warning) for a
-- non-zero difference, DR12:suspense_nonzero (info) when the suspense row is
-- non-zero, and one DR11:trial_balance_summary (info) per run. It writes
-- nothing but incidents. It never opens the freeze: an automatic opener is
-- exactly the mechanism that refuses a legitimate movement on a false alarm,
-- the threshold is Dan's (standard 6.13), and tests/law/
-- PayoutFreezeIsHumanOnly.law.test.ts pins that no cron body and no watch
-- function may reference the opener.
--
-- Expect this to fire on player_diamonds every hour until DR3 lands. That is
-- the correct reading of today's database, not a bug in the watch: the journal
-- is one sided, rows are deleted from it hourly, and the balance moves through
-- writers that do not all journal.
--
-- -- 3. FOUR EYES LEARNS THE ASSET (DR13) ------------------------------------
--
-- ca_manual_adjustments was built for chips: eleven chip target kinds, no
-- asset column (audit lane 4, row 10). It gains asset ('chips' | 'diamonds',
-- defaulted to chips so every future chip proposal is unchanged), two diamond
-- target kinds, and a CHECK that the two agree. 0 rows exist, so no backfill
-- and nothing to violate. fn_ca_propose_manual_adjustment validated
-- target_kind against its own copy of the list; that list is widened and the
-- function gains p_asset (NULL derives the asset from the target kind, so
-- every existing call site keeps working). fn_ca_approve_manual_adjustment and
-- fn_ca_reject_manual_adjustment are untouched: they key on id and status and
-- never read target_kind or asset.
--
-- -- 4. THE KILL SWITCH LEARNS THE ASSET -------------------------------------
--
-- ca_payout_freeze.scope was CHECK (scope = 'tournament_payouts'). It gains
-- diamond_issuance, diamond_tournament_payouts and arena_withdrawals, and
-- fn_ca_open_payout_freeze accepts them. VERIFIED against the live body before
-- writing: fn_settle_tournament_obligation reads
-- "f.scope = 'tournament_payouts' AND f.cleared_at IS NULL" and nothing else,
-- so a row in any new scope cannot refuse a chip payout. Nothing consults the
-- three new scopes yet: they are the names Lanes B, D and H will read. The
-- table stays empty and human-only.
--
-- -- 5. THE DEAD STORES (DR10, the delete list) ------------------------------
--
-- Nothing is dropped. The standard's delete list is gated on seven days of
-- zero use and the gate has not run, so this file only publishes the evidence:
-- ca_diamond_dead_store_writes joins pg_stat_user_tables to what was measured
-- by hand tonight, so the same query answers the gate in seven days.
--
-- -- WHAT IS NOT HERE --------------------------------------------------------
--
-- No automatic freeze opener. No DROP of any dead store. No refusal anywhere.
-- The money-path trigger on profiles.diamonds is Lane C's; the audit half of
-- DR6 is this lane's second migration, which owns the profiles trigger alone.
--
-- DDL: one transaction, applied once. No hot table is touched: two CHECK
-- constraints and one column on two empty tables, three functions, one view,
-- one cron job.

BEGIN;

SET LOCAL lock_timeout = '4s';

-- ---------------------------------------------------------------------------
-- 1. Four eyes learns the asset (DR13)
-- ---------------------------------------------------------------------------

ALTER TABLE public.ca_manual_adjustments
  ADD COLUMN asset text NOT NULL DEFAULT 'chips';

ALTER TABLE public.ca_manual_adjustments
  ADD CONSTRAINT ca_manual_adjustments_asset_check
  CHECK (asset IN ('chips', 'diamonds'));

ALTER TABLE public.ca_manual_adjustments
  DROP CONSTRAINT ca_manual_adjustments_target_kind_check;

ALTER TABLE public.ca_manual_adjustments
  ADD CONSTRAINT ca_manual_adjustments_target_kind_check
  CHECK (target_kind IN ('player_wallet', 'promo_wallet', 'club_treasury', 'union_bank',
                         'union_wallet', 'agent_wallet', 'club_wallet', 'bbj_pool',
                         'spin_reserve', 'prize_liability', 'bounty_liability',
                         'diamond_wallet', 'diamond_house'));

-- The asset and the target kind cannot disagree: a diamond adjustment against
-- a chip account, or a chip adjustment against the diamond house, is the shape
-- of the mistake four eyes exists to catch.
ALTER TABLE public.ca_manual_adjustments
  ADD CONSTRAINT ca_manual_adjustments_asset_matches_target
  CHECK ((asset = 'diamonds') = (target_kind IN ('diamond_wallet', 'diamond_house')));

COMMENT ON COLUMN public.ca_manual_adjustments.asset IS
  'DR13: which asset this manual movement is denominated in. Defaults to chips so every '
  'proposal written before 2026-09-03 reads correctly. diamond_wallet and diamond_house are '
  'the only diamond target kinds and the asset_matches_target CHECK keeps the two in step.';

-- fn_ca_propose_manual_adjustment carried its own copy of the target_kind list
-- and no asset. Replaced with the same body plus p_asset; the 7-argument form
-- is dropped so there is no overload for a named-argument call to be ambiguous
-- between. Every positional and named call that worked before still works:
-- p_asset defaults to NULL, which derives the asset from the target kind.
--
-- ROLLBACK for this statement: re-create the 7-argument function from
-- supabase/migrations/20260902203000_chip_std_controls.sql verbatim and drop
-- the 8-argument one. No row depends on either: ca_manual_adjustments held 0
-- rows when this was written and no database function and no repo file calls
-- fn_ca_propose_manual_adjustment (verified by pg_proc.prosrc scan and grep).
DROP FUNCTION IF EXISTS public.fn_ca_propose_manual_adjustment(text, numeric, text, uuid, uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.fn_ca_propose_manual_adjustment(
  p_reason        text,
  p_amount        numeric,
  p_target_kind   text,
  p_target_id     uuid    DEFAULT NULL,
  p_tournament_id uuid    DEFAULT NULL,
  p_actor         uuid    DEFAULT NULL,
  p_actor_label   text    DEFAULT NULL,
  p_asset         text    DEFAULT NULL
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
  v_kind  text := lower(btrim(COALESCE(p_target_kind, '')));
  v_asset text;
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
  IF v_kind NOT IN
     ('player_wallet','promo_wallet','club_treasury','union_bank','union_wallet','agent_wallet',
      'club_wallet','bbj_pool','spin_reserve','prize_liability','bounty_liability',
      'diamond_wallet','diamond_house') THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'unknown_target_kind');
  END IF;

  -- The target kind decides the asset. p_asset is accepted so a caller can say
  -- it out loud, and it is compared, never trusted.
  v_asset := CASE WHEN v_kind IN ('diamond_wallet','diamond_house') THEN 'diamonds' ELSE 'chips' END;
  IF NULLIF(btrim(COALESCE(p_asset, '')), '') IS NOT NULL
     AND lower(btrim(p_asset)) <> v_asset THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'asset_does_not_match_target_kind',
      'asset_for_target_kind', v_asset, 'asset_supplied', lower(btrim(p_asset)));
  END IF;
  IF v_asset = 'diamonds' AND round(p_amount, 2) <> round(p_amount, 0) THEN
    RETURN jsonb_build_object('ok', false, 'refused_reason', 'diamonds_are_whole_numbers');
  END IF;

  INSERT INTO public.ca_manual_adjustments
    (actor, actor_label, reason, amount, target_kind, target_id, tournament_id, asset)
  VALUES (v_actor, v_label, btrim(p_reason), round(p_amount, 2), v_kind, p_target_id,
          p_tournament_id, v_asset)
  RETURNING * INTO v_row;

  PERFORM public.fn_raise_server_financial_alert(
    'info', 'ca_manual_adjustments',
    format('Manual adjustment PROPOSED by %s: %s %s to %s (%s)',
           v_label, v_row.amount, v_asset, v_kind, btrim(p_reason)),
    jsonb_build_object('adjustment_id', v_row.id, 'actor', v_actor, 'actor_label', v_label,
                       'amount', v_row.amount, 'asset', v_asset, 'target_kind', v_kind,
                       'target_id', p_target_id, 'tournament_id', p_tournament_id),
    'adj:' || v_row.id::text);

  RETURN jsonb_build_object('ok', true, 'adjustment_id', v_row.id, 'status', v_row.status,
    'actor', v_actor, 'amount', v_row.amount, 'asset', v_asset, 'target_kind', v_kind);
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_propose_manual_adjustment(text, numeric, text, uuid, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_propose_manual_adjustment(text, numeric, text, uuid, uuid, uuid, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. The kill switch learns the asset
-- ---------------------------------------------------------------------------

ALTER TABLE public.ca_payout_freeze
  DROP CONSTRAINT ca_payout_freeze_scope_check;

ALTER TABLE public.ca_payout_freeze
  ADD CONSTRAINT ca_payout_freeze_scope_check
  CHECK (scope IN ('tournament_payouts',
                   'diamond_issuance',
                   'diamond_tournament_payouts',
                   'arena_withdrawals'));

COMMENT ON COLUMN public.ca_payout_freeze.scope IS
  'What an open row refuses. tournament_payouts is read by fn_settle_tournament_obligation '
  'and is the only scope any function consults today. diamond_issuance, '
  'diamond_tournament_payouts and arena_withdrawals are the names standard 3.4 layer 6 '
  'reserves for the diamond paths; the readers arrive with Lanes B, D and H. A row in a scope '
  'nobody reads refuses nothing.';

-- Same body as 20260902203000_chip_std_controls.sql, with the scope list
-- widened. Nothing else changes; the INSERT below is still the only INSERT
-- into ca_payout_freeze anywhere in the repo (tests/law/
-- PayoutFreezeIsHumanOnly.law.test.ts).
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
  IF v_scope NOT IN ('tournament_payouts', 'diamond_issuance',
                     'diamond_tournament_payouts', 'arena_withdrawals') THEN
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

  PERFORM public.fn_raise_server_financial_alert(
    'warning', 'ca_payout_freeze',
    format('Payouts FROZEN on scope %s by %s: %s', v_scope, v_label, btrim(p_reason)),
    jsonb_build_object('freeze_id', v_row.id, 'scope', v_scope, 'opened_by', v_uid,
                       'opened_by_label', v_label, 'opened_at', v_row.opened_at),
    'freeze:' || v_row.id::text);

  RETURN jsonb_build_object('ok', true, 'already_open', false, 'freeze_id', v_row.id,
    'scope', v_row.scope, 'opened_at', v_row.opened_at, 'opened_by', v_uid,
    'opened_by_label', v_label, 'reason', v_row.reason);
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_open_payout_freeze(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_open_payout_freeze(text, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. fn_ca_diamond_trial_balance (DR11) and its suspense row (DR12)
-- ---------------------------------------------------------------------------
--
-- Account -> what balance_now reads -> what balance_delta reads
--
--   player_diamonds      SUM(profiles.diamonds)          ca_diamond_snapshots.profile_diamonds
--   diamond_house        ca_diamond_house.balance        ca_diamond_house_ledger, when it exists
--   diamond_debts        diamond_debts unsettled         (Lane D; absent today)
--   promo_budgets_spent  diamond_reward_budgets.spent    (no history table; delta unknown)
--   mirror_mismatch      count of disagreeing mirrors    (a count, not a balance)
--   dead_stores          the five fossil stores          (informative, delete list)
--   suspense             journal rows with no counterparty since the foundation
--   total                player + house + debts          the sum of its own balance rows
--
-- total is computed as the SUM OF THE ROWS THIS CALL JUST RETURNED, never from
-- a stored total column. ca_supply_snapshots.total was re-based on 2026-09-01
-- and the chip trial balance read that re-basing as a 4,364,262.71 mint
-- (20260902204500_chip_std_controls_total_is_the_sum_of_its_rows.sql).
-- ca_diamond_snapshots.total has the same defect today for a different reason
-- (it adds the mirrors to the canonical store). Neither is read here.

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_trial_balance(
  p_since timestamptz DEFAULT now() - interval '75 minutes'
)
RETURNS TABLE (
  account        text,
  balance_now    numeric,
  balance_delta  numeric,
  journal_net    numeric,
  mint_net       numeric,
  difference     numeric,
  note           text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  -- 2026-09-03 00:07 UTC: the moment 20260903000735_diamond_std_foundation
  -- added diamond_transactions.counterparty. Every row older than that has a
  -- NULL counterparty because the column did not exist, not because a writer
  -- failed to name one, so the suspense row starts here.
  c_foundation constant timestamptz := timestamptz '2026-09-03 00:07:00+00';
  v_since      timestamptz := COALESCE(p_since, now() - interval '75 minutes');
  s0           public.ca_diamond_snapshots%ROWTYPE;
  v_now        numeric;
  v_delta      numeric;
  v_jrn        numeric;
  v_mint       numeric;
  v_note       text;
  v_n          bigint;
  v_missing    bigint;
  v_sub        numeric;
  v_tot_now    numeric := 0;
  v_tot_delta  numeric := 0;
  v_tot_jrn    numeric := 0;
  v_tot_mint   numeric := 0;
  v_tot_parts  text    := '';
  r            record;
BEGIN
  SELECT * INTO s0 FROM public.ca_diamond_snapshots
   WHERE taken_at >= v_since
   ORDER BY taken_at ASC LIMIT 1;

  -- player_diamonds: the canonical store
  BEGIN
    SELECT COALESCE(SUM(COALESCE(p.diamonds, 0)), 0)::numeric INTO v_now FROM public.profiles p;
    IF s0.id IS NULL THEN
      v_delta := NULL;
      v_note  := 'no diamond snapshot at or after the window start, so the delta is unknown';
    ELSE
      v_delta := v_now - s0.profile_diamonds;
      v_note  := 'delta measured against ca_diamond_snapshots.profile_diamonds at '
              || to_char(s0.taken_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') || ' UTC';
    END IF;
    SELECT COALESCE(SUM(dt.amount), 0)::numeric INTO v_jrn
      FROM public.diamond_transactions dt WHERE dt.created_at >= v_since;
    SELECT COALESCE(SUM(CASE WHEN ml.action = 'mint' THEN ml.amount ELSE -ml.amount END), 0)::numeric
      INTO v_mint FROM public.ca_mint_ledger ml
     WHERE ml.asset = 'diamonds' AND ml.holder_type = 'player' AND ml.created_at >= v_since;

    v_tot_now   := v_tot_now + v_now;
    v_tot_delta := v_tot_delta + COALESCE(v_delta, 0);
    v_tot_jrn   := v_tot_jrn + v_jrn;
    v_tot_mint  := v_tot_mint + v_mint;
    v_tot_parts := v_tot_parts || 'player_diamonds';

    RETURN QUERY SELECT
      'player_diamonds'::text, v_now, v_delta, v_jrn, v_mint,
      CASE WHEN v_delta IS NULL THEN NULL ELSE v_delta - v_jrn END,
      v_note || '. The journal is ONE SIDED until DR3 is enforced: journal_net is what the '
             || 'writers declared, not a double entry, so the difference measures undeclared '
             || 'movement. mint_net is the ledgered issuance for the same window and is '
             || 'informative beside it, not subtracted. Journal rows the certification '
             || 'cleanup deleted inside the window are gone from journal_net and read as a '
             || 'difference.';
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    RETURN QUERY SELECT 'player_diamonds'::text, NULL::numeric, NULL::numeric, NULL::numeric,
                        NULL::numeric, NULL::numeric, 'table absent'::text;
  END;

  -- diamond_house
  BEGIN
    IF to_regclass('public.ca_diamond_house') IS NULL THEN
      RETURN QUERY SELECT 'diamond_house'::text, NULL::numeric, NULL::numeric, NULL::numeric,
                          NULL::numeric, NULL::numeric, 'table absent'::text;
    ELSE
      SELECT COALESCE(SUM(h.balance), 0)::numeric INTO v_now FROM public.ca_diamond_house h;
      v_delta := NULL;
      v_note  := 'no ca_diamond_house_ledger exists yet, so the delta is unknown; the house '
              || 'account is funded and drained by Lanes B and H';
      IF to_regclass('public.ca_diamond_house_ledger') IS NOT NULL THEN
        BEGIN
          EXECUTE 'SELECT COALESCE(SUM(amount), 0)::numeric FROM public.ca_diamond_house_ledger '
               || 'WHERE created_at >= $1' INTO v_delta USING v_since;
          v_note := 'delta from ca_diamond_house_ledger';
        EXCEPTION WHEN OTHERS THEN
          v_delta := NULL;
          v_note  := 'ca_diamond_house_ledger exists but does not expose (created_at, amount)';
        END;
      END IF;
      SELECT COALESCE(SUM(CASE WHEN ml.action = 'mint' THEN ml.amount ELSE -ml.amount END), 0)::numeric
        INTO v_mint FROM public.ca_mint_ledger ml
       WHERE ml.asset = 'diamonds' AND ml.holder_type = 'house' AND ml.created_at >= v_since;

      v_tot_now   := v_tot_now + v_now;
      v_tot_delta := v_tot_delta + COALESCE(v_delta, 0);
      v_tot_mint  := v_tot_mint + v_mint;
      v_tot_parts := v_tot_parts || ' + diamond_house';

      RETURN QUERY SELECT 'diamond_house'::text, v_now, v_delta, NULL::numeric, v_mint,
        CASE WHEN v_delta IS NULL THEN NULL ELSE v_delta - v_mint END,
        v_note || '. DR14: what leaves a player and reaches no player belongs here, so a rake, '
               || 'fee, cut or forfeit that shows up nowhere is a break on this row.';
    END IF;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    RETURN QUERY SELECT 'diamond_house'::text, NULL::numeric, NULL::numeric, NULL::numeric,
                        NULL::numeric, NULL::numeric, 'table absent'::text;
  END;

  -- diamond_debts (Lane D)
  BEGIN
    IF to_regclass('public.diamond_debts') IS NULL THEN
      RETURN QUERY SELECT 'diamond_debts'::text, NULL::numeric, NULL::numeric, NULL::numeric,
                          NULL::numeric, NULL::numeric, 'table absent'::text;
    ELSE
      EXECUTE 'SELECT COALESCE(SUM(amount), 0)::numeric FROM public.diamond_debts '
           || 'WHERE settled_at IS NULL' INTO v_now;
      v_tot_now   := v_tot_now + v_now;
      v_tot_parts := v_tot_parts || ' + diamond_debts';
      RETURN QUERY SELECT 'diamond_debts'::text, v_now, NULL::numeric, NULL::numeric,
                          NULL::numeric, NULL::numeric,
                          'unsettled chargeback receivable (DR1). A balance is never negative; '
                          'the remainder lands here and the next credit settles it.'::text;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT 'diamond_debts'::text, NULL::numeric, NULL::numeric, NULL::numeric,
                        NULL::numeric, NULL::numeric, 'table absent'::text;
  END;

  -- promo_budgets_spent (DR7)
  BEGIN
    IF to_regclass('public.diamond_reward_budgets') IS NULL THEN
      RETURN QUERY SELECT 'promo_budgets_spent'::text, NULL::numeric, NULL::numeric,
                          NULL::numeric, NULL::numeric, NULL::numeric, 'table absent'::text;
    ELSE
      SELECT COALESCE(SUM(b.spent_diamonds), 0)::numeric,
             COALESCE(SUM(b.budget_diamonds), 0)::numeric,
             count(*)
        INTO v_now, v_sub, v_n
        FROM public.diamond_reward_budgets b;
      RETURN QUERY SELECT 'promo_budgets_spent'::text, v_now, NULL::numeric, NULL::numeric,
                          NULL::numeric, NULL::numeric,
        format('%s budget lines, %s diamonds budgeted, %s spent. A counter, not a balance: '
               'there is no history table, so the delta is unknown. It is here because '
               'DR7 makes every promotional issuance draw from one of these lines.',
               v_n, v_sub, v_now);
    END IF;
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    RETURN QUERY SELECT 'promo_budgets_spent'::text, NULL::numeric, NULL::numeric, NULL::numeric,
                        NULL::numeric, NULL::numeric, 'table absent'::text;
  END;

  -- mirror_mismatch (DR10)
  v_now  := 0;
  v_note := '';
  FOR r IN SELECT * FROM (VALUES ('user_diamonds', 'balance'),
                                 ('user_diamond_balance', 'balance'),
                                 ('diamond_wallets', 'balance')) AS m(rel, col)
  LOOP
    BEGIN
      IF to_regclass('public.' || r.rel) IS NULL THEN
        v_note := v_note || r.rel || ': absent. ';
      ELSE
        EXECUTE format('SELECT count(*) FROM public.profiles p JOIN public.%I m ON m.user_id = p.id '
                       'WHERE COALESCE(m.%I, 0) <> COALESCE(p.diamonds, 0)', r.rel, r.col)
          INTO v_n;
        EXECUTE format('SELECT count(*) FROM public.profiles p WHERE NOT EXISTS '
                       '(SELECT 1 FROM public.%I m WHERE m.user_id = p.id)', r.rel)
          INTO v_missing;
        v_now  := v_now + v_n;
        v_note := v_note || format('%s: %s rows disagree, %s profiles have no row. ',
                                   r.rel, v_n, v_missing);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_note := v_note || r.rel || ': unreadable. ';
    END;
  END LOOP;
  RETURN QUERY SELECT 'mirror_mismatch'::text, v_now, NULL::numeric, NULL::numeric, NULL::numeric,
                      NULL::numeric,
    v_note || 'balance_now is a COUNT of disagreeing rows, not diamonds. A profile with no '
           || 'mirror row is counted in the note, not the number: the mirror trigger UPDATEs '
           || 'diamond_wallets without an upsert, so a profile that never had a row can never '
           || 'get one (audit lane 1, defect 2a).';

  -- dead_stores (DR10, the delete list)
  v_now  := 0;
  v_note := '';
  FOR r IN SELECT * FROM (VALUES ('user_progress', 'diamonds'),
                                 ('bot_profiles', 'diamonds'),
                                 ('club_members', 'diamonds'),
                                 ('club_memberships', 'diamonds'),
                                 ('club_diamond_wallets', 'balance')) AS m(rel, col)
  LOOP
    BEGIN
      IF to_regclass('public.' || r.rel) IS NULL THEN
        v_note := v_note || r.rel || ': absent. ';
      ELSE
        EXECUTE format('SELECT COALESCE(SUM(COALESCE(%I, 0)), 0)::numeric FROM public.%I',
                       r.col, r.rel) INTO v_sub;
        v_now  := v_now + v_sub;
        v_note := v_note || format('%s.%s = %s. ', r.rel, r.col, v_sub);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_note := v_note || r.rel || ': unreadable. ';
    END;
  END LOOP;
  RETURN QUERY SELECT 'dead_stores'::text, v_now, NULL::numeric, NULL::numeric, NULL::numeric,
                      NULL::numeric,
    v_note || 'Informative and deliberately OUTSIDE the total: none of these is the canonical '
           || 'store and none of them is spendable. They are the delete list in standard '
           || 'section 5 Lane G, gated on seven days of zero writes; '
           || 'ca_diamond_dead_store_writes is the gate.';

  -- suspense (DR12)
  BEGIN
    SELECT COALESCE(SUM(dt.amount), 0)::numeric, count(*)
      INTO v_now, v_n
      FROM public.diamond_transactions dt
     WHERE dt.created_at >= GREATEST(v_since, c_foundation)
       AND (dt.counterparty IS NULL OR dt.counterparty = 'unknown');
    RETURN QUERY SELECT 'suspense'::text, v_now, NULL::numeric, v_now, NULL::numeric, NULL::numeric,
      format('%s journal rows written since the counterparty column existed (2026-09-03 '
             '00:07 UTC) name no counterparty. DR12: this must be zero. Rows older than '
             'that are excluded because the column did not exist, not because a writer '
             'failed to name a side.', v_n);
  EXCEPTION WHEN undefined_table OR undefined_column THEN
    RETURN QUERY SELECT 'suspense'::text, NULL::numeric, NULL::numeric, NULL::numeric,
                        NULL::numeric, NULL::numeric, 'table absent'::text;
  END;

  -- total
  RETURN QUERY SELECT 'total'::text, v_tot_now,
    CASE WHEN s0.id IS NULL THEN NULL ELSE v_tot_delta END,
    v_tot_jrn, v_tot_mint,
    CASE WHEN s0.id IS NULL THEN NULL ELSE v_tot_delta - v_tot_jrn END,
    'the sum of the BALANCE rows above (' || COALESCE(NULLIF(v_tot_parts, ''), 'none') || '), '
    || 'computed from the rows this call just returned and never from a stored total column. '
    || 'mirror_mismatch is a count, dead_stores is outside the supply, promo_budgets_spent is '
    || 'a counter and suspense is a flow, so none of the four is summed here.';
END $fn$;

REVOKE ALL ON FUNCTION public.fn_ca_diamond_trial_balance(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_trial_balance(timestamptz) TO service_role;

COMMENT ON FUNCTION public.fn_ca_diamond_trial_balance(timestamptz) IS
  'DR11: one row per diamond account with balance, delta, journal net, mint net and the '
  'difference. Reports; refuses nothing. Every account is guarded so a table another lane has '
  'not landed yields a row noted "table absent" rather than an error.';

-- ---------------------------------------------------------------------------
-- 4. The hourly watch (DR11, DR12). Log-only, and it never opens the freeze.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_trial_balance_watch()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  r        record;
  v_since  timestamptz := now() - interval '1 hour';
  v_filed  integer := 0;
  v_rows   integer := 0;
  v_broken text := '';
BEGIN
  FOR r IN SELECT * FROM public.fn_ca_diamond_trial_balance(v_since) LOOP
    v_rows := v_rows + 1;

    IF r.account <> 'total' AND r.difference IS NOT NULL AND abs(r.difference) > 0 THEN
      PERFORM public.fn_ca_diamond_incident(
        'DR11:trial_balance_break', 'warning', NULL, r.difference, r.account,
        jsonb_build_object('account', r.account, 'balance_now', r.balance_now,
                           'balance_delta', r.balance_delta, 'journal_net', r.journal_net,
                           'mint_net', r.mint_net, 'difference', r.difference,
                           'window_start', v_since, 'note', r.note));
      v_filed  := v_filed + 1;
      v_broken := v_broken || r.account || ' ';
    END IF;

    IF r.account = 'suspense' AND COALESCE(r.balance_now, 0) <> 0 THEN
      PERFORM public.fn_ca_diamond_incident(
        'DR12:suspense_nonzero', 'info', NULL, r.balance_now,
        'fn_ca_diamond_trial_balance_watch',
        jsonb_build_object('suspense', r.balance_now, 'window_start', v_since, 'note', r.note));
      v_filed := v_filed + 1;
    END IF;
  END LOOP;

  PERFORM public.fn_ca_diamond_incident(
    'DR11:trial_balance_summary', 'info', NULL, NULL, 'fn_ca_diamond_trial_balance_watch',
    jsonb_build_object('accounts_reported', v_rows, 'incidents_filed', v_filed,
                       'accounts_broken', NULLIF(btrim(v_broken), ''),
                       'window_start', v_since, 'window_end', now()));
  RETURN v_filed;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_ca_diamond_trial_balance_watch failed: %', SQLERRM;
  RETURN -1;
END $fn$;

REVOKE ALL ON FUNCTION public.fn_ca_diamond_trial_balance_watch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_trial_balance_watch() TO service_role;

COMMENT ON FUNCTION public.fn_ca_diamond_trial_balance_watch() IS
  'Hourly at minute 20. Files DR11:trial_balance_break (warning) per account with a non-zero '
  'difference, DR12:suspense_nonzero (info) when suspense is non-zero, and one '
  'DR11:trial_balance_summary (info) per run. Writes nothing but incidents and NEVER opens '
  'ca_payout_freeze: the threshold is Dan (standard 6.13) and an automatic opener is the '
  'mechanism that refuses a legitimate movement on a false alarm.';

SELECT cron.unschedule('ca-diamond-trial-balance-hourly')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-diamond-trial-balance-hourly');

SELECT cron.schedule(
  'ca-diamond-trial-balance-hourly',
  '20 * * * *',
  $cron$SELECT CASE WHEN pg_try_advisory_lock(hashtext('ca-diamond-trial-balance'))
      THEN public.fn_ca_diamond_trial_balance_watch()
      ELSE NULL END$cron$
);

-- ---------------------------------------------------------------------------
-- 5. ca_diamond_dead_store_writes: the seven-day gate, as a view
-- ---------------------------------------------------------------------------
--
-- Measured 2026-09-03 00:20 UTC, in the same pg_stat window in which profiles
-- took 267 updates and club_members took 20,566: every store below shows 0
-- inserts, 0 updates and 0 deletes. pg_stat_database.stats_reset is NULL on
-- this database, so the counters run from an unrecorded reset and the
-- comparison is RELATIVE, which is what the gate needs: a store nothing writes
-- while the live tables take twenty thousand writes is a store nothing writes.

CREATE VIEW public.ca_diamond_dead_store_writes
WITH (security_invoker = true) AS
SELECT d.store,
       d.dead_column,
       d.holdings_at_2026_09_03,
       COALESCE(s.n_tup_ins, 0)                                                       AS n_tup_ins,
       COALESCE(s.n_tup_upd, 0)                                                       AS n_tup_upd,
       COALESCE(s.n_tup_del, 0)                                                       AS n_tup_del,
       COALESCE(s.n_tup_ins, 0) + COALESCE(s.n_tup_upd, 0) + COALESCE(s.n_tup_del, 0) AS writes,
       s.last_autoanalyze,
       s.last_autovacuum,
       d.writer_evidence
  FROM (VALUES
    ('diamond_ledger', '(the whole table)', '0 rows all time',
     'One function names it, complete_daily_challenge, which is EXECUTE-granted to postgres and service_role only. The live daily-challenge path is claim_daily_challenge(s), which journals to diamond_transactions.'),
    ('user_progress', 'diamonds', '107 rows, 10,700 diamonds',
     'create_user_progress_on_signup is the only writer and is attached to NO trigger (pg_trigger scan, 2026-09-03). A fossil of the pre-profiles balance.'),
    ('bot_profiles', 'diamonds', '100 rows, 26,541 diamonds',
     'No function in the database inserts, updates or deletes this relation.'),
    ('club_members', 'diamonds', '0 diamonds across 1,935 rows',
     'No function writes club_members.diamonds. Two bodies match a naive club_members-near-set-diamonds scan (fn_atomic_buyin, fn_union_send_to_member_zd3core) and BOTH write profiles.diamonds; the column is a false positive. club_members.chip_balance is written constantly and is not this column.'),
    ('club_memberships', 'diamonds', '0 diamonds',
     'No function in the database names this relation at all.'),
    ('club_diamond_wallets', 'balance', '2 rows, 0.00',
     'One function names it (ca_promo_vault_buy). Both rows have held 0.00 since creation.')
  ) AS d(store, dead_column, holdings_at_2026_09_03, writer_evidence)
  LEFT JOIN pg_stat_user_tables s
         ON s.schemaname = 'public' AND s.relname = d.store;

COMMENT ON VIEW public.ca_diamond_dead_store_writes IS
  'DR10 delete-list evidence for standard section 5 Lane G. Nothing is dropped: the delete '
  'list is gated on seven days of zero writes and this view is the gate. writes > 0 on any '
  'row means that store is NOT dead and the row must be re-investigated before anyone drops '
  'anything. Read it beside the dead_stores row of fn_ca_diamond_trial_balance.';

REVOKE ALL ON public.ca_diamond_dead_store_writes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ca_diamond_dead_store_writes TO service_role;

-- ---------------------------------------------------------------------------
-- Post-apply assertions
-- ---------------------------------------------------------------------------
DO $assert$
DECLARE
  v_n   integer;
  v_def text;
BEGIN
  -- The trial balance returns a total row, and eight rows in all.
  SELECT count(*) INTO v_n
    FROM public.fn_ca_diamond_trial_balance(now() - interval '24 hours')
   WHERE account = 'total';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'fn_ca_diamond_trial_balance returned % total rows, expected 1', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.fn_ca_diamond_trial_balance(now() - interval '24 hours');
  IF v_n <> 8 THEN
    RAISE EXCEPTION 'fn_ca_diamond_trial_balance returned % rows, expected 8', v_n;
  END IF;

  -- The cron job exists exactly once.
  SELECT count(*) INTO v_n FROM cron.job WHERE jobname = 'ca-diamond-trial-balance-hourly';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'ca-diamond-trial-balance-hourly not scheduled exactly once (%)', v_n;
  END IF;

  -- Four eyes has the asset column and its CHECK.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'ca_manual_adjustments'
                    AND column_name = 'asset') THEN
    RAISE EXCEPTION 'ca_manual_adjustments.asset missing';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conname = 'ca_manual_adjustments_asset_check';
  IF v_def IS NULL OR v_def NOT LIKE '%diamonds%' THEN
    RAISE EXCEPTION 'ca_manual_adjustments_asset_check does not accept diamonds: %', v_def;
  END IF;
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conname = 'ca_manual_adjustments_target_kind_check';
  IF v_def IS NULL OR v_def NOT LIKE '%diamond_house%' OR v_def NOT LIKE '%diamond_wallet%' THEN
    RAISE EXCEPTION 'target_kind CHECK does not accept the diamond accounts: %', v_def;
  END IF;

  -- The kill switch accepts the three new scopes. Read from the constraint,
  -- never by inserting a row: tests/law/PayoutFreezeIsHumanOnly.law.test.ts
  -- forbids writing a row into ca_payout_freeze anywhere outside the human
  -- opener, and a rolled-back probe row would still be such a write in this
  -- file. (This comment is worded around the phrase that law greps for; the
  -- applied migration record carries the earlier wording, which is why the
  -- repo file and supabase_migrations differ by these three comment lines and
  -- by nothing else. No DDL differs.)
  SELECT pg_get_constraintdef(oid) INTO v_def FROM pg_constraint
   WHERE conname = 'ca_payout_freeze_scope_check';
  IF v_def IS NULL
     OR v_def NOT LIKE '%diamond_issuance%'
     OR v_def NOT LIKE '%diamond_tournament_payouts%'
     OR v_def NOT LIKE '%arena_withdrawals%'
     OR v_def NOT LIKE '%tournament_payouts%' THEN
    RAISE EXCEPTION 'ca_payout_freeze scope CHECK is wrong: %', v_def;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_ca_open_payout_freeze'
                   AND prosrc LIKE '%diamond_issuance%') THEN
    RAISE EXCEPTION 'fn_ca_open_payout_freeze does not accept diamond_issuance';
  END IF;

  -- The chip payout path is untouched: the settle function still consults the
  -- table, and still on the tournament_payouts scope alone.
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE proname = 'fn_settle_tournament_obligation'
                    AND prosrc LIKE '%tournament_payouts%') THEN
    RAISE EXCEPTION 'fn_settle_tournament_obligation no longer reads scope tournament_payouts';
  END IF;

  -- Exactly one propose function, and it knows the diamond accounts.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_propose_manual_adjustment';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'fn_ca_propose_manual_adjustment has % overloads, expected 1', v_n;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'fn_ca_propose_manual_adjustment'
                   AND prosrc LIKE '%diamond_house%') THEN
    RAISE EXCEPTION 'fn_ca_propose_manual_adjustment does not accept diamond_house';
  END IF;

  -- The register and the switch are still empty.
  SELECT count(*) INTO v_n FROM public.ca_manual_adjustments;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'ca_manual_adjustments is no longer empty (% rows)', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.ca_payout_freeze;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'ca_payout_freeze is no longer empty (% rows)', v_n;
  END IF;

  -- The gate view reads.
  SELECT count(*) INTO v_n FROM public.ca_diamond_dead_store_writes;
  IF v_n <> 6 THEN
    RAISE EXCEPTION 'ca_diamond_dead_store_writes returned % rows, expected 6', v_n;
  END IF;
END $assert$;

COMMIT;
