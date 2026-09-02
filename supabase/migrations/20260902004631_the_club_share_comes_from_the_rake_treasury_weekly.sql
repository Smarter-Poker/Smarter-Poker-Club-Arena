-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902004631; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- DAN'S RULING, 2026-09-02: "club shares come from the rake treasury, its sent
-- at the end of the week."
--
-- That settles the double-bank. atomic_distribute_rake was crediting TWO real
-- balances for one hand's rake:
--
--   club_wallets.chip_balance  += (rake - bbj)     <- a per-hand PRE-PAYMENT
--   union_wallets.rake_wallet  += rake             <- the rake treasury
--   (or clubs.chip_treasury    += rake for a club game with no union)
--
-- Under the ruling only the second is right. The rake belongs in the treasury,
-- and the club's share leaves it once a week through the settlement cascade.
-- Paying the club a slice of every pot as it happens is paying them twice:
-- once now, once on Friday.
--
-- MEASURED before the change: 3,032.55 collected against 5,770.40 distributed
-- in 90 minutes, on 1,629 of 1,692 raked hands - about 1,762 chips an hour,
-- 40,000 a day, appearing from nowhere.
--
-- TWO THINGS CHECKED BEFORE TOUCHING A LIVE MONEY PATH:
--
--   1. The weekly settlement does not use this column. fn_union_settlement_
--      cascade, fn_union_issue_weekly_invoices and fn_union_apply_
--      presettlements never reference club_wallets; the preview works from
--      rake_wallet and chip_treasury. So removing the per-hand credit takes
--      nothing away from what the club is actually paid on Friday.
--   2. Nothing live spends it. club_wallet_transactions has 46,991
--      commission_out rows but the newest is 2026-08-20 - none in thirteen
--      days, none in the last seven - so the agent-commission path has moved
--      elsewhere and is not funded from here any more.
--
-- WHAT IS KEPT. period_rake_collected, lifetime_rake_collected and the two BBJ
-- counters still accumulate on every hand, because those are the record of
-- what the club earned and the basis the weekly settlement is computed from.
-- The rake_in transaction row is still written for the same reason. Only the
-- spendable balance stops moving.
--
-- The 4,351,836 chips already sitting in club_wallets.chip_balance are left
-- alone: they are history, and Dan has ruled twice that history stays.
--
-- ROLLBACK: re-apply the two assignments below in reverse
--   UPDATE: chip_balance = chip_balance + v_net
--   INSERT VALUES: v_net in place of 0
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

-- The legacy club-side path carries the same pre-payment. It only runs for a
-- private or union-less game (it delegates union games to
-- atomic_distribute_rake), but it would re-open the same hole the moment such
-- a game ran.
DO $legacy$
DECLARE
  v_def text;
  v_old text := 'chip_balance = chip_balance + (p_rake_amount - v_bbj_amount),';
  v_new text := 'chip_balance = chip_balance,  -- 2026-09-02 ruling: club share is paid weekly from the rake treasury';
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'record_rake';

  IF v_def IS NULL THEN
    RAISE NOTICE 'record_rake not found; nothing to do';
    RETURN;
  END IF;
  IF position(v_old in v_def) = 0 THEN
    RAISE NOTICE 'record_rake does not carry the per-hand chip_balance credit in the expected form; left untouched';
    RETURN;
  END IF;

  EXECUTE replace(v_def, v_old, v_new);
END $legacy$;

