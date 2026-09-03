-- ============================================================
-- FIX 137: Server Crash Recovery — Hand State Snapshots
--
-- Bible V8 §7.17: "Server crash recovery — reload state from DB, resume"
-- Bible V8 §9.2: "Auto-recovery from crashes"
--
-- After EVERY action, the server snapshots the entire hand state
-- to this table. On server restart, any incomplete hands are
-- detected and resumed from the last snapshot.
-- ============================================================

CREATE TABLE IF NOT EXISTS hand_state_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id UUID NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  hand_number INTEGER NOT NULL,
  -- Full hand state (serialized JSON — contains all game state)
  state_json JSONB NOT NULL,
  -- Config that started this hand (needed to reconstruct HandController)
  config_json JSONB NOT NULL,
  -- Dealer seat for this hand
  dealer_seat INTEGER NOT NULL,
  -- Players at start of hand (needed for stack verification)
  players_json JSONB NOT NULL,
  -- Current stage for quick queries
  stage TEXT NOT NULL DEFAULT 'preflop',
  -- Whether this hand has been completed (settlement done)
  is_complete BOOLEAN NOT NULL DEFAULT FALSE,
  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast lookup: find incomplete hands for a table on server restart
CREATE INDEX IF NOT EXISTS idx_hand_snapshots_active
  ON hand_state_snapshots (table_id, is_complete)
  WHERE is_complete = FALSE;

-- Only one active (incomplete) hand per table at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_hand_snapshots_one_active_per_table
  ON hand_state_snapshots (table_id)
  WHERE is_complete = FALSE;

-- Cleanup: auto-delete completed snapshots older than 24 hours (via cron or app logic)
-- For now, mark complete and let cleanup happen separately.

-- RPC: Save or update hand state snapshot (called by server after every action)
CREATE OR REPLACE FUNCTION save_hand_state_snapshot(
  p_table_id UUID,
  p_hand_number INTEGER,
  p_state_json JSONB,
  p_config_json JSONB,
  p_dealer_seat INTEGER,
  p_players_json JSONB,
  p_stage TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO hand_state_snapshots (
    table_id, hand_number, state_json, config_json, dealer_seat, players_json, stage, updated_at
  ) VALUES (
    p_table_id, p_hand_number, p_state_json, p_config_json, p_dealer_seat, p_players_json, p_stage, NOW()
  )
  ON CONFLICT (table_id) WHERE is_complete = FALSE
  DO UPDATE SET
    state_json = EXCLUDED.state_json,
    stage = EXCLUDED.stage,
    updated_at = NOW();
END;
$$;

-- RPC: Mark hand as complete (called after settlement)
CREATE OR REPLACE FUNCTION complete_hand_snapshot(
  p_table_id UUID,
  p_hand_number INTEGER
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  UPDATE hand_state_snapshots
  SET is_complete = TRUE, updated_at = NOW()
  WHERE table_id = p_table_id
    AND hand_number = p_hand_number
    AND is_complete = FALSE;
END;
$$;

-- RPC: Get active (incomplete) hand snapshot for crash recovery
CREATE OR REPLACE FUNCTION get_active_hand_snapshot(
  p_table_id UUID
) RETURNS TABLE (
  hand_number INTEGER,
  state_json JSONB,
  config_json JSONB,
  dealer_seat INTEGER,
  players_json JSONB,
  stage TEXT,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    hss.hand_number,
    hss.state_json,
    hss.config_json,
    hss.dealer_seat,
    hss.players_json,
    hss.stage,
    hss.updated_at
  FROM hand_state_snapshots hss
  WHERE hss.table_id = p_table_id
    AND hss.is_complete = FALSE
  LIMIT 1;
END;
$$;
