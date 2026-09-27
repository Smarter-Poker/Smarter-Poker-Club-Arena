-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260503235554 "x223_legacy_seed_reconcile_backfill_34_pre_bible_v8_wallets"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 0c435a752d8bb2ae67edc85a3de4eede of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- x223 — One-time OPENING_BALANCE backfill for 34 pre-Bible-V8 test wallets.
--
-- Problem (Phase L finding): 34 player wallets have wallets.balance >
-- chip_ledger sum (net +$2.27M drift). Drifts come from pre-Bible-V8
-- direct-SQL chip grants that bypassed the ledger. All 34 are dormant
-- test accounts (33 dormant 30+d, 23 created 60+d ago).
--
-- Fix: insert ONE chip_ledger row per drifted user that closes the gap.
-- Uses the same pattern Dan (daniel@smarter.poker) has used 586 times
-- before for legacy_seed_reconcile entries: from_type='system_mint' →
-- to_type='player_wallet' for credits, or reverse for debits.
--
-- After this runs, reconcile_ledger_nightly() should report
-- critical_count=0 (or near zero, depending on race-window writes).

WITH drifts AS (
  SELECT entity_id::uuid AS user_id,
         (stored_balance - ledger_balance) AS gap
  FROM public.ledger_reconcile_log
  WHERE run_date = CURRENT_DATE
    AND severity = 'critical'
    AND entity_type = 'player_wallet'
)
INSERT INTO public.chip_ledger
  (performed_by,
   from_type, from_entity_id, from_label,
   to_type,   to_entity_id,   to_label,
   amount, category, description, notes, created_at)
SELECT
  '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid,  -- daniel@smarter.poker, established system actor
  CASE WHEN gap > 0 THEN 'system_mint'    ELSE 'player_wallet' END,
  CASE WHEN gap > 0 THEN NULL             ELSE user_id END,
  'Pre-Bible-V8 epoch backfill',
  CASE WHEN gap > 0 THEN 'player_wallet'  ELSE 'system_burn' END,
  CASE WHEN gap > 0 THEN user_id          ELSE NULL END,
  'Pre-Bible-V8 epoch backfill',
  ABS(gap),
  'legacy_seed_reconcile',
  'x223 — pre-Bible-V8 wallet/ledger gap closeout',
  'Migration x223 applied 2026-05-03. Closes pre-Bible-V8 era drift between wallets.balance and chip_ledger sum so reconcile starts from clean state. See AG-PROMPT-OR-DAN-DECISION-pre-launch-ledger-cleanup.md.',
  now()
FROM drifts;

-- Re-run reconcile to verify the gap is closed
SELECT * FROM public.reconcile_ledger_nightly();
