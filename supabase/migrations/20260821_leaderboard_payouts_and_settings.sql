-- 20260821_leaderboard_payouts_and_settings.sql
-- Create leaderboard prize settings and historical archive for payouts/trophies.

CREATE TABLE IF NOT EXISTS club_leaderboard_settings (
    club_id UUID PRIMARY KEY REFERENCES clubs(id) ON DELETE CASCADE,
    payout_currency TEXT DEFAULT 'diamonds' CHECK (payout_currency IN ('diamonds', 'chips')),
    weekly_prizes JSONB DEFAULT '[{"rank": 1, "amount": 500}, {"rank": 2, "amount": 250}, {"rank": 3, "amount": 100}]'::jsonb,
    monthly_prizes JSONB DEFAULT '[{"rank": 1, "amount": 2000}, {"rank": 2, "amount": 1000}, {"rank": 3, "amount": 500}]'::jsonb,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE club_leaderboard_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "club_leaderboard_settings_select" ON club_leaderboard_settings FOR SELECT USING (true);
CREATE POLICY "club_leaderboard_settings_update" ON club_leaderboard_settings FOR ALL USING (club_id IN (SELECT id FROM clubs WHERE owner_id = auth.uid()));

CREATE TABLE IF NOT EXISTS leaderboard_payouts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    club_id UUID NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    period TEXT NOT NULL, -- 'weekly', 'monthly'
    metric TEXT NOT NULL,
    start_date TIMESTAMPTZ NOT NULL,
    end_date TIMESTAMPTZ NOT NULL,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    rank INTEGER NOT NULL,
    payout_amount DECIMAL NOT NULL,
    payout_currency TEXT NOT NULL,
    awarded_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(club_id, period, metric, start_date, user_id)
);

ALTER TABLE leaderboard_payouts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "leaderboard_payouts_select" ON leaderboard_payouts FOR SELECT USING (true);


CREATE OR REPLACE FUNCTION fn_payout_leaderboard(
    p_club_id UUID,
    p_period TEXT,
    p_metric TEXT,
    p_start_date TIMESTAMPTZ,
    p_end_date TIMESTAMPTZ
) RETURNS VOID AS $$
DECLARE
    v_settings club_leaderboard_settings%ROWTYPE;
    v_prizes JSONB;
    v_prize JSONB;
    v_rank INT := 1;
    v_amount DECIMAL;
    v_winner RECORD;
    v_payout_exists BOOLEAN;
    v_club_diamonds DECIMAL;
BEGIN
    -- 1. Ensure user is the owner
    IF NOT EXISTS (SELECT 1 FROM clubs WHERE id = p_club_id AND owner_id = auth.uid()) THEN
        RAISE EXCEPTION 'Not authorized. Only the Club Owner can finalize the leaderboard.';
    END IF;

    -- 2. Ensure period is strictly in the past
    IF p_end_date >= NOW() THEN
        RAISE EXCEPTION 'Cannot finalize a period that has not ended yet.';
    END IF;

    -- 3. Get club settings
    SELECT * INTO v_settings FROM club_leaderboard_settings WHERE club_id = p_club_id;
    IF NOT FOUND THEN
        INSERT INTO club_leaderboard_settings (club_id) VALUES (p_club_id) RETURNING * INTO v_settings;
    END IF;

    IF p_period = 'weekly' THEN
        v_prizes := v_settings.weekly_prizes;
    ELSIF p_period = 'monthly' THEN
        v_prizes := v_settings.monthly_prizes;
    ELSE
        RAISE EXCEPTION 'Unsupported period. Must be weekly or monthly.';
    END IF;

    -- 4. Get Winners and Payout
    FOR v_winner IN 
        SELECT user_id, value, rank 
        FROM fn_club_leaderboard_period_v2(p_club_id, p_metric, p_start_date, p_end_date, 10, 0)
    LOOP
        v_amount := 0;
        FOR v_prize IN SELECT * FROM jsonb_array_elements(v_prizes)
        LOOP
            IF (v_prize->>'rank')::INT = v_winner.rank THEN
                v_amount := (v_prize->>'amount')::DECIMAL;
                EXIT;
            END IF;
        END LOOP;

        IF v_amount > 0 THEN
            -- Check if already paid
            SELECT EXISTS(
                SELECT 1 FROM leaderboard_payouts 
                WHERE club_id = p_club_id AND period = p_period AND metric = p_metric 
                  AND start_date = p_start_date AND user_id = v_winner.user_id
            ) INTO v_payout_exists;

            IF NOT v_payout_exists THEN
                
                -- Pay in Diamonds
                IF v_settings.payout_currency = 'diamonds' THEN
                    -- Check club diamond balance
                    SELECT balance INTO v_club_diamonds FROM club_diamond_wallets WHERE club_id = p_club_id;
                    IF v_club_diamonds IS NULL OR v_club_diamonds < v_amount THEN
                        RAISE EXCEPTION 'Insufficient club diamonds to pay Rank % (%)', v_winner.rank, v_amount;
                    END IF;
                    
                    -- Deduct from club
                    UPDATE club_diamond_wallets SET balance = balance - v_amount WHERE club_id = p_club_id;
                    -- Credit player
                    PERFORM increment_diamonds(v_winner.user_id, v_amount::INT);
                
                -- Pay in Chips
                ELSIF v_settings.payout_currency = 'chips' THEN
                    -- Mints the chips into the user's global chip wallet
                    PERFORM credit_player_wallet(v_winner.user_id, v_amount);
                END IF;

                -- Record the payout (Trophy logic on frontend will read this)
                INSERT INTO leaderboard_payouts (club_id, period, metric, start_date, end_date, user_id, rank, payout_amount, payout_currency)
                VALUES (p_club_id, p_period, p_metric, p_start_date, p_end_date, v_winner.user_id, v_winner.rank, v_amount, v_settings.payout_currency);

            END IF;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
