-- 20261019092327_the_daily_login_streak_counts_consecutive_days_again.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- TIER:         3 (diamond payouts)
-- AUTHOR:       Claude (session 01NeFtpaosJDSLE13ps9HZgX), Phase 1A of Dan's
--               launch-day programme ("START PHASE 1.").
-- AFFECTS:      public.award_diamonds_v2 (daily_login branch only),
--               public.diamond_transactions + profiles.diamonds (one back-pay
--               credit per affected player, through add_diamonds_to_balance)
-- IRREVERSIBLE: the back-pay is (diamonds are never clawed back). The function
--               change is reversible by re-installing the pre-image, whose md5
--               is pinned below.
--
-- WHAT WAS WRONG, READ FROM ROWS ON 2026-10-19:
--
--   The daily login reward is 10 on day one and 5 more for every consecutive
--   day, to a ceiling of 110 (award_diamonds_v2: c_login_base 10, c_login_step
--   5, c_login_max 110; streak = consecutive Chicago days with a daily_login
--   credit ending yesterday, plus today). The live body counted the run with
--
--       WHERE d = v_today - rn
--
--   rn is ROW_NUMBER(), a bigint, and Postgres has no date - bigint operator,
--   so the statement fails at run time with 42883. It sat inside
--   BEGIN ... EXCEPTION WHEN others THEN v_streak := 0, which swallowed the
--   error, so every award since was the day-one minimum. The last correct
--   streak recorded is 2026-09-06 06:37 UTC (smarterpoker, streak 3); from
--   2026-09-07 every daily_login row records streak 1 and pays 10. The week of
--   2026-08-31 still paid streaks up to 24 and 110 a day. The same symptom is
--   on the rows of this rule's first week, 2026-08-07 to 08-15 (catalog
--   version 3 recorded streak 1 on four of kingfish's consecutive days) until
--   2026-08-16, when it counted again. The live body matched no migration file
--   in this repository (drift); this file is now its source.
--
-- THE FIX (CLAUDE.md 10.11): the run length is counted with
--
--       WHERE d = v_today - rn::int
--
--   and the exception handler around it is REMOVED. It existed only to hide
--   this error; a failure counting a streak now fails the award loudly instead
--   of paying the wrong amount without a word. Nothing else in the function
--   changes: the pre-image md5 is asserted, the new body's md5 is asserted
--   after install, and the ACL is restated as it is live.
--
-- THE DAMAGE, SETTLED ONCE (CLAUDE.md 10.9, 10.12 - no job, no sweep):
--
--   For every daily_login credit paid under this rule (catalog version 3, in
--   force since 2026-08-07; the earlier catalogs priced logins differently and
--   are not touched), the streak it should have carried is derived from the
--   same rows the function reads (consecutive Chicago days with a daily_login
--   credit), the amount from the function's own rule and
--   the multiplier recorded on that row, and the shortfall is limited by the
--   daily and monthly allowance the player had left that day (150/4,500 VIP,
--   110/3,300 otherwise, from the cap-counted rows of that day and month), so
--   nobody is paid past a cap the live path would have applied. The model is
--   checked against the witness first: wherever the function did count a
--   streak (recorded streak above 1) it must equal this derivation and must
--   have paid this derivation's amount unless it recorded a cap; the only
--   credits owed anything are those with the defect's signature (recorded
--   streak 1 on a day that continued a run). Each player is then paid the total once through
--   add_diamonds_to_balance, type 'adjustment' (no multiplier is applied a
--   second time, and the correction does not spend today's earning
--   allowance), reference 'daily_login_streak_backpay:<player id>' - a re-run
--   pays nobody twice.
--
--   Proved first in a self-aborting probe (one call, one DO block ending in
--   RAISE EXCEPTION) at 2026-10-19 09:39:37 UTC. 34 logins were short across
--   three players, all humans (no horse has a daily_login credit; horses
--   would be paid by the same rule), every multiplier 1.00, no cap ever bound:
--     kingfish      620  (20 logins: 2026-09-07..09-10 at streak 25-28 paid
--                         10 instead of 110, 12 more in Sep/Oct, and 4 in
--                         Aug 7-15 worth 50)
--     smarterpoker   95  (8 logins)
--     danimal5022    40  (6 logins)
--   755 diamonds in all. The migration requires exactly those amounts for the
--   logins made before the probe; a login made between the probe and the
--   install is short by the same rule and is paid with it, and reported.
--
-- PRE-IMAGE: md5(pg_get_functiondef(public.award_diamonds_v2(uuid,text,text,text,jsonb)))
--            = 5c3f0cfa1e932d72b52c667374fbcb8c (prosrc 8135d921728dfb319ff0a9d675791ce7)
-- POST-IMAGE: md5(prosrc) = 2218957f43bc6c653f7827b6344164ea
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $preimage$
DECLARE
    v_md5 text;
BEGIN
    SELECT md5(pg_get_functiondef(p.oid)) INTO v_md5
      FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.award_diamonds_v2(uuid,text,text,text,jsonb)');
    IF v_md5 IS DISTINCT FROM '5c3f0cfa1e932d72b52c667374fbcb8c' THEN
        RAISE EXCEPTION 'pre-image: award_diamonds_v2 is not the body this migration was written against (md5 %)', v_md5;
    END IF;
END $preimage$;

