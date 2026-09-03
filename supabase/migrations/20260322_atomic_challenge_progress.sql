-- ═══════════════════════════════════════════════════════════════════════════════
-- Atomic Challenge Progress Increment RPC
-- Eliminates read-then-write race condition in updateProgress()
-- Uses SQL-level LEAST() to cap at requirement and detect completion atomically
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION increment_challenge_progress(
    p_user_id UUID,
    p_challenge_row_id UUID,
    p_amount INT,
    p_requirement INT
) RETURNS JSONB AS $$
DECLARE
    v_new_progress INT;
    v_is_completed BOOLEAN;
BEGIN
    -- Atomically increment progress, cap at requirement, detect completion
    UPDATE user_daily_challenges
    SET
        progress = LEAST(progress + p_amount, p_requirement),
        completed = (LEAST(progress + p_amount, p_requirement) >= p_requirement),
        completed_at = CASE
            WHEN LEAST(progress + p_amount, p_requirement) >= p_requirement AND NOT completed
            THEN NOW()
            ELSE completed_at
        END
    WHERE id = p_challenge_row_id
      AND user_id = p_user_id
      AND completed = false
    RETURNING progress, completed INTO v_new_progress, v_is_completed;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('updated', false);
    END IF;

    RETURN jsonb_build_object(
        'updated', true,
        'progress', v_new_progress,
        'completed', COALESCE(v_is_completed, false)
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
