-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419182429 "phase26e_monetization_metrics_trust_score"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 18060f76ffeb574d3f8d5cfaa9b64c44 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- =========================================================================
--  PHASE 26 PART E — Monetization metrics + composite trust score
-- =========================================================================

-- ════════════════════════════════════════════════════════════════════════
-- User trust score column (0-100, computed from multiple signals)
-- ════════════════════════════════════════════════════════════════════════
ALTER TABLE profiles 
    ADD COLUMN IF NOT EXISTS trust_score numeric(5,2),
    ADD COLUMN IF NOT EXISTS trust_score_refreshed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_profiles_trust_score 
    ON profiles (trust_score DESC NULLS LAST) WHERE trust_score > 50;

COMMENT ON COLUMN profiles.trust_score IS
  'Phase 26/E: 0-100 composite trust. Verification tier + account age + host/player history + dispute history.';

-- Compute trust score for one user
CREATE OR REPLACE FUNCTION public.compute_user_trust_score(p_user_id uuid)
RETURNS numeric
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE
    v_profile       RECORD;
    v_games_hosted  int;
    v_games_attended int;
    v_disputes_opened_against int;
    v_disputes_lost int;
    v_score         numeric := 0;
    v_account_age_days int;
BEGIN
    SELECT p.*, EXTRACT(day FROM (NOW() - p.created_at))::int AS age_days
      INTO v_profile
      FROM profiles p WHERE id = p_user_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_account_age_days := v_profile.age_days;

    -- Verification tier (0-40 points)
    v_score := v_score + CASE v_profile.verification_tier
        WHEN 'premium' THEN 40
        WHEN 'id'      THEN 30
        WHEN 'phone'   THEN 15
        WHEN 'email'   THEN 5
        ELSE 0 END;

    -- Account age (0-15 points, scales over first year)
    v_score := v_score + LEAST(15, (v_account_age_days / 365.0) * 15);

    -- Host history (0-15 points)
    SELECT COALESCE(SUM(games_hosted), 0) INTO v_games_hosted 
      FROM commander_home_groups WHERE owner_id = p_user_id;
    v_score := v_score + LEAST(15, v_games_hosted * 1.5);

    -- Attendance history (0-15 points)
    SELECT COUNT(*) INTO v_games_attended FROM commander_home_rsvps r 
     WHERE r.user_id = p_user_id AND r.checked_in_at IS NOT NULL;
    v_score := v_score + LEAST(15, v_games_attended * 0.5);

    -- Dispute history (0 to -30 points — penalty for losing disputes against them)
    SELECT COUNT(*) INTO v_disputes_opened_against 
      FROM commander_disputes 
     WHERE respondent_user_id = p_user_id 
       AND opened_at > NOW() - INTERVAL '1 year';
    SELECT COUNT(*) INTO v_disputes_lost 
      FROM commander_disputes 
     WHERE respondent_user_id = p_user_id 
       AND status = 'resolved_favor_opener'
       AND opened_at > NOW() - INTERVAL '1 year';
    -- Pending disputes: light penalty; lost disputes: heavy penalty
    v_score := v_score - LEAST(10, (v_disputes_opened_against - v_disputes_lost) * 2);
    v_score := v_score - LEAST(20, v_disputes_lost * 8);

    -- Badges add bonus (0-5 points)
    v_score := v_score + LEAST(5, (SELECT COUNT(*) FROM commander_home_user_badges WHERE user_id = p_user_id) * 0.5);

    RETURN ROUND(GREATEST(0, LEAST(100, v_score)), 1);
