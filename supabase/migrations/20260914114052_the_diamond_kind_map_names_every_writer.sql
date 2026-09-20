BEGIN;

CREATE OR REPLACE FUNCTION public.fn_diamond_kind_bucket(
    p_type             text,
    p_transaction_type text,
    p_source           text,
    p_amount           bigint
)
RETURNS TABLE (kind text, bucket text, label text)
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
    WITH resolved AS (
        SELECT LOWER(COALESCE(
            NULLIF(BTRIM(p_transaction_type), ''),
            CASE WHEN LOWER(COALESCE(p_type, '')) IN ('spend', 'earn', 'credit', 'debit')
                 THEN NULLIF(BTRIM(p_source), '') END,
            NULLIF(BTRIM(p_type), ''),
            ''
        )) AS k
    ),
    bucketed AS (
        SELECT k, CASE
            -- ── SPENT (amount < 0): exact kinds first ──────────────────────
            WHEN p_amount < 0 AND k IN ('arena_deposit', 'tournament_fee')                 THEN 'arena'
            WHEN p_amount < 0 AND k IN ('diamond_gift_sent', 'live_gift_sent', 'transfer') THEN 'gifts_sent'
            WHEN p_amount < 0 AND k IN ('chip_purchase', 'chip_mint')                      THEN 'club_chips'
            WHEN p_amount < 0 AND k IN ('plinko_drop', 'crash_bet', 'wheel_spin', 'pvp_stake',
                                        'game_cost', 'arcade_entry', 'memory_game', 'trivia_entry',
                                        'trivia_arcade', 'trivia_lifeline', 'training_entry',
                                        'tournament_entry', 'daily_challenge_reroll')       THEN 'games'
            WHEN p_amount < 0 AND k IN ('feature_purchase', 'feature_unlock', 'video_unlock',
                                        'streak_freeze', 'throwable_purchase', 'cosmetic_purchase',
                                        'card_slide_purchase')                             THEN 'store'
            WHEN p_amount < 0 AND k IN ('refund', 'stripe_refund', 'chargeback', 'debt_settlement') THEN 'purchase_refunds'
            WHEN p_amount < 0 AND k IN ('adjustment', 'reconciliation', 'burn', 'admin', 'admin_grant',
                                        'seeded', 'bridge', 'house')                       THEN 'adjustments'
            -- ── SPENT: patterns second ─────────────────────────────────────
            WHEN p_amount < 0 AND k LIKE '%vip%'                                           THEN 'vip'
            WHEN p_amount < 0 AND k LIKE '%arena%'                                         THEN 'arena'
            WHEN p_amount < 0 AND k LIKE '%gift%'                                          THEN 'gifts_sent'
            WHEN p_amount < 0 AND k LIKE '%chip%'                                          THEN 'club_chips'
            WHEN p_amount < 0 AND (k LIKE '%refund%' OR k LIKE '%chargeback%' OR k LIKE '%debt%') THEN 'purchase_refunds'
            WHEN p_amount < 0 AND (k LIKE '%adjust%' OR k LIKE '%reconcil%' OR k LIKE '%burn%'
                                   OR k LIKE '%admin%')                                    THEN 'adjustments'
            WHEN p_amount < 0 AND (k LIKE '%purchase%' OR k LIKE '%unlock%' OR k LIKE '%feature%'
                                   OR k LIKE '%throwable%' OR k LIKE '%cosmetic%' OR k LIKE '%avatar%'
                                   OR k LIKE '%theme%' OR k LIKE '%video%' OR k LIKE '%freeze%'
                                   OR k LIKE '%slide%')                                    THEN 'store'
            WHEN p_amount < 0 AND (k LIKE '%bet%' OR k LIKE '%spin%' OR k LIKE '%stake%'
                                   OR k LIKE '%game%' OR k LIKE '%arcade%' OR k LIKE '%trivia%'
                                   OR k LIKE '%training%' OR k LIKE '%entry%' OR k LIKE '%reroll%') THEN 'games'
            WHEN p_amount < 0                                                              THEN 'other_spent'
            -- ── EARNED (amount > 0): exact kinds first ─────────────────────
            WHEN k IN ('arena_withdraw', 'arena')                                          THEN 'arena_cash_outs'
            WHEN k IN ('diamond_gift_received', 'live_gift_received', 'transfer')          THEN 'gifts_received'
            WHEN k IN ('union_grant', 'club_grant')                                        THEN 'grants'
            WHEN k IN ('diamond_purchase', 'purchase', 'purchased', 'stripe_purchase',
                       'store_purchase', 'mint', 'purchase_clearing')                      THEN 'purchases'
            WHEN k IN ('daily_login', 'daily_bonus', 'daily_bonus_boost', 'daily_challenge_claim',
                       'daily_mission_milestone', 'daily_trivia_challenge', 'daily_trivia',
                       'streak_reward', 'streak_diamonds', 'challenge', 'achievement',
                       'hand_of_the_day', 'gto_chart_study', 'training_reward',
                       'training_level_complete', 'first_training_session', 'trivia_run',
                       'trivia_reward', 'trivia_daily_bonus', 'trivia_prize_wheel', 'wheel_prize',
                       'game_reward', 'reward_diamonds', 'bonus_diamonds', 'prize_diamonds') THEN 'rewards'
            WHEN k IN ('signup_bonus', 'bonus', 'promotional', 'promo', 'promo_code',
                       'promo_purchased', 'easter_egg', 'birthday', 'first_purchase',
                       'referral', 'referral_bonus', 'referral_qualified', 'referral_referee',
                       'referral_vip_conversion', 'welcome_spin')                           THEN 'bonuses'
            WHEN k IN ('tournament_prize', 'pvp_win', 'pvp_prize', 'pvp_match_win', 'crash_win',
                       'plinko_win', 'trivia_pvp_match')                                   THEN 'winnings'
            WHEN k IN ('vip_reward', 'vip_stipend', 'vip_daily', 'vip_monthly', 'vip_bonus') THEN 'vip_bonuses'
            WHEN k IN ('social_post', 'follow', 'reaction', 'comment', 'strategy_comment', 'share',
                       'share_content', 'profile_complete', 'profile_pic', 'video_watch',
                       'video_favorite', 'hendonmob_link', 'venue_review', 'email_verified',
                       'phone_verified')                                                   THEN 'social'
            WHEN k IN ('refund', 'pvp_refund', 'pvp_tie_refund', 'diamond_gift_refund', 'diamond_refund',
                       'tournament_cancel_refund', 'tournament_entry_refund')              THEN 'refunds'
            WHEN k IN ('adjustment', 'reconciliation', 'admin', 'admin_grant', 'seeded', 'bridge',
                       'house')                                                            THEN 'adjustments'
            -- ── EARNED: patterns second ────────────────────────────────────
            WHEN k LIKE '%refund%'                                                         THEN 'refunds'
            WHEN k LIKE '%adjust%' OR k LIKE '%reconcil%' OR k LIKE '%admin%'              THEN 'adjustments'
            WHEN k LIKE '%arena%'                                                          THEN 'arena_cash_outs'
            WHEN k LIKE '%gift%'                                                           THEN 'gifts_received'
            WHEN k LIKE '%grant%'                                                          THEN 'grants'
            WHEN k LIKE '%vip%'                                                            THEN 'vip_bonuses'
            WHEN k LIKE '%purchase%'                                                       THEN 'purchases'
            WHEN k LIKE '%prize%' OR k LIKE '%win%'                                        THEN 'winnings'
            WHEN k LIKE '%promo%' OR k LIKE '%referral%' OR k LIKE '%bonus%'               THEN 'bonuses'
            WHEN k LIKE '%daily%' OR k LIKE '%reward%' OR k LIKE '%challenge%'
                 OR k LIKE '%mission%' OR k LIKE '%streak%' OR k LIKE '%training%'
                 OR k LIKE '%trivia%'                                                      THEN 'rewards'
            WHEN k LIKE '%social%' OR k LIKE '%profile%' OR k LIKE '%video%'
                 OR k LIKE '%verified%' OR k LIKE '%share%' OR k LIKE '%comment%'          THEN 'social'
            ELSE 'other_earned'
        END AS bucket
        FROM resolved
    )
    SELECT k AS kind, bucket, CASE bucket
            WHEN 'arena'            THEN 'Diamond Arena Seats'
            WHEN 'gifts_sent'       THEN 'Gifts To Friends'
            WHEN 'vip'              THEN 'VIP Membership'
            WHEN 'club_chips'       THEN 'Club Chip Purchases'
            WHEN 'games'            THEN 'Games And Arcade'
            WHEN 'store'            THEN 'Store Items And Perks'
            WHEN 'purchase_refunds' THEN 'Refunded Purchases'
            WHEN 'adjustments'      THEN 'Adjustments'
            WHEN 'other_spent'      THEN 'Other'
            WHEN 'arena_cash_outs'  THEN 'Diamond Arena Cash-Outs'
            WHEN 'gifts_received'   THEN 'Gifts From Friends'
            WHEN 'grants'           THEN 'Union And Club Grants'
            WHEN 'purchases'        THEN 'Diamonds You Bought'
            WHEN 'rewards'          THEN 'Daily Rewards And Challenges'
            WHEN 'bonuses'          THEN 'Bonuses And Promotions'
            WHEN 'winnings'         THEN 'Tournament And PvP Winnings'
            WHEN 'vip_bonuses'      THEN 'VIP Bonuses'
            WHEN 'social'           THEN 'Social And Community'
            WHEN 'refunds'          THEN 'Refunds'
            ELSE 'Other'
        END AS label
    FROM bucketed;
$fn$;

COMMENT ON FUNCTION public.fn_diamond_kind_bucket(text, text, text, bigint) IS
  'Resolves a diamond_transactions row (type, transaction_type, source, amount) to its kind, a spend/earn bucket and a player-facing label. Every kind a writer can produce is named exactly (2026-09-14 inventory of 24 writers, the reward catalog and the Mint register); patterns second, Other last, so no row vanishes. ONE place, so both wallets bucket identically. DIAMONDS ONLY: club_chips is a chip purchase in a member club; the Diamond Arena has no chips.';

COMMIT;