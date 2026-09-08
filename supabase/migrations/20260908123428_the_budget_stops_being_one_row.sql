-- 20260908123428_the_budget_stops_being_one_row.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--

-- ONE BUDGET ROW WAS SERIALISING EVERY AWARD ON THE PLATFORM, AND THE GUARD FAILED OPEN.
-- (CLAUDE.md 10.9, 10.11, 10.12, 10.86; rulings 17 and 18;
--  docs/changelog/2026-09-08-the-budget-stops-being-one-row.md)
--
-- WHAT WAS OBSERVED. 5,860 unresolved `DR7:ledger_write_failed` incidents, worth 399,948 diamonds
-- across `daily_challenges` and `daily_missions`, every one carrying SQLSTATE 55P03 - 'canceling
-- statement due to lock timeout' - plus 21 deadlocks. The first is stamped 05:37:01, the same
-- second the diamond register began failing for the same reason and was fixed in
-- `the_register_lost_a_movement`. This is the second writer hit by the same contention, and it was
-- still failing after the first was fixed.
--
-- THE CAUSE. `fn_ca_diamond_earn_ledger` opens with
--
--     INSERT INTO diamond_reward_budgets (period, engine, ...) ... ON CONFLICT (period, engine)
--       DO UPDATE SET spent_diamonds = diamond_reward_budgets.spent_diamonds + EXCLUDED.spent_diamonds
--
-- so EVERY award of one engine in one month updates ONE row, and that row lock is held until the
-- awarding transaction commits. It is the register's advisory lock in a different costume: a
-- running total maintained on a path that runs thousands of times an hour, which therefore
-- serialises everything that runs on that path.
--
-- WHAT IT COST, AND IT IS MORE THAN A COUNTER. The whole body sits inside one
-- `EXCEPTION WHEN OTHERS` block, so a timeout on that first statement skipped everything after it:
--
--   * the budget was not debited - `spent_diamonds` is short by 399,948;
--   * `diamond_user_daily_awards` was never written, so the PER-USER daily figure is short too;
--   * and NEITHER RULE WAS EVALUATED. `v_refuse` is set inside the block and raised outside it, so
--     a failed ledger write does not refuse - it permits, silently.
--
-- THAT LAST POINT IS THE ONE THAT MATTERS BEFORE 2026-09-14. On that day `DR7:engine_over_budget`
-- and `DR7:user_over_daily_cap` flip from `log` to `refuse`. Under the load that makes the guard
-- fail, the guard would not have refused anything at all: the failure mode of the cap is to let
-- the award through. A rule that stops working precisely when it is needed is not a rule, and no
-- test would have caught it, because at one award a second nothing times out.
--
-- THE FIX, AT THE ROOT (10.11): the spend stops being a running total.
--
-- `ca_diamond_engine_spend` takes one INSERT per award. Two awards never touch the same row, so
-- there is nothing to wait for. `fn_ca_diamond_engine_spent(period, engine)` reports the figure as
-- the frozen `diamond_reward_budgets.spent_diamonds` BASELINE plus the sum of the new rows - the
-- same shape as the register, which was seeded from balances rather than by replaying history, and
-- for the same reason: replaying what the baseline already contains would double it.
--
-- `spent_diamonds` is therefore frozen from this migration onward. Nothing writes it; its comment
-- says so. `fn_ca_diamond_trial_balance` reads the function instead, so the report and the rule
-- can never disagree about what has been spent.
--
-- THE DAMAGE IS SETTLED HERE, ONCE, FROM THE EVIDENCE. The 5,860 awards are inserted as spend rows
-- keyed by the journal id the incident recorded, and each incident is resolved with what happened.
-- `journal_id` is UNIQUE, so a replay cannot double count. Nothing scheduled is created; if this
-- ever needs doing again the cause came back and the cause is the thing to fix (10.12).
--
-- AND THE FAILURE STOPS BEING QUIET. If the ledger write fails while either rule is in `refuse`
-- mode, the incident is filed as CRITICAL, because it now means a guard did not run. The award is
-- still paid: a player never loses an earned reward because our bookkeeping stumbled (10.9 rule 3),
-- and "I could not tell" gets its own severity rather than being folded into silence (10.86).
--
-- NOT FIXED HERE, AND NAMED SO IT IS NOT MISSED: `award_diamonds_v2` holds
-- `SELECT ... FOR UPDATE` on `diamond_platform_budget` for the period - a different table, the same
-- one-hot-row-per-month shape. It is not in any of tonight's incidents and is not on the claim
-- path, so it is not changed blind alongside a fix that can be measured.
--
-- One transaction.

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '10min';

