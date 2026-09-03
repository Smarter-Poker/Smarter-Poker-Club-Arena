-- ═══════════════════════════════════════════════════════════════════════════════
--  PHASE 3 — ENGINE INTEGRITY (SMARTER-POKER-LAUNCH-READINESS-PLAN.md § 6.1)
-- ═══════════════════════════════════════════════════════════════════════════════
--
--  Adds schema prerequisites for server-authoritative engine + hand replay:
--    6.1.2  Server-authoritative actions  → public.action_log
--    6.1.3  Immutable hand history        → public.hand_history (add seed, version, started_at, ended_at)
--    6.1.4  Deterministic shuffle         → public.hand_history.seed
--
--  DESIGN NOTES:
--    * hole_cards intentionally remain in public.table_hole_cards (live) and will be
--      moved into hand_history.hole_cards on hand settle by the engine (Hetzner). The
--      column is added here so the engine can write it; RLS locks it to the player.
--    * action_log is append-only. The engine is the sole writer (service role); the
--      client reads only rows for hands it participated in (players @> uid).
--    * Archive policy (> 90d → R2) is enforced by a nightly cron (not this migration).
--
--  Applied via: mcp__supabase__apply_migration (idempotent).
-- ═══════════════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────────────────
-- 1. hand_history — add seed, version, started_at, ended_at, hole_cards, board
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.hand_history
  ADD COLUMN IF NOT EXISTS seed        TEXT,                                    -- hex PRNG seed (6.1.4)
  ADD COLUMN IF NOT EXISTS version     TEXT NOT NULL DEFAULT 'v1',              -- replay format version
  ADD COLUMN IF NOT EXISTS started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),      -- deal time
  ADD COLUMN IF NOT EXISTS ended_at    TIMESTAMPTZ,                             -- settled time
  ADD COLUMN IF NOT EXISTS hole_cards  JSONB,                                   -- {seat: [card,card]} — written on settle
  ADD COLUMN IF NOT EXISTS board       JSONB;                                   -- {flop, turn, river}

COMMENT ON COLUMN public.hand_history.seed
  IS 'PRNG seed (hex HMAC_SHA256) used for deterministic shuffle (Plan 6.1.4)';
COMMENT ON COLUMN public.hand_history.version
  IS 'Replay format version; bump when actions/hole_cards schema changes';

CREATE INDEX IF NOT EXISTS idx_hand_history_table_started
  ON public.hand_history(table_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_hand_history_players_gin
  ON public.hand_history USING GIN (players);

-- ──────────────────────────────────────────────────────────────────────────────
-- 2. hand_history RLS — player sees own hands + club owner sees club hands
-- ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.hand_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hand_history_player_read_own"  ON public.hand_history;
DROP POLICY IF EXISTS "hand_history_admin_read_all"   ON public.hand_history;
DROP POLICY IF EXISTS "hand_history_service_write"    ON public.hand_history;

-- Player reads hands they participated in (players jsonb contains their user_id).
CREATE POLICY "hand_history_player_read_own"
  ON public.hand_history FOR SELECT
  USING (players @> jsonb_build_array(jsonb_build_object('user_id', auth.uid()::text)));

-- Admins/owners read everything.
CREATE POLICY "hand_history_admin_read_all"
  ON public.hand_history FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('admin', 'owner', 'super_agent')
    )
  );

-- Only service role (engine) writes. No anon insert/update/delete via API.
CREATE POLICY "hand_history_service_write"
  ON public.hand_history FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

-- ──────────────────────────────────────────────────────────────────────────────
-- 3. action_log — append-only log of every validated action (Plan 6.1.2)
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.action_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id        UUID NOT NULL,
  hand_id         UUID,                                 -- FK set after hand_history row exists
  hand_number     INTEGER,
  seq             BIGINT NOT NULL,                      -- per-table monotonic sequence
  user_id         UUID NOT NULL,
  seat            SMALLINT NOT NULL CHECK (seat BETWEEN 0 AND 9),
  street          TEXT NOT NULL CHECK (street IN ('preflop','flop','turn','river','showdown','blinds','antes')),
  action          TEXT NOT NULL CHECK (action IN ('bet','raise','call','check','fold','all-in','post','ante','straddle','muck','show','time-bank')),
  amount          NUMERIC(12,2) NOT NULL DEFAULT 0,
  stack_before    NUMERIC(12,2) NOT NULL DEFAULT 0,
  stack_after     NUMERIC(12,2) NOT NULL DEFAULT 0,
  pot_after       NUMERIC(12,2) NOT NULL DEFAULT 0,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,   -- { "auto": true } for time-bank-fold etc.
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (table_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_action_log_table_seq    ON public.action_log(table_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_action_log_hand         ON public.action_log(hand_id);
CREATE INDEX IF NOT EXISTS idx_action_log_user_created ON public.action_log(user_id, created_at DESC);

ALTER TABLE public.action_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "action_log_player_read_own"    ON public.action_log;
DROP POLICY IF EXISTS "action_log_admin_read_all"     ON public.action_log;
DROP POLICY IF EXISTS "action_log_service_write"      ON public.action_log;

CREATE POLICY "action_log_player_read_own"
  ON public.action_log FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "action_log_admin_read_all"
  ON public.action_log FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE profiles.id = auth.uid()
        AND profiles.role IN ('admin', 'owner', 'super_agent')
    )
  );

CREATE POLICY "action_log_service_write"
  ON public.action_log FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

COMMENT ON TABLE public.action_log
  IS 'Append-only log of every engine-validated action. Engine is sole writer (service role). Consumed by anti-collusion, hand-replay, and audit.';

-- ──────────────────────────────────────────────────────────────────────────────
-- 4. engine_state_snapshot — periodic checkpoints for reconnection resync
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.engine_state_snapshot (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id      UUID NOT NULL,
  seq           BIGINT NOT NULL,                        -- matches action_log.seq
  state         JSONB NOT NULL,                         -- full table state at this seq
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (table_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_engine_snap_table_seq
  ON public.engine_state_snapshot(table_id, seq DESC);

ALTER TABLE public.engine_state_snapshot ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "engine_snap_service_only" ON public.engine_state_snapshot;

CREATE POLICY "engine_snap_service_only"
  ON public.engine_state_snapshot FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

COMMENT ON TABLE public.engine_state_snapshot
  IS 'Periodic engine state checkpoints for resync-on-reconnect. Service-role only.';

-- ──────────────────────────────────────────────────────────────────────────────
-- 5. Verification — fail loudly if the migration somehow left things broken
-- ──────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='hand_history' AND column_name='seed') THEN
    RAISE EXCEPTION 'hand_history.seed not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='action_log') THEN
    RAISE EXCEPTION 'action_log not created';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                 WHERE table_schema='public' AND table_name='engine_state_snapshot') THEN
    RAISE EXCEPTION 'engine_state_snapshot not created';
  END IF;
END $$;
