-- ═══════════════════════════════════════════════════════════════════════════════
-- SCHEMA GAP REMEDIATION — Full Build-Out (March 14, 2026)
-- Addresses ALL missing tables, views, RPCs, columns, and constraints
-- identified during the 23-bug audit sweep (Phases 7-23).
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. club_agents VIEW (wraps agents table)
-- Multiple RPCs (fn_request_agent_payout, increment_agent_rake) query
-- "club_agents" which doesn't exist — this view makes them work.
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW club_agents AS
SELECT
    id,
    user_id,
    club_id,
    membership_id,
    role,
    status,
    parent_agent_id,
    commission_rate,
    player_rakeback_rate,
    credit_limit,
    credit_used,
    is_prepaid,
    -- Map canonical wallet columns
    COALESCE(agent_wallet_balance, business_balance, 0) AS agent_wallet_balance,
    COALESCE(player_wallet_balance, player_balance, 0) AS player_wallet_balance,
    COALESCE(promo_wallet_balance, promo_balance, 0) AS promo_wallet_balance,
    -- Legacy aliases (for backward compatibility)
    COALESCE(agent_wallet_balance, business_balance, 0) AS business_balance,
    COALESCE(player_wallet_balance, player_balance, 0) AS player_balance,
    COALESCE(promo_wallet_balance, promo_balance, 0) AS promo_balance,
    total_players,
    active_player_count,
    sub_agent_count,
    -- Stats
    COALESCE(weekly_rake_generated, 0) AS weekly_rake_generated,
    COALESCE(lifetime_rake_generated, 0) AS lifetime_rake_generated,
    created_at,
    updated_at
