-- 20260914110559_where_the_diamonds_go.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (phase 5 of the diamond wallet programme):
--
-- THE DIAMOND ARENA IS DIAMONDS ONLY. NO CHIPS, EVER. (Dan, 2026-09-13.)
--
-- The wallet prints one Spent figure and one Earned figure. The ledger knows
-- what every diamond went on (arena seats, gifts, the store, VIP, club chips,
-- games) and where every diamond came from (daily rewards, gifts, arena
-- cash-outs, purchases, social, tournaments, refunds). With the arena the
-- intended sink, the player needs to see the split, and so do we.
--
-- Two functions. `fn_diamond_kind_bucket` maps a ledger kind to a bucket and
-- a player-facing label, by exact kind first and by pattern second, so a kind
-- added tomorrow lands somewhere sensible instead of vanishing - and it lives
-- in ONE place so the two wallets cannot bucket the same row differently.
-- `fn_diamond_flow_by_kind` sums a player's ledger by bucket, spent and
-- earned, lifetime and the last 30 days, in SQL over the whole ledger.
-- Read only; own-user only unless service_role.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

-- One place that says what a ledger row IS. The ledger carries three kind
-- columns: `type` (always set, sometimes a wrapper like 'spend' / 'earn' /
-- 'credit'), `transaction_type` (the specific kind, null on older rows) and
-- `source` (set by a few writers). Read on 2026-09-14: wherever both are set
-- they agree; the wrappers carry the real kind in transaction_type; the
-- phase41 reconciliation rows carry it in `type`. So: transaction_type first,
-- then source when type is a wrapper, then type. Exact kinds first, patterns
-- second, Other last: no row vanishes, and a kind added tomorrow lands
-- somewhere sensible until it is named here.
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
            -- ── SPENT (amount < 0) ─────────────────────────────────────────
            WHEN p_amount < 0 AND k = 'arena_deposit'                                     THEN 'arena'
            WHEN p_amount < 0 AND k IN ('diamond_gift_sent', 'live_gift_sent')            THEN 'gifts_sent'
            WHEN p_amount < 0 AND k LIKE '%vip%'                                          THEN 'vip'
            WHEN p_amount < 0 AND k IN ('chip_purchase', 'chip_mint')                     THEN 'club_chips'
            WHEN p_amount < 0 AND k IN ('plinko_drop', 'crash_bet', 'wheel_spin', 'pvp_stake',
                                        'game_cost', 'arcade_entry', 'memory_game', 'trivia_entry',
                                        'trivia_arcade', 'trivia_lifeline', 'training_entry',
                                        'daily_challenge_reroll')                         THEN 'games'
            WHEN p_amount < 0 AND (k LIKE '%purchase%' OR k LIKE '%unlock%' OR k LIKE '%feature%'
                                   OR k LIKE '%throwable%' OR k LIKE '%cosmetic%' OR k LIKE '%avatar%'
                                   OR k LIKE '%theme%' OR k LIKE '%video%')               THEN 'store'
            WHEN p_amount < 0 AND (k LIKE '%adjust%' OR k LIKE '%debt%' OR k LIKE '%reconcil%') THEN 'adjustments'
            WHEN p_amount < 0 AND k LIKE '%arena%'                                        THEN 'arena'
            WHEN p_amount < 0 AND k LIKE '%gift%'                                         THEN 'gifts_sent'
            WHEN p_amount < 0 AND (k LIKE '%bet%' OR k LIKE '%spin%' OR k LIKE '%stake%'
                                   OR k LIKE '%game%' OR k LIKE '%arcade%' OR k LIKE '%trivia%'
                                   OR k LIKE '%training%' OR k LIKE '%entry%')            THEN 'games'
            WHEN p_amount < 0                                                             THEN 'other_spent'
            -- ── EARNED (amount > 0) ────────────────────────────────────────
            WHEN k = 'arena_withdraw'                                                     THEN 'arena_cash_outs'
            WHEN k IN ('diamond_gift_received', 'live_gift_received', 'transfer')         THEN 'gifts_received'
            WHEN k IN ('diamond_purchase', 'purchase', 'mint', 'store_purchase')          THEN 'purchases'
            WHEN k IN ('daily_login', 'daily_bonus', 'daily_challenge_claim', 'daily_mission_milestone',
                       'streak_reward', 'daily_trivia', 'signup_bonus', 'bonus', 'easter_egg',
                       'achievement', 'challenge', 'promo_code', 'trivia_run', 'trivia_reward',
                       'game_reward', 'training_reward', 'wheel_prize')                  THEN 'rewards'
            WHEN k IN ('tournament_prize', 'pvp_win', 'pvp_prize', 'crash_win', 'plinko_win') THEN 'winnings'
            WHEN k IN ('vip_reward', 'vip_stipend', 'vip_daily', 'vip_bonus')             THEN 'vip_bonuses'
            WHEN k IN ('social_post', 'follow', 'reaction', 'comment', 'share', 'referral',
                       'profile_complete', 'profile_pic', 'video_watch', 'video_favorite',
                       'hendonmob_link', 'venue_review')                                  THEN 'social'
            WHEN k LIKE '%refund%'                                                        THEN 'refunds'
            WHEN k LIKE '%adjust%' OR k LIKE '%reconcil%' OR k LIKE '%debt%'              THEN 'adjustments'
            WHEN k LIKE '%arena%'                                                         THEN 'arena_cash_outs'
            WHEN k LIKE '%gift%'                                                          THEN 'gifts_received'
            WHEN k LIKE '%vip%'                                                           THEN 'vip_bonuses'
            WHEN k LIKE '%purchase%'                                                      THEN 'purchases'
            WHEN k LIKE '%prize%' OR k LIKE '%win%'                                       THEN 'winnings'
            WHEN k LIKE '%daily%' OR k LIKE '%bonus%' OR k LIKE '%reward%'
                 OR k LIKE '%challenge%' OR k LIKE '%mission%'                            THEN 'rewards'
            WHEN k LIKE '%social%' OR k LIKE '%profile%' OR k LIKE '%referral%'           THEN 'social'
            ELSE 'other_earned'
        END AS bucket
        FROM resolved
    )
    SELECT k AS kind, bucket, CASE bucket
            WHEN 'arena'           THEN 'Diamond Arena Seats'
            WHEN 'gifts_sent'      THEN 'Gifts To Friends'
            WHEN 'vip'             THEN 'VIP Membership'
            WHEN 'club_chips'      THEN 'Club Chip Purchases'
            WHEN 'games'           THEN 'Games And Arcade'
            WHEN 'store'           THEN 'Store Items And Perks'
            WHEN 'adjustments'     THEN 'Adjustments'
            WHEN 'other_spent'     THEN 'Other'
            WHEN 'arena_cash_outs' THEN 'Diamond Arena Cash-Outs'
            WHEN 'gifts_received'  THEN 'Gifts From Friends'
            WHEN 'purchases'       THEN 'Diamonds You Bought'
            WHEN 'rewards'         THEN 'Daily Rewards And Challenges'
            WHEN 'winnings'        THEN 'Tournament And PvP Winnings'
            WHEN 'vip_bonuses'     THEN 'VIP Bonuses'
            WHEN 'social'          THEN 'Social And Community'
            WHEN 'refunds'         THEN 'Refunds'
            ELSE 'Other'
        END AS label
    FROM bucketed;
