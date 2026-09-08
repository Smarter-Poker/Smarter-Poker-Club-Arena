-- 20260908130203_only_a_user_budget_refuses.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--

-- RULING 21 (Dan, 2026-09-08): A PLATFORM BUDGET NEVER REFUSES A PLAYER. ONLY A USER BUDGET DOES.
--
-- Dan, verbatim: "THERE SHOULDN'T BE A PLATFORM BUDGET ON THINGS LIKE THIS, ONLY A USER BUDGET."
--
-- A per-user cap is a rule about one player and their own earning. A platform-wide monthly pot is
-- a rule about EVERYONE ELSE'S earning: it is a shared pool, so the players who log in early spend
-- it and the players who log in late are refused for something they did nothing wrong to deserve.
-- That is not a cap, it is a race, and the player cannot see the clock.
--
-- Two platform pots could refuse a player. Both stop.
--
-- 1. THE PER-ENGINE MONTHLY POT (`diamond_reward_budgets`, read by fn_ca_diamond_earn_ledger).
--    `DR7:engine_over_budget` was scheduled to flip from `log` to `refuse` on 2026-09-14. With the
--    spend counter repaired earlier today, `daily_missions` reads 127,305 against a 30,000 line -
--    4.2 times over - so the flip would have refused EVERY daily-mission award for the rest of
--    September. The rule is retired rather than deferred: a rule row that can never be armed is
--    the "reads as armed and is not" shape this estate keeps being bitten by (CLAUDE.md 10.86).
--
-- 2. THE PLATFORM-WIDE MONTHLY POT (`diamond_platform_budget`, read by award_diamonds_v2). This
--    one was refusing TODAY, and doing something worse besides:
--
--        v_award := LEAST(v_award::bigint, v_budget_left)::int;
--
--    a SILENT TRUNCATION. A player owed 100 who arrived when the pot held 7 was paid 7, with
--    `capped: true` and no way to know that the number had nothing to do with anything they did.
--    Both the truncation and the `budget_exhausted` refusal are gone. It has not bitten yet -
--    1,210 spent of 2,500,000 this month - which is exactly why it is worth removing before it
--    does.
--
-- WHAT STAYS, AND IT IS THE WHOLE OF THE CONTROL NOW:
--
--   * `diamond_engine_daily_caps` - per user, per engine, per day: daily_challenges 2,000,
--     daily_missions 500, trivia 2,000, wheel 10,000, referrals 1,500, catalog_v2 110,
--     club_arena_daily 110. `DR7:user_over_daily_cap` still flips to refuse on 2026-09-14.
--   * `award_diamonds_v2`'s own per-user daily allowance and its per-user MONTHLY allowance
--     (4,500 for VIP, 3,300 otherwise). A monthly limit on one player is a user budget and is
--     untouched; only the pot shared between players goes.
--
-- WHAT STAYS AS A NUMBER, NOT A GATE. `budget_diamonds` on both tables keeps being written and
-- read by the economy report - what an engine costs per month is worth knowing, and the velocity
-- alarm still watches issuance against what players spend. It simply cannot refuse anybody. Both
-- columns say so in their comments, so nobody re-arms them by reading the name.
--
-- The append-only spend recording built earlier today is untouched and is now the only thing these
-- tables are for: measurement.
--
-- One transaction. No money moves.

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

CREATE FUNCTION pg_temp.ca_patch(p_oid oid, p_from text, p_to text)
RETURNS void LANGUAGE plpgsql AS $ca$
DECLARE v_def text; v_n integer;
BEGIN
  SELECT pg_get_functiondef(p_oid) INTO v_def;
  v_n := (length(v_def) - length(replace(v_def, p_from, ''))) / length(p_from);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ca_patch: marker found % times in %', v_n, p_oid::regprocedure; END IF;
  EXECUTE replace(v_def, p_from, p_to);
END $ca$;