CREATE OR REPLACE FUNCTION public.award_diamonds_v2(p_user_id uuid, p_action_key text, p_reference_id text DEFAULT NULL::text, p_target_id text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    c_catalog_version   constant integer := 3;
    c_platform_budget   constant bigint  := 2500000;

    c_login_base        constant integer := 10;
    c_login_step        constant integer := 5;
    c_login_max         constant integer := 110;

    c_egg_monthly_cap   constant integer := 1000;
    c_egg_max_single    constant integer := 1000;

    c_streak_monthly_cap       constant integer := 1000;
    c_daily_bonus_monthly_cap  constant integer := 3750;
    c_training_monthly_cap     constant integer := 1500;
    c_achievement_monthly_cap  constant integer := 1000;
    c_challenge_monthly_cap    constant integer := 1000;

    v_now               timestamptz := now();
    v_today             date;
    v_day_start         timestamptz;
    v_day_end           timestamptz;
    v_month_start       timestamptz;
    v_month_end         timestamptz;
    v_period            text;

    v_found_action      boolean;
    v_base_diamonds     integer;
    v_max_per_day       integer;
    v_counts_cap        boolean;
    v_lifetime          boolean;
    v_category          text;

    v_balance           integer := 0;
    v_multiplier        numeric(6,2) := 1.00;
    v_is_vip            boolean := false;
    v_vip_tier          text;
    v_vip_expires_at    timestamptz;

    v_daily_cap         integer;
    v_monthly_cap       integer;
    v_daily_used        integer := 0;
    v_monthly_used      integer := 0;
    v_daily_remaining   integer;
    v_monthly_remaining integer;

    v_reference_id      text;
    v_requested         integer := 0;
    v_award             integer := 0;
    v_capped            boolean := false;
    v_streak            integer := 0;
    v_action_count      integer := 0;
    v_egg_request       integer := 0;
    v_family_request    integer := 0;
    v_streak_entitlement_continuation boolean := false;
    v_streak_entitlement_initialization boolean := false;
    v_streak_milestone_days integer := 0;
    v_streak_milestone_base integer := 0;
    v_streak_entitlement integer := 0;
    v_streak_already_awarded integer := 0;
    v_streak_claim_count integer := 0;
    v_expected_streak_reference text;

    -- These values always describe the same action family. The allowance is
    -- deliberately applied only after v_requested has been multiplied.
    v_family_monthly_cap integer;
    v_family_month_total bigint := 0;
    v_family_remaining   bigint := 0;
    v_family_all_or_nothing boolean := false;

    v_budget_total      bigint;
    v_budget_spent      bigint;
    v_budget_left       bigint;
    v_new_balance       integer;
    v_metadata          jsonb;
    v_profile_rows      integer := 0;
    v_constraint_name   text;
BEGIN
    v_today       := (v_now AT TIME ZONE 'America/Chicago')::date;
    v_day_start   := v_today::timestamp AT TIME ZONE 'America/Chicago';
    v_day_end     := (v_today + 1)::timestamp AT TIME ZONE 'America/Chicago';
    v_month_start := date_trunc('month', v_today::timestamp) AT TIME ZONE 'America/Chicago';
    v_month_end   := (date_trunc('month', v_today::timestamp) + interval '1 month')
                     AT TIME ZONE 'America/Chicago';
    v_period      := to_char(v_today, 'YYYY-MM');

    IF p_user_id IS NULL OR p_action_key IS NULL OR btrim(p_action_key) = '' THEN
        RETURN jsonb_build_object(
            'success', false, 'awarded', 0, 'requested', 0,
            'reason', 'invalid_input', 'capped', false,
            'daily_remaining', 0, 'monthly_remaining', 0, 'balance_after', 0
        );
    END IF;

    v_reference_id := COALESCE(btrim(p_reference_id), '');
    v_metadata     := COALESCE(p_metadata, '{}'::jsonb);

    -- Only the server-owned milestone claim ledger may submit an amount that
    -- is already post-multiplier. The row and exact part reference are checked
    -- again below; arbitrary service callers cannot use metadata to bypass a
    -- user's multiplier or manufacture an entitlement.
    BEGIN
        v_streak_entitlement_continuation :=
            p_action_key = 'streak_reward'
            AND COALESCE(v_metadata ->> '_source', '') = 'fn_claim_training_streak_milestone_v2'
            AND COALESCE((v_metadata ->> 'post_multiplier_entitlement')::boolean, false);
        v_streak_entitlement_initialization :=
            p_action_key = 'streak_reward'
            AND COALESCE(v_metadata ->> '_source', '') = 'fn_claim_training_streak_milestone_v2'
            AND NOT v_streak_entitlement_continuation;
    EXCEPTION WHEN invalid_text_representation THEN
        v_streak_entitlement_continuation := false;
        v_streak_entitlement_initialization := false;
    END;

    -- Serialize every award for one user before reading any user-owned state.
    -- The first integer is a namespace reserved for award_diamonds_v2; a hash
    -- collision can only over-serialize two users, never weaken correctness.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        1799876946,
        pg_catalog.hashtext(p_user_id::text)
    );

    SELECT true, c.diamonds, c.max_per_day, c.counts_toward_daily_cap,
           c.lifetime, c.category
      INTO v_found_action, v_base_diamonds, v_max_per_day, v_counts_cap,
           v_lifetime, v_category
      FROM public.diamond_reward_catalog c
     WHERE c.action_key = p_action_key
       AND c.active = true;

    IF NOT FOUND OR NOT COALESCE(v_found_action, false) THEN
        RETURN jsonb_build_object(
            'success', false, 'awarded', 0, 'requested', 0,
            'reason', 'unknown_action', 'capped', false,
            'daily_remaining', 0, 'monthly_remaining', 0, 'balance_after', 0
        );
    END IF;

    -- This row lock is both a cross-function serialization boundary and the
    -- authoritative balance/multiplier snapshot used by every write below.
    SELECT COALESCE(pr.diamonds, 0),
           COALESCE(pr.diamond_multiplier, 1.00),
           COALESCE(pr.is_vip, false),
           pr.vip_tier,
           pr.vip_expires_at
      INTO v_balance, v_multiplier, v_is_vip, v_vip_tier, v_vip_expires_at
      FROM public.profiles pr
     WHERE pr.id = p_user_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false, 'awarded', 0, 'requested', 0,
            'reason', 'user_not_found', 'capped', false,
            'daily_remaining', 0, 'monthly_remaining', 0, 'balance_after', 0
        );
    END IF;

    -- Keep the currently deployed 1x..10x validation contract. Regardless of
    -- the stored multiplier, the post-multiplier caps below remain absolute.
    IF v_multiplier IS NULL OR v_multiplier <= 0 OR v_multiplier > 10 THEN
        v_multiplier := 1.00;
    END IF;

    -- COALESCE is intentional: SQL NULL must never make this VIP check fail
    -- open. The standing economy invariant inspects this exact property.
    v_is_vip := COALESCE(v_is_vip, false)
        AND (
            COALESCE(v_vip_tier, '') = 'lifetime'
            OR (v_vip_expires_at IS NOT NULL AND v_vip_expires_at > v_now)
        );

    -- Kill switch (Diamond Accounting Standard 3.4 layer 6, review D11): a human-opened
    -- diamond_issuance freeze refuses every promotional award until it is cleared.
    IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f WHERE f.scope = 'diamond_issuance' AND f.cleared_at IS NULL) THEN
        RETURN jsonb_build_object(
            'success', false, 'awarded', 0, 'requested', 0,
            'reason', 'diamond_issuance_frozen', 'capped', false,
            'daily_remaining', 0, 'monthly_remaining', 0, 'balance_after', v_balance
        );
    END IF;

    v_daily_cap   := CASE WHEN v_is_vip THEN 150 ELSE 110 END;
    v_monthly_cap := CASE WHEN v_is_vip THEN 4500 ELSE 3300 END;

    IF v_counts_cap THEN
        SELECT COALESCE(SUM(t.amount), 0)::int
          INTO v_daily_used
          FROM public.diamond_transactions t
          JOIN public.diamond_reward_catalog c ON c.action_key = t.transaction_type
         WHERE t.user_id = p_user_id
           AND t.amount > 0
           AND c.counts_toward_daily_cap = true
           AND t.created_at >= v_day_start
           AND t.created_at < v_day_end;

        SELECT COALESCE(SUM(t.amount), 0)::int
          INTO v_monthly_used
          FROM public.diamond_transactions t
          JOIN public.diamond_reward_catalog c ON c.action_key = t.transaction_type
         WHERE t.user_id = p_user_id
           AND t.amount > 0
           AND c.counts_toward_daily_cap = true
           AND t.created_at >= v_month_start
           AND t.created_at < v_month_end;
    END IF;

    v_daily_remaining   := GREATEST(v_daily_cap - v_daily_used, 0);
    v_monthly_remaining := GREATEST(v_monthly_cap - v_monthly_used, 0);

    IF v_max_per_day IS NOT NULL THEN
        SELECT COUNT(*)::int
          INTO v_action_count
          FROM public.diamond_transactions t
         WHERE t.user_id = p_user_id
           AND t.transaction_type = p_action_key
           AND t.amount > 0
           AND t.created_at >= v_day_start
           AND t.created_at < v_day_end;

        IF v_action_count >= v_max_per_day THEN
            RETURN jsonb_build_object(
                'success', false, 'awarded', 0, 'requested', 0,
                'reason', 'action_limit', 'capped', true,
                'daily_remaining', v_daily_remaining,
                'monthly_remaining', v_monthly_remaining,
                'balance_after', v_balance,
                'multiplier', v_multiplier
            );
        END IF;
    END IF;

    IF v_lifetime AND EXISTS (
        SELECT 1
          FROM public.diamond_transactions t
         WHERE t.user_id = p_user_id
           AND t.transaction_type = p_action_key
           AND t.amount > 0
    ) THEN
        RETURN jsonb_build_object(
            'success', false, 'awarded', 0, 'requested', 0,
            'reason', 'already_claimed', 'capped', false,
            'daily_remaining', v_daily_remaining,
            'monthly_remaining', v_monthly_remaining,
            'balance_after', v_balance
        );
    END IF;

    IF v_reference_id <> '' AND EXISTS (
        SELECT 1
          FROM public.diamond_transactions t
         WHERE t.user_id = p_user_id
           AND t.reference_id = v_reference_id
    ) THEN
        RETURN jsonb_build_object(
            'success', false, 'awarded', 0, 'requested', 0,
            'reason', 'duplicate', 'capped', false,
            'daily_remaining', v_daily_remaining,
            'monthly_remaining', v_monthly_remaining,
            'balance_after', v_balance
        );
    END IF;

    v_requested := COALESCE(v_base_diamonds, 0);

    IF p_action_key = 'daily_login' THEN
        -- The run of consecutive Chicago days with a daily_login credit that
        -- ends yesterday: the n-th most recent prior day is on the run only if
        -- it is exactly n days ago. rn is a bigint and date - bigint does not
        -- exist, so it is cast; there is deliberately no exception handler
        -- here (2026-10-19: one swallowed that type error from 2026-09-07 and
        -- paid every login the day-one minimum).
        WITH ranked AS (
            SELECT (created_at AT TIME ZONE 'America/Chicago')::date AS d,
                   ROW_NUMBER() OVER (
                       ORDER BY (created_at AT TIME ZONE 'America/Chicago')::date DESC
                   ) AS rn
              FROM public.diamond_transactions
             WHERE user_id = p_user_id
               AND transaction_type = 'daily_login'
               AND amount > 0
               AND (created_at AT TIME ZONE 'America/Chicago')::date < v_today
             GROUP BY 1
        )
        SELECT COUNT(*)::int
          INTO v_streak
          FROM ranked
         WHERE d = v_today - rn::int;

        v_streak    := v_streak + 1;
        v_requested := LEAST(c_login_base + (v_streak - 1) * c_login_step, c_login_max);

    ELSIF p_action_key = 'easter_egg' THEN
        BEGIN
            v_egg_request := COALESCE((v_metadata ->> 'egg_diamonds')::int, 0);
        EXCEPTION WHEN others THEN
            v_egg_request := 0;
        END;

        v_egg_request := LEAST(GREATEST(v_egg_request, 0), c_egg_max_single);
        v_requested := v_egg_request;
        v_family_monthly_cap := c_egg_monthly_cap;
        v_family_all_or_nothing := true;

    ELSIF p_action_key = 'streak_reward' THEN
        IF v_streak_entitlement_continuation OR v_streak_entitlement_initialization THEN
            BEGIN
                v_streak_milestone_days := COALESCE((v_metadata ->> 'milestone_days')::int, 0);
            EXCEPTION WHEN others THEN
                v_streak_milestone_days := 0;
            END;

            v_streak_milestone_base := CASE v_streak_milestone_days
                WHEN 3 THEN 25
                WHEN 7 THEN 75
                WHEN 14 THEN 150
                WHEN 30 THEN 400
                WHEN 60 THEN 800
                WHEN 100 THEN 2000
                WHEN 365 THEN 10000
                ELSE 0
            END;

            SELECT claims.entitlement_diamonds,
                   claims.diamonds_awarded,
                   claims.claim_count
              INTO v_streak_entitlement,
                   v_streak_already_awarded,
                   v_streak_claim_count
              FROM public.training_streak_milestone_claims claims
             WHERE claims.user_id = p_user_id
               AND claims.milestone_days = v_streak_milestone_days
               AND claims.completed_at IS NULL
             FOR UPDATE;

            v_expected_streak_reference := 'streak_' || p_user_id::text || '_'
                || v_streak_milestone_days::text || '_part_'
                || (v_streak_claim_count + 1)::text;
            v_family_request := CASE
                WHEN v_streak_entitlement_continuation THEN GREATEST(
                    COALESCE(v_streak_entitlement, 0)
                      - COALESCE(v_streak_already_awarded, 0),
                    0
                )
                ELSE v_streak_milestone_base
            END;

            IF NOT FOUND
               OR (
                 v_streak_entitlement_continuation
                 AND COALESCE(v_streak_entitlement, 0) <= 0
               )
               OR (
                 v_streak_entitlement_initialization
                 AND v_streak_entitlement IS NOT NULL
               )
               OR v_streak_milestone_base <= 0
               OR COALESCE(v_streak_already_awarded, 0) > v_streak_milestone_base * 10
               OR v_family_request <= 0
               OR v_family_request > 100000
               OR v_reference_id <> v_expected_streak_reference
               OR COALESCE((v_metadata ->> 'streak_diamonds')::int, -1) <> v_family_request THEN
                RETURN jsonb_build_object(
                    'success', false, 'awarded', 0, 'requested', 0,
                    'reason', 'invalid_entitlement', 'capped', false,
                    'daily_remaining', v_daily_remaining,
                    'monthly_remaining', v_monthly_remaining,
                    'balance_after', v_balance
                );
            END IF;
        ELSE
            BEGIN
                v_family_request := COALESCE((v_metadata ->> 'streak_diamonds')::int, 0);
            EXCEPTION WHEN others THEN
                v_family_request := 0;
            END;
            v_family_request := LEAST(GREATEST(v_family_request, 0), 10000);
        END IF;
        IF v_family_request <= 0 THEN
            RETURN jsonb_build_object(
                'success', false, 'awarded', 0, 'requested', v_family_request,
                'reason', 'invalid_amount', 'capped', false,
                'daily_remaining', v_daily_remaining,
                'monthly_remaining', v_monthly_remaining,
                'balance_after', v_balance
            );
        END IF;
        v_requested := v_family_request;
        v_family_monthly_cap := c_streak_monthly_cap;

    ELSIF p_action_key IN ('daily_bonus', 'daily_bonus_boost') THEN
        BEGIN
            v_family_request := COALESCE((v_metadata ->> 'bonus_diamonds')::int, 0);
        EXCEPTION WHEN others THEN
            v_family_request := 0;
        END;
        v_family_request := LEAST(GREATEST(v_family_request, 0), 125);
        IF v_family_request <= 0 THEN
            RETURN jsonb_build_object(
                'success', false, 'awarded', 0, 'requested', v_family_request,
                'reason', 'invalid_amount', 'capped', false,
                'daily_remaining', v_daily_remaining,
                'monthly_remaining', v_monthly_remaining,
                'balance_after', v_balance
            );
        END IF;
        v_requested := v_family_request;
        v_family_monthly_cap := c_daily_bonus_monthly_cap;

    ELSIF p_action_key = 'training_reward' THEN
        BEGIN
            v_family_request := COALESCE((v_metadata ->> 'reward_diamonds')::int, 0);
        EXCEPTION WHEN others THEN
            v_family_request := 0;
        END;
        v_family_request := LEAST(GREATEST(v_family_request, 0), 50);
        IF v_family_request <= 0 THEN
            RETURN jsonb_build_object(
                'success', false, 'awarded', 0, 'requested', v_family_request,
                'reason', 'invalid_amount', 'capped', false,
                'daily_remaining', v_daily_remaining,
                'monthly_remaining', v_monthly_remaining,
                'balance_after', v_balance
            );
        END IF;
        v_requested := v_family_request;
        v_family_monthly_cap := c_training_monthly_cap;

    ELSIF p_action_key = 'achievement' THEN
        BEGIN
            v_family_request := COALESCE((v_metadata ->> 'achievement_diamonds')::int, 0);
        EXCEPTION WHEN others THEN
            v_family_request := 0;
        END;
        v_family_request := LEAST(GREATEST(v_family_request, 0), 500);
        IF v_family_request <= 0 THEN
            RETURN jsonb_build_object(
                'success', false, 'awarded', 0, 'requested', v_family_request,
                'reason', 'invalid_amount', 'capped', false,
                'daily_remaining', v_daily_remaining,
                'monthly_remaining', v_monthly_remaining,
                'balance_after', v_balance
            );
        END IF;
        v_requested := v_family_request;
        v_family_monthly_cap := c_achievement_monthly_cap;

    ELSIF p_action_key = 'challenge' THEN
        BEGIN
            v_family_request := COALESCE((v_metadata ->> 'challenge_diamonds')::int, 0);
        EXCEPTION WHEN others THEN
            v_family_request := 0;
        END;
        v_family_request := LEAST(GREATEST(v_family_request, 0), 500);
        IF v_family_request <= 0 THEN
            RETURN jsonb_build_object(
                'success', false, 'awarded', 0, 'requested', v_family_request,
                'reason', 'invalid_amount', 'capped', false,
                'daily_remaining', v_daily_remaining,
                'monthly_remaining', v_monthly_remaining,
                'balance_after', v_balance
            );
        END IF;
        v_requested := v_family_request;
        v_family_monthly_cap := c_challenge_monthly_cap;

    ELSIF p_action_key = 'tournament_prize' THEN
        BEGIN
            v_family_request := COALESCE((v_metadata ->> 'prize_diamonds')::int, 0);
        EXCEPTION WHEN others THEN
            v_family_request := 0;
        END;
        v_family_request := LEAST(GREATEST(v_family_request, 0), 10000);
        IF v_family_request <= 0 THEN
            RETURN jsonb_build_object(
                'success', false, 'awarded', 0, 'requested', 0,
                'reason', 'invalid_amount', 'capped', false,
                'daily_remaining', v_daily_remaining,
                'monthly_remaining', v_monthly_remaining,
                'balance_after', v_balance
            );
        END IF;
        v_requested := v_family_request;
    END IF;

    IF v_requested <= 0 THEN
        RETURN jsonb_build_object(
            'success', false, 'awarded', 0, 'requested', 0,
            'reason', 'not_eligible', 'capped', false,
            'daily_remaining', v_daily_remaining,
            'monthly_remaining', v_monthly_remaining,
            'balance_after', v_balance
        );
    END IF;

    -- This is the only multiplier application. Every family and general cap
    -- below is therefore enforced against the amount that could be credited.
    IF NOT v_streak_entitlement_continuation THEN
        v_requested := GREATEST(ROUND(v_requested * v_multiplier)::int, 1);
    END IF;

    IF v_streak_entitlement_initialization THEN
        -- Snapshot the full post-multiplier milestone entitlement only after
        -- the server-owned claim RPC proves post-epoch eligibility. Historical
        -- transaction-backed credit is then deducted exactly once; it is not
        -- multiplied a second time.
        v_streak_entitlement := GREATEST(
            v_requested,
            COALESCE(v_streak_already_awarded, 0)
        );
        IF v_streak_entitlement > v_requested THEN
            -- Historical exact-reference credit can exceed today's price when
            -- the claim-time multiplier was higher. Report an effective
            -- multiplier that reproduces the clamped integer entitlement so
            -- every replay/API response remains internally consistent.
            v_multiplier := ROUND(
                v_streak_entitlement::numeric / v_streak_milestone_base::numeric,
                6
            );
        END IF;
        v_requested := GREATEST(
            v_streak_entitlement - COALESCE(v_streak_already_awarded, 0),
            0
        );
        IF v_requested = 0 THEN
            RETURN jsonb_build_object(
                'success', true, 'awarded', 0, 'requested', 0,
                'entitlement', v_streak_entitlement,
                'reason', 'entitlement_already_paid', 'capped', false,
                'daily_remaining', v_daily_remaining,
                'monthly_remaining', v_monthly_remaining,
                'balance_after', v_balance,
                'multiplier', v_multiplier
            );
        END IF;
    END IF;
    v_award := v_requested;

    IF v_family_monthly_cap IS NOT NULL THEN
        SELECT COALESCE(SUM(t.amount), 0)::bigint
          INTO v_family_month_total
          FROM public.diamond_transactions t
         WHERE t.user_id = p_user_id
           AND t.transaction_type = p_action_key
           AND t.amount > 0
           AND t.created_at >= v_month_start
           AND t.created_at < v_month_end;

        v_family_remaining := GREATEST(
            v_family_monthly_cap::bigint - v_family_month_total,
            0::bigint
        );

        IF v_family_remaining <= 0 THEN
            RETURN jsonb_build_object(
                'success', false, 'awarded', 0, 'requested', v_requested,
                'entitlement', CASE
                    WHEN v_streak_entitlement_initialization
                      OR v_streak_entitlement_continuation
                      THEN v_streak_entitlement
                    ELSE NULL
                END,
                'reason', 'action_limit', 'capped', true,
                'daily_remaining', v_daily_remaining,
                'monthly_remaining', v_monthly_remaining,
                'balance_after', v_balance,
                'multiplier', v_multiplier
            );
        END IF;

        -- Easter eggs preserve their documented whole-award/defer behavior.
        IF v_family_all_or_nothing AND v_award::bigint > v_family_remaining THEN
            RETURN jsonb_build_object(
                'success', false, 'awarded', 0, 'requested', v_requested,
                'reason', 'action_limit', 'capped', true,
                'daily_remaining', v_daily_remaining,
                'monthly_remaining', v_monthly_remaining,
                'balance_after', v_balance
            );
        END IF;

        v_award := LEAST(v_award::bigint, v_family_remaining)::int;
    END IF;

    IF v_counts_cap THEN
        IF v_daily_remaining <= 0 THEN
            RETURN jsonb_build_object(
                'success', false, 'awarded', 0, 'requested', v_requested,
                'entitlement', CASE
                    WHEN v_streak_entitlement_initialization
                      OR v_streak_entitlement_continuation
                      THEN v_streak_entitlement
                    ELSE NULL
                END,
                'reason', 'daily_cap', 'capped', true,
                'daily_remaining', 0,
                'monthly_remaining', v_monthly_remaining,
                'balance_after', v_balance,
                'multiplier', v_multiplier
            );
        END IF;

        IF v_monthly_remaining <= 0 THEN
            RETURN jsonb_build_object(
                'success', false, 'awarded', 0, 'requested', v_requested,
                'entitlement', CASE
                    WHEN v_streak_entitlement_initialization
                      OR v_streak_entitlement_continuation
                      THEN v_streak_entitlement
                    ELSE NULL
                END,
                'reason', 'monthly_cap', 'capped', true,
                'daily_remaining', v_daily_remaining,
                'monthly_remaining', 0,
                'balance_after', v_balance,
                'multiplier', v_multiplier
            );
        END IF;

        v_award := LEAST(v_award, v_daily_remaining, v_monthly_remaining);
    END IF;

    -- RULING 21 (Dan, 2026-09-08): a platform-wide pot never refuses a player, and never
    -- quietly shrinks what they earned. This block read diamond_platform_budget FOR UPDATE,
    -- refused with 'budget_exhausted' when the shared pot was dry, and - worse - did
    --
    --     v_award := LEAST(v_award::bigint, v_budget_left)::int;
    --
    -- so a player owed 100 who arrived when the pot held 7 was paid 7, flagged `capped`, with no
    -- way to learn that the number had nothing to do with anything they had done. Both are gone.
    -- The per-user daily and monthly allowances above are the whole of the limit now, and they
    -- have already been applied to v_award.
    --
    -- v_budget_total, v_budget_spent and v_budget_left are left declared and unused rather than
    -- editing the DECLARE block of a long money function for cosmetics.
    IF v_award <= 0 THEN
            RETURN jsonb_build_object(
                'success', false, 'awarded', 0, 'requested', v_requested,
                'entitlement', CASE
                    WHEN v_streak_entitlement_initialization
                      OR v_streak_entitlement_continuation
                      THEN v_streak_entitlement
                    ELSE NULL
                END,
                'reason', 'nothing_to_award', 'capped', true,
            'daily_remaining', v_daily_remaining,
            'monthly_remaining', v_monthly_remaining,
            'balance_after', v_balance,
            'multiplier', v_multiplier
        );
    END IF;

    v_capped := v_award < v_requested;
    v_new_balance := v_balance + v_award;

    -- The running total on this one row is gone with the gate it fed. It was also the same
    -- one-hot-row-per-month shape that lost 5,860 awards to lock timeouts on the engine table
    -- this morning, so removing it takes a second contention point out of an award path. What
    -- this award cost is recorded by the journal trigger, in ca_diamond_engine_spend.

    UPDATE public.profiles
       SET diamonds = v_new_balance,
           diamond_balance = v_new_balance,
           updated_at = now()
     WHERE id = p_user_id;
    GET DIAGNOSTICS v_profile_rows = ROW_COUNT;

    IF v_profile_rows <> 1 THEN
        RAISE EXCEPTION 'award_diamonds_v2 profile row disappeared for user %', p_user_id
            USING ERRCODE = 'P0001';
    END IF;

    v_metadata := v_metadata || jsonb_build_object(
        'catalog_version', c_catalog_version,
        'action_key', p_action_key,
        'target_id', p_target_id,
        'requested', v_requested,
        'awarded', v_award,
        'capped', v_capped,
        'multiplier', v_multiplier,
        'entitlement', CASE
            WHEN v_streak_entitlement_initialization
              OR v_streak_entitlement_continuation
              THEN v_streak_entitlement
            ELSE NULL
        END,
        'category', v_category,
        'reference_id', v_reference_id,
        'streak', CASE WHEN p_action_key = 'daily_login' THEN v_streak ELSE NULL END,
        'is_vip', v_is_vip
    );

    INSERT INTO public.diamond_transactions (
        user_id, amount, transaction_type, type, description,
        balance_after, reference_id, metadata, created_at,
        counterparty, issuance_class
    ) VALUES (
        p_user_id,
        v_award,
        p_action_key,
        p_action_key,
        format(
            'Diamond Rewards v2: %s%s',
            p_action_key,
            CASE WHEN v_capped THEN ' (capped)' ELSE '' END
        ),
        v_new_balance,
        CASE WHEN v_reference_id = '' THEN NULL ELSE v_reference_id END,
        v_metadata,
        v_now,
        'promo_budget:catalog_v2',
        'promotional'
    );

    IF v_counts_cap THEN
        v_daily_remaining := GREATEST(v_daily_remaining - v_award, 0);
        v_monthly_remaining := GREATEST(v_monthly_remaining - v_award, 0);
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'awarded', v_award,
        'requested', v_requested,
        'entitlement', CASE
            WHEN v_streak_entitlement_initialization
              OR v_streak_entitlement_continuation
              THEN v_streak_entitlement
            ELSE NULL
        END,
        'reason', 'ok',
        'capped', v_capped,
        'daily_remaining', v_daily_remaining,
        'monthly_remaining', v_monthly_remaining,
        'balance_after', v_new_balance
        , 'multiplier', v_multiplier
    );