END;
$fn$;
REVOKE EXECUTE ON FUNCTION public.compute_user_trust_score(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.compute_user_trust_score(uuid) TO authenticated, service_role;

-- Batch refresh (cron + on-demand)
CREATE OR REPLACE FUNCTION public.fn_refresh_user_trust_scores(
    p_max_users int DEFAULT 10000
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_updated int := 0; v_user RECORD;
BEGIN
    -- Refresh active users (any recent activity or account <90 days old)
    FOR v_user IN 
        SELECT p.id FROM profiles p
         WHERE p.created_at > NOW() - INTERVAL '90 days'
            OR p.id IN (
                SELECT DISTINCT user_id FROM commander_home_rsvps 
                 WHERE responded_at > NOW() - INTERVAL '30 days'
                UNION 
                SELECT DISTINCT owner_id FROM commander_home_groups 
                 WHERE last_activity_at > NOW() - INTERVAL '30 days'
            )
         ORDER BY p.created_at DESC
         LIMIT p_max_users
    LOOP
        UPDATE profiles 
           SET trust_score = public.compute_user_trust_score(v_user.id),
               trust_score_refreshed_at = NOW()
         WHERE id = v_user.id;
        v_updated := v_updated + 1;
    END LOOP;
    RETURN jsonb_build_object('success', true, 'updated', v_updated);
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.fn_refresh_user_trust_scores(int) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_refresh_user_trust_scores(int) TO service_role;

-- Schedule: daily at 04:30 UTC (after quality scores at 04:00)
SELECT cron.schedule(
    'user-trust-scores-refresh',
    '30 4 * * *',
    $$SELECT public.fn_refresh_user_trust_scores(10000);$$
);

-- Run once immediately for a small batch
SELECT public.fn_refresh_user_trust_scores(500);

-- ════════════════════════════════════════════════════════════════════════
-- Monetization dashboard RPC — for founder pulse + investor deck
-- Reports escrow volume even though we aren't actually moving money yet.
-- ════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_monetization_metrics(
    p_caller_user_id  uuid,
    p_days            int DEFAULT 30
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
DECLARE v_cutoff timestamptz;
BEGIN
    IF auth.uid() IS NULL OR (auth.uid() <> p_caller_user_id) THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
    v_cutoff := NOW() - (p_days || ' days')::interval;

    RETURN jsonb_build_object(
        'generated_at', NOW(),
        'window_days', p_days,
        'escrow', jsonb_build_object(
            'accounts_total', (SELECT COUNT(*) FROM commander_home_game_escrow WHERE created_at >= v_cutoff),
            'accounts_by_status', COALESCE((
                SELECT jsonb_object_agg(status, cnt)
                  FROM (SELECT status, COUNT(*) AS cnt 
                          FROM commander_home_game_escrow 
                         WHERE created_at >= v_cutoff
                         GROUP BY status) t
            ), '{}'::jsonb),
            'gross_collected', COALESCE((SELECT SUM(collected_total) 
                                           FROM commander_home_game_escrow 
                                          WHERE created_at >= v_cutoff), 0),
            'settled_to_players', COALESCE((SELECT SUM(settled_total) 
                                              FROM commander_home_game_escrow 
                                             WHERE settled_at >= v_cutoff), 0),
            'platform_fees_collected', COALESCE((SELECT SUM(platform_fee_total) 
                                                   FROM commander_home_game_escrow 
                                                  WHERE settled_at >= v_cutoff), 0),
            'host_payouts', COALESCE((SELECT SUM(host_payout_total) 
                                        FROM commander_home_game_escrow 
                                       WHERE settled_at >= v_cutoff), 0)
        ),
        'verification', jsonb_build_object(
            'submissions_total', (SELECT COUNT(*) FROM commander_verification_submissions WHERE submitted_at >= v_cutoff),
            'submissions_pending', (SELECT COUNT(*) FROM commander_verification_submissions WHERE status = 'pending'),
            'submissions_approved', (SELECT COUNT(*) FROM commander_verification_submissions WHERE status = 'approved' AND reviewed_at >= v_cutoff),
            'by_tier', COALESCE((
                SELECT jsonb_object_agg(verification_tier, cnt)
                  FROM (SELECT verification_tier, COUNT(*) AS cnt 
                          FROM profiles 
                         WHERE verification_tier IS NOT NULL
                         GROUP BY verification_tier) t
            ), '{}'::jsonb)
        ),
        'venue_claims', jsonb_build_object(
            'requests_total', (SELECT COUNT(*) FROM commander_venue_claim_requests WHERE submitted_at >= v_cutoff),
            'requests_pending', (SELECT COUNT(*) FROM commander_venue_claim_requests WHERE status IN ('pending','reviewing')),
            'requests_approved', (SELECT COUNT(*) FROM commander_venue_claim_requests WHERE status = 'approved' AND reviewed_at >= v_cutoff),
            'venues_claimed_total', (SELECT COUNT(*) FROM poker_venues WHERE is_claimed = true)
        ),
        'disputes', jsonb_build_object(
            'opened_total', (SELECT COUNT(*) FROM commander_disputes WHERE opened_at >= v_cutoff),
            'open_right_now', (SELECT COUNT(*) FROM commander_disputes 
                                 WHERE status IN ('opened','investigating','awaiting_response','escalated')),
            'by_category', COALESCE((
                SELECT jsonb_object_agg(category, cnt)
                  FROM (SELECT category, COUNT(*) AS cnt 
                          FROM commander_disputes 
                         WHERE opened_at >= v_cutoff
                         GROUP BY category) t
            ), '{}'::jsonb),
            'urgent_unresolved', (SELECT COUNT(*) FROM commander_disputes 
                                    WHERE priority = 'urgent' 
                                      AND status IN ('opened','investigating','awaiting_response','escalated')),
            'median_resolution_hours', COALESCE((
                SELECT EXTRACT(epoch FROM percentile_cont(0.5) WITHIN GROUP (ORDER BY (resolved_at - opened_at)))/3600
                  FROM commander_disputes 
                 WHERE resolved_at IS NOT NULL 
                   AND opened_at >= v_cutoff
            ), 0)
        ),
        'trust', jsonb_build_object(
            'avg_trust_score', COALESCE((SELECT ROUND(AVG(trust_score), 2) FROM profiles WHERE trust_score IS NOT NULL), 0),
            'high_trust_users', (SELECT COUNT(*) FROM profiles WHERE trust_score >= 70),
            'low_trust_users', (SELECT COUNT(*) FROM profiles WHERE trust_score < 30 AND trust_score IS NOT NULL)
        )
    );
END; $fn$;
REVOKE EXECUTE ON FUNCTION public.get_monetization_metrics(uuid, int) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_monetization_metrics(uuid, int) TO authenticated, service_role;
