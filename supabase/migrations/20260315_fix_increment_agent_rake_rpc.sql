-- ═══════════════════════════════════════════════════════════════════════════════
-- Fix increment_agent_rake RPC: agents.rake_generated → lifetime_rake_generated
-- 
-- BUG: The original RPC references agents.rake_generated which does not exist.
-- The schema_gap_remediation migration added weekly_rake_generated and 
-- lifetime_rake_generated, but NOT rake_generated.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Ensure the column exists before updating the RPC
ALTER TABLE agents ADD COLUMN IF NOT EXISTS lifetime_rake_generated NUMERIC(18,4) DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS weekly_rake_generated NUMERIC(18,4) DEFAULT 0;

-- Fix the RPC to use the correct column name
CREATE OR REPLACE FUNCTION increment_agent_rake(
    p_agent_id UUID,
    p_amount NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE agents
    SET lifetime_rake_generated = COALESCE(lifetime_rake_generated, 0) + p_amount,
        weekly_rake_generated = COALESCE(weekly_rake_generated, 0) + p_amount
    WHERE id = p_agent_id;
END;
$$;