EXCEPTION
    WHEN unique_violation THEN
        -- Entering this handler rolls back every statement in the function
        -- body, including budget/profile updates. Only the two canonical
        -- reference-id idempotency indexes represent a duplicate award;
        -- unrelated uniqueness defects must stay loud and roll back.
        GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
        IF v_constraint_name NOT IN (
            'idx_diamond_transactions_reference_id',
            'diamond_transactions_user_reference_uidx'
        ) THEN
            RAISE;
        END IF;
        RETURN jsonb_build_object(
            'success', false, 'awarded', 0,
            'requested', COALESCE(v_requested, 0),
            'reason', 'duplicate', 'capped', false,
            'daily_remaining', COALESCE(v_daily_remaining, 0),
            'monthly_remaining', COALESCE(v_monthly_remaining, 0),
            'balance_after', COALESCE(v_balance, 0)
        );
END;
$function$;

-- The ACL as it is live: owner and service_role only.
REVOKE ALL ON FUNCTION public.award_diamonds_v2(uuid, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.award_diamonds_v2(uuid, text, text, text, jsonb) TO service_role;

DO $postimage$
DECLARE
    v_src  text;
    v_def  boolean;
    v_cfg  text[];
BEGIN
    SELECT p.prosrc, p.prosecdef, p.proconfig INTO v_src, v_def, v_cfg
      FROM pg_proc p
     WHERE p.oid = to_regprocedure('public.award_diamonds_v2(uuid,text,text,text,jsonb)');
    IF md5(v_src) IS DISTINCT FROM '2218957f43bc6c653f7827b6344164ea' THEN
        RAISE EXCEPTION 'post-image: award_diamonds_v2 body is not this file''s (md5 %)', md5(v_src);
    END IF;
    IF position('WHERE d = v_today - rn::int;' IN v_src) = 0
       OR position('WHERE d = v_today - rn;' IN v_src) > 0 THEN
        RAISE EXCEPTION 'post-image: the streak is not counted with v_today - rn::int';
    END IF;
    IF NOT v_def OR v_cfg IS DISTINCT FROM ARRAY['search_path=public'] THEN
        RAISE EXCEPTION 'post-image: award_diamonds_v2 lost SECURITY DEFINER or its search_path';
    END IF;
    IF has_function_privilege('anon', 'public.award_diamonds_v2(uuid,text,text,text,jsonb)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.award_diamonds_v2(uuid,text,text,text,jsonb)', 'EXECUTE')
       OR NOT has_function_privilege('service_role', 'public.award_diamonds_v2(uuid,text,text,text,jsonb)', 'EXECUTE') THEN
        RAISE EXCEPTION 'post-image: award_diamonds_v2 privileges are not owner and service_role only';
    END IF;
END $postimage$;

-- The one-time settlement of the logins the defect underpaid.
DO $backpay$
DECLARE
    c_probe_cutoff constant timestamptz := '2026-10-19 09:39:37+00';
    -- Owed for logins made before the probe, as the probe found them.
    c_probed       constant jsonb := '{
        "47965354-0e56-43ef-931c-ddaab82af765": 620,
        "2d1cd6c3-5700-4af9-a271-d4863fdab20d": 95,
        "9b027798-9532-403f-a5c1-15554ce2959c": 40
    }'::jsonb;
    v_bad      text;
    v_hist     jsonb;
    v_res      jsonb;
    v_n        integer;
    v_amt      bigint;
    v_total    bigint := 0;
    v_players  integer := 0;
    v_late     integer;
    r          record;