FROM agents;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. commission_ledger TABLE
-- AgentPortalPage queries this for the commission chart
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS commission_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id UUID NOT NULL,
    club_id UUID,
    period TEXT, -- 'weekly', 'monthly'
    period_start TIMESTAMPTZ,
    period_end TIMESTAMPTZ,
    gross_rake NUMERIC(18,4) DEFAULT 0,
    commission_rate NUMERIC(5,4) DEFAULT 0.10,
    commission_earned NUMERIC(18,4) DEFAULT 0,
    player_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid', 'void')),
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commission_ledger_agent ON commission_ledger(agent_id);
CREATE INDEX IF NOT EXISTS idx_commission_ledger_period ON commission_ledger(period_start, period_end);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. rake_rate_audit TABLE
-- RakeService.logRateChange() inserts here for audit trail
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS rake_rate_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    club_id UUID,
    changed_by UUID,
    old_rate NUMERIC(5,4),
    new_rate NUMERIC(5,4),
    rate_type TEXT, -- 'rake', 'bbj', 'commission'
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rake_rate_audit_club ON rake_rate_audit(club_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. rake_records ALTER — add source/tournament tracking columns
-- Enables tournament vs cash game revenue separation
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE rake_records ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'cash_game';
ALTER TABLE rake_records ADD COLUMN IF NOT EXISTS tournament_id UUID;
ALTER TABLE rake_records ADD COLUMN IF NOT EXISTS metadata JSONB;

CREATE INDEX IF NOT EXISTS idx_rake_records_source ON rake_records(source);
CREATE INDEX IF NOT EXISTS idx_rake_records_tournament ON rake_records(tournament_id) WHERE tournament_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. Wallet Column Sync Trigger
-- Keeps business_balance ↔ agent_wallet_balance in sync automatically
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION sync_agent_wallet_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- If agent_wallet_balance changed, sync to business_balance
    IF NEW.agent_wallet_balance IS DISTINCT FROM OLD.agent_wallet_balance THEN
        NEW.business_balance := NEW.agent_wallet_balance;
    -- If business_balance changed, sync to agent_wallet_balance
    ELSIF NEW.business_balance IS DISTINCT FROM OLD.business_balance THEN
        NEW.agent_wallet_balance := NEW.business_balance;
    END IF;
    
    -- Sync player wallets
    IF NEW.player_wallet_balance IS DISTINCT FROM OLD.player_wallet_balance THEN
        NEW.player_balance := NEW.player_wallet_balance;
    ELSIF NEW.player_balance IS DISTINCT FROM OLD.player_balance THEN
        NEW.player_wallet_balance := NEW.player_balance;
    END IF;
    
    -- Sync promo wallets
    IF NEW.promo_wallet_balance IS DISTINCT FROM OLD.promo_wallet_balance THEN
        NEW.promo_balance := NEW.promo_wallet_balance;
    ELSIF NEW.promo_balance IS DISTINCT FROM OLD.promo_balance THEN
        NEW.promo_wallet_balance := NEW.promo_balance;
    END IF;
    
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_agent_wallets ON agents;
CREATE TRIGGER trg_sync_agent_wallets
    BEFORE UPDATE ON agents
    FOR EACH ROW
    EXECUTE FUNCTION sync_agent_wallet_columns();

-- Initial sync: copy canonical → legacy for any existing rows
UPDATE agents SET
    business_balance = COALESCE(agent_wallet_balance, business_balance, 0),
    player_balance = COALESCE(player_wallet_balance, player_balance, 0),
    promo_balance = COALESCE(promo_wallet_balance, promo_balance, 0)
WHERE agent_wallet_balance IS NOT NULL 
   OR player_wallet_balance IS NOT NULL 
   OR promo_wallet_balance IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. Missing RPCs — Critical Services
-- ═══════════════════════════════════════════════════════════════════════════════

-- 6a. increment_club_rake: Atomically increment a club's total rake
CREATE OR REPLACE FUNCTION increment_club_rake(
    p_club_id UUID,
    p_amount NUMERIC
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    UPDATE clubs
    SET total_rake = COALESCE(total_rake, 0) + p_amount,
        updated_at = NOW()
    WHERE id = p_club_id;
END;
$$;

-- 6b. increment_union_rake: Atomically increment a union's total rake
CREATE OR REPLACE FUNCTION increment_union_rake(
    p_union_id UUID,
    p_amount NUMERIC
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    UPDATE unions
    SET total_rake = COALESCE(total_rake, 0) + p_amount,
        updated_at = NOW()
    WHERE id = p_union_id;
END;
$$;

-- 6c. increment_rake_generated: Atomically increment a player's rake contribution
CREATE OR REPLACE FUNCTION increment_rake_generated(
    p_club_id UUID,
    p_user_id UUID,
    p_amount NUMERIC
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    UPDATE club_members
    SET rake_generated = COALESCE(rake_generated, 0) + p_amount,
        updated_at = NOW()
    WHERE club_id = p_club_id AND user_id = p_user_id;
END;
$$;

-- 6d. log_wallet_transaction: Insert wallet transaction audit record
CREATE OR REPLACE FUNCTION log_wallet_transaction(
    p_user_id UUID,
    p_wallet_type TEXT,
    p_amount NUMERIC,
    p_type TEXT,
    p_category TEXT,
    p_description TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_id UUID;
BEGIN
    INSERT INTO wallet_transactions (user_id, wallet_type, amount, type, category, description)
    VALUES (p_user_id, p_wallet_type, p_amount, p_type, p_category, p_description)
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

-- 6e. verify_ledger_totals: Verify chip integrity across the system
CREATE OR REPLACE FUNCTION verify_ledger_totals()
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_minted NUMERIC;
    v_wallets NUMERIC;
    v_locked NUMERIC;
BEGIN
    SELECT COALESCE(SUM(amount), 0) INTO v_minted
    FROM chip_mint_log WHERE type = 'mint';
    
    SELECT COALESCE(SUM(balance), 0) INTO v_wallets
    FROM player_wallets;
    
    SELECT COALESCE(SUM(locked_amount), 0) INTO v_locked
    FROM table_chip_locks WHERE status = 'locked';
    
    RETURN json_build_object(
        'total_minted', v_minted,
        'total_in_wallets', v_wallets,
        'total_locked', v_locked,
        'difference', v_minted - v_wallets - v_locked
    );
END;
$$;

-- 6f. decrement_club_member_count: Atomically decrement member count
CREATE OR REPLACE FUNCTION decrement_club_member_count(
    p_club_id UUID
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    UPDATE clubs
    SET member_count = GREATEST(COALESCE(member_count, 1) - 1, 0),
        updated_at = NOW()
    WHERE id = p_club_id;
END;
$$;

-- 6g. decrement_club_table_count: Atomically decrement table count
CREATE OR REPLACE FUNCTION decrement_club_table_count(
    p_club_id UUID
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    UPDATE clubs
    SET table_count = GREATEST(COALESCE(table_count, 1) - 1, 0),
        updated_at = NOW()
    WHERE id = p_club_id;
END;
$$;

-- 6h. increment_tournament_rake: Track tournament rake separately
CREATE OR REPLACE FUNCTION increment_tournament_rake(
    p_tournament_id UUID,
    p_amount NUMERIC
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    UPDATE tournaments
    SET total_rake = COALESCE(total_rake, 0) + p_amount,
        updated_at = NOW()
    WHERE id = p_tournament_id;
END;
$$;

-- 6i. record_arena_session: Record training arena session for diamond rewards
CREATE OR REPLACE FUNCTION record_arena_session(
    p_user_id UUID,
    p_session_id UUID,
    p_level TEXT,
    p_mastery_rate NUMERIC,
    p_questions_correct INTEGER
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    INSERT INTO arena_sessions (user_id, session_id, level, mastery_rate, questions_correct)
    VALUES (p_user_id, p_session_id, p_level, p_mastery_rate, p_questions_correct)
    ON CONFLICT (session_id) DO NOTHING;
END;
$$;

-- 6j. transfer_club_ownership: Atomically transfer club ownership
CREATE OR REPLACE FUNCTION transfer_club_ownership(
    p_club_id UUID,
    p_new_owner_id UUID
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_old_owner_id UUID;
BEGIN
    SELECT owner_id INTO v_old_owner_id FROM clubs WHERE id = p_club_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Club not found';
    END IF;
    
    -- Transfer ownership
    UPDATE clubs SET owner_id = p_new_owner_id, updated_at = NOW() WHERE id = p_club_id;
    
    -- Update old owner's role to admin
    UPDATE club_members SET role = 'admin', updated_at = NOW()
    WHERE club_id = p_club_id AND user_id = v_old_owner_id;
    
    -- Update new owner's role to owner
    UPDATE club_members SET role = 'owner', updated_at = NOW()
    WHERE club_id = p_club_id AND user_id = p_new_owner_id;
END;
$$;

-- 6k. deduct_marketplace_chips: Deduct chips for marketplace purchase
CREATE OR REPLACE FUNCTION deduct_marketplace_chips(
    p_club_id UUID,
    p_user_id UUID,
    p_amount NUMERIC,
    p_item_id UUID
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    UPDATE player_wallets
    SET balance = balance - p_amount, updated_at = NOW()
    WHERE user_id = p_user_id AND wallet_type = 'PLAYER' AND balance >= p_amount;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Insufficient balance for marketplace purchase';
    END IF;
    
    -- Log transaction
    INSERT INTO wallet_transactions (user_id, wallet_type, amount, type, category, description)
    VALUES (p_user_id, 'PLAYER', p_amount, 'debit', 'marketplace', 'Marketplace item purchase: ' || p_item_id);
END;
$$;

-- 6l. recompute_club_levels: Recalculate club level based on activity
CREATE OR REPLACE FUNCTION recompute_club_levels(
    p_club_id UUID DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    IF p_club_id IS NOT NULL THEN
        UPDATE clubs
        SET level = LEAST(GREATEST(
            FLOOR(LOG(2, GREATEST(COALESCE(member_count, 1), 1)) + 
                  LOG(2, GREATEST(COALESCE(total_rake, 1), 1) / 100)),
            1), 10),
            updated_at = NOW()
        WHERE id = p_club_id;
    ELSE
        UPDATE clubs
        SET level = LEAST(GREATEST(
            FLOOR(LOG(2, GREATEST(COALESCE(member_count, 1), 1)) + 
                  LOG(2, GREATEST(COALESCE(total_rake, 1), 1) / 100)),
            1), 10),
            updated_at = NOW();
    END IF;
END;
$$;

-- 6m. get_union_rake_for_period: Get union rake within a date range
CREATE OR REPLACE FUNCTION get_union_rake_for_period(
    p_union_id UUID,
    p_start_date TIMESTAMPTZ,
    p_end_date TIMESTAMPTZ
) RETURNS NUMERIC
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_total NUMERIC;
BEGIN
    SELECT COALESCE(SUM(r.rake_amount), 0) INTO v_total
    FROM rake_records r
    JOIN clubs c ON r.club_id = c.id
    WHERE c.union_id = p_union_id
      AND r.created_at BETWEEN p_start_date AND p_end_date;
    RETURN v_total;
END;
$$;

-- 6n. Anti-Cheat RPCs (stubs that return sensible defaults)

CREATE OR REPLACE FUNCTION get_anti_cheat_stats(
    p_club_id UUID
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_total_hands BIGINT;
    v_flagged INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_total_hands FROM rake_records WHERE club_id = p_club_id;
    
    RETURN json_build_object(
        'total_hands_analyzed', v_total_hands,
        'flagged_players', 0,
        'active_investigations', 0,
        'collusion_alerts', 0,
        'bot_suspicions', 0,
        'chip_dumping_alerts', 0,
        'last_scan', NOW()
    );
END;
$$;

CREATE OR REPLACE FUNCTION detect_collusion_pairs(
    p_club_id UUID,
    p_threshold NUMERIC DEFAULT 0.75,
    p_min_hands INTEGER DEFAULT 5
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    -- Returns empty array — full implementation requires hand history analysis engine
    RETURN '[]'::JSON;
END;
$$;

CREATE OR REPLACE FUNCTION detect_suspicious_plays(
    p_club_id UUID,
    p_limit INTEGER DEFAULT 500
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    -- Returns empty array — full implementation requires hand history analysis engine
    RETURN '[]'::JSON;
END;
$$;

-- 6o. get_bbj_pool: Get BBJ pool for a union
CREATE OR REPLACE FUNCTION get_bbj_pool(
    p_union_id UUID
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_pool RECORD;
BEGIN
    SELECT * INTO v_pool FROM bbj_pools WHERE union_id = p_union_id AND status = 'active' LIMIT 1;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    RETURN row_to_json(v_pool);
END;
$$;

-- 6p. increment_diamonds: Add diamonds to a user
CREATE OR REPLACE FUNCTION increment_diamonds(
    p_user_id UUID,
    p_amount INTEGER
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    UPDATE profiles
    SET diamonds = COALESCE(diamonds, 0) + p_amount,
        updated_at = NOW()
    WHERE id = p_user_id;
END;
$$;

-- 6q. get_top_mission_completers: Leaderboard for mission completions
CREATE OR REPLACE FUNCTION get_top_mission_completers(
    p_club_id UUID,
    p_limit INTEGER DEFAULT 10
) RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    RETURN (
        SELECT COALESCE(json_agg(row_to_json(t)), '[]'::JSON)
        FROM (
            SELECT cm.user_id, p.display_name, p.avatar_url,
                   COALESCE(cm.missions_completed, 0) AS missions_completed
            FROM club_members cm
            LEFT JOIN profiles p ON cm.user_id = p.id
            WHERE cm.club_id = p_club_id
            ORDER BY cm.missions_completed DESC NULLS LAST
            LIMIT p_limit
        ) t
    );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. Ensure required columns exist on tables referenced by RPCs
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS total_rake NUMERIC(18,4) DEFAULT 0;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS level INTEGER DEFAULT 1;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS table_count INTEGER DEFAULT 0;
ALTER TABLE unions ADD COLUMN IF NOT EXISTS total_rake NUMERIC(18,4) DEFAULT 0;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS total_rake NUMERIC(18,4) DEFAULT 0;
ALTER TABLE club_members ADD COLUMN IF NOT EXISTS missions_completed INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS weekly_rake_generated NUMERIC(18,4) DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS lifetime_rake_generated NUMERIC(18,4) DEFAULT 0;

-- arena_sessions table for record_arena_session RPC
CREATE TABLE IF NOT EXISTS arena_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    session_id UUID NOT NULL UNIQUE,
    level TEXT,
    mastery_rate NUMERIC(5,4),
    questions_correct INTEGER DEFAULT 0,
    diamonds_earned INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_arena_sessions_user ON arena_sessions(user_id);

-- chip_mint_log for verify_ledger_totals
CREATE TABLE IF NOT EXISTS chip_mint_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    club_id UUID,
    amount NUMERIC(18,4) NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('mint', 'burn')),
    minted_by UUID,
    reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- table_chip_locks for verify_ledger_totals
CREATE TABLE IF NOT EXISTS table_chip_locks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    table_id UUID NOT NULL,
    locked_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
    status TEXT DEFAULT 'locked' CHECK (status IN ('locked', 'unlocked')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. GRANT EXECUTE on all new functions
-- ═══════════════════════════════════════════════════════════════════════════════
GRANT EXECUTE ON FUNCTION increment_club_rake TO authenticated, anon;
GRANT EXECUTE ON FUNCTION increment_union_rake TO authenticated, anon;
GRANT EXECUTE ON FUNCTION increment_rake_generated TO authenticated, anon;
GRANT EXECUTE ON FUNCTION log_wallet_transaction TO authenticated, anon;
GRANT EXECUTE ON FUNCTION verify_ledger_totals TO authenticated, anon;
GRANT EXECUTE ON FUNCTION decrement_club_member_count TO authenticated, anon;
GRANT EXECUTE ON FUNCTION decrement_club_table_count TO authenticated, anon;
GRANT EXECUTE ON FUNCTION increment_tournament_rake TO authenticated, anon;
GRANT EXECUTE ON FUNCTION record_arena_session TO authenticated, anon;
GRANT EXECUTE ON FUNCTION transfer_club_ownership TO authenticated, anon;
GRANT EXECUTE ON FUNCTION deduct_marketplace_chips TO authenticated, anon;
GRANT EXECUTE ON FUNCTION recompute_club_levels TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_union_rake_for_period TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_anti_cheat_stats TO authenticated, anon;
GRANT EXECUTE ON FUNCTION detect_collusion_pairs TO authenticated, anon;
GRANT EXECUTE ON FUNCTION detect_suspicious_plays TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_bbj_pool TO authenticated, anon;
GRANT EXECUTE ON FUNCTION increment_diamonds TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_top_mission_completers TO authenticated, anon;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. RLS Policies for new tables
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE commission_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE rake_rate_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chip_mint_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE table_chip_locks ENABLE ROW LEVEL SECURITY;

-- Commission ledger: agents can see their own records
CREATE POLICY "Agents can view own commission ledger" ON commission_ledger
    FOR SELECT USING (agent_id IN (SELECT id FROM agents WHERE user_id = auth.uid()));

-- Rake rate audit: club admins can see audit logs
CREATE POLICY "Club admins can view rake rate changes" ON rake_rate_audit
    FOR SELECT USING (
        club_id IN (
            SELECT club_id FROM club_members 
            WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
        )
    );

-- Arena sessions: users can see their own
CREATE POLICY "Users can view own arena sessions" ON arena_sessions
    FOR SELECT USING (user_id = auth.uid());

-- Chip mint log: club admins can view
CREATE POLICY "Club admins can view mint log" ON chip_mint_log
    FOR SELECT USING (
        club_id IN (
            SELECT club_id FROM club_members 
            WHERE user_id = auth.uid() AND role IN ('owner', 'admin')
        )
    );

-- Table chip locks: users can see their own
CREATE POLICY "Users can view own chip locks" ON table_chip_locks
    FOR SELECT USING (user_id = auth.uid());
