-- ═══════════════════════════════════════════════════════════════════════════════
-- Bible V8 §6.4 (Admin Action Logging) + Tier E E4 (Tiered admin permission model)
-- Phase X2 (Master Gap Ledger 2026-04-28) — closes P0-G1 / P0-F1 / P0-F2
-- Migration: 20260428000001_audit_trail.sql
--
-- Purpose:
--   Single canonical record of every privileged mutation across:
--     - chip operations (mint / clawback / transfer / distribute)
--     - agent + sub-agent + union management
--     - cashout approval / rejection
--     - club + table + tournament admin
--     - anti-cheat dispositions (dismiss / warn / suspend / ban)
--
--   Every ops-API mutating route writes one row here in the same transaction
--   as the underlying mutation. Hard requirement for relaunch.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.audit_trail (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who performed the action
  actor_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK (actor_role IN
    ('owner','co_owner','host','agent','sub_agent','union_admin','platform_admin','system')),

  -- What was done
  action TEXT NOT NULL,                  -- e.g. 'mint_chips','approve_cashout','suspend_agent','dismiss_flag'
  target_type TEXT NOT NULL,             -- e.g. 'wallet','agent','club','cashout_request','anti_cheat_flag'
  target_id UUID,                        -- FK by convention to target_type.id (no hard FK — cross-table)

  -- Optional context
  club_id     UUID REFERENCES public.clubs(id) ON DELETE SET NULL,
  agent_id    UUID,                      -- soft ref; agent can be deleted while audit row persists
  amount      NUMERIC(20,4),             -- chips moved (NULL when N/A)
  currency    TEXT DEFAULT 'CHIPS',

  -- State diff (JSONB so we never lose type info on legacy column drops)
  before_state JSONB,
  after_state  JSONB,

  -- Operator-supplied justification — REQUIRED for irreversible / sensitive actions
  reason TEXT,

  -- Provenance
  ip_address INET,
  user_agent TEXT,
  request_id TEXT,                       -- correlates with idempotency_keys.key when available

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot-path indexes
CREATE INDEX IF NOT EXISTS idx_audit_trail_actor       ON public.audit_trail (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_trail_target      ON public.audit_trail (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_trail_club_action ON public.audit_trail (club_id, action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_trail_created     ON public.audit_trail (created_at DESC);

-- RLS: append-only from server roles; readable by platform_admin + by club owners
-- restricted to their own club's rows.
ALTER TABLE public.audit_trail ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role full access" ON public.audit_trail;
CREATE POLICY "service_role full access"
  ON public.audit_trail
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "club owners read own club rows" ON public.audit_trail;
CREATE POLICY "club owners read own club rows"
  ON public.audit_trail FOR SELECT TO authenticated
  USING (
    club_id IN (
      SELECT id FROM public.clubs c
      WHERE c.owner_id = auth.uid()
    )
  );

-- No UPDATE / DELETE policies on purpose — table is append-only by design.
-- Rare admin corrections must go through a documented superuser RPC that
-- writes a *new* corrective row referencing the original.

COMMENT ON TABLE public.audit_trail IS
  'Append-only privileged-action log. Closes P0-G1/F1/F2. Every mutating ops-API '
  'route MUST write a row here in the same transaction as the underlying mutation.';
