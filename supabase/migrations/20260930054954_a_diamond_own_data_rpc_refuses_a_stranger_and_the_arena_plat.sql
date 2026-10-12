-- 20260930054954_a_diamond_own_data_rpc_refuses_a_stranger_and_the_arena_plat.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (deep-dive audit of the diamond wallet database
-- layer, 2026-09-30). Three defects, one transaction, no new object.
--
-- 1. fn_diamond_lifetime_totals ANSWERED 0 WHERE IT COULD NOT TELL.
--
-- Its three sibling own-data functions each refuse a caller who is neither the
-- subject nor service_role, and each refusal was verified to fire:
-- wallet_summary_is_own_only, diamond_flow_is_own_only,
-- arena_reconciliation_is_own_only, all SQLSTATE 42501. This one had no guard
-- at all. It is SECURITY INVOKER, so RLS policy diamond_transactions_select_own
-- did hold and no money leaked - but a caller naming somebody else's id got
-- lifetime_earned 0, lifetime_spent 0, credits 0, debits 0. Measured on
-- production against a wallet that actually holds 613,595 earned and 132,320
-- spent: four confident zeros, indistinguishable from a brand-new account.
-- CLAUDE.md 10.86 rules 1 and 2: "I could not tell" is a distinct outcome and
-- must have its own name, and an unreadable answer is never coerced into an
-- empty one. It now refuses by name, in the siblings' style, with its own:
-- lifetime_totals_is_own_only.
--
-- The guard is the siblings' expression exactly - service_role may name any
-- user, and it must, because the World Hub route
-- pages/api/store/diamond-transactions.js calls this RPC with an explicit
-- p_user_id under a service-role client (auth.uid() is NULL there) and is
-- entitled to. Club Arena's DiamondService.getLifetimeStats passes the signed-in
-- user's own id from the browser and is unaffected. fn_diamond_wallet_summary
-- calls this function for v_user, which its own guard has already pinned to
-- auth.uid() unless the caller is service_role, so the nested call passes too.
--
-- The language changes from sql to plpgsql only because a guard has to be able
-- to RAISE. The signature, the four output columns and the sums are unchanged.
--
-- 2. THE ARENA PLATE CONTRADICTED ITSELF.
--
-- fn_diamond_wallet_summary computed open_cash_tables, min_cash_buy_in and
-- cheapest_table WITHOUT consulting cash_games_enabled, so it handed the wallet
-- "17 open cash tables, cheapest seat 80 Diamonds, NLH 1/2" for an arena whose
-- cash games are switched off. Read live 2026-09-30: ca_arena_settings row 1
-- has cash_games_enabled false and tournaments_enabled false, and the 17 tables
-- are the arena's pre-provisioned stake ladder, all created 2026-09-11 and all
-- still 'waiting'.
--
-- WHICH SOURCE IS AUTHORITATIVE: the switch. cash_games_enabled is the
-- admission switch fn_poker_diamond_buyin and fn_poker_diamond_top_up enforce -
-- they are the only doors that fund a Diamond seat, and while it is false every
-- one of those 17 tables refuses a buy-in by name. A table nobody can sit at is
-- not an open table, so the count was the thing that was wrong, not the flag.
-- The scan is now skipped entirely while the switch is off, which also spares
-- the wallet a 17-predicate table scan it could never act on. Open the switch
-- and the same three fields answer exactly as they do today.
--
-- No client behaviour changes today: PlayerWalletPage already gates the
-- cheapest-seat sentence and the Sit Down control on cashGamesEnabled ||
-- tournamentsEnabled, and the World Hub route reads only the two flags. This
-- makes the RPC agree with the surfaces instead of relying on every reader to
-- remember the rule.
--
-- 3. A PLAYER WAS SHOWN THE WORD "Test Entry".
--
-- fn_diamond_kind_row_label mapped every kind matching 'test%' to the operator
-- string 'Test Entry'. Four production rows render it to a player today (kinds
-- test, test_verify, test_ref_id; +1, +1, -1, -1 Diamonds; 2026-02-21 through
-- 2026-05-17). They are real one-Diamond corrections, so they take the label
-- the platform already uses for a correction, 'Balance Adjustment'. Nothing
-- else in the map changes; the journal is append-only and no row is rewritten.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).
--
-- Horses are players (10.5): nothing here reads or writes is_horse, and none of
-- these three functions has ever taken an include/exclude flag.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- A. NO PLAYER READS THE WORD "Test Entry" (defect 3 in the header above)
-- ─────────────────────────────────────────────────────────────────────────────

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
        WHEN k.k LIKE 'test%'                                                THEN 'Balance Adjustment'
        ELSE NULL
    END, (SELECT b.label FROM public.fn_diamond_kind_bucket(k.k, k.k, NULL, p_amount) b))
    FROM k;