-- ---------------------------------------------------------------------------
-- 1. The per-engine pot stops being consulted at all.
-- ---------------------------------------------------------------------------
SELECT pg_temp.ca_patch('public.fn_ca_diamond_earn_ledger()'::regprocedure,
$ca_from$        SELECT b.budget_diamonds INTO v_budget
          FROM public.diamond_reward_budgets b WHERE b.period = v_period AND b.engine = v_engine;
        v_spent := public.fn_ca_diamond_engine_spent(v_period, v_engine);

        IF v_budget IS NOT NULL AND v_spent > v_budget THEN
            IF public.fn_ca_diamond_rule_mode('DR7:engine_over_budget') = 'refuse' THEN
                v_refuse := 'DR7:engine_over_budget';
                v_refuse_detail := format('engine %s period %s budget %s spent %s', v_engine, v_period, v_budget, v_spent);
            END IF;
            PERFORM public.fn_ca_diamond_incident('DR7:engine_over_budget', 'warning', NEW.user_id, NEW.amount,
                'fn_ca_diamond_earn_ledger',
                jsonb_build_object('engine', v_engine, 'period', v_period, 'budget_diamonds', v_budget,
                                   'spent_diamonds', v_spent, 'journal_id', NEW.id, 'reference_id', NEW.reference_id));
        END IF;
$ca_from$,
$ca_to$        -- RULING 21: THE ENGINE'S MONTHLY TOTAL IS A FORECAST, NOT A GATE. It is a pot shared
        -- between players, so refusing on it punishes whoever arrives last for what everybody
        -- else earned. The spend row appended above is the measurement, and the economy report
        -- reads it; nothing here refuses, and no incident is filed per award - daily_missions is
        -- 4.2x its line today, so one would fire on every single award and be muted inside a day
        -- (10.84). The only cap that refuses is the per-user one below.
$ca_to$);

SELECT pg_temp.ca_patch('public.fn_ca_diamond_earn_ledger()'::regprocedure,
$ca_from$        v_armed := public.fn_ca_diamond_rule_mode('DR7:engine_over_budget') = 'refuse'
                OR public.fn_ca_diamond_rule_mode('DR7:user_over_daily_cap') = 'refuse';$ca_from$,
$ca_to$        -- Only the per-user cap can refuse now (ruling 21), so it alone decides whether a
        -- write that could not complete means a guard failed open. The engine pot is a forecast
        -- and its rule row is deleted below; consulting a rule that no longer exists would read
        -- as armed while being nothing at all.
        v_armed := public.fn_ca_diamond_rule_mode('DR7:user_over_daily_cap') = 'refuse';$ca_to$);

-- The rule row goes with it. A rule nothing consults reads as armed while being unreachable, and
-- fn_ca_diamond_unreachable_money is built to catch exactly that.
DELETE FROM public.ca_diamond_rule_modes WHERE rule = 'DR7:engine_over_budget';

COMMENT ON COLUMN public.diamond_reward_budgets.budget_diamonds IS
  'A FORECAST, NOT A GATE (ruling 21, 2026-09-08). What this engine is expected to cost in the period. Nothing refuses an award because of it: a platform-wide pot refuses whoever arrives last for what everybody else earned. The per-user cap in diamond_engine_daily_caps is the control.';

-- ---------------------------------------------------------------------------
-- 2. The platform-wide pot stops refusing, and stops silently shrinking awards.
-- ---------------------------------------------------------------------------
SELECT pg_temp.ca_patch('public.award_diamonds_v2(uuid,text,text,text,jsonb)'::regprocedure,
$ca_from$    INSERT INTO public.diamond_platform_budget (period, budget_diamonds)
    VALUES (v_period, c_platform_budget)
    ON CONFLICT (period) DO NOTHING;

    SELECT b.budget_diamonds, b.spent_diamonds
      INTO v_budget_total, v_budget_spent
      FROM public.diamond_platform_budget b
     WHERE b.period = v_period
     FOR UPDATE;

    v_budget_left := GREATEST(
        COALESCE(v_budget_total, 0) - COALESCE(v_budget_spent, 0),
        0
    );

    IF v_budget_left <= 0 THEN
            RETURN jsonb_build_object(
                'success', false, 'awarded', 0, 'requested', v_requested,
                'entitlement', CASE
                    WHEN v_streak_entitlement_initialization
                      OR v_streak_entitlement_continuation
                      THEN v_streak_entitlement
                    ELSE NULL
                END,
                'reason', 'budget_exhausted', 'capped', true,
                'daily_remaining', v_daily_remaining,
                'monthly_remaining', v_monthly_remaining,
                'balance_after', v_balance,
                'multiplier', v_multiplier
        );
    END IF;

    v_award := LEAST(v_award::bigint, v_budget_left)::int;
    IF v_award <= 0 THEN
            RETURN jsonb_build_object(
                'success', false, 'awarded', 0, 'requested', v_requested,
                'entitlement', CASE
                    WHEN v_streak_entitlement_initialization
                      OR v_streak_entitlement_continuation
                      THEN v_streak_entitlement
                    ELSE NULL
                END,
                'reason', 'budget_exhausted', 'capped', true,
            'daily_remaining', v_daily_remaining,
            'monthly_remaining', v_monthly_remaining,
            'balance_after', v_balance,
            'multiplier', v_multiplier
        );
    END IF;
$ca_from$,
$ca_to$    -- RULING 21 (Dan, 2026-09-08): a platform-wide pot never refuses a player, and never
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
$ca_to$);