BEGIN
    CREATE TEMP TABLE daily_login_streak_owed ON COMMIT DROP AS
    WITH t AS (
        SELECT dt.id, dt.user_id, dt.created_at, dt.amount, dt.metadata,
               NULLIF(dt.metadata ->> 'catalog_version', '')::int AS catalog_version,
               (dt.created_at AT TIME ZONE 'America/Chicago')::date AS d
          FROM public.diamond_transactions dt
         WHERE dt.transaction_type = 'daily_login'
           AND dt.amount > 0
    ),
    days AS (
        SELECT DISTINCT user_id, d FROM t
    ),
    islands AS (
        -- Consecutive days share one anchor: d minus its rank in the player's days.
        SELECT user_id, d, d - (ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY d))::int AS anchor
          FROM days
    ),
    streaks AS (
        SELECT user_id, d, (ROW_NUMBER() OVER (PARTITION BY user_id, anchor ORDER BY d))::int AS streak
          FROM islands
    ),
    capped AS (
        SELECT dt.user_id, (dt.created_at AT TIME ZONE 'America/Chicago')::date AS d, dt.amount
          FROM public.diamond_transactions dt
          JOIN public.diamond_reward_catalog c
            ON c.action_key = dt.transaction_type AND c.counts_toward_daily_cap = true
         WHERE dt.amount > 0
    ),
    priced AS (
        SELECT t.id, t.user_id, t.created_at, t.d, t.amount AS paid, s.streak, t.catalog_version,
               NULLIF(t.metadata ->> 'streak', '')::int AS recorded_streak,
               COALESCE((t.metadata ->> 'capped')::boolean, false) AS was_capped,
               GREATEST(ROUND(LEAST(10 + (s.streak - 1) * 5, 110)
                              * COALESCE(NULLIF(t.metadata ->> 'multiplier', '')::numeric, 1.00))::int, 1) AS correct,
               CASE WHEN COALESCE((t.metadata ->> 'is_vip')::boolean, false) THEN 150 ELSE 110 END AS day_cap,
               CASE WHEN COALESCE((t.metadata ->> 'is_vip')::boolean, false) THEN 4500 ELSE 3300 END AS month_cap,
               (SELECT COALESCE(sum(c.amount), 0) FROM capped c
                 WHERE c.user_id = t.user_id AND c.d = t.d) AS day_total,
               (SELECT COALESCE(sum(c.amount), 0) FROM capped c
                 WHERE c.user_id = t.user_id AND date_trunc('month', c.d) = date_trunc('month', t.d)) AS month_total
          FROM t
          JOIN streaks s ON s.user_id = t.user_id AND s.d = t.d
    )
    SELECT p.*,
           CASE WHEN p.catalog_version = 3 AND p.recorded_streak = 1 AND p.streak > 1
                THEN GREATEST(0, LEAST(p.correct - p.paid, p.day_cap - p.day_total, p.month_cap - p.month_total))
                ELSE 0 END::int AS owed
      FROM priced p;

    -- The witness first. Whenever this rule (catalog version 3) did count a
    -- streak, it must be the streak this derivation gives, and it must have
    -- paid this derivation's amount unless it recorded a cap. Otherwise the
    -- model is wrong: stop. The only disagreement allowed is the defect's
    -- signature, a recorded streak of 1 on a day that continued a run.
    SELECT string_agg(o.id::text || ' recorded ' || o.recorded_streak || ' derived ' || o.streak, '; ')
      INTO v_bad
      FROM daily_login_streak_owed o
     WHERE o.catalog_version = 3
       AND (o.recorded_streak IS NULL OR (o.recorded_streak > 1 AND o.recorded_streak <> o.streak));
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'back-pay: the derivation disagrees with streaks the function recorded: %', v_bad;
    END IF;
    SELECT string_agg(o.id::text || ' paid ' || o.paid || ' derived ' || o.correct, '; ')
      INTO v_bad
      FROM daily_login_streak_owed o
     WHERE o.catalog_version = 3 AND o.recorded_streak = o.streak
       AND o.paid <> o.correct AND NOT o.was_capped;
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'back-pay: the derivation disagrees with amounts the function paid for a streak it counted: %', v_bad;
    END IF;

    -- The logins made before the probe are owed exactly what the probe found.
    SELECT COALESCE(jsonb_object_agg(x.user_id::text, x.owed), '{}'::jsonb) INTO v_hist
      FROM (SELECT o.user_id, sum(o.owed) AS owed
              FROM daily_login_streak_owed o
             WHERE o.created_at < c_probe_cutoff
             GROUP BY o.user_id HAVING sum(o.owed) > 0) x;
    IF v_hist <> c_probed THEN
        RAISE EXCEPTION 'back-pay: owed before the probe moved: expected %, derived %', c_probed, v_hist;
    END IF;
    SELECT count(*) INTO v_late FROM daily_login_streak_owed o
     WHERE o.created_at >= c_probe_cutoff AND o.owed > 0;

    FOR r IN
        SELECT o.user_id, sum(o.owed)::int AS owed, count(*) FILTER (WHERE o.owed > 0)::int AS logins
          FROM daily_login_streak_owed o
         GROUP BY o.user_id
        HAVING sum(o.owed) > 0
         ORDER BY o.user_id
    LOOP
        v_res := public.add_diamonds_to_balance(
            r.user_id,
            r.owed,
            'adjustment',
            format('Daily Login streak back-pay: %s daily logins were paid the day-one 10 instead of their consecutive-day reward', r.logins),
            'daily_login_streak_backpay:' || r.user_id::text
        );
        IF NOT COALESCE((v_res ->> 'success')::boolean, false) THEN
            RAISE EXCEPTION 'back-pay: credit for % refused: %', r.user_id, v_res;
        END IF;
        IF (v_res ->> 'amount')::bigint <> r.owed THEN
            RAISE EXCEPTION 'back-pay: credit for % was % instead of %', r.user_id, v_res ->> 'amount', r.owed;
        END IF;

        SELECT count(*), COALESCE(sum(t.amount), 0) INTO v_n, v_amt
          FROM public.diamond_transactions t
         WHERE t.user_id = r.user_id AND t.reference_id = 'daily_login_streak_backpay:' || r.user_id::text;
        IF v_n <> 1 OR v_amt <> r.owed THEN
            RAISE EXCEPTION 'back-pay: % must hold exactly one % back-pay row; found % totalling %', r.user_id, r.owed, v_n, v_amt;
        END IF;
        v_total := v_total + r.owed;
        v_players := v_players + 1;
    END LOOP;

    IF v_total < 755 OR v_players < 3 THEN
        RAISE EXCEPTION 'back-pay: expected at least 755 to at least three players, paid % to %', v_total, v_players;
    END IF;
    RAISE NOTICE 'daily login streak back-pay: % diamonds to % players (% short logins after the probe)', v_total, v_players, v_late;
END $backpay$;

COMMIT;
