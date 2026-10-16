-- 20261016231936_owner_moves_bbj_backup_and_promo_to_union_bank.sql
--
-- OWNER REQUEST (Dan / KingFish, 2026-10-16, verbatim): "reduce the BBJ down
-- to $7,777.77 for now, and remove 100% of the back up bbj and 75% of the
-- promo chips and send them all to the union main bank."
--
-- Scope: the Midway Union, the only active BBJ pool (bbj_pools f9806a7f...,
-- union fade0000-...0001). Three moves, all INTO union_wallets.chip_balance
-- (the "Union Bank"), all category treasury_transfer, one correlation id:
--
--  1. bbj_pools.main_balance  -> 7,777.77 exactly; everything above it moves.
--     Shape copied from the scoped launch reset's BBJ step
--     (fn_ca_launch_reset_execute, 20261013202353): declare union_bank as the
--     counterparty, let the bbj_pools journal write the bbj_pool -> union_bank
--     leg, stand the union_wallets journal down for the matching credit.
--  2. bbj_pools.backup_balance -> 0; all of it moves, same shape. Refused if
--     any parked (owed, unpaid) share sits in either bank.
--  3. union_wallets.promo_wallet -> 75% moves (rounded to the cent). Promo and
--     the bank are different ledger accounts (union_wallet vs union_bank), so
--     the one cross-account leg is written by hand and labelled on both sides,
--     the mirror of fn_spin_reserve_wallet_fund's bank -> union_wallet leg.
--     Both columns move in one UPDATE, so the Diamond reserved-cover guard
--     sees promo + bank unchanged.
--
-- Amounts are read under FOR UPDATE at apply time, not hard-coded: the main
-- bank takes contributions every hand (48,652.61 at 23:0x UTC, 48,688.53 at
-- the probe). Probed twice in self-aborting DO blocks (CLAUDE.md 11.5) with
-- SET CONSTRAINTS ALL IMMEDIATE so the commit-time ledger checks fired:
-- every check passed, fn_bbj_conservation_check healthy=true (drift -9.82,
-- unchanged), fn_union_treasury_selftest healthy with no breaches,
-- fn_bbj_promo_bank_check reconciles=true. lifetime_healthy was already false
-- before this and is context, not an alarm (see the check's own note).
--
-- Deliberately NOT tagged bbj_promo_sweep (that would read as an over-sweep in
-- fn_bbj_promo_bank_check). No function is created, so nothing new enters the
-- money RPC registry; this is one DO block, data only, no DDL reload.
--
-- Known consequences the owner accepted by asking for 100% of backup:
--  - the Mini jackpot pays from backup, so it has nothing to pay until the
--    backup bank refills from contributions;
--  - the Midway weekly horse promo (20261016132743) budgets half of the promo
--    wallet at each weekly close, so its first run (week ending Oct 19) is a
--    quarter of what it would have been.
--
-- Replay-safe: refuses if any chip_ledger row already carries this
-- operation's idempotency prefix.

BEGIN;
SET LOCAL lock_timeout = '4s';
SET LOCAL statement_timeout = '60s';

DO $rebalance$
DECLARE
 c_pool  constant uuid := 'f9806a7f-e7a2-47d2-a676-36336e3a5337';
 c_union constant uuid := 'fade0000-0000-0000-0000-000000000001';
 c_owner constant uuid := '47965354-0e56-43ef-931c-ddaab82af765'; -- KingFish, player 1
 c_op    constant text := 'owner-bbj-promo-to-union-bank-20261016';
 c_corr  constant uuid := 'b0b3d117-45d4-45c8-87d6-77f92f91a978';
 c_main_target constant numeric := 7777.77;
 pool public.bbj_pools%ROWTYPE;
 w public.union_wallets%ROWTYPE;
 d_main numeric; d_backup numeric; d_promo numeric;
 bank_after numeric; promo_after numeric;
 v_saved jsonb;
BEGIN
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'REBALANCE_PLATFORM_FROZEN'; END IF;
 IF EXISTS (SELECT 1 FROM public.chip_ledger WHERE idempotency_key LIKE c_op || ':%') THEN
  RAISE EXCEPTION 'REBALANCE_ALREADY_APPLIED';
 END IF;

 SELECT * INTO pool FROM public.bbj_pools
  WHERE id = c_pool AND union_id = c_union AND status = 'active' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'REBALANCE_POOL_NOT_FOUND'; END IF;
 SELECT * INTO w FROM public.union_wallets WHERE union_id = c_union FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'REBALANCE_UNION_WALLET_NOT_FOUND'; END IF;

 -- A parked (owed, unpaid) share must never leave its bank.
 IF public.fn_bbj_parked_reserve(pool.id, 'main') <> 0
    OR public.fn_bbj_parked_reserve(pool.id, 'backup') <> 0 THEN
  RAISE EXCEPTION 'REBALANCE_PARKED_RESERVE_PRESENT';
 END IF;

 d_main   := pool.main_balance - c_main_target;   -- everything above 7,777.77
 d_backup := pool.backup_balance;                   -- 100% of the backup bank
 d_promo  := round(w.promo_wallet * 0.75, 2);       -- 75% of the union promo wallet
 IF d_main <= 0 THEN RAISE EXCEPTION 'REBALANCE_MAIN_ALREADY_AT_OR_BELOW_TARGET %', pool.main_balance; END IF;
 IF d_backup < 0 OR d_promo < 0 THEN RAISE EXCEPTION 'REBALANCE_NEGATIVE_SOURCE'; END IF;

 -- 1. BBJ main bank -> union main bank (house precedent: the scoped launch
 --    reset's BBJ step). The bbj_pools journal writes the bbj_pool ->
 --    union_bank leg; the union_wallets side stands down for it.
 PERFORM public.fn_ca_declare_ledger('treasury_transfer', 'union_bank', c_union, NULL,
   c_op || ':bbj-main', ARRAY['union_wallets']);
 PERFORM set_config('app.ledger_correlation', c_corr::text, true);
 UPDATE public.bbj_pools SET main_balance = c_main_target WHERE id = pool.id;
 UPDATE public.union_wallets SET chip_balance = chip_balance + d_main, updated_at = now()
  WHERE union_id = c_union RETURNING chip_balance INTO bank_after;
 PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);
 INSERT INTO public.union_wallet_transactions (union_id, wallet, direction, amount, balance_after, tx_type, notes)
 VALUES (c_union, 'chip_balance', 'credit', d_main, bank_after, 'bbj_main_to_bank',
   'Owner request 2026-10-16: BBJ main bank reduced to 7,777.77, the rest to the union main bank');

 -- 2. BBJ backup bank -> union main bank, all of it.
 IF d_backup > 0 THEN
  PERFORM public.fn_ca_declare_ledger('treasury_transfer', 'union_bank', c_union, NULL,
    c_op || ':bbj-backup', ARRAY['union_wallets']);
  PERFORM set_config('app.ledger_correlation', c_corr::text, true);
  UPDATE public.bbj_pools SET backup_balance = 0 WHERE id = pool.id;
  UPDATE public.union_wallets SET chip_balance = chip_balance + d_backup, updated_at = now()
   WHERE union_id = c_union RETURNING chip_balance INTO bank_after;
  PERFORM set_config('app.ledger_autoskip_union_wallets', '', true);
  INSERT INTO public.union_wallet_transactions (union_id, wallet, direction, amount, balance_after, tx_type, notes)
  VALUES (c_union, 'chip_balance', 'credit', d_backup, bank_after, 'bbj_backup_to_bank',
    'Owner request 2026-10-16: 100% of the BBJ backup bank to the union main bank');
 END IF;

 -- 3. Union promo wallet -> union main bank, 75%. Both columns move in one
 --    statement (the reserved-cover guard sees promo+bank unchanged) and the
 --    one cross-account leg is written by hand, labelled on both sides - the
 --    mirror of fn_spin_reserve_wallet_fund's bank -> union_wallet leg.
 IF d_promo > 0 THEN
  v_saved := public.fn_ca_ledger_declaration_save(ARRAY['union_wallets']);
  PERFORM set_config('app.ledger_autoskip_union_wallets', '1', true);
  UPDATE public.union_wallets
     SET promo_wallet = promo_wallet - d_promo, chip_balance = chip_balance + d_promo, updated_at = now()
   WHERE union_id = c_union RETURNING promo_wallet, chip_balance INTO promo_after, bank_after;
  INSERT INTO public.chip_ledger
    (performed_by, from_type, from_entity_id, from_label, to_type, to_entity_id, to_label,
     amount, category, union_id, description, idempotency_key, correlation_id)
  VALUES (c_owner, 'union_wallet', c_union, 'union_wallets.promo_wallet',
          'union_bank', c_union, 'union_wallets.chip_balance',
          d_promo, 'treasury_transfer', c_union,
          'Owner request 2026-10-16: 75% of the union promo wallet to the union main bank',
          c_op || ':promo', c_corr);
  PERFORM public.fn_ca_ledger_declaration_restore(v_saved);
  INSERT INTO public.union_wallet_transactions (union_id, wallet, direction, amount, balance_after, tx_type, notes)
  VALUES (c_union, 'promo_wallet', 'debit', d_promo, promo_after, 'promo_to_bank',
    'Owner request 2026-10-16: 75% of the union promo wallet to the union main bank'),
         (c_union, 'chip_balance', 'credit', d_promo, bank_after, 'promo_to_bank',
    'Owner request 2026-10-16: 75% of the union promo wallet to the union main bank');
 END IF;

 -- Postconditions, against the numbers read under lock above.
 IF NOT EXISTS (SELECT 1 FROM public.bbj_pools WHERE id = pool.id
   AND main_balance = c_main_target AND backup_balance = 0 AND promo_balance = pool.promo_balance) THEN
  RAISE EXCEPTION 'REBALANCE_POOL_POSTCONDITION_FAILED';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.union_wallets WHERE union_id = c_union
   AND chip_balance = w.chip_balance + d_main + d_backup + d_promo
   AND promo_wallet = w.promo_wallet - d_promo
   AND rake_wallet IS NOT DISTINCT FROM w.rake_wallet
   AND bbj_wallet IS NOT DISTINCT FROM w.bbj_wallet) THEN
  RAISE EXCEPTION 'REBALANCE_WALLET_POSTCONDITION_FAILED';
 END IF;

 -- Fire the commit-time ledger checks now, inside this transaction.
 SET CONSTRAINTS ALL IMMEDIATE;

 RAISE NOTICE 'OWNER_REBALANCE_APPLIED %', jsonb_build_object(
   'main_before', pool.main_balance, 'main_after', c_main_target, 'main_to_bank', d_main,
   'backup_before', pool.backup_balance, 'backup_to_bank', d_backup,
   'promo_before', w.promo_wallet, 'promo_to_bank', d_promo, 'promo_after', w.promo_wallet - d_promo,
   'bank_before', w.chip_balance, 'bank_after', w.chip_balance + d_main + d_backup + d_promo);
END $rebalance$;

COMMIT;
