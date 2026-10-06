-- ===========================================================================
--  THE THREE FICTION REWARD BUDGET LINES ARE SET FROM MEASURED ISSUANCE
-- ===========================================================================
--
-- For weeks fn_ca_diamond_health() has reported exactly one area that is not
-- `ok`:
--
--   budget plans | attention | "3 budget line(s) are fiction. They refuse
--                              nobody (ruling 21); setting them is Dan's."
--
-- Dan, verbatim on 2026-10-05, answering a list of items handed back to him as
-- owner decisions, this one among them: "NOTHING IS MINE, EVER.... THEY ARE
-- ALWAYS YOURS TO DO." So the three figures are set here. That instruction is
-- later and more specific than the notes that call these numbers his, and
-- under CLAUDE.md 10.8 the later explicit owner instruction governs.
--
-- IT IS NOT A LICENCE TO INVENT A NUMBER. Every figure below is derived from
-- measured issuance read from production on 2026-10-05, and each one is a row
-- in diamond_reward_budgets, so any of them can be changed later by editing a
-- row rather than by changing code.
--
-- RULING 21 IS WHY THIS IS SAFE TO DO AT ALL, and it is not weakened by one
-- character. "THERE SHOULDN'T BE A PLATFORM BUDGET ON THINGS LIKE THIS, ONLY A
-- USER BUDGET" (Dan, 2026-09-08, migration 20260908130203). A per-engine
-- monthly line is a shared pot: refusing on it punishes whoever arrives last
-- for what everybody else earned. Since that ruling the line is a forecast and
-- nothing reads it to refuse anybody - DR7:engine_over_budget was deleted, not
-- deferred, and the earn ledger's budget write is a once-a-month upsert with no
-- refusal path. The only thing that refuses is the per-user cap in
-- diamond_engine_daily_caps. So these three numbers going up cannot pay anybody
-- more and these three numbers going down cannot refuse anybody; all they
-- change is whether the report says the plan matches reality. This file
-- asserts that shape is still in place before and after, and writes no rule,
-- no cap, no price and no rate.
--
-- WHAT CHANGES - three UPDATEs, three rows, and nothing else in the database:
--
--   2026-09 / daily_missions        30,000 -> 600,000
--     September is complete. fn_ca_diamond_engine_spent reads 565,705 issued to
--     977 distinct players: 491,200 in the append-only ca_diamond_engine_spend
--     journal from 2026-09-08, plus the 74,505 frozen spent_diamonds baseline
--     from before that journal existed. The 30,000 line was written
--     2026-09-07, before any of it, and reality overran it 18.9 times. 600,000
--     is the next round figure above what the month actually issued, 6.1 per
--     cent of headroom. It is a record of what this engine cost in September,
--     set from September's own rows.
--
--   2026-10 / daily_challenges     100,000 -> 12,000,000
--     October is in progress, so the plan has to cover the month, not the part
--     of it that has happened. The four complete Chicago days 2026-10-01 to
--     2026-10-04 issued 1,504,465, a mean of 376,116 a day; across 31 days
--     that projects to 11,659,604. 12,000,000 is the next round figure above
--     the projection. It is also the plan this same engine already carried for
--     2026-09 (set 2026-09-08), against which September's complete-month
--     5,347,453 read "Plausible" at 0.45x - so the figure is not new to this
--     engine, it is the one month somebody did set, now carried to the month
--     that needs it. The 100,000 line was already 15.8x over on day five.
--
--   2026-10 / mint                        0 -> 2,400,000
--     "BUDGETED ZERO, ISSUED 2040000. The plan says this engine does not
--     exist." It does exist. Every row the earn ledger files under `mint` in
--     October is one credit: "The Mint: Lifetime VIP Monthly Diamond Benefit",
--     source `the_mint`, 2,000 Diamonds, paid once a month to each lifetime
--     VIP - 1,020 recipients at exactly 2,000 each between 2026-10-02 and
--     2026-10-04, 2,040,000 in total, against a lifetime-VIP population of
--     1,021 today. 2,400,000 is 1,200 recipients at 2,000, which covers the
--     measured population and 17.5 per cent of growth in it.
--
--     CLAUDE.md 10.5: 1,000 of those 1,020 recipients are horses and 20 are
--     human. The population this line is sized on is the whole of it. A horse
--     earns and is paid what a human does, so a horse is budgeted for exactly
--     as a human is, and this plan would be the same number if every recipient
--     were human.
--
--     The figure is deliberately NOT 2,500,000. That is the literal the earn
--     ledger used to invent for an engine nobody had planned, removed on
--     2026-10-04 by 20261004211453; a plan that happened to equal it would
--     read, to the next person, as that invention rather than as a decision.
--
-- THE INVENTED FALLBACK STAYS GONE, AND THIS FILE ADDS NOTHING TO THAT.
-- fn_ca_diamond_earn_ledger created a missing period's line as
-- COALESCE(<previous period's line>, 2500000). That was removed on 2026-10-04
-- (20261004211453, applied; the live body carries the carry-forward and no
-- literal, md5 0ed2763a2454d76d9557ae4aa46f14b8) and pinned by
-- tests/an-unset-budget-is-not-a-number.law.test.ts and by the column's own
-- CHECK ca_budget_is_a_number_or_nothing, which admits NULL. Decision: it
-- stays removed. A new engine's first credit now creates its line NULL, which
-- fn_ca_diamond_budget_reality reports as "NO PLAN SET. Refuses nobody either
-- way (ruling 21); this is simply unstated." - a named absence rather than a
-- number nobody approved, which is what the design asks for. This file
-- asserts both halves of that are still true rather than trusting them.
--
-- WHAT THIS FILE DOES NOT TOUCH. The other 36 budget lines, including the
-- three 2,500,000 `signup` lines for 2026-05, 2026-07 and 2026-08 and the two
-- 2,500,000 `daily_mission_milestones` lines: none of them reads as fiction
-- (each is above its own issuance), and rewriting a recorded line that nothing
-- reports on would be tidying, not fixing. spent_diamonds is a frozen baseline
-- and is not written here. No diamond_transactions row, no ca_diamond_engine_
-- spend row and no ca_mint_ledger row is read for anything but counting, and
-- none is written: a settled financial record is never rewritten. Both
-- ca_arena_settings switches are asserted unchanged and never written -
-- cash_games_enabled is false and tournaments_enabled has been true since
-- 20261005105457, and both are the owner's to move, not this file's.
--
-- LOCKS AND CONTENTION. Three rows of a 39-row table with no inbound foreign
-- key, no trigger, no policy and no publication (all four read from the
-- catalogue on 2026-10-05). The write is RowExclusive on three rows. The one
-- live writer that can contend is fn_ca_diamond_earn_ledger's once-a-month
-- INSERT ... ON CONFLICT (period, engine) DO NOTHING, which for an existing
-- row must wait on an uncommitted conflicting update - so every expensive read
-- in this file happens BEFORE the three UPDATEs, and only cheap assertions
-- follow them. fn_ca_diamond_health() is deliberately NOT called inside this
-- transaction: it runs the trial balance and fourteen-day cap headroom, and
-- holding the 2026-10/daily_challenges row through that would make live
-- daily-challenge awards wait. This file asserts the exact predicate that
-- health reads instead, and health itself is read live after the apply.
--
-- CLAUDE.md section 2: one migration, one transaction. No DDL, so no
-- PostgREST reload and no schema-manifest change. No function is created,
-- replaced or dropped, so no guard redefinition is declared (neither
-- fn_ca_diamond_budget_reality nor fn_ca_diamond_earn_ledger is on
-- fn_ca_guard_watchlist(), checked). 10.12: no cron, sweep, reconciler,
-- backfill or compensating write anywhere in it.
-- ===========================================================================
-- @live-proof: (SELECT budget_diamonds FROM public.diamond_reward_budgets WHERE period = '2026-09' AND engine = 'daily_missions') = 600000
-- @live-proof: (SELECT budget_diamonds FROM public.diamond_reward_budgets WHERE period = '2026-10' AND engine = 'daily_challenges') = 12000000
-- @live-proof: (SELECT budget_diamonds FROM public.diamond_reward_budgets WHERE period = '2026-10' AND engine = 'mint') = 2400000
-- @live-proof: (SELECT count(*) FROM public.fn_ca_diamond_budget_reality() x WHERE x.verdict LIKE 'ALREADY OVER%' OR x.verdict LIKE 'FUTURE PLAN BELOW%' OR x.verdict LIKE 'BUDGETED ZERO%') = 0
-- @live-proof: (SELECT status FROM public.fn_ca_diamond_health() h WHERE h.area = 'budget plans') = 'ok'

BEGIN;

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 0. PREIMAGE. Everything expensive happens here, before any row is locked.
--    If production is not the estate measured on 2026-10-05, this file
--    refuses and changes nothing.
-- ---------------------------------------------------------------------------
DO $one$
DECLARE
  v_n bigint; v_m bigint; v_txt text; v_fiction text; v_bad text;
  v_rows bigint; v_others_before text; v_others_after text;
BEGIN
  -- 0.1 The three lines exist and hold the fiction that was read.
  IF (SELECT budget_diamonds FROM public.diamond_reward_budgets
       WHERE period = '2026-09' AND engine = 'daily_missions') IS DISTINCT FROM 30000 THEN
    RAISE EXCEPTION 'preimage: 2026-09/daily_missions is not the 30000 line that was read; re-read production before applying this file';
  END IF;
  IF (SELECT budget_diamonds FROM public.diamond_reward_budgets
       WHERE period = '2026-10' AND engine = 'daily_challenges') IS DISTINCT FROM 100000 THEN
    RAISE EXCEPTION 'preimage: 2026-10/daily_challenges is not the 100000 line that was read; re-read production before applying this file';
  END IF;
  IF (SELECT budget_diamonds FROM public.diamond_reward_budgets
       WHERE period = '2026-10' AND engine = 'mint') IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'preimage: 2026-10/mint is not the zero line that was read; re-read production before applying this file';
  END IF;

  -- 0.2 THESE THREE ARE THE WHOLE OF THE FICTION. If a fourth line has become
  --     fiction since, setting three of them would turn the area green while
  --     leaving a real one unreported, which is worse than the attention.
  SELECT count(*), string_agg(x.period || '/' || x.engine, ', ' ORDER BY x.period, x.engine)
    INTO v_n, v_fiction
    FROM public.fn_ca_diamond_budget_reality() x
   WHERE x.verdict LIKE 'ALREADY OVER%'
      OR x.verdict LIKE 'FUTURE PLAN BELOW%'
      OR x.verdict LIKE 'BUDGETED ZERO%';
  IF v_n <> 3 THEN
    RAISE EXCEPTION 'preimage: % budget line(s) read as fiction, expected 3: %', v_n, COALESCE(v_fiction, '(none)');
  END IF;
  IF v_fiction <> '2026-09/daily_missions, 2026-10/daily_challenges, 2026-10/mint' THEN
    RAISE EXCEPTION 'preimage: the fiction is a different set of lines: %', v_fiction;
  END IF;

  -- 0.3 THE MEASURED BASIS. Each new figure must still cover what its engine
  --     has issued. The journal is append-only, so a measured actual can only
  --     grow; if one has grown past the plan this file would set, the plan is
  --     wrong and this file must not land.
  v_n := public.fn_ca_diamond_engine_spent('2026-09', 'daily_missions');
  IF v_n < 565705 OR v_n > 600000 THEN
    RAISE EXCEPTION 'basis: 2026-09/daily_missions issued %, outside the measured 565705 and the 600000 this file sets', v_n;
  END IF;

  v_n := public.fn_ca_diamond_engine_spent('2026-10', 'daily_challenges');
  IF v_n < 1500000 OR v_n > 12000000 THEN
    RAISE EXCEPTION 'basis: 2026-10/daily_challenges issued %, outside the measured run rate and the 12000000 this file sets', v_n;
  END IF;

  v_n := public.fn_ca_diamond_engine_spent('2026-10', 'mint');
  IF v_n < 2040000 OR v_n > 2400000 THEN
    RAISE EXCEPTION 'basis: 2026-10/mint issued %, outside the measured 2040000 and the 2400000 this file sets', v_n;
  END IF;

  -- 0.4 The mint line is sized on recipients x 2000, so both halves are read.
  SELECT count(DISTINCT s.user_id), count(DISTINCT s.amount)
    INTO v_n, v_m
    FROM public.ca_diamond_engine_spend s
   WHERE s.period = '2026-10' AND s.engine = 'mint';
  IF v_n < 1000 OR v_m <> 1 THEN
    RAISE EXCEPTION 'basis: 2026-10/mint is % recipient(s) at % distinct amount(s); the per-recipient benefit this plan is sized on is not what is being paid', v_n, v_m;
  END IF;
  IF (SELECT DISTINCT s.amount FROM public.ca_diamond_engine_spend s
       WHERE s.period = '2026-10' AND s.engine = 'mint') <> 2000 THEN
    RAISE EXCEPTION 'basis: the lifetime VIP monthly benefit is no longer 2000 Diamonds; re-derive the mint plan';
  END IF;
  -- CLAUDE.md 10.5: the population includes horses, and the plan is sized on
  -- all of it. A plan that only covered the humans would be a plan that
  -- excluded horses from being paid what humans are paid.
  SELECT count(*) INTO v_n FROM public.profiles p
   WHERE COALESCE(p.is_vip, false) AND COALESCE(p.vip_tier, '') = 'lifetime';
  IF v_n > 1200 THEN
    RAISE EXCEPTION 'basis: % lifetime VIPs, more than the 1200 recipients the 2400000 mint plan covers', v_n;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p
                  WHERE COALESCE(p.is_vip, false) AND COALESCE(p.vip_tier, '') = 'lifetime'
                    AND COALESCE(p.is_horse, false)) THEN
    RAISE EXCEPTION 'basis: no horse is in the lifetime VIP population this plan is sized on; 10.5 says a horse is paid what a human is';
  END IF;

  -- 0.5 No line exists for a period after this one, so raising a current
  --     month's plan cannot make a later month read FUTURE PLAN BELOW PAST
  --     ACTUAL against it.
  SELECT count(*) INTO v_n FROM public.diamond_reward_budgets WHERE period > '2026-10';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'preimage: % budget line(s) exist for a period after 2026-10; re-reason the forward effect', v_n;
  END IF;

  -- 0.6 RULING 21 IS IN FORCE AND THIS FILE LEAVES IT THAT WAY. A platform pot
  --     refuses nobody: the rule that once could is absent, and the earn
  --     ledger has no refusal on the engine total.
  IF EXISTS (SELECT 1 FROM public.ca_diamond_rule_modes WHERE rule = 'DR7:engine_over_budget') THEN
    RAISE EXCEPTION 'ruling 21: DR7:engine_over_budget has a rule row again; a platform pot must not be able to refuse';
  END IF;
  v_txt := pg_get_functiondef('public.fn_ca_diamond_earn_ledger()'::regprocedure);
  IF position('2500000' IN v_txt) > 0 THEN
    RAISE EXCEPTION 'the earn ledger invents a budget again; the invented fallback was removed on 2026-10-04';
  END IF;
  IF position('WHERE b.engine = v_engine AND b.period < v_period' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the earn ledger lost its carry-forward; a month with no new instruction must continue the last plan somebody set';
  END IF;
  IF position('DR7:user_over_daily_cap' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the earn ledger lost the only cap that refuses (ruling 21)';
  END IF;

  -- 0.7 The switches are the owner's. Read, never written.
  IF (SELECT cash_games_enabled FROM public.ca_arena_settings WHERE id = 1) IS NOT FALSE THEN
    RAISE EXCEPTION 'cash_games_enabled is not false; this file must not run while that is unexpected';
  END IF;
  IF (SELECT tournaments_enabled FROM public.ca_arena_settings WHERE id = 1) IS NOT TRUE THEN
    RAISE EXCEPTION 'tournaments_enabled is not true; this file must not run while that is unexpected';
  END IF;

  -- 0.8 The books are sound going in.
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the register and supply disagree before this file; nothing is written while that is true';
  END IF;
  IF (SELECT count(*) FROM public.diamond_reward_budgets) <> 39 THEN
    RAISE EXCEPTION 'diamond_reward_budgets holds % rows, not the 39 that were read', (SELECT count(*) FROM public.diamond_reward_budgets);
  END IF;

  -- 0.9 EVERY OTHER LINE, EXACTLY AS IT STANDS. Compared again after the write
  --     so this file can prove it touched nothing but the three rows it names.
  SELECT md5(string_agg(b.period || '/' || b.engine || '=' || COALESCE(b.budget_diamonds::text, 'NULL')
                        || '/' || b.spent_diamonds::text, ';' ORDER BY b.period, b.engine))
    INTO v_others_before
    FROM public.diamond_reward_budgets b
   WHERE (b.period, b.engine) NOT IN (('2026-09','daily_missions'), ('2026-10','daily_challenges'), ('2026-10','mint'));

  -- -------------------------------------------------------------------------
  -- 1. THE THREE PLANS. The only write in this file.
  -- -------------------------------------------------------------------------
  UPDATE public.diamond_reward_budgets
     SET budget_diamonds = 600000, updated_at = now()
   WHERE period = '2026-09' AND engine = 'daily_missions' AND budget_diamonds = 30000;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'set: 2026-09/daily_missions matched % rows, expected 1', v_rows; END IF;

  UPDATE public.diamond_reward_budgets
     SET budget_diamonds = 12000000, updated_at = now()
   WHERE period = '2026-10' AND engine = 'daily_challenges' AND budget_diamonds = 100000;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'set: 2026-10/daily_challenges matched % rows, expected 1', v_rows; END IF;

  UPDATE public.diamond_reward_budgets
     SET budget_diamonds = 2400000, updated_at = now()
   WHERE period = '2026-10' AND engine = 'mint' AND budget_diamonds = 0;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'set: 2026-10/mint matched % rows, expected 1', v_rows; END IF;

  -- -------------------------------------------------------------------------
  -- 2. POSTIMAGE. Cheap only: the three rows locked above are released at
  --    COMMIT and nothing slow runs while they are held.
  -- -------------------------------------------------------------------------
  -- 2.1 The three figures are the ones this header states.
  IF (SELECT budget_diamonds FROM public.diamond_reward_budgets
       WHERE period = '2026-09' AND engine = 'daily_missions') <> 600000
     OR (SELECT budget_diamonds FROM public.diamond_reward_budgets
          WHERE period = '2026-10' AND engine = 'daily_challenges') <> 12000000
     OR (SELECT budget_diamonds FROM public.diamond_reward_budgets
          WHERE period = '2026-10' AND engine = 'mint') <> 2400000 THEN
    RAISE EXCEPTION 'postimage: a plan did not take the figure this file states';
  END IF;

  -- 2.2 THE PREDICATE fn_ca_diamond_health() READS. Zero fiction, which is
  --     what makes the `budget plans` area ok.
  SELECT count(*), string_agg(x.period || '/' || x.engine || ': ' || x.verdict, ' | ')
    INTO v_n, v_bad
    FROM public.fn_ca_diamond_budget_reality() x
   WHERE x.verdict LIKE 'ALREADY OVER%'
      OR x.verdict LIKE 'FUTURE PLAN BELOW%'
      OR x.verdict LIKE 'BUDGETED ZERO%';
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'postimage: % budget line(s) still read as fiction: %', v_n, v_bad;
  END IF;

  -- 2.3 And each of the three says so in its own words.
  SELECT string_agg(x.period || '/' || x.engine || ': ' || x.verdict, ' | ')
    INTO v_bad
    FROM public.fn_ca_diamond_budget_reality() x
   WHERE (x.period, x.engine) IN (('2026-09','daily_missions'), ('2026-10','daily_challenges'), ('2026-10','mint'))
     AND x.verdict NOT LIKE 'Plausible:%';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'postimage: a line this file set does not read as plausible: %', v_bad;
  END IF;

  -- 2.4 NOTHING ELSE MOVED. The frozen baselines, the row count, the other 36
  --     lines, the switches and the register are all as they were.
  IF (SELECT spent_diamonds FROM public.diamond_reward_budgets
       WHERE period = '2026-09' AND engine = 'daily_missions') <> 74505 THEN
    RAISE EXCEPTION 'postimage: the 2026-09/daily_missions frozen baseline moved; it is a settled measurement';
  END IF;
  IF EXISTS (SELECT 1 FROM public.diamond_reward_budgets
              WHERE period = '2026-10' AND engine IN ('daily_challenges','mint') AND spent_diamonds <> 0) THEN
    RAISE EXCEPTION 'postimage: an October frozen baseline moved';
  END IF;
  SELECT md5(string_agg(b.period || '/' || b.engine || '=' || COALESCE(b.budget_diamonds::text, 'NULL')
                        || '/' || b.spent_diamonds::text, ';' ORDER BY b.period, b.engine))
    INTO v_others_after
    FROM public.diamond_reward_budgets b
   WHERE (b.period, b.engine) NOT IN (('2026-09','daily_missions'), ('2026-10','daily_challenges'), ('2026-10','mint'));
  IF v_others_after IS DISTINCT FROM v_others_before THEN
    RAISE EXCEPTION 'postimage: a budget line this file does not name reads differently than it did at the preimage (% -> %). A concurrent first credit for an engine with no line yet would also do this, and it is benign; re-read the table and apply again.', v_others_before, v_others_after;
  END IF;
  IF (SELECT cash_games_enabled FROM public.ca_arena_settings WHERE id = 1) IS NOT FALSE
     OR (SELECT tournaments_enabled FROM public.ca_arena_settings WHERE id = 1) IS NOT TRUE THEN
    RAISE EXCEPTION 'postimage: an arena switch moved; this file must never write one';
  END IF;
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'postimage: the register and supply disagree; a plan is not money and must not have moved any';
  END IF;

  -- 2.5 RULING 21 STILL HOLDS. A bigger plan must not have become a bigger
  --     gate: nothing refuses on the engine total, going out as going in.
  IF EXISTS (SELECT 1 FROM public.ca_diamond_rule_modes WHERE rule = 'DR7:engine_over_budget') THEN
    RAISE EXCEPTION 'postimage: DR7:engine_over_budget exists; a platform pot must refuse nobody';
  END IF;
  IF position('2500000' IN pg_get_functiondef('public.fn_ca_diamond_earn_ledger()'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'postimage: the earn ledger invents a budget again';
  END IF;
END $one$;

COMMIT;
