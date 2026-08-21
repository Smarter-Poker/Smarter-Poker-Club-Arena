CREATE OR REPLACE FUNCTION public.fn_club_leaderboard_by_dates(
    p_club_id uuid,
    p_metric text,
    p_start_date date,
    p_end_date date,
    p_limit integer DEFAULT 10,
    p_offset integer DEFAULT 0
)
RETURNS TABLE(
    user_id uuid,
    hands_played numeric,
    total_winnings numeric,
    total_losses numeric,
    tournaments_won numeric,
    total_rake numeric,
    sum_big_blind numeric,
    rank_change integer,
    qualified boolean,
    rank integer,
    total_ranked integer,
    baseline_date date
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE 
    v_start_snap date;
    v_end_snap date;
    v_min_hands integer := 20;
    v_total integer;
BEGIN
    -- Find closest snapshot on or before start date
    SELECT max(snapshot_date) INTO v_start_snap FROM player_stats_snapshots
    WHERE club_id = p_club_id AND snapshot_date <= p_start_date;
    
    -- Find closest snapshot on or before end date (but after start_snap)
    SELECT max(snapshot_date) INTO v_end_snap FROM player_stats_snapshots
    WHERE club_id = p_club_id AND snapshot_date <= p_end_date;

    IF v_start_snap IS NULL OR v_end_snap IS NULL OR v_start_snap = v_end_snap THEN
        -- Return empty if we don't have bounding snapshots
        RETURN;
    END IF;

    SELECT count(DISTINCT s.user_id) INTO v_total 
    FROM player_stats_snapshots s 
    WHERE s.club_id = p_club_id AND s.snapshot_date = v_end_snap;

    RETURN QUERY
    WITH cur AS (
        SELECT pe.user_id AS uid,
               GREATEST(pe.hands_dealt - COALESCE(ps.hands_dealt, 0), 0)::numeric AS d_hands,
               (pe.total_winnings - COALESCE(ps.total_winnings, 0)) AS d_win,
               (pe.total_losses - COALESCE(ps.total_losses, 0)) AS d_loss,
               GREATEST(pe.tournaments_won - COALESCE(ps.tournaments_won, 0), 0)::numeric AS d_twon,
               GREATEST(pe.total_rake - COALESCE(ps.total_rake, 0), 0) AS d_rake,
               GREATEST(pe.sum_big_blind - COALESCE(ps.sum_big_blind, 0), 0) AS d_bb
        FROM player_stats_snapshots pe
        LEFT JOIN player_stats_snapshots ps 
          ON ps.user_id = pe.user_id AND ps.club_id = pe.club_id AND ps.snapshot_date = v_start_snap
        WHERE pe.club_id = p_club_id AND pe.snapshot_date = v_end_snap
    ),
    scored AS (
        SELECT c.*,
               (CASE p_metric
                  WHEN 'profit' THEN c.d_win - c.d_loss
                  WHEN 'bb100'  THEN (CASE WHEN c.d_hands < v_min_hands THEN -999999 ELSE ((c.d_win - c.d_loss) / NULLIF(c.d_bb, 0)) * 100 END)
                  WHEN 'hands_played' THEN c.d_hands
                  WHEN 'tournaments_won' THEN c.d_twon
                  ELSE c.d_win - c.d_loss
                END) AS sort_val,
               (CASE p_metric
                  WHEN 'bb100' THEN c.d_hands >= v_min_hands
                  WHEN 'roi' THEN c.d_hands >= v_min_hands
                  ELSE true
                END) AS is_qualified
        FROM cur c
    ),
    ranked AS (
        SELECT s.uid, s.d_hands, s.d_win, s.d_loss, s.d_twon, s.d_rake, s.d_bb, s.is_qualified,
               (row_number() OVER (ORDER BY s.sort_val DESC, s.uid))::integer AS rnk
        FROM scored s
    )
    SELECT r.uid, r.d_hands, r.d_win, r.d_loss, r.d_twon, r.d_rake, r.d_bb,
           0 AS rank_change,
           r.is_qualified,
           r.rnk,
           v_total,
           v_start_snap
    FROM ranked r
    ORDER BY r.rnk
    LIMIT p_limit OFFSET p_offset;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_user_rank_by_dates(
  p_user_id uuid, p_club_id uuid,
  p_metric text, p_start_date date, p_end_date date
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE r record;
BEGIN
  SELECT b.rank, b.total_ranked, b.qualified, b.total_winnings, b.total_losses,
         b.hands_played, b.tournaments_won, b.sum_big_blind
    INTO r
    FROM fn_club_leaderboard_by_dates(p_club_id, p_metric, p_start_date, p_end_date, 1000000, 0) b
   WHERE b.user_id = p_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'rank', r.rank,
    'total', r.total_ranked,
    'qualified', r.qualified,
    'value', (CASE p_metric
                WHEN 'profit' THEN r.total_winnings - r.total_losses
                WHEN 'bb100'  THEN (CASE WHEN r.hands_played < 20 THEN -999999 ELSE ((r.total_winnings - r.total_losses) / NULLIF(r.sum_big_blind, 0)) * 100 END)
                WHEN 'hands_played' THEN r.hands_played
                WHEN 'tournaments_won' THEN r.tournaments_won
                ELSE r.total_winnings - r.total_losses
              END)
  );
END;
$$;

-- Fix the broken payout function to use the correct function and date casts
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
        SELECT user_id, (total_winnings - total_losses) as value, rank 
        FROM fn_club_leaderboard_by_dates(p_club_id, p_metric, p_start_date::date, p_end_date::date, 10, 0)
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

CREATE OR REPLACE FUNCTION public.fn_global_leaderboard_by_dates(
  p_metric text,
  p_start_date date,
  p_end_date date,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE(
    user_id uuid, hands_played numeric, total_winnings numeric,
    total_losses numeric, tournaments_won numeric, total_rake numeric,
    rank_change integer, qualified boolean, rank integer, total_ranked integer, baseline_date date
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE 
    v_start_snap date;
    v_end_snap date;
    v_min_hands integer := 20;
    v_total integer;
BEGIN
    SELECT max(snapshot_date) INTO v_start_snap FROM player_stats_snapshots WHERE snapshot_date <= p_start_date;
    SELECT max(snapshot_date) INTO v_end_snap FROM player_stats_snapshots WHERE snapshot_date <= p_end_date;

    IF v_start_snap IS NULL OR v_end_snap IS NULL OR v_start_snap = v_end_snap THEN
        RETURN;
    END IF;

    SELECT count(DISTINCT s.user_id) INTO v_total 
    FROM player_stats_snapshots s 
    WHERE s.snapshot_date = v_end_snap;

    RETURN QUERY
    WITH end_snap AS (
        SELECT s.user_id AS uid,
               SUM(s.hands_played)::numeric    AS s_hands,
               SUM(s.total_winnings)::numeric  AS s_win,
               SUM(s.total_losses)::numeric    AS s_loss,
               SUM(s.tournaments_won)::numeric AS s_twon,
               SUM(s.total_rake)::numeric      AS s_rake,
               SUM(s.sum_big_blind)::numeric   AS s_bb
          FROM player_stats_snapshots s
         WHERE s.snapshot_date = v_end_snap
         GROUP BY s.user_id
    ),
    start_snap AS (
        SELECT s.user_id AS uid,
               SUM(s.hands_played)::numeric    AS s_hands,
               SUM(s.total_winnings)::numeric  AS s_win,
               SUM(s.total_losses)::numeric    AS s_loss,
               SUM(s.tournaments_won)::numeric AS s_twon,
               SUM(s.total_rake)::numeric      AS s_rake,
               SUM(s.sum_big_blind)::numeric   AS s_bb
          FROM player_stats_snapshots s
         WHERE s.snapshot_date = v_start_snap
         GROUP BY s.user_id
    ),
    cur AS (
        SELECT e.uid,
               GREATEST(e.s_hands - COALESCE(b.s_hands,0), 0)::numeric AS d_hands,
               (e.s_win - COALESCE(b.s_win,0)) AS d_win,
               (e.s_loss - COALESCE(b.s_loss,0)) AS d_loss,
               GREATEST(e.s_twon - COALESCE(b.s_twon,0), 0)::numeric AS d_twon,
               GREATEST(e.s_rake - COALESCE(b.s_rake,0), 0) AS d_rake,
               GREATEST(e.s_bb - COALESCE(b.s_bb,0), 0) AS d_bb
          FROM end_snap e
          LEFT JOIN start_snap b ON b.uid = e.uid
    ),
    scored AS (
        SELECT c.*,
               (CASE p_metric
                  WHEN 'profit' THEN c.d_win - c.d_loss
                  WHEN 'bb100'  THEN (CASE WHEN c.d_hands < v_min_hands THEN -999999 ELSE ((c.d_win - c.d_loss) / NULLIF(c.d_bb, 0)) * 100 END)
                  WHEN 'hands_played' THEN c.d_hands
                  WHEN 'tournaments_won' THEN c.d_twon
                  ELSE c.d_win - c.d_loss
                END) AS sort_val,
               (CASE p_metric
                  WHEN 'bb100' THEN c.d_hands >= v_min_hands
                  WHEN 'roi' THEN c.d_hands >= v_min_hands
                  ELSE true
                END) AS is_qualified
        FROM cur c
    ),
    ranked AS (
        SELECT s.uid, s.d_hands, s.d_win, s.d_loss, s.d_twon, s.d_rake, s.d_bb, s.is_qualified,
               (row_number() OVER (ORDER BY s.sort_val DESC, s.uid))::integer AS rnk
        FROM scored s
    )
    SELECT r.uid, r.d_hands, r.d_win, r.d_loss, r.d_twon, r.d_rake, r.d_bb,
           0 AS rank_change,
           r.is_qualified,
           r.rnk,
           v_total,
           v_start_snap
    FROM ranked r
    ORDER BY r.rnk
    LIMIT p_limit OFFSET p_offset;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_user_rank_global_by_dates(
  p_user_id uuid,
  p_metric text, p_start_date date, p_end_date date
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE r record;
BEGIN
  SELECT b.rank, b.total_ranked, b.qualified, b.total_winnings, b.total_losses,
         b.hands_played, b.tournaments_won, b.sum_big_blind
    INTO r
    FROM fn_global_leaderboard_by_dates(p_metric, p_start_date, p_end_date, 1000000, 0) b
   WHERE b.user_id = p_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'rank', r.rank,
    'total', r.total_ranked,
    'qualified', r.qualified,
    'value', (CASE p_metric
                WHEN 'profit' THEN r.total_winnings - r.total_losses
                WHEN 'bb100'  THEN (CASE WHEN r.hands_played < 20 THEN -999999 ELSE ((r.total_winnings - r.total_losses) / NULLIF(r.sum_big_blind, 0)) * 100 END)
                WHEN 'hands_played' THEN r.hands_played
                WHEN 'tournaments_won' THEN r.tournaments_won
                ELSE r.total_winnings - r.total_losses
              END)
  );
END;
$$;
