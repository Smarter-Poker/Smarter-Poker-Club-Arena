-- ═══════════════════════════════════════════════════════════════════════════════
-- ⏰ CASHOUT EXPIRY — Auto-reject stale pending cashouts
-- ═══════════════════════════════════════════════════════════════════════════════
-- Pending cashout requests that go unprocessed for >72 hours are automatically
-- rejected, returning escrowed chips to the player's wallet. This prevents
-- permanent chip lock when agents are inactive.
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fn_expire_stale_cashouts(
    p_max_hours INTEGER DEFAULT 72
)
RETURNS TABLE (
    expired_id UUID,
    player_id UUID,
    amount NUMERIC
) AS $$
DECLARE
    rec RECORD;
BEGIN
    -- Find all pending cashouts older than p_max_hours
    FOR rec IN
        SELECT id, cr.player_id AS pid, cr.amount AS amt
        FROM cashout_requests cr
        WHERE cr.status = 'pending'
          AND cr.created_at < NOW() - (p_max_hours || ' hours')::INTERVAL
    LOOP
        -- Return chips to player wallet (atomic)
        UPDATE wallets
        SET balance = balance + rec.amt,
            updated_at = NOW()
        WHERE user_id = rec.pid
          AND wallet_type = 'PLAYER';

        -- Mark cashout as expired
        UPDATE cashout_requests
        SET status = 'expired',
            notes = 'Auto-expired after ' || p_max_hours || ' hours without agent action',
            updated_at = NOW()
        WHERE id = rec.id;

        -- Return the expired record
        expired_id := rec.id;
        player_id := rec.pid;
        amount := rec.amt;
        RETURN NEXT;
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DO $$ BEGIN RAISE NOTICE '⏰ fn_expire_stale_cashouts created — auto-rejects pending cashouts after 72h'; END $$;
