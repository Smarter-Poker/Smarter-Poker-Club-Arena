-- Diamond Spins exposes the authoritative daily-activity catalog and the
-- existing 500-diamond qualified-referral reward. Qualification and duplicate
-- protection remain in the existing referral service; daily caps do not apply
-- to those referrals (Dan 2026-09-14). No reward is paid by this reader.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
UPDATE public.diamond_reward_catalog SET max_per_day=NULL,counts_toward_daily_cap=false,updated_at=now()
 WHERE action_key='referral_qualified';
-- Only the qualified 500-diamond referral is uncapped. Other referral
-- rewards retain their existing daily limits and their existing budget line.
INSERT INTO public.diamond_engine_daily_caps(engine,max_per_user_per_day,max_per_user_per_day_vip,note)
 VALUES('qualified_referrals',NULL,NULL,'Dan 2026-09-14: qualified friend referrals are outside the daily activity cap and have no daily referral limit.')
 ON CONFLICT(engine) DO UPDATE SET max_per_user_per_day=NULL,max_per_user_per_day_vip=NULL,note=EXCLUDED.note,updated_at=now();
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_engine_of(p_type text, p_transaction_type text, p_source text, p_description text, p_reference_id text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT CASE
        WHEN COALESCE(p_transaction_type,p_type)='referral_qualified' THEN 'qualified_referrals'
        WHEN starts_with(p_reference_id, 'ca_daily_bonus:')   THEN 'club_arena_daily'
        WHEN starts_with(p_reference_id, 'wheel:')            THEN 'wheel'
        WHEN starts_with(p_reference_id, 'trivia_tourn_')     THEN 'trivia_tournaments'
        WHEN starts_with(p_reference_id, 'trivia_session_')   THEN 'trivia'
        WHEN starts_with(p_reference_id, 'trivia_wheel_')     THEN 'trivia'
        WHEN starts_with(p_reference_id, 'challenge_claim')   THEN 'daily_challenges'
        WHEN starts_with(p_reference_id, 'daily_mission_milestones:') THEN 'daily_missions'
        WHEN starts_with(p_reference_id, 'daily-missions-historical-multiplier:') THEN 'daily_missions'
        WHEN starts_with(p_reference_id, 'daily_mission_')    THEN 'daily_missions'
        WHEN starts_with(p_reference_id, 'streak_milestone_') THEN 'share_streak'
        WHEN starts_with(p_reference_id, 'streak_')           THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'signup:')           THEN 'signup'
        WHEN starts_with(p_reference_id, 'easter_egg_')       THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'video_favorite_')   THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'vip_stipend_')      THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'hotd_')             THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'progress_')         THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'customization-cert-fund') THEN 'cert_fixture'
        WHEN p_source = 'complete_daily_challenge' THEN 'memory_game'
        WHEN p_source = 'handle_new_user'          THEN 'signup'
        WHEN p_source = 'union'                    THEN 'union_grant'
        WHEN p_source = 'the_mint'                 THEN 'mint'
        WHEN COALESCE(p_transaction_type, p_type) IN ('wheel_prize', 'wheel_spin') THEN 'wheel'
        WHEN COALESCE(p_transaction_type, p_type) IN (
                'referral_bonus', 'referral_bonus_reversal', 'referral_qualified',
                'referral_referee', 'referral_vip_conversion',
                'referral_milestone', 'referral_reward')                    THEN 'referrals'
        WHEN COALESCE(p_transaction_type, p_type) = 'signup_bonus'         THEN 'signup'
        WHEN COALESCE(p_transaction_type, p_type) = 'union_grant'          THEN 'union_grant'
        WHEN COALESCE(p_transaction_type, p_type) IN (
                'pvp_refund', 'pvp_win', 'pvp_tie_refund', 'trivia_run',
                'trivia_daily_bonus', 'daily_trivia', 'trivia_reward',
                'trivia_prize_wheel', 'endless_reward', 'survival_reward',
                'mixed_reward', 'time_attack_reward', 'trivia_double_win')  THEN 'trivia'
        WHEN COALESCE(p_transaction_type, p_type) IN (
                'tournament_prize', 'tournament_entry_refund',
                'tournament_cancel_refund')                                THEN 'trivia_tournaments'
        WHEN COALESCE(p_transaction_type, p_type) IN ('daily_challenge_claim') THEN 'daily_challenges'
        WHEN COALESCE(p_transaction_type, p_type) IN ('daily_mission_milestone', 'daily_mission_reward') THEN 'daily_missions'
        WHEN COALESCE(p_transaction_type, p_type) = 'streak_reward'        THEN 'share_streak'
        WHEN COALESCE(p_transaction_type, p_type) IN (
                'daily_login', 'easter_egg', 'training_reward',
                'video_favorite', 'vip_stipend')                           THEN 'catalog_v2'
        WHEN COALESCE(p_transaction_type, p_type) IN ('credit', 'earn', 'bonus') THEN 'legacy_credit'
        WHEN p_description LIKE 'Diamond Rewards v2:%'                      THEN 'catalog_v2'
        ELSE 'other'
    END;
$function$
;

CREATE FUNCTION public.fn_diamond_spins_earn_guide()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_user uuid:=auth.uid(); p public.profiles; caps jsonb; actions jsonb; ref_amount integer; v_multiplier numeric;
BEGIN
 IF v_user IS NULL THEN RETURN jsonb_build_object('ok',false,'error','Sign In To See Your Rewards'); END IF;
 SELECT * INTO p FROM public.profiles WHERE id=v_user;
 IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','Your Profile Could Not Be Found'); END IF;
 caps:=public.fn_ca_daily_bonus_caps(v_user,COALESCE(p.is_vip,false) AND
  (COALESCE(p.vip_tier,'')='lifetime' OR (p.vip_expires_at IS NOT NULL AND p.vip_expires_at>now())));
 v_multiplier:=CASE WHEN p.diamond_multiplier>0 AND p.diamond_multiplier<=10 THEN p.diamond_multiplier ELSE 1 END;
 SELECT jsonb_agg(jsonb_build_object('key',c.action_key,'base_diamonds',c.diamonds,
  'diamonds',round(c.diamonds*v_multiplier),'max_per_day',c.max_per_day,'category',c.category) ORDER BY c.category,c.action_key)
 INTO actions FROM public.diamond_reward_catalog c WHERE c.active AND c.counts_toward_daily_cap
  AND c.action_key IN ('social_post','share_content','strategy_comment','reaction','follow','video_watch','video_favorite','training_level_complete','gto_chart_study','daily_trivia_challenge');
 SELECT diamonds INTO ref_amount FROM public.diamond_reward_catalog WHERE action_key='referral_qualified' AND active;
 RETURN jsonb_build_object('ok',true,'daily_cap',caps->'daily_cap','daily_used',caps->'daily_used','daily_remaining',caps->'daily_remaining',
  'monthly_remaining',caps->'monthly_remaining','frozen',caps->'frozen','actions',COALESCE(actions,'[]'::jsonb),
  'referral_diamonds',ref_amount,'referral_code',p.referral_code,'referral_daily_limit',NULL);
END $$;
REVOKE ALL ON FUNCTION public.fn_diamond_spins_earn_guide() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_diamond_spins_earn_guide() TO authenticated,service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
