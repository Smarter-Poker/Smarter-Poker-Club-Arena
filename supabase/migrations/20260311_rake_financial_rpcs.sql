-- ═══════════════════════════════════════════════════════════════════════════════
-- Atomic Rake Increment RPCs
-- Prevents race conditions in concurrent hand rake crediting
-- ═══════════════════════════════════════════════════════════════════════════════

-- Atomic union total_rake increment (prevents read-modify-write race)
CREATE OR REPLACE FUNCTION increment_union_rake(
    p_union_id UUID,
    p_amount NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE unions
    SET total_rake = COALESCE(total_rake, 0) + p_amount
    WHERE id = p_union_id;
END;
$$;

-- Atomic agent rake_generated increment (prevents concurrent hand race)
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
    SET rake_generated = COALESCE(rake_generated, 0) + p_amount
    WHERE id = p_agent_id;
END;
$$;

-- Atomic club_members rake_generated increment
CREATE OR REPLACE FUNCTION increment_rake_generated(
    p_club_id UUID,
    p_user_id UUID,
    p_amount NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    UPDATE club_members
    SET rake_generated = COALESCE(rake_generated, 0) + p_amount
    WHERE club_id = p_club_id AND user_id = p_user_id;
END;
$$;
