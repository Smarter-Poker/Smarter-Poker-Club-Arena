BEGIN;

CREATE OR REPLACE FUNCTION public.fn_diamond_kind_row_label(p_kind text, p_amount bigint)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
    WITH k AS (SELECT LOWER(COALESCE(BTRIM(p_kind), '')) AS k)
    SELECT COALESCE(CASE
        WHEN k.k = 'arena_deposit'                                           THEN 'Diamond Arena Buy-In'
        WHEN k.k = 'arena_withdraw'                                          THEN 'Diamond Arena Cash-Out'
        WHEN k.k = 'tournament_fee'                                          THEN 'Diamond Arena Tournament Fee'
        WHEN k.k = 'daily_challenge_claim'                                   THEN 'Daily Challenge Reward'
        WHEN k.k = 'daily_mission_milestone'                                 THEN 'Daily Missions Milestone'
        WHEN k.k = 'daily_challenge_reroll'                                  THEN 'Daily Challenge Reroll'
        WHEN k.k = 'daily_login'                                             THEN 'Daily Login Reward'
        WHEN k.k = 'daily_bonus'                                             THEN 'Daily Bonus'
        WHEN k.k = 'daily_bonus_boost'                                       THEN 'Daily Bonus Boost'
        WHEN k.k = 'daily_bonus_spin'                                        THEN 'Bonus Spin Ticket'
        WHEN k.k IN ('streak_reward', 'streak_diamonds')                     THEN 'Streak Reward'
        WHEN k.k = 'streak_freeze'                                           THEN 'Streak Freeze'
        WHEN k.k = 'signup_bonus'                                            THEN 'Welcome Bonus'
        WHEN k.k = 'bonus'                                                   THEN 'Bonus'
        WHEN k.k IN ('promotional', 'promo', 'promo_code', 'promo_purchased') THEN 'Promotion'
        WHEN k.k = 'easter_egg'                                              THEN 'Easter Egg'
        WHEN k.k = 'birthday'                                                THEN 'Birthday Bonus'
        WHEN k.k = 'first_purchase'                                          THEN 'First Purchase Bonus'
        WHEN k.k IN ('referral', 'referral_bonus', 'referral_qualified',
                     'referral_referee', 'referral_vip_conversion')          THEN 'Referral Bonus'
        WHEN k.k = 'union_grant'                                             THEN 'Union Grant'
        WHEN k.k = 'club_grant'                                              THEN 'Club Grant'
        WHEN k.k = 'diamond_gift_sent'                                       THEN 'Diamonds Sent To A Friend'
        WHEN k.k = 'diamond_gift_received'                                   THEN 'Diamonds Received From A Friend'
        WHEN k.k = 'diamond_gift_refund'                                     THEN 'Gift Refund'
        WHEN k.k = 'live_gift_sent'                                          THEN 'Live Gift Sent'
        WHEN k.k = 'live_gift_received'                                      THEN 'Live Gift Received'
        WHEN k.k = 'transfer'                                                THEN 'Transfer'
        WHEN k.k IN ('purchase', 'purchased', 'diamond_purchase',
                     'stripe_purchase', 'store_purchase', 'purchase_clearing') THEN 'Diamond Purchase'
        WHEN k.k = 'mint'                                                    THEN 'Diamonds Issued'
        WHEN k.k IN ('refund', 'stripe_refund')                              THEN 'Purchase Refund'
        WHEN k.k = 'chargeback'                                              THEN 'Chargeback'
        WHEN k.k = 'debt_settlement'                                         THEN 'Debt Settlement'
        WHEN k.k = 'chip_purchase'                                           THEN 'Club Chip Purchase'
        WHEN k.k = 'chip_mint'                                               THEN 'Club Chip Mint'
        WHEN k.k = 'plinko_drop'                                             THEN 'Plinko Drop'
        WHEN k.k = 'plinko_win'                                              THEN 'Plinko Prize'
        WHEN k.k = 'crash_bet'                                               THEN 'Crash Bet'
        WHEN k.k = 'crash_win'                                               THEN 'Crash Prize'
        WHEN k.k = 'wheel_spin'                                              THEN 'Wheel Spin'
        WHEN k.k = 'wheel_prize'                                             THEN 'Wheel Prize'
        WHEN k.k = 'diamond_game'                                            THEN 'Diamond Game Bet'
        WHEN k.k = 'diamond_game_prize'                                      THEN 'Diamond Game Prize'
        WHEN k.k = 'pvp_stake'                                               THEN 'PvP Stake'
        WHEN k.k IN ('pvp_win', 'pvp_prize', 'pvp_match_win')                THEN 'PvP Winnings'
        WHEN k.k IN ('pvp_refund', 'pvp_tie_refund')                         THEN 'PvP Refund'
        WHEN k.k IN ('game_cost', 'arcade_entry', 'memory_game')             THEN 'Game Entry'
        WHEN k.k = 'game_reward'                                             THEN 'Game Reward'
        WHEN k.k = 'trivia_entry'                                            THEN 'Trivia Entry'
        WHEN k.k = 'trivia_arcade'                                           THEN 'Trivia Arcade'
        WHEN k.k = 'trivia_lifeline'                                         THEN 'Trivia Lifeline'
        WHEN k.k IN ('trivia_run', 'trivia_reward', 'daily_trivia',
                     'daily_trivia_challenge', 'trivia_daily_bonus')         THEN 'Trivia Reward'
        WHEN k.k = 'trivia_prize_wheel'                                      THEN 'Trivia Prize Wheel'
        WHEN k.k = 'trivia_pvp_match'                                        THEN 'Trivia PvP Match'
        WHEN k.k = 'tournament_entry'                                        THEN 'Tournament Entry'
        WHEN k.k = 'tournament_prize'                                        THEN 'Tournament Prize'
        WHEN k.k IN ('tournament_cancel_refund', 'tournament_entry_refund')  THEN 'Tournament Refund'
        WHEN k.k = 'training_entry'                                          THEN 'Training Entry'
        WHEN k.k IN ('training_reward', 'training_level_complete',
                     'first_training_session')                               THEN 'Training Reward'
        WHEN k.k = 'gto_chart_study'                                         THEN 'GTO Chart Study Reward'
        WHEN k.k = 'hand_of_the_day'                                         THEN 'Hand Of The Day Reward'
        WHEN k.k = 'achievement'                                             THEN 'Achievement Reward'
        WHEN k.k = 'challenge'                                               THEN 'Challenge Reward'
        WHEN k.k IN ('feature_purchase', 'feature_unlock')                   THEN 'Store Purchase'
        WHEN k.k = 'video_unlock'                                            THEN 'Video Unlock'
        WHEN k.k = 'deduction'                                               THEN 'Store Perk'
        WHEN k.k = 'throwable_purchase'                                      THEN 'Throwables'
        WHEN k.k = 'cosmetic_purchase'                                       THEN 'Cosmetic Purchase'
        WHEN k.k = 'card_slide_purchase'                                     THEN 'Card Slide'
        WHEN k.k IN ('vip_purchase', 'vip_monthly', 'vip_subscription',
                     'vip_membership')                                       THEN 'VIP Membership'
        WHEN k.k IN ('vip_stipend', 'vip_daily', 'vip_reward', 'vip_bonus')  THEN 'VIP Bonus'
        WHEN k.k = 'social_post'                                             THEN 'Social Post Reward'
        WHEN k.k = 'follow'                                                  THEN 'Follow Reward'
        WHEN k.k = 'reaction'                                                THEN 'Reaction Reward'
        WHEN k.k IN ('comment', 'strategy_comment')                          THEN 'Comment Reward'
        WHEN k.k IN ('share', 'share_content')                               THEN 'Share Reward'
        WHEN k.k = 'profile_complete'                                        THEN 'Profile Complete Reward'
        WHEN k.k = 'profile_pic'                                             THEN 'Profile Picture Reward'
        WHEN k.k = 'video_watch'                                             THEN 'Video Watch Reward'
        WHEN k.k = 'video_favorite'                                          THEN 'Video Favorite Reward'
        WHEN k.k = 'hendonmob_link'                                          THEN 'Hendon Mob Link Reward'
        WHEN k.k = 'venue_review'                                            THEN 'Venue Review Reward'
        WHEN k.k = 'email_verified'                                          THEN 'Email Verified Reward'
        WHEN k.k = 'phone_verified'                                          THEN 'Phone Verified Reward'
        WHEN k.k IN ('adjustment', 'reconciliation', 'admin', 'admin_grant') THEN 'Balance Adjustment'
        WHEN k.k = 'burn'                                                    THEN 'Diamonds Retired'
        WHEN k.k = 'seeded'                                                  THEN 'Seeded Diamonds'
        WHEN k.k LIKE 'test%'                                                THEN 'Test Entry'
        ELSE NULL
    END, (SELECT b.label FROM public.fn_diamond_kind_bucket(k.k, k.k, NULL, p_amount) b))
    FROM k;
