-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260719142037 "harden_save_hand_state_snapshot_search_path_20260719"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 3bb7d017ed1a5c5bc3079a89fc6a3604 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

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
SET search_path TO 'public'
AS $$
BEGIN
  INSERT INTO hand_state_snapshots (
    table_id, hand_number, state_json, config_json, dealer_seat, players_json, stage, updated_at
  ) VALUES (
    p_table_id, p_hand_number, p_state_json, p_config_json, p_dealer_seat, p_players_json, p_stage, NOW()
  )
  ON CONFLICT (table_id) WHERE is_complete = FALSE
  DO UPDATE SET
    hand_number = EXCLUDED.hand_number,
    state_json = EXCLUDED.state_json,
    config_json = EXCLUDED.config_json,
    dealer_seat = EXCLUDED.dealer_seat,
    players_json = EXCLUDED.players_json,
    stage = EXCLUDED.stage,
    updated_at = NOW();
END;
$$;
