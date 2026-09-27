-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420011713 "phase7_1_7_settlement_journal"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8efe7fb49f11c8747988542a86210057 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- Phase 7.1.7 — Settlement engine
-- ──────────────────────────────────────────────────────────────────────────
-- Adds the settlement_journal table required by plan §7.1.7 and an
-- idempotency-guarded claim helper. The union-rakeback cron calls
-- fn_claim_settlement_period(key, ...) before any writes; if the key is
-- already in the journal, the claim is rejected and the cron skips. This
-- makes the whole weekly cycle replay-safe.

BEGIN;

CREATE TABLE IF NOT EXISTS public.settlement_journal (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE,
  period_kind     TEXT NOT NULL CHECK (period_kind IN (
                    'union_rakeback',
                    'club_weekly',
                    'club_daily',
                    'tournament_payout',
                    'manual'
                  )),
  period_start    TIMESTAMPTZ NOT NULL,
  period_end      TIMESTAMPTZ NOT NULL,
  clubs_affected  INTEGER NOT NULL DEFAULT 0,
  players_affected INTEGER NOT NULL DEFAULT 0,
  total_rake      NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_rakeback  NUMERIC(18,2) NOT NULL DEFAULT 0,
  union_id        UUID NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','settled','failed','rolled_back')),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at      TIMESTAMPTZ,
  error_detail    TEXT,
  summary         JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT settlement_journal_period_valid CHECK (period_end > period_start)
);

CREATE INDEX IF NOT EXISTS idx_settlement_journal_union_period
  ON public.settlement_journal (union_id, period_start DESC);
CREATE INDEX IF NOT EXISTS idx_settlement_journal_kind_status
  ON public.settlement_journal (period_kind, status, started_at DESC);

ALTER TABLE public.settlement_journal ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS settlement_journal_service_all ON public.settlement_journal;
CREATE POLICY settlement_journal_service_all
  ON public.settlement_journal FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS settlement_journal_admin_read ON public.settlement_journal;
CREATE POLICY settlement_journal_admin_read
  ON public.settlement_journal FOR SELECT
  TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid()
      AND p.role IN ('admin','superadmin','god')
  ));

-- ── Claim helper: atomically reserve a (union_id, period_kind, period_start)
-- slot. If the idempotency_key already exists, returns the existing row's
-- status; callers must bail out on 'settled' or 'pending'.
CREATE OR REPLACE FUNCTION public.fn_claim_settlement_period(
  p_idempotency_key TEXT,
  p_period_kind     TEXT,
  p_union_id        UUID,
  p_period_start    TIMESTAMPTZ,
  p_period_end      TIMESTAMPTZ
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row settlement_journal%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM settlement_journal WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'already_claimed',
      'existing_status', v_row.status,
      'id', v_row.id
    );
  END IF;

  INSERT INTO settlement_journal (
    idempotency_key, period_kind, period_start, period_end, union_id, status
  ) VALUES (
    p_idempotency_key, p_period_kind, p_period_start, p_period_end,
    p_union_id, 'pending'
  )
  RETURNING * INTO v_row;

  RETURN jsonb_build_object('ok', true, 'id', v_row.id);
END; $$;

-- ── Finalize helper: mark a pending claim as settled (or failed) and record
-- the summary + aggregates.
CREATE OR REPLACE FUNCTION public.fn_finalize_settlement_period(
  p_id             UUID,
  p_status         TEXT,           -- 'settled' | 'failed' | 'rolled_back'
  p_clubs_affected INTEGER,
  p_players_affected INTEGER,
  p_total_rake     NUMERIC,
  p_total_rakeback NUMERIC,
  p_summary        JSONB,
  p_error_detail   TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row settlement_journal%ROWTYPE;
BEGIN
  IF p_status NOT IN ('settled','failed','rolled_back') THEN
    RAISE EXCEPTION 'Invalid status: %', p_status;
  END IF;

  UPDATE settlement_journal
     SET status           = p_status,
         clubs_affected   = COALESCE(p_clubs_affected, clubs_affected),
         players_affected = COALESCE(p_players_affected, players_affected),
         total_rake       = COALESCE(p_total_rake, total_rake),
         total_rakeback   = COALESCE(p_total_rakeback, total_rakeback),
         summary          = COALESCE(p_summary, summary),
         error_detail     = p_error_detail,
         settled_at       = CASE WHEN p_status = 'settled' THEN now() ELSE settled_at END
   WHERE id = p_id AND status = 'pending'
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_pending', 'id', p_id);
  END IF;

  RETURN jsonb_build_object('ok', true, 'id', v_row.id, 'status', v_row.status);
END; $$;

GRANT EXECUTE ON FUNCTION public.fn_claim_settlement_period(TEXT, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_finalize_settlement_period(UUID, TEXT, INTEGER, INTEGER, NUMERIC, NUMERIC, JSONB, TEXT)
  TO service_role;

COMMIT;