SELECT pg_temp.ca_patch('public.award_diamonds_v2(uuid,text,text,text,jsonb)'::regprocedure,
$ca_from$    UPDATE public.diamond_platform_budget
       SET spent_diamonds = spent_diamonds + v_award,
           updated_at = now()
     WHERE period = v_period;

$ca_from$,
$ca_to$    -- The running total on this one row is gone with the gate it fed. It was also the same
    -- one-hot-row-per-month shape that lost 5,860 awards to lock timeouts on the engine table
    -- this morning, so removing it takes a second contention point out of an award path. What
    -- this award cost is recorded by the journal trigger, in ca_diamond_engine_spend.

$ca_to$);

COMMENT ON COLUMN public.diamond_platform_budget.budget_diamonds IS
  'A FORECAST, NOT A GATE (ruling 21, 2026-09-08). Nothing refuses or shrinks an award because of it. Until then it both refused with budget_exhausted and silently truncated an award to whatever was left in the shared pot.';

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_ledger text; v_award text; v_left text; v_caps integer;
BEGIN
  -- COMMENTS STRIPPED FIRST. Both bodies now explain, by name, what they no longer do - and an
  -- earlier version of these very checks failed on its own explanation. A mention is not a call
  -- (the same mistake fixed in fn_ca_diamond_unreachable_money on 2026-09-08).
  SELECT regexp_replace(prosrc, '--[^' || chr(10) || ']*', '', 'g') INTO v_ledger
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_diamond_earn_ledger';
  SELECT regexp_replace(prosrc, '--[^' || chr(10) || ']*', '', 'g') INTO v_award
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'award_diamonds_v2';

  -- NO PLATFORM POT CAN REFUSE ANYBODY
  IF v_ledger LIKE '%DR7:engine_over_budget%' THEN
    RAISE EXCEPTION 'the earn ledger still consults the per-engine pot';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ca_diamond_rule_modes WHERE rule = 'DR7:engine_over_budget') THEN
    RAISE EXCEPTION 'the retired rule is still in the mode table';
  END IF;
  IF v_award LIKE '%budget_exhausted%' THEN
    RAISE EXCEPTION 'award_diamonds_v2 can still refuse for a shared pot';
  END IF;
  IF v_award LIKE '%LEAST(v_award::bigint, v_budget_left)%' THEN
    RAISE EXCEPTION 'award_diamonds_v2 can still silently shrink an award to the shared pot';
  END IF;
  IF v_award LIKE '%UPDATE public.diamond_platform_budget%' THEN
    RAISE EXCEPTION 'award_diamonds_v2 still maintains the shared running total';
  END IF;

  -- AND THE USER BUDGET IS UNTOUCHED, still armed for its flip
  IF v_ledger NOT LIKE '%DR7:user_over_daily_cap%' THEN
    RAISE EXCEPTION 'the per-user cap stopped being evaluated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ca_diamond_rule_modes
                  WHERE rule = 'DR7:user_over_daily_cap' AND flip_after IS NOT NULL) THEN
    RAISE EXCEPTION 'the per-user cap is no longer scheduled to become a refusal';
  END IF;
  IF v_award NOT LIKE '%v_monthly_cap := CASE WHEN v_is_vip THEN 4500 ELSE 3300 END%' THEN
    RAISE EXCEPTION 'the per-user monthly allowance was lost';
  END IF;
  SELECT count(*) INTO v_caps FROM public.diamond_engine_daily_caps WHERE max_per_user_per_day IS NOT NULL;
  IF v_caps < 7 THEN RAISE EXCEPTION 'only % per-user daily cap(s) remain', v_caps; END IF;

  -- the spend recording built this morning is untouched
  IF v_ledger NOT LIKE '%INSERT INTO public.ca_diamond_engine_spend%' THEN
    RAISE EXCEPTION 'the append-only spend recording was lost';
  END IF;

  -- nothing became unreachable, and no money moved
  SELECT string_agg(finding || ': ' || object, '; ') INTO v_left FROM public.fn_ca_diamond_unreachable_money();
  IF v_left IS NOT NULL THEN RAISE EXCEPTION 'unreachable money paths: %', v_left; END IF;
  IF (SELECT public.fn_ca_mint_supply('diamonds'))
     <> (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) + public.fn_ca_arena_diamonds() THEN
    RAISE EXCEPTION 'players + arena <> register after a change that moves no money';
  END IF;
END $$;

COMMIT;
