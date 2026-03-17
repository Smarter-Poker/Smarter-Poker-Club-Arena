-- Create atomic RPC for incrementing a player's total_rake_paid in club_members.
-- This avoids race conditions when a player is seated at multiple tables
-- and both tables complete a hand simultaneously.

CREATE OR REPLACE FUNCTION increment_rake_generated(
  p_club_id UUID,
  p_user_id UUID,
  p_amount NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE club_members
  SET total_rake_paid = COALESCE(total_rake_paid, 0) + p_amount,
      updated_at = NOW()
  WHERE club_id = p_club_id
    AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE WARNING 'increment_rake_generated: club member not found club=% user=%', p_club_id, p_user_id;
  END IF;
END;
$$;