$fn$;

COMMENT ON FUNCTION public.fn_diamond_kind_row_label(text, bigint) IS
  'The player-facing row label for a diamond ledger kind ("Daily Challenge Reward", "Diamond Arena Buy-In"); falls back to the bucket label from fn_diamond_kind_bucket. Pure; Title Case at the source. The test kinds take Balance Adjustment, the label the platform already uses for a correction: "Test Entry" was operator copy on a player''s screen (2026-09-30). DIAMONDS ONLY.';

REVOKE ALL ON FUNCTION public.fn_diamond_kind_row_label(text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_kind_row_label(text, bigint) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- B. THE LIFETIME TOTALS REFUSE A STRANGER INSTEAD OF ANSWERING ZERO (defect 1)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_diamond_lifetime_totals(
    p_user_id uuid DEFAULT auth.uid()
)
RETURNS TABLE(lifetime_earned bigint, lifetime_spent bigint, credits bigint, debits bigint)
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $fn$
DECLARE
    v_user uuid := COALESCE(p_user_id, auth.uid());
    v_role text := COALESCE(auth.jwt() ->> 'role', current_user);
BEGIN
    -- The siblings' two refusals, word for word, with this function's own name.
    -- Never a zero for a question this function cannot answer (10.86).
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501';
    END IF;
    IF v_role <> 'service_role' AND v_user IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'lifetime_totals_is_own_only' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT
        COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount END), 0)::bigint,
        COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount END), 0)::bigint,
        COUNT(*) FILTER (WHERE t.amount > 0)::bigint,
        COUNT(*) FILTER (WHERE t.amount < 0)::bigint
    FROM public.diamond_transactions t
    WHERE t.user_id = v_user;
END;
$fn$;

COMMENT ON FUNCTION public.fn_diamond_lifetime_totals(uuid) IS
  'Lifetime diamonds earned (sum of positive rows) and spent (sum of |negative rows|) for one user, summed in SQL over the WHOLE ledger. SECURITY INVOKER: RLS on diamond_transactions decides visibility. Own-user only unless service_role, refusing with lifetime_totals_is_own_only (42501) - before 2026-09-30 it answered four zeros for a user it could not read, which reads as a brand-new account (10.86).';

