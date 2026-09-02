-- ═══════════════════════════════════════════════════════════════════════════
-- DAN'S RULING, 2026-09-02: "club shares come from the rake treasury, its sent
-- at the end of the week."
--
-- That settles the double-bank. atomic_distribute_rake credited TWO real
-- balances for one hand's rake:
--
--   club_wallets.chip_balance  += (rake - bbj)     <- a per-hand PRE-PAYMENT
--   union_wallets.rake_wallet  += rake             <- the rake treasury
--   (or clubs.chip_treasury    += rake, no union)
--
-- Under the ruling only the second is right. The rake belongs in the treasury
-- and the club's share leaves it once a week through the settlement cascade.
-- Paying the club a slice of every pot as it happens pays them twice: once
-- now, once on Friday.
--
-- MEASURED before: 3,032.55 collected against 5,770.40 distributed in 90
-- minutes, on 1,629 of 1,692 raked hands - ~1,762 chips an hour, ~40,000 a
-- day, appearing from nowhere.
--
-- TWO THINGS CHECKED BEFORE TOUCHING A LIVE MONEY PATH:
--   1. The weekly settlement does not use this column. fn_union_settlement_
--      cascade, fn_union_issue_weekly_invoices and fn_union_apply_
--      presettlements never reference club_wallets; the preview works from
--      rake_wallet and chip_treasury. Removing the per-hand credit takes
--      nothing away from what the club is actually paid.
--   2. Nothing live spends it. club_wallet_transactions has 46,991
--      commission_out rows but the newest is 2026-08-20 - none in thirteen
--      days - so the agent-commission path has moved elsewhere.
--
-- KEPT: period_rake_collected, lifetime_rake_collected and the BBJ counters
-- still accumulate every hand, because they are the record of what the club
-- earned and the basis the weekly settlement computes from. The rake_in
-- transaction row is still written. Only the spendable balance stops moving.
--
-- The 4,351,836 chips already in club_wallets.chip_balance are left alone:
-- history, and Dan has ruled twice that history stays.
--
-- VERIFIED on live traffic after applying: club_wallets moved 0.00 over 25
-- seconds of play while the union rake wallet took 3.35 against 4.25
-- collected. One destination, as ruled.
--
-- ROLLBACK: restore `chip_balance = chip_balance + v_net` in the UPDATE and
-- `v_net` in place of `0` in the INSERT VALUES.
-- ═══════════════════════════════════════════════════════════════════════════

DO $fix$
DECLARE
  v_def text;
  v_upd_old text := 'chip_balance              = chip_balance + v_net,';
  v_upd_new text := 'chip_balance              = chip_balance,  -- 2026-09-02 ruling: the club share is paid weekly from the rake treasury, not per hand';
  v_ins_old text := 'p_club_id, v_net, p_rake, v_bbj, p_rake, v_bbj';
  v_ins_new text := 'p_club_id, 0, p_rake, v_bbj, p_rake, v_bbj';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'atomic_distribute_rake';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'atomic_distribute_rake not found';
  END IF;
  IF position(v_upd_old in v_def) = 0 THEN
    IF position('the club share is paid weekly' in v_def) > 0 THEN
      RAISE NOTICE 'already applied; nothing to do';
      RETURN;
    END IF;
    RAISE EXCEPTION 'the club_wallets UPDATE is not where this migration expects it; read the function before re-running';
  END IF;
  IF position(v_ins_old in v_def) = 0 THEN
    RAISE EXCEPTION 'the club_wallets INSERT is not where this migration expects it; read the function before re-running';
  END IF;

  v_def := replace(v_def, v_upd_old, v_upd_new);
  v_def := replace(v_def, v_ins_old, v_ins_new);
  EXECUTE v_def;
END $fix$;
