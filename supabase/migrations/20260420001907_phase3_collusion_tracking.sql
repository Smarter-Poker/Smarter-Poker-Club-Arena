-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420001907 "phase3_collusion_tracking"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b0b97f5105fb609771cd54dd41a4ee85 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- Phase 3 — Anti-collusion signals (Plan § 6.1.8)
CREATE TABLE IF NOT EXISTS public.collusion_tracking (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  player_a         UUID NOT NULL,
  player_b         UUID,
  pattern_type     TEXT NOT NULL CHECK (pattern_type IN (
    'FOLD_TO_PLAYER','CHIP_DUMP','COORDINATED_SEATING','SOFT_PLAY','WIN_RATE_ANOMALY','CONCURRENT_IP','TIMING_CORRELATION'
  )),
  suspicion_score  SMALLINT NOT NULL CHECK (suspicion_score BETWEEN 0 AND 100),
  evidence         JSONB NOT NULL DEFAULT '{}'::jsonb,
  window_start     TIMESTAMPTZ NOT NULL,
  window_end       TIMESTAMPTZ NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','cleared','actioned')),
  reviewed_by      UUID,
  reviewed_at      TIMESTAMPTZ,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_collusion_scan_date     ON public.collusion_tracking(scan_date DESC);
CREATE INDEX IF NOT EXISTS idx_collusion_players       ON public.collusion_tracking(player_a, player_b);
CREATE INDEX IF NOT EXISTS idx_collusion_status_score  ON public.collusion_tracking(status, suspicion_score DESC);
CREATE INDEX IF NOT EXISTS idx_collusion_pattern       ON public.collusion_tracking(pattern_type, scan_date DESC);

ALTER TABLE public.collusion_tracking ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "collusion_service_write"  ON public.collusion_tracking;
DROP POLICY IF EXISTS "collusion_admin_read"     ON public.collusion_tracking;
DROP POLICY IF EXISTS "collusion_admin_update"   ON public.collusion_tracking;

CREATE POLICY "collusion_service_write"
  ON public.collusion_tracking FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "collusion_admin_read"
  ON public.collusion_tracking FOR SELECT
  USING (
    auth.role() = 'service_role'
    OR EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('admin','owner','super_agent')
    )
  );

CREATE POLICY "collusion_admin_update"
  ON public.collusion_tracking FOR UPDATE
  USING (
    auth.role() = 'service_role'
    OR EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('admin','owner','super_agent')
    )
  );

COMMENT ON TABLE public.collusion_tracking
  IS 'Anti-collusion scan findings. Written by nightly cron + engine telemetry. Reviewed by security/admin team. (Plan § 6.1.8)';

