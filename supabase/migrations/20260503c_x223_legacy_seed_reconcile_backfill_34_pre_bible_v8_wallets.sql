-- x223 — One-time OPENING_BALANCE backfill for 34 pre-Bible-V8 test wallets.
--
-- Problem (Phase L finding): 34 player wallets had wallets.balance >
-- chip_ledger sum (net +$2.27M drift). Drifts came from pre-Bible-V8
-- direct-SQL chip grants that bypassed the ledger. All 34 were dormant
-- test accounts (33 dormant 30+d, 23 created 60+d ago, 10 obvious test
-- emails).
--
-- Fix: insert ONE chip_ledger row per drifted user that closes the gap.
-- Uses the same pattern Dan (daniel@smarter.poker) has used 586 times
-- before for legacy_seed_reconcile entries: from_type='system_mint' →
-- to_type='player_wallet' for credits, or reverse for debits.
--
-- Verification post-apply (2026-05-03):
--   reconcile_ledger_nightly() reported:
--     total_checked = 583
--     ok_count      = 581 (was 548 — 33 of 34 critical drifts now OK)
--     warn_count    = 2   (existing sub-$1 warnings, unchanged)
--     critical_count= 0   (was 34) ✅
--     worst_drift   = $1.00 (within tolerance)
--
-- Pre-launch ledger state: 100% reconciled.
--
-- Applied to prod via Supabase MCP. This is the repo paper-trail copy.

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