REVOKE ALL ON FUNCTION public.fn_diamond_lifetime_totals(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_lifetime_totals(uuid) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- C. THE ARENA PLATE AGREES WITH THE SWITCH (defect 2)
--
-- LAST IN THE FILE ON PURPOSE: tests/the-route-and-the-client-agree.law.test.ts
-- reads this function's answer keys by slicing from `RETURN jsonb_build_object(`
-- to the end of the migration, so anything declared after it is read as another
-- key of the wallet summary.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_diamond_wallet_summary(
    p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
    v_user       uuid := COALESCE(p_user_id, auth.uid());
    v_role       text := COALESCE(auth.jwt() ->> 'role', current_user);
    v_on_hand    bigint;
    v_collateral bigint;
    v_in_arena   bigint;
    v_seats      integer;
    v_entries    integer;
    v_arena      record;
    v_cheapest   record;
    v_open       integer := 0;
    v_lifetime   record;
BEGIN
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'authentication_required' USING ERRCODE = '42501';
    END IF;
    IF v_role <> 'service_role' AND v_user IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'wallet_summary_is_own_only' USING ERRCODE = '42501';
    END IF;

    SELECT COALESCE(diamonds, 0)::bigint INTO v_on_hand
      FROM public.profiles WHERE id = v_user;
    v_on_hand := COALESCE(v_on_hand, 0);

    SELECT COALESCE(SUM(GREATEST(issued - consumed - refunded - arena_reserved, 0)), 0)::bigint
      INTO v_collateral
      FROM public.diamond_purchase_lots WHERE user_id = v_user;

    SELECT COALESCE(SUM(balance), 0)::bigint,
           COUNT(*) FILTER (WHERE purpose = 'cash_seat')::integer,
           COUNT(*) FILTER (WHERE purpose = 'tournament_entry')::integer
      INTO v_in_arena, v_seats, v_entries
      FROM public.poker_diamond_custody
     WHERE user_id = v_user AND state <> 'released';

    SELECT c.id, c.name, c.slug, a.cash_games_enabled, a.tournaments_enabled
      INTO v_arena
      FROM public.ca_arena_settings a
      JOIN public.clubs c ON c.id = a.club_id
     WHERE a.id = 1 AND c.asset = 'diamonds' AND c.is_platform IS TRUE;

    -- THE PLATE MAY NOT CONTRADICT THE SWITCH (2026-09-30). These three fields
    -- used to be computed whatever cash_games_enabled said, so a closed arena
    -- still reported 17 open tables and a named 80-Diamond seat. The switch is
    -- the authority: it is what fn_poker_diamond_buyin and fn_poker_diamond_top_up
    -- enforce, and while it is false every one of those tables refuses a buy-in.
    -- Closed therefore means open_cash_tables 0, min_cash_buy_in NULL and
    -- cheapest_table NULL, and the scan does not run at all.
    IF v_arena.id IS NOT NULL AND COALESCE(v_arena.cash_games_enabled, false) THEN
        -- The cheapest seat a player could actually take: the same predicate
        -- fn_poker_diamond_buyin admits on, so this number is never a seat
        -- that function would refuse.
        SELECT t.id, t.name, t.small_blind, t.big_blind, t.min_buy_in,
               COUNT(*) OVER ()::integer AS open_count
          INTO v_cheapest
          FROM public.tables t
         WHERE t.club_id = v_arena.id
           AND t.game_variant = 'nlh'
           AND t.tournament_id IS NULL
           AND t.cluster_id IS NULL
           AND NOT COALESCE(t.is_template, false)
           AND t.status IN ('waiting', 'running', 'playing', 'active')
           AND COALESCE(t.rake_percent, 0) = 0 AND COALESCE(t.bbj_percent, 0) = 0
           AND NOT COALESCE(t.insurance_enabled, false) AND NOT COALESCE(t.bomb_pot_enabled, false)
           AND NOT COALESCE(t.run_it_twice_enabled, false) AND NOT COALESCE(t.run_it_twice, false)
           AND NOT COALESCE(t.allow_run_it_twice, false) AND NOT COALESCE(t.straddle_enabled, false)
           AND NOT COALESCE(t.seven_deuce_enabled, false) AND NOT COALESCE(t.nit_game, false)
           AND NOT COALESCE(t.all_in_or_fold, false) AND NOT COALESCE(t.pineapple_holdem, false)
           AND NOT COALESCE(t.cap_enabled, false) AND NOT COALESCE(t.auto_utg_straddle, false)
           AND NOT COALESCE(t.voluntary_straddle, false)
           AND t.min_buy_in IS NOT NULL AND t.min_buy_in > 0
         ORDER BY t.min_buy_in ASC, t.big_blind ASC, t.name ASC
         LIMIT 1;
        v_open := COALESCE(v_cheapest.open_count, 0);
    END IF;

    SELECT * INTO v_lifetime FROM public.fn_diamond_lifetime_totals(v_user);

    RETURN jsonb_build_object(
        'user_id',        v_user,
        'on_hand',        v_on_hand,
        'collateral',     v_collateral,
        'sendable',       GREATEST(v_on_hand - v_collateral, 0),
        'in_arena',       v_in_arena,
        'arena_seats',    v_seats,
        'arena_entries',  v_entries,
        'arena', CASE WHEN v_arena.id IS NULL THEN NULL ELSE jsonb_build_object(
            'club_id',             v_arena.id,
            'name',                v_arena.name,
            'slug',                v_arena.slug,
            'cash_games_enabled',  COALESCE(v_arena.cash_games_enabled, false),
            'tournaments_enabled', COALESCE(v_arena.tournaments_enabled, false),
            'open_cash_tables',    v_open,
            'min_cash_buy_in',     CASE WHEN v_cheapest.id IS NULL THEN NULL
                                        ELSE v_cheapest.min_buy_in::bigint END,
            'cheapest_table',      CASE WHEN v_cheapest.id IS NULL THEN NULL ELSE jsonb_build_object(
                'id',          v_cheapest.id,
                'name',        v_cheapest.name,
                'small_blind', v_cheapest.small_blind,
                'big_blind',   v_cheapest.big_blind
            ) END
        ) END,
        'lifetime_earned', COALESCE(v_lifetime.lifetime_earned, 0),
        'lifetime_spent',  COALESCE(v_lifetime.lifetime_spent, 0),
        'read_at',         now()
    );
END;
$fn$;

COMMENT ON FUNCTION public.fn_diamond_wallet_summary(uuid) IS
  'The diamond wallet in one read: on_hand, collateral (the transfer RPC''s own refusal expression), sendable, in_arena (open poker_diamond_custody) with seat/entry counts, the Diamond Arena club with its open flags, its cheapest eligible cash seat (fn_poker_diamond_buyin''s own table predicate) and open table count, and lifetime totals. The seat figures obey cash_games_enabled: a closed arena reports 0 open tables and no cheapest seat, because the buy-in doors refuse every one of them. DIAMONDS ONLY: the Diamond Arena has no chips, ever. Own-user only unless service_role.';

REVOKE ALL ON FUNCTION public.fn_diamond_wallet_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_diamond_wallet_summary(uuid) TO authenticated, service_role;

COMMIT;