$fn$;

COMMENT ON FUNCTION public.fn_diamond_kind_bucket(text, text, text, bigint) IS
  'Resolves a diamond_transactions row (type, transaction_type, source, amount) to its kind, a spend/earn bucket and a player-facing label. Exact kinds first, patterns second, Other last, so no row vanishes. ONE place, so both wallets bucket identically. DIAMONDS ONLY: club_chips is a chip purchase in a member club; the Diamond Arena has no chips.';

CREATE OR REPLACE FUNCTION public.fn_diamond_flow_by_kind(
    p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
    v_user uuid := COALESCE(p_user_id, auth.uid());
    v_role text := COALESCE(auth.jwt() ->> 'role', current_user);
    v_out  jsonb;
BEGIN
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501';
    END IF;
    IF v_role <> 'service_role' AND v_user IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'diamond_flow_is_own_only' USING ERRCODE = '42501';
    END IF;

    WITH rows AS (
        SELECT t.amount::bigint AS amount, t.created_at, b.bucket, b.label
          FROM public.diamond_transactions t
          CROSS JOIN LATERAL public.fn_diamond_kind_bucket(t.type, t.transaction_type, t.source, t.amount::bigint) b
         WHERE t.user_id = v_user AND t.amount <> 0
    ),
    agg AS (
        SELECT bucket, label,
               (amount < 0) AS spent,
               SUM(ABS(amount))::bigint AS lifetime_amount,
               COUNT(*)::integer AS lifetime_count,
               COALESCE(SUM(ABS(amount)) FILTER (WHERE created_at >= now() - interval '30 days'), 0)::bigint AS last30_amount,
               COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')::integer AS last30_count
          FROM rows
         GROUP BY bucket, label, (amount < 0)
    )
    SELECT jsonb_build_object(
        'user_id', v_user,
        'spent', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                    'bucket', bucket, 'label', label,
                    'lifetime', lifetime_amount, 'lifetime_count', lifetime_count,
                    'last30', last30_amount, 'last30_count', last30_count)
                  ORDER BY lifetime_amount DESC, bucket)
                  FROM agg WHERE spent), '[]'::jsonb),
        'earned', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                    'bucket', bucket, 'label', label,
                    'lifetime', lifetime_amount, 'lifetime_count', lifetime_count,
                    'last30', last30_amount, 'last30_count', last30_count)
                  ORDER BY lifetime_amount DESC, bucket)
                  FROM agg WHERE NOT spent), '[]'::jsonb),
        'spent_total',   COALESCE((SELECT SUM(lifetime_amount) FROM agg WHERE spent), 0),
        'earned_total',  COALESCE((SELECT SUM(lifetime_amount) FROM agg WHERE NOT spent), 0),
        'spent_last30',  COALESCE((SELECT SUM(last30_amount) FROM agg WHERE spent), 0),
        'earned_last30', COALESCE((SELECT SUM(last30_amount) FROM agg WHERE NOT spent), 0),
        'read_at', now()
    ) INTO v_out;

    RETURN v_out;
END;
$fn$;

COMMENT ON FUNCTION public.fn_diamond_flow_by_kind(uuid) IS
  'Where a player''s diamonds go and come from: the ledger summed by bucket (fn_diamond_kind_bucket), spent and earned, lifetime and the last 30 days, in SQL over the whole ledger. Read only; own-user only unless service_role. DIAMONDS ONLY.';

REVOKE ALL ON FUNCTION public.fn_diamond_kind_bucket(text, text, text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_kind_bucket(text, text, text, bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_diamond_flow_by_kind(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_flow_by_kind(uuid) TO authenticated, service_role;

COMMIT;
