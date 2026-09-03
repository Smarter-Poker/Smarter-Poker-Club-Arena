-- ═══════════════════════════════════════════════════════════════════════════════
-- Bible V8 §1.9 (Settlement Atomicity, 15-step pipeline)
-- Phase X2 — closes P0-G8
-- Migration: 20260428000003_settlement_idempotency_keys.sql
--
-- Purpose:
--   The engine retries settlement on transient errors (DB blip, network jitter).
--   Without an idempotency key on the settlement boundary, a retry can
--   double-credit the winner or double-charge rake. This table is the
--   server-side dedupe ledger keyed by (table_id, hand_id) — the unique pair
--   the engine knows even before the Supabase RPC has run.
--
--   Distinct from public.idempotency_keys (which keys ops-API mutations by
--   client-supplied UUID). Settlement is server-initiated; the natural key
--   is the hand itself.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.settlement_idempotency_keys (
  -- Composite natural key
  table_id UUID NOT NULL,
  hand_id  UUID NOT NULL,

  -- Outcome cache (so retries return the original result rather than re-running)
  status TEXT NOT NULL DEFAULT 'in_flight'
    CHECK (status IN ('in_flight','succeeded','failed')),
  result JSONB,                          -- the full settlement payload as returned to engine
  error  TEXT,                           -- failure reason if status='failed'

  -- Diagnostics
  attempt_count INT NOT NULL DEFAULT 1,
  first_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,

  PRIMARY KEY (table_id, hand_id)
);

CREATE INDEX IF NOT EXISTS idx_settlement_idem_status_age
  ON public.settlement_idempotency_keys (status, last_attempt_at DESC)
  WHERE status = 'in_flight';

-- RLS — service-role only; never exposed to clients
ALTER TABLE public.settlement_idempotency_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role full access" ON public.settlement_idempotency_keys;
CREATE POLICY "service_role full access"
  ON public.settlement_idempotency_keys FOR ALL TO service_role
  USING (true) WITH CHECK (true);

COMMENT ON TABLE public.settlement_idempotency_keys IS
  'Per-(table,hand) settlement dedupe ledger. settleHandAtomically() RPC '
  'inserts ON CONFLICT DO NOTHING; if row already at status=succeeded it '
  'returns cached result. Closes P0-G8.';
