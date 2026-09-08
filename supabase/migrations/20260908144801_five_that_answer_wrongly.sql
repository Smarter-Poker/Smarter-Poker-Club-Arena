-- 20260908144801_five_that_answer_wrongly.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- APPLIED TO PRODUCTION 2026-09-08 via the us-west-2 session pooler; this file is
-- the record of what ran, and is registered in supabase_migrations.schema_migrations.

-- FIVE THINGS THAT ANSWER CONFIDENTLY WITHOUT KNOWING, AND TWO THAT TURNED OUT TO BE FINE.
-- (CLAUDE.md 10.5, 10.9, 10.11, 10.86; ruling 21; docs/changelog/2026-09-08-five-that-answer-wrongly.md)
--
-- An adversarial review raised seventeen items against the diamond work. Four were settled in the
-- migration before this one. Of the rest, TWO WERE NOT DEFECTS AT ALL and saying so is part of the
-- job - a fix applied to something that was already right is a change with no upside:
--
--   * `fn_ca_diamond_engine_spent` was reported as disagreeing with the journal by 1,836,311 on
--     daily_challenges. It is the frozen baseline plus the journal, by design, and the baseline
--     accounts for the difference EXACTLY on all 34 period-engine rows. Measured, not assumed.
--   * The RAISE in `fn_ca_diamond_offledger_float` was reported unreachable. It fires when
--     `fn_ca_arena_diamonds()` returns NULL, which is a real outcome distinct from the function
--     being absent. It is reachable and it is the point of the function.
--
-- The five below are real, and four of the five are the same shape: something answers, and the
-- answer does not depend on what it claims to.
--
-- 1. A PREDICATE THAT GIVES A DIFFERENT ANSWER DEPENDING ON WHO ASKS.
--    `fn_ca_is_cert_account` is SECURITY INVOKER. Its twin `fn_ca_is_fixture_account`, which does
--    the same job and was written beside it, is DEFINER. The function reads `auth.users`, which
--    `authenticated` cannot select from - so asked by service_role it answers correctly, and asked
--    through any player-facing path the auth.users arm contributes nothing and the answer silently
--    changes. Eleven functions consult it, including the collusion scan. It becomes DEFINER, like
--    its twin. THIS IS THE SECOND TIME THESE TWO HAVE DISAGREED IN ONE DAY: yesterday's fix taught
--    one of them that a horse is a player and missed the other, and that is what having two of
--    anything costs.
--
-- 2. A BUDGET THAT REFUSES NOBODY BUT READS AS A LIMIT.
--    Ruling 21 took the platform budget out of every refusal path - only a per-user budget may
--    refuse a player. `diamond_reward_budgets.budget_diamonds` therefore stops nothing, yet it
--    still reads like a control, and three of its rows are visibly wrong:
--      * 2026-10 / club_arena_daily holds 9,223,372,036,854,775,807 - bigint max, somebody's
--        "unlimited" sentinel. A sentinel in a column of real numbers is a number to everyone who
--        reads it later.
--      * 2026-10 / daily_challenges is 100,000 against a September actual of 1,836,311.
--      * 2026-09 / daily_missions is already at 74,505 against 30,000 and nothing said so.
--    The sentinel becomes NULL, which is what "no limit" honestly looks like, and a CHECK stops
--    another one being written. **THE OTHER TWO NUMBERS ARE NOT CHANGED HERE.** What an engine is
--    budgeted to issue next month is what players will be offered, and 10.9 reserves that to Dan.
--    What is mine is making the gap impossible to miss, so `fn_ca_diamond_budget_reality` states
--    each budget against what that engine actually issued, and says in words which are fiction.
--
-- 3. AN APPEND-ONLY LEDGER THAT NOTHING KEPT APPEND-ONLY.
--    `ca_diamond_engine_spend` replaced a single running total whose row lock serialised the
--    platform and lost 5,861 awards. It is the register of engine spend and it is only trustworthy
--    if it is immutable; nothing enforced that. A BEFORE UPDATE OR DELETE trigger does now.
--
-- 4. A RETIRED RULE'S INCIDENTS THAT NO INSTRUMENT CAN SEE.
--    297 `DR7:engine_over_budget` incidents sit in the table for a rule ruling 21 removed from
--    `ca_diamond_rule_modes`. The flip forecast joins FROM the rule table, so those 297 are
--    invisible to it - not reported as retired, simply absent. That is the failure mode 10.86 is
--    about: silence and "nothing to report" are the same reading. The forecast now names a retired
--    rule that still holds incidents, and says it is retired. The rows stay; they are history, and
--    history is not tidied away (10.9).
--
-- 5. TWO COPIES OF THE HORSE CLAIM LOOP.
--    `record_daily_challenge_event` (6 args) and `record_daily_challenge_event_serialized_body`
--    (5 args) each carry their own copy. They agree today - the previous migration patched both -
--    and there is no way to notice if they ever stop. **I HAVE NOT MERGED THEM AND THE REASON IS
--    NOT THAT IT IS HARD.** This is the path 759 unclaimed rewards came back through this
--    afternoon; restructuring it and the settlement in the same day is how a good change becomes an
--    incident. An assertion pins the two loops character-for-character instead, so a divergence
--    cannot ship silently, and merging them is named in the changelog as owed work rather than
--    left to be rediscovered.
--
-- One transaction.

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '5min';