-- ---------------------------------------------------------------------------
-- 1. Spend becomes rows, not a total.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ca_diamond_engine_spend (
  id          bigserial PRIMARY KEY,
  period      text        NOT NULL,
  engine      text        NOT NULL,
  user_id     uuid,
  amount      bigint      NOT NULL,
  journal_id  uuid        UNIQUE,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ca_diamond_engine_spend_period_engine
  ON public.ca_diamond_engine_spend (period, engine);

COMMENT ON TABLE public.ca_diamond_engine_spend IS
  'One row per promotional award. Replaces the running total on diamond_reward_budgets.spent_diamonds, which serialised every award on the platform behind a single row and lost 5,860 of them to lock timeouts on 2026-09-08. journal_id is UNIQUE, so a replay counts once.';
COMMENT ON COLUMN public.diamond_reward_budgets.spent_diamonds IS
  'FROZEN 2026-09-08: spend recorded BEFORE the append-only cutover. Nothing writes this any more. The live figure is fn_ca_diamond_engine_spent(period, engine) - this baseline plus the rows in ca_diamond_engine_spend. Adding to it again would double count.';

REVOKE ALL ON TABLE public.ca_diamond_engine_spend FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.ca_diamond_engine_spend TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.ca_diamond_engine_spend_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_engine_spent(p_period text, p_engine text)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- The frozen baseline plus everything appended since. One number, one definition, read by the
  -- rule and by the report alike.
  SELECT COALESCE((SELECT b.spent_diamonds FROM public.diamond_reward_budgets b
                    WHERE b.period = p_period AND b.engine = p_engine), 0)
       + COALESCE((SELECT SUM(s.amount) FROM public.ca_diamond_engine_spend s
                    WHERE s.period = p_period AND s.engine = p_engine), 0);
$$;
COMMENT ON FUNCTION public.fn_ca_diamond_engine_spent(text, text) IS
  'What an engine has spent in a period: the frozen diamond_reward_budgets.spent_diamonds baseline plus the append-only rows in ca_diamond_engine_spend.';
-- SECURITY DEFINER telemetry, closed in the same migration that creates it. It runs as the owner
-- and past RLS, and it never asks who is calling, so a browser must not be able to reach it: what
-- every engine has spent this month is operator information. anon inherits whatever PUBLIC holds,
-- so PUBLIC is named too - revoking anon alone reads as a fix and does nothing.
REVOKE ALL ON FUNCTION public.fn_ca_diamond_engine_spent(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_engine_spent(text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. The ledger stops taking a contended lock, and stops failing quietly.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_earn_ledger()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_engine text; v_period text; v_day date; v_budget bigint; v_spent bigint; v_awarded bigint;
    v_cap integer; v_cap_vip integer; v_is_vip boolean := false; v_at timestamptz;
    v_refuse text; v_refuse_detail text; v_armed boolean;
BEGIN
    BEGIN
        IF COALESCE(NEW.issuance_class, '') IN ('purchased', 'transferred', 'refund', 'admin', 'arena', 'spend', 'deletion', 'bridge') THEN
            RETURN NULL;
        END IF;
        IF COALESCE(NEW.type, '') = 'purchase' OR COALESCE(NEW.transaction_type, '') = 'purchase' THEN
            RETURN NULL;
        END IF;
        -- Fixture accounts are not players (2026-09-07 review DEF-03): their issuance is not
        -- promotional spend. Horses ARE players and are counted.
        IF public.fn_ca_is_fixture_account(NEW.user_id) THEN
            RETURN NULL;
        END IF;

        v_at     := COALESCE(NEW.created_at, now());
        v_engine := CASE WHEN NEW.issuance_class IS NULL THEN 'unclassified'
                         ELSE public.fn_ca_diamond_engine_of(NEW.type, NEW.transaction_type, NEW.source,
                                                             NEW.description, NEW.reference_id) END;
        v_period := to_char((v_at AT TIME ZONE 'America/Chicago'), 'YYYY-MM');
        v_day    := (v_at AT TIME ZONE 'America/Chicago')::date;

        -- THE PER-USER ROW FIRST. It is keyed (user_id, engine, day), so it contends only with the
        -- same player's own concurrent awards - which is to say, essentially never. It used to sit
        -- after the budget write and was therefore lost every time the budget write timed out,
        -- taking the per-user cap figure down with it.
        INSERT INTO public.diamond_user_daily_awards (user_id, engine, day, awarded, updated_at)
        VALUES (NEW.user_id, v_engine, v_day, NEW.amount, now())
        ON CONFLICT (user_id, engine, day) DO UPDATE
           SET awarded = diamond_user_daily_awards.awarded + EXCLUDED.awarded, updated_at = now()
        RETURNING awarded INTO v_awarded;

        -- THE BUDGET LINE EXISTS, BUT ITS TOTAL IS NO LONGER MAINTAINED HERE. This upsert touches
        -- the row only when the line is missing for a new period, so it is a once-a-month write,
        -- not a once-an-award one.
        INSERT INTO public.diamond_reward_budgets (period, engine, budget_diamonds, spent_diamonds, updated_at)
        VALUES (v_period, v_engine,
                COALESCE((SELECT b.budget_diamonds FROM public.diamond_reward_budgets b
                           WHERE b.engine = v_engine AND b.period < v_period
                           ORDER BY b.period DESC LIMIT 1), 2500000),
                0, now())
        ON CONFLICT (period, engine) DO NOTHING;

        -- ONE INSERT, NO CONTENTION. Two awards never touch the same row, so there is nothing to
        -- wait behind. This is the whole fix.
        INSERT INTO public.ca_diamond_engine_spend (period, engine, user_id, amount, journal_id, at)
        VALUES (v_period, v_engine, NEW.user_id, NEW.amount, NEW.id, v_at)
        ON CONFLICT (journal_id) DO NOTHING;

        SELECT b.budget_diamonds INTO v_budget
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

        SELECT c.max_per_user_per_day, c.max_per_user_per_day_vip INTO v_cap, v_cap_vip
          FROM public.diamond_engine_daily_caps c WHERE c.engine = v_engine;
        IF v_cap_vip IS NOT NULL THEN
            SELECT COALESCE(p.is_vip, false) AND (COALESCE(p.vip_tier, '') = 'lifetime'
                     OR (p.vip_expires_at IS NOT NULL AND p.vip_expires_at > now()))
              INTO v_is_vip FROM public.profiles p WHERE p.id = NEW.user_id;
            IF COALESCE(v_is_vip, false) THEN v_cap := v_cap_vip; END IF;
        END IF;

        IF v_cap IS NOT NULL AND v_awarded > v_cap THEN
            IF public.fn_ca_diamond_rule_mode('DR7:user_over_daily_cap') = 'refuse' THEN
                v_refuse := COALESCE(v_refuse, 'DR7:user_over_daily_cap');
                v_refuse_detail := COALESCE(v_refuse_detail, format('engine %s day %s cap %s awarded %s', v_engine, v_day, v_cap, v_awarded));
            END IF;
            PERFORM public.fn_ca_diamond_incident('DR7:user_over_daily_cap', 'warning', NEW.user_id, NEW.amount,
                'fn_ca_diamond_earn_ledger',
                jsonb_build_object('engine', v_engine, 'day', v_day, 'is_vip', v_is_vip,
                                   'max_per_user_per_day', v_cap, 'awarded_today', v_awarded,
                                   'journal_id', NEW.id, 'reference_id', NEW.reference_id));
        END IF;
    EXCEPTION WHEN OTHERS THEN
        -- A FAILURE HERE MEANS A GUARD DID NOT RUN, and that is a different thing from a counter
        -- being late. While both rules are in `log` it is a warning; the moment either is armed to
        -- refuse, a write that could not complete is the guard failing OPEN, so it is CRITICAL and
        -- says so. The award is still paid: a player never loses an earned reward because our
        -- bookkeeping stumbled (10.9 rule 3), and "I could not tell" gets its own severity rather
        -- than being folded into silence (10.86).
        v_armed := public.fn_ca_diamond_rule_mode('DR7:engine_over_budget') = 'refuse'
                OR public.fn_ca_diamond_rule_mode('DR7:user_over_daily_cap') = 'refuse';
        PERFORM public.fn_ca_diamond_incident('DR7:ledger_write_failed',
            CASE WHEN v_armed THEN 'critical' ELSE 'warning' END, NEW.user_id, NEW.amount,
            'fn_ca_diamond_earn_ledger',
            jsonb_build_object('sqlstate', SQLSTATE, 'sqlerrm', SQLERRM, 'journal_id', NEW.id,
                               'reference_id', NEW.reference_id, 'rules_armed', v_armed,
                               'note', CASE WHEN v_armed
                                            THEN 'A rule is armed to refuse and this write did not complete, so neither cap was evaluated for this award. The guard failed OPEN.'
                                            ELSE 'Both rules are in log mode; nothing was refused either way.' END));
    END;
    -- DIAMOND-RULINGS 17/18: a flipped DR7 refuses the credit. Raising here aborts the writer's
    -- whole transaction (balance, journal, ledger rows), so nothing is issued and nothing is
    -- half-written. The incident above rolls back with it; the writer's error carries the reason.
    IF v_refuse IS NOT NULL THEN
        RAISE EXCEPTION '%: promotional issuance refused (%)', v_refuse, v_refuse_detail
            USING ERRCODE = 'P0407';
    END IF;
    RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. The report reads the same number the rule reads.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_def text; v_from text; v_to text; v_n integer;
BEGIN
  v_from := 'SELECT COALESCE(SUM(b.spent_diamonds), 0)::numeric, COALESCE(SUM(b.budget_diamonds), 0)::numeric, count(*) INTO v_sub, v_tmp, v_n';
  v_to   := 'SELECT COALESCE(SUM(public.fn_ca_diamond_engine_spent(b.period, b.engine)), 0)::numeric, COALESCE(SUM(b.budget_diamonds), 0)::numeric, count(*) INTO v_sub, v_tmp, v_n';
  SELECT pg_get_functiondef('public.fn_ca_diamond_trial_balance(timestamptz)'::regprocedure) INTO v_def;
  v_n := (length(v_def) - length(replace(v_def, v_from, ''))) / length(v_from);
  IF v_n <> 1 THEN RAISE EXCEPTION 'trial balance marker found % times', v_n; END IF;
  EXECUTE replace(v_def, v_from, v_to);
END $$;

-- ---------------------------------------------------------------------------
-- 4. Settle the 5,860, from the incidents that recorded them.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_rows integer; v_amount numeric;
BEGIN
  WITH lost AS (
    SELECT DISTINCT ON (dt.id)
           dt.id AS journal_id, dt.user_id, dt.amount,
           to_char((COALESCE(dt.created_at, now()) AT TIME ZONE 'America/Chicago'), 'YYYY-MM') AS period,
           CASE WHEN dt.issuance_class IS NULL THEN 'unclassified'
                ELSE public.fn_ca_diamond_engine_of(dt.type, dt.transaction_type, dt.source,
                                                    dt.description, dt.reference_id) END AS engine,
           COALESCE(dt.created_at, now()) AS at
      FROM public.ca_diamond_incidents i
      JOIN public.diamond_transactions dt ON dt.id = (i.detail ->> 'journal_id')::uuid
     WHERE i.rule = 'DR7:ledger_write_failed'
       AND i.resolved_at IS NULL
       AND NOT public.fn_ca_is_fixture_account(dt.user_id)
  )
  INSERT INTO public.ca_diamond_engine_spend (period, engine, user_id, amount, journal_id, at)
  SELECT period, engine, user_id, amount, journal_id, at FROM lost
  ON CONFLICT (journal_id) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  SELECT COALESCE(sum(amount), 0) INTO v_amount FROM public.ca_diamond_engine_spend;

  UPDATE public.ca_diamond_incidents
     SET resolved_at = now(),
         detail = detail || jsonb_build_object(
           'resolution',
           'Recorded by 2026-09-08 the-budget-stops-being-one-row. The award itself was always paid and its journal row always stood; what was lost was the budget debit, the per-user daily figure, and the evaluation of both DR7 rules - all skipped because the first statement timed out on the single budget row this migration replaces with append-only spend. Counted once, keyed on the journal id.',
           'resolved_by', 'migration:the-budget-stops-being-one-row')
   WHERE rule = 'DR7:ledger_write_failed' AND resolved_at IS NULL;

  RAISE NOTICE 'recorded % lost award(s); ca_diamond_engine_spend now holds %', v_rows, v_amount;
END $$;

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_body text; v_sep numeric; v_col numeric; v_fn numeric; v_open integer; v_left text;
BEGIN
  -- the hot path no longer maintains a running total
  SELECT prosrc INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_diamond_earn_ledger';
  IF v_body LIKE '%spent_diamonds = diamond_reward_budgets.spent_diamonds%' THEN
    RAISE EXCEPTION 'the ledger still adds to the contended budget row';
  END IF;
  IF v_body NOT LIKE '%INSERT INTO public.ca_diamond_engine_spend%' THEN
    RAISE EXCEPTION 'the ledger does not append its spend';
  END IF;
  IF v_body NOT LIKE '%rules_armed%' THEN
    RAISE EXCEPTION 'a failed write still cannot say that a guard did not run';
  END IF;
  -- the per-user row is written before anything that could contend
  IF position('diamond_user_daily_awards' IN v_body) > position('ca_diamond_engine_spend' IN v_body) THEN
    RAISE EXCEPTION 'the per-user write is still behind the budget write';
  END IF;

  -- the figures: the function must exceed the frozen column by exactly what was recovered
  SELECT COALESCE(sum(spent_diamonds), 0) INTO v_col FROM public.diamond_reward_budgets;
  SELECT COALESCE(sum(public.fn_ca_diamond_engine_spent(period, engine)), 0) INTO v_fn
    FROM public.diamond_reward_budgets;
  SELECT COALESCE(sum(amount), 0) INTO v_sep FROM public.ca_diamond_engine_spend s
   WHERE EXISTS (SELECT 1 FROM public.diamond_reward_budgets b
                  WHERE b.period = s.period AND b.engine = s.engine);
  IF v_fn <> v_col + v_sep THEN
    RAISE EXCEPTION 'the spent figure does not reconcile: function % <> baseline % + appended %', v_fn, v_col, v_sep;
  END IF;
  IF v_fn < v_col THEN
    RAISE EXCEPTION 'recording the lost awards reduced the spend figure';
  END IF;

  -- and the report agrees with it
  IF (SELECT balance_now FROM public.fn_ca_diamond_trial_balance(now() - interval '75 minutes')
       WHERE account = 'promo_budgets_spent') <> v_fn THEN
    RAISE EXCEPTION 'the trial balance and the rule disagree about what has been spent';
  END IF;

  -- nothing is left unrecorded, and nothing else broke
  SELECT count(*) INTO v_open FROM public.ca_diamond_incidents i
    JOIN public.diamond_transactions dt ON dt.id = (i.detail ->> 'journal_id')::uuid
    LEFT JOIN public.ca_diamond_engine_spend s ON s.journal_id = dt.id
   WHERE i.rule = 'DR7:ledger_write_failed' AND s.id IS NULL
     AND NOT public.fn_ca_is_fixture_account(dt.user_id);
  IF v_open <> 0 THEN RAISE EXCEPTION '% lost award(s) are still unrecorded', v_open; END IF;

  IF (SELECT public.fn_ca_mint_supply('diamonds'))
     <> (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) + public.fn_ca_arena_diamonds() THEN
    RAISE EXCEPTION 'players + arena <> register after a change that moves no money';
  END IF;
  SELECT string_agg(finding || ': ' || object, '; ') INTO v_left FROM public.fn_ca_diamond_unreachable_money();
  IF v_left IS NOT NULL THEN RAISE EXCEPTION 'unreachable money paths: %', v_left; END IF;
END $$;

COMMIT;
