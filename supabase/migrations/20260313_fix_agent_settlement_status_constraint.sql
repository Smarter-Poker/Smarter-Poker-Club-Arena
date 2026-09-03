-- ═══════════════════════════════════════════════════════════════════════════════
-- 🔧 FIX: agent_settlements.status CHECK constraint
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- The original CHECK constraint in 006_settlement_cycle.sql only permits:
--   ('pending', 'approved', 'paid', 'disputed')
--
-- But the runtime settlement engine uses additional states:
--   'processing' — set by executeMondayPayouts when claiming a settlement
--                  (atomic claim guard: approved → processing)
--   'failed'    — set when a payout attempt fails and needs manual reconciliation
--
-- The atomic_pay_agent_settlement RPC (20260312) explicitly checks:
--   IF v_status != 'processing' AND v_status != 'approved' THEN RAISE EXCEPTION
--
-- Without this fix, the checkout-to-processing transition would trigger a
-- Postgres CHECK violation, causing every agent payout to silently fail
-- with the settlement row remaining stuck in 'approved' state forever.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Drop the old constraint
ALTER TABLE agent_settlements DROP CONSTRAINT IF EXISTS agent_settlements_status_check;

-- Re-create with all valid runtime states
ALTER TABLE agent_settlements ADD CONSTRAINT agent_settlements_status_check
  CHECK (status IN ('pending', 'approved', 'processing', 'paid', 'failed', 'disputed'));

DO $$ BEGIN RAISE NOTICE '🔧 agent_settlements status CHECK constraint updated — added processing + failed'; END $$;
