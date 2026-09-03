-- ═══════════════════════════════════════════════════════════════════════════════
-- Enable RLS on financial tables that were missing it
-- Deploy Date: 2026-03-17
-- Status: APPLIED TO LIVE DB
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE agent_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_weekly_snapshots ENABLE ROW LEVEL SECURITY;

-- Agents can read their own settlements
CREATE POLICY agent_settlements_select_own ON agent_settlements
  FOR SELECT USING (
    agent_id IN (SELECT id FROM agents WHERE user_id = auth.uid())
  );

-- Agents can read their own commission payouts
CREATE POLICY commission_payouts_select_own ON commission_payouts
  FOR SELECT USING (
    agent_id IN (SELECT id FROM agents WHERE user_id = auth.uid())
  );

-- Players can read their own weekly snapshots
CREATE POLICY player_weekly_snapshots_select_own ON player_weekly_snapshots
  FOR SELECT USING (player_id = auth.uid());