-- ---------------------------------------------------------------------------
-- 1. The cert predicate answers the same for everyone.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_is_cert_account(p_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- DEFINER, like fn_ca_is_fixture_account. It reads auth.users, which `authenticated` cannot
  -- select from, so as INVOKER it answered one thing for service_role and another for everyone
  -- else - a predicate whose result depended on the caller rather than the account.
  --
  -- A HORSE IS A PLAYER (CLAUDE.md 10.5), so it is never certification equipment, whatever its
  -- address looks like. The fleet shares an email domain, which classified 468 of them as test
  -- equipment until 2026-09-08.
  SELECT p_user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_user_id AND COALESCE(p.is_horse, false))
    AND (
      EXISTS (SELECT 1 FROM public.ca_cert_accounts c WHERE c.user_id = p_user_id AND c.active)
      OR p_user_id::text LIKE '00000000-0000-0000-0000-%'
      OR EXISTS (SELECT 1 FROM auth.users u
                  WHERE u.id = p_user_id
                    AND (u.email LIKE '%@horses.smarter.poker'
                         OR u.email LIKE '%.invalid'))
    );
$$;

REVOKE ALL ON FUNCTION public.fn_ca_is_cert_account(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_is_cert_account(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. The budget stops pretending to be a limit.
-- ---------------------------------------------------------------------------
-- NOT NULL is what forced somebody to invent a sentinel: there was no way to say "no plan" except
-- to write a number that meant "ignore this number". Its only reader sums the column
-- (fn_ca_diamond_trial_balance, COALESCE(SUM(...), 0)), and SUM ignores NULL, so the honest value
-- is now expressible. fn_ca_diamond_earn_ledger declares v_budget and never assigns it - a leftover
-- from before ruling 21, and independent confirmation that no refusal reads this column.
ALTER TABLE public.diamond_reward_budgets ALTER COLUMN budget_diamonds DROP NOT NULL;

UPDATE public.diamond_reward_budgets
   SET budget_diamonds = NULL
 WHERE budget_diamonds >= 9223372036854775000;

ALTER TABLE public.diamond_reward_budgets
  DROP CONSTRAINT IF EXISTS ca_budget_is_a_number_or_nothing;
ALTER TABLE public.diamond_reward_budgets
  ADD CONSTRAINT ca_budget_is_a_number_or_nothing
  CHECK (budget_diamonds IS NULL OR budget_diamonds BETWEEN 0 AND 1000000000);

COMMENT ON COLUMN public.diamond_reward_budgets.budget_diamonds IS
  'A PLAN, NOT A LIMIT. Since ruling 21 no platform budget refuses any player - only a per-user budget does (diamond_engine_daily_caps). NULL means no plan has been set. Never write a sentinel here; a bigint-max "unlimited" sat in 2026-10/club_arena_daily and read as a number to everyone after. What an engine should be budgeted is Dan''s decision (CLAUDE.md 10.9); fn_ca_diamond_budget_reality shows which of these numbers are fiction.';

COMMENT ON COLUMN public.diamond_reward_budgets.spent_diamonds IS
  'FROZEN BASELINE, not a running total. It stopped being updated when ca_diamond_engine_spend replaced it: the single row''s lock serialised the whole platform and 5,861 awards were lost in one morning. fn_ca_diamond_engine_spent = this baseline + the append-only journal.';

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_budget_reality(p_period text DEFAULT NULL)
RETURNS TABLE (
  period    text,
  engine    text,
  budgeted  bigint,
  actual    numeric,
  ratio     numeric,
  verdict   text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_now text := to_char((now() AT TIME ZONE 'America/Chicago'), 'YYYY-MM');
BEGIN
  IF COALESCE(auth.role(), 'service_role') <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required';
  END IF;

  RETURN QUERY
  WITH ref AS (
    -- What each engine ACTUALLY issued in the most recent complete-enough month we have, which is
    -- the only honest thing to judge a plan against.
    SELECT b.period AS per, b.engine AS eng,
           public.fn_ca_diamond_engine_spent(b.period, b.engine)::numeric AS act,
           b.budget_diamonds AS bud
      FROM public.diamond_reward_budgets b
     WHERE p_period IS NULL OR b.period = p_period)
  SELECT r.per, r.eng, r.bud, r.act,
         CASE WHEN r.bud IS NULL OR r.bud = 0 THEN NULL
              ELSE round(r.act / r.bud, 2) END,
         CASE
           WHEN r.bud IS NULL THEN
             'NO PLAN SET. Refuses nobody either way (ruling 21); this is simply unstated.'
           WHEN r.act = 0 AND r.bud = 0 THEN 'Nothing budgeted, nothing issued.'
           WHEN r.bud = 0 AND r.act > 0 THEN
             'BUDGETED ZERO, ISSUED ' || r.act || '. The plan says this engine does not exist.'
           WHEN r.act > r.bud THEN
             'ALREADY OVER: issued ' || r.act || ' against a plan of ' || r.bud || ' ('
             || round(r.act / NULLIF(r.bud, 0), 1) || 'x). The plan is fiction.'
           WHEN r.per > v_now AND r.bud > 0 AND EXISTS (
                  SELECT 1 FROM public.diamond_reward_budgets q
                   WHERE q.engine = r.eng AND q.period < r.per
                     AND public.fn_ca_diamond_engine_spent(q.period, q.engine) > r.bud * 2)
             THEN 'FUTURE PLAN BELOW PAST ACTUAL. A previous month issued more than twice this '
                  || 'plan, so it will read as over on the day it starts.'
           ELSE 'Plausible: issued ' || r.act || ' against a plan of ' || r.bud || '.'
         END
    FROM ref r
   ORDER BY r.per DESC, (CASE WHEN r.bud IS NULL THEN 0 ELSE r.act / NULLIF(r.bud, 0) END) DESC NULLS LAST;
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_diamond_budget_reality(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_budget_reality(text) TO service_role;

COMMENT ON FUNCTION public.fn_ca_diamond_budget_reality(text) IS
  'Every reward budget against what that engine actually issued, with a verdict in words. Exists because the budgets refuse nobody (ruling 21) yet read as controls, and three of them were fiction - a bigint-max sentinel, an October plan 18x under September actual, and a September plan already exceeded 2.5x with nothing saying so.';

-- ---------------------------------------------------------------------------
-- 3. The spend journal is append-only, enforced.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_engine_spend_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION
    'ca_diamond_engine_spend is append-only: % on id % refused. It is the register of engine spend, and it replaced a running total whose mutability cost 5,861 awards. Correct it forward with a new row.',
    TG_OP, COALESCE(OLD.id, -1);
END $$;

DROP TRIGGER IF EXISTS zz_engine_spend_append_only ON public.ca_diamond_engine_spend;
CREATE TRIGGER zz_engine_spend_append_only
  BEFORE UPDATE OR DELETE ON public.ca_diamond_engine_spend
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_engine_spend_append_only();

-- ---------------------------------------------------------------------------
-- 4. The forecast can see a retired rule that still holds incidents.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_flip_forecast(p_hours integer DEFAULT 24)
RETURNS TABLE (
  rule           text,
  mode           text,
  arms_on        date,
  would_refuse   bigint,
  players_hit    bigint,
  diamonds       numeric,
  last_seen      timestamptz,
  verdict        text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_since timestamptz := now() - make_interval(hours => GREATEST(COALESCE(p_hours, 24), 1));
        v_blind bigint; v_blind_new timestamptz;
BEGIN
  IF COALESCE(auth.role(), 'service_role') <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required';
  END IF;

  RETURN QUERY
  SELECT m.rule, m.mode, m.flip_after::date,
         count(i.id), count(DISTINCT i.user_id), COALESCE(sum(abs(i.amount)), 0)::numeric,
         max(i.occurred_at),
         CASE
           WHEN m.mode = 'refuse' THEN
             'ALREADY ARMED. It is refusing now; the count is what it has refused.'
           WHEN count(i.id) = 0 THEN
             'SAFE TO ARM. Nothing in the window would have been refused.'
           WHEN max(i.occurred_at) < now() - interval '3 hours' THEN
             'PROBABLY FIXED ALREADY. ' || count(i.id) || ' in the window, but the most recent was '
             || to_char(now() - max(i.occurred_at), 'HH24:MI') || ' ago and nothing since. Re-read '
             || 'over a shorter window before acting.'
           WHEN m.flip_after IS NULL THEN
             'WOULD REFUSE ' || count(i.id) || ' - no arming date set, so this is advisory only.'
           WHEN m.flip_after <= now() THEN
             'OVERDUE AND LOUD. Its date has passed, it is still logging, and it would refuse '
             || count(i.id) || ' movement(s) affecting ' || count(DISTINCT i.user_id) || ' player(s).'
           ELSE
             'WOULD REFUSE ' || count(i.id) || ' movement(s) worth ' || COALESCE(sum(abs(i.amount)), 0)
             || ' diamonds across ' || count(DISTINCT i.user_id) || ' player(s), most recent '
             || to_char(now() - max(i.occurred_at), 'HH24:MI') || ' ago, starting in '
             || (m.flip_after::date - now()::date) || ' day(s). Read this before that date.'
         END
    FROM public.ca_diamond_rule_modes m
    LEFT JOIN public.ca_diamond_incidents i
           ON i.rule = m.rule AND i.occurred_at >= v_since
   GROUP BY m.rule, m.mode, m.flip_after;

  -- A RETIRED RULE THAT STILL HOLDS INCIDENTS. The query above starts FROM the rule table, so a
  -- rule that has been removed contributes nothing and reads as absent rather than as retired.
  -- 297 DR7:engine_over_budget incidents were invisible that way. Silence and "nothing to report"
  -- must never be the same reading (CLAUDE.md 10.86).
  RETURN QUERY
  SELECT x.rule, 'retired'::text, NULL::date,
         count(*), count(DISTINCT x.user_id), COALESCE(sum(abs(x.amount)), 0)::numeric,
         max(x.occurred_at),
         'RETIRED RULE, ' || count(*) || ' incident(s) still in the window. It refuses nothing and '
         || 'arms on no date. The rows are history and stay; nothing acts on them.'
    FROM public.ca_diamond_incidents x
   WHERE x.occurred_at >= v_since
     AND NOT EXISTS (SELECT 1 FROM public.ca_diamond_rule_modes m WHERE m.rule = x.rule)
   GROUP BY x.rule;

  SELECT count(*), max(x.occurred_at) INTO v_blind, v_blind_new
    FROM public.ca_diamond_incidents x
   WHERE x.rule = 'DR7:ledger_write_failed' AND x.occurred_at >= v_since;
  RETURN QUERY SELECT
    '(forecast confidence)'::text,
    CASE WHEN v_blind = 0 THEN 'complete' ELSE 'incomplete' END::text,
    NULL::date, v_blind, 0::bigint, 0::numeric, v_blind_new,
    CASE WHEN v_blind = 0
         THEN 'Every award in the window was evaluated, so the counts above are totals.'
         ELSE v_blind || ' award(s) could not be evaluated at all because the ledger write failed, '
              || 'most recent ' || to_char(now() - v_blind_new, 'HH24:MI') || ' ago. Every count '
              || 'above is a FLOOR, not a total.'
    END;
END $$;

REVOKE ALL ON FUNCTION public.fn_ca_diamond_flip_forecast(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_flip_forecast(integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. The two claim loops can be compared, so a divergence cannot ship quietly.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_normalise_claim_loop(p_src text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_temp
AS $$
  -- Reduce a function body to just its horse claim loop, in a form two copies can be compared in.
  -- Cut at END LOOP: past that point each copy closes a DIFFERENT enclosing function, and comparing
  -- that scaffolding reports a divergence that is not one. Self-names collapse to SELF because each
  -- copy correctly names itself in the incident it files. Comments go because they are commentary.
  -- What survives is the behaviour: which claims are selected, in what order, what pays them, which
  -- error is deliberately silent, and that the pass stops after a refusal.
  SELECT regexp_replace(
           regexp_replace(
             replace(replace(
               substring(cut FROM 1 FOR NULLIF(strpos(cut, 'END LOOP'), 0) + 7),
               'record_daily_challenge_event(6)', 'SELF'),
               'record_daily_challenge_event_serialized_body', 'SELF'),
             '--[^' || chr(10) || ']*', '', 'g'),
           '\s+', ' ', 'g')
    FROM (SELECT substring(p_src FROM NULLIF(position('FOR v_claim IN' IN p_src), 0)) AS cut) s;
$$;

COMMENT ON FUNCTION public.fn_ca_normalise_claim_loop(text) IS
  'Reduces a function body to its horse claim loop for comparison. The loop exists in two copies (record_daily_challenge_event and its _serialized_body) which must behave identically; merging them is owed work, and until then this is what makes a silent divergence impossible.';

-- ---------------------------------------------------------------------------
-- Assertions.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_a text; v_b text; v_n integer; v_sent integer; v_ok boolean;
BEGIN
  -- 1. the two harness predicates agree about everything, including how they are executed
  IF (SELECT count(DISTINCT prosecdef) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('fn_ca_is_cert_account', 'fn_ca_is_fixture_account')) <> 1 THEN
    RAISE EXCEPTION 'the two harness predicates still run under different security';
  END IF;
  IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.is_horse
              AND (public.fn_ca_is_cert_account(p.id) OR public.fn_ca_is_fixture_account(p.id))) THEN
    RAISE EXCEPTION 'a horse still reads as harness equipment';
  END IF;
  IF public.fn_ca_is_cert_account('00000000-0000-0000-0000-000000000abc') IS NOT TRUE
     OR public.fn_ca_is_cert_account(NULL) IS NOT FALSE THEN
    RAISE EXCEPTION 'the cert predicate no longer answers correctly for its real cases';
  END IF;

  -- 2. no sentinel survives, and none can be written
  SELECT count(*) INTO v_sent FROM public.diamond_reward_budgets
   WHERE budget_diamonds >= 9223372036854775000;
  IF v_sent <> 0 THEN RAISE EXCEPTION '% sentinel budget(s) remain', v_sent; END IF;
  BEGIN
    INSERT INTO public.diamond_reward_budgets (period, engine, budget_diamonds, spent_diamonds)
    VALUES ('1999-01', 'zz_probe', 9223372036854775807, 0);
    RAISE EXCEPTION 'a bigint-max sentinel was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- and the reality report names the fiction rather than hiding it
  IF NOT EXISTS (SELECT 1 FROM public.fn_ca_diamond_budget_reality()
                  WHERE verdict LIKE 'ALREADY OVER%') THEN
    RAISE EXCEPTION 'the budget reality report does not name the September daily_missions overrun';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.fn_ca_diamond_budget_reality()
                  WHERE verdict LIKE 'NO PLAN SET%') THEN
    RAISE EXCEPTION 'the retired sentinel is not reported as an unset plan';
  END IF;
  -- THE COLUMN'S ONLY READER STILL WORKS WITH A NULL IN IT. Making a column nullable is only safe
  -- if what sums it says so, and the way to know is to run it. Six informational rows carry a NULL
  -- `difference` BY DESIGN (arena_wallets, diamond_debts, promo_budgets_spent, mirror_mismatch,
  -- dead_stores, suspense have nothing to reconcile against); an earlier draft of this assertion
  -- read that as breakage, which is the mistake this migration is otherwise about.
  SELECT count(*) INTO v_n FROM public.fn_ca_diamond_trial_balance();
  IF v_n = 0 THEN RAISE EXCEPTION 'the trial balance returned nothing after budget_diamonds became nullable'; END IF;
  IF EXISTS (SELECT 1 FROM public.fn_ca_diamond_trial_balance()
              WHERE difference IS NULL
                AND account IN ('player_diamonds','fixture_accounts','diamond_house','register','total')) THEN
    RAISE EXCEPTION 'a NULL budget propagated into a reconciling row of the trial balance';
  END IF;

  -- AND THE SENTINEL IS OUT OF THE BOOKS. It was not merely sitting in a column: the trial balance
  -- summed it and printed "9,223,372,036,867,275,807 budgeted" on the promo_budgets_spent line, so
  -- the one report a person reads to see whether the diamond books are sound carried a number
  -- larger than every diamond that will ever exist, and had done since 2026-09-07.
  SELECT note INTO v_a FROM public.fn_ca_diamond_trial_balance() WHERE account = 'promo_budgets_spent';
  IF v_a IS NULL THEN RAISE EXCEPTION 'the trial balance no longer reports promo_budgets_spent'; END IF;
  IF (SELECT COALESCE(max(m[1]::numeric), 0) FROM regexp_matches(v_a, '([0-9]{10,})', 'g') m) > 1000000000 THEN
    RAISE EXCEPTION 'the trial balance still prints a sentinel-sized budget: %', v_a;
  END IF;

  -- 3. the spend journal refuses to be rewritten
  BEGIN
    UPDATE public.ca_diamond_engine_spend SET amount = amount WHERE id = (
      SELECT id FROM public.ca_diamond_engine_spend ORDER BY id DESC LIMIT 1);
    RAISE EXCEPTION 'the engine spend journal accepted an UPDATE';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%append-only%' THEN RAISE; END IF;
  END;

  -- 4. the retired rule is visible, and named as retired
  SELECT count(*) INTO v_n FROM public.fn_ca_diamond_flip_forecast(24)
   WHERE mode = 'retired' AND rule = 'DR7:engine_over_budget';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the forecast still cannot see the 297 incidents of the retired budget rule';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.fn_ca_diamond_flip_forecast(24)
                  WHERE rule = '(forecast confidence)') THEN
    RAISE EXCEPTION 'the forecast stopped reporting its own confidence';
  END IF;

  -- 5. THE TWO CLAIM LOOPS DO THE SAME THING.
  -- Not character-for-character: they differ on purpose in two ways, and an assertion that failed
  -- on those would be noise that the next agent learns to weaken. Each names ITSELF in the incident
  -- it files, which is how you tell which copy refused, and each carries its own comments. So both
  -- are normalised - comments stripped, whitespace collapsed, the two self-names replaced by a
  -- single token - and what remains is the behaviour: the query that selects the claims, their
  -- order, the call that pays them, the error it stays silent about, and the EXIT.
  SELECT public.fn_ca_normalise_claim_loop(p.prosrc)
    INTO v_a FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'record_daily_challenge_event' AND p.pronargs = 6;
  SELECT public.fn_ca_normalise_claim_loop(p.prosrc)
    INTO v_b FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'record_daily_challenge_event_serialized_body' AND p.pronargs = 5;
  IF v_a IS NULL OR v_b IS NULL OR length(v_a) < 200 THEN
    RAISE EXCEPTION 'the horse claim loop could not be located in both copies';
  END IF;
  IF v_a IS DISTINCT FROM v_b THEN
    RAISE EXCEPTION 'the two copies of the horse claim loop have diverged in behaviour. A: % --- B: %',
      v_a, v_b;
  END IF;
  -- and both still do the thing that matters, so a loop emptied of its body cannot pass the above
  IF strpos(v_a, 'claim_daily_challenge_serialized_body(p_user_id, v_claim.id, NULL)') = 0
     OR strpos(v_a, 'DR7:user_over_daily_cap') = 0
     OR strpos(v_a, 'EXIT') = 0 THEN
    RAISE EXCEPTION 'the claim loop no longer pays, no longer matches the cap precisely, or no longer exits';
  END IF;

  -- and the money still adds up
  IF (SELECT public.fn_ca_mint_supply('diamonds'))
     <> (SELECT COALESCE(sum(diamonds), 0) FROM public.profiles) + public.fn_ca_diamond_offledger_float() THEN
    RAISE EXCEPTION 'players + float <> register after a change that moves no money';
  END IF;

  RAISE NOTICE 'five defects closed; nothing moved';
END $$;

COMMIT;