$fn$;

COMMENT ON FUNCTION public.fn_diamond_kind_row_label(text, bigint) IS
  'The player-facing row label for a diamond ledger kind ("Daily Challenge Reward", "Diamond Arena Buy-In"); falls back to the bucket label from fn_diamond_kind_bucket. Pure; Title Case at the source. DIAMONDS ONLY.';

CREATE OR REPLACE FUNCTION public.fn_diamond_ledger_line(
    p_type             text,
    p_transaction_type text,
    p_source           text,
    p_amount           bigint,
    p_description      text
)
RETURNS text
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
        )) AS k,
        BTRIM(COALESCE(p_description, '')) AS d
    ),
    cleaned AS (
        SELECT k, d,
            regexp_replace(
              regexp_replace(
                regexp_replace(
                  regexp_replace(
                    regexp_replace(
                      regexp_replace(
                        regexp_replace(
                          regexp_replace(
                            regexp_replace(d,
                              E'\\s*[\u2012\u2013\u2014\u2015]\\s*', ', ', 'g'),          -- em and en dashes: a comma clause
                            E'\\s*\U0001F48E', ' diamonds', 'g'),                        -- the diamond glyph is a word
                          E'[\U0001F000-\U0001FAFF\u2728\u2B50\u2705\u274C]', '', 'g'),    -- every other emoji goes
                        '(\d)(diamonds?)\M', '\1 \2', 'gi'),                              -- 10diamonds -> 10 diamonds
                      '\s*\[[0-9a-f-]{36}\]\s*$', '', 'i'),                               -- trailing [uuid] reference
                    '\s*\((?:match|table|game|seat|round)\s+[0-9a-f-]{36}\)', '', 'gi'),  -- (match <uuid>)
                  '\s+for\s+[0-9a-f-]{36}\M', '', 'gi'),                                  -- for <uuid>
                '\s{2,}', ' ', 'g'),
              '^[\s,.:;-]+|[\s,.:;-]+$', '', 'g') AS line
        FROM resolved
    )
    SELECT CASE
        WHEN d = ''
          OR k IN ('daily_challenge_claim', 'daily_mission_milestone')
          OR LOWER(d) ~ '(audit|reconcil|retro-credit|orphaned|clawback|replay|bypass|cowork|make-good|certification|pipeline|verification|journaled|\mtest\M|phase\s?\d|drift|rollback|pre-fix|constraint|batch)'
          OR LOWER(d) ~ '^(challenge reward|diamond rewards v\d|diamond award|diamond deduction|deduct|training):'
          OR d ~ '^[a-z0-9_]+$'
          OR line ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}'
          OR line = ''
        THEN public.fn_diamond_kind_row_label(k, p_amount)
        ELSE line
    END
    FROM cleaned;
$fn$;

COMMENT ON FUNCTION public.fn_diamond_ledger_line(text, text, text, bigint, text) IS
  'The line a player reads for a diamond ledger row: the description when it is player copy, cleaned (dashes, glued units, emoji, uuids), else the row label for the kind. Operator notes, machine tails and test rows never reach a player. Pure. Casing is the surface''s (Title Case). DIAMONDS ONLY.';

-- PostgREST computed column: `select=id,amount,player_line` on diamond_transactions.
CREATE OR REPLACE FUNCTION public.player_line(t public.diamond_transactions)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
    SELECT public.fn_diamond_ledger_line(t.type, t.transaction_type, t.source, t.amount::bigint, t.description);
$fn$;

COMMENT ON FUNCTION public.player_line(public.diamond_transactions) IS
  'Computed column for diamond_transactions: the player-facing line for the row (fn_diamond_ledger_line), read under the row''s own RLS. Both wallets print this and nothing else from the description column.';

REVOKE ALL ON FUNCTION public.fn_diamond_kind_row_label(text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_kind_row_label(text, bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_diamond_ledger_line(text, text, text, bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_ledger_line(text, text, text, bigint, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.player_line(public.diamond_transactions) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.player_line(public.diamond_transactions) TO authenticated, service_role;

COMMIT;
