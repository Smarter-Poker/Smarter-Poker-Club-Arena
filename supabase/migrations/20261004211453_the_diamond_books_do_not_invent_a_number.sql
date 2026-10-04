-- ============================================================================
-- THE DIAMOND BOOKS DO NOT INVENT A NUMBER
-- ============================================================================
--
-- Two defects from docs/DIAMOND-DESTINATIONS-DESIGN-2026-09-21.md section 6,
-- "What Is Already Wrong Today": item 4 (a paid trivia entry breaks the
-- Diamond identity) and item 8 (the earn ledger writes a budget nobody set).
-- Both were re-read on production on 2026-10-04 and both were still live.
-- Neither needs an economics decision and neither sets a number: item 4 adds
-- the register row the house credit always owed, and item 8 stops a trigger
-- inventing a plan.
--
-- 1. ITEM 4. enter_trivia_tournament_v2 (md5 e636c45d5552ce1484e602bbb5d07917,
--    unchanged since the design was written) retires the player's whole entry
--    fee through the diamond journal - which the register follows, so the fee
--    is burned from that player - credits the 10 percent cut to
--    ca_diamond_house, and writes a ca_diamond_house_ledger row. It writes NO
--    house mint row to ca_mint_ledger. ca_diamond_house_ledger is the house's
--    own balance history and the register does not see it, so the house ends
--    up holding Diamonds the register never issued.
--
--    Measured, 2026-10-04, in a transaction that ended in RAISE EXCEPTION and
--    rolled back (CLAUDE.md 11.5 rule 1, one call, one self-aborting DO
--    block): on a 50 Diamond entry the prize pool took 45, the house took 5,
--    one ca_diamond_house_ledger row was written, NO ca_mint_ledger row was
--    written, and fn_ca_diamond_register_vs_supply().difference moved from
--    0.00 to 5.00 - exactly the cut. That difference being 0 is the assertion
--    every Diamond migration ends on, so the next Diamond migration to run
--    after a paid trivia entry would refuse itself. No trivia entry has been
--    made since 2026-02-12 (208 entries, last at 15:54:35 UTC) and
--    ca_diamond_house_ledger holds no trivia_tournament_entry_cut row, so
--    this has never fired and there is nothing to settle. The house balance
--    is 0 and the identity difference is 0 as this is written.
--
--    THE FIX is rule R2 of the destinations design, section 3.1: a Diamond
--    crossing the line between a player and the house is a registered PAIR in
--    one transaction - the payer's spend journal row, which retires it from
--    the player, and a house mint row, which issues it to the house. Nothing
--    crosses with one row, and nothing crosses through
--    ca_diamond_house_ledger. The shape is copied from
--    fn_poker_diamond_tournament_settle_fee, the estate's other Diamond house
--    credit, which writes exactly one ca_mint_ledger 'mint' row for the house
--    reasoned DR14 (poker_tournament_fee). The op_id is the same idempotency
--    reference the house ledger row already uses, so the UNIQUE index on
--    ca_mint_ledger.op_id makes a replay impossible; the duplicate-entry
--    check at the top of the door already made one unreachable.
--
--    The caller is NOT in this repository. enter_trivia_tournament_v2 is
--    reached from the World Hub, pages/api/trivia/tournament-enter.js line 35
--    (repo Smarter-Poker/Smarter-Poker-World-Hub), and there is no caller in
--    Club Arena's src/ or server/ trees. The FUNCTION, though, is Club
--    Arena's: its current body was written by Club Arena's
--    20260903002841_diamond_e_every_earn_engine_has_a_budget_line (DR14, "the
--    entry fee cut is banked, not burned"), and the Diamond register, the
--    house account and the identity assertion all live here. World Hub's
--    20260906120000_trivia_pvp_containment only re-checks the signature and
--    re-grants EXECUTE to service_role; it does not define the body. So the
--    fix belongs in this tree, the door keeps its signature, its
--    service_role-only grant and its search_path, and the World Hub needs no
--    change and no redeploy.
--
-- 2. ITEM 8. fn_ca_diamond_earn_ledger creates an engine's
--    diamond_reward_budgets line for a new period with
--
--        COALESCE((SELECT b.budget_diamonds ... b.period < v_period
--                   ORDER BY b.period DESC LIMIT 1), 2500000)
--
--    so an engine that has never had a line gets one of 2,500,000 Diamonds -
--    a number nobody approved, written by a trigger. Under ruling 21 the
--    engine total refuses nobody, but fn_ca_diamond_budget_reality then
--    compares real issuance against it and reports a ratio, which is the
--    10.86 rule 1 failure exactly: "I could not tell" folded into a
--    plausible-looking value instead of being given its own name.
--
--    THE FIX NEEDS NO NUMBER, and sets none. Only the invented fallback goes.
--    The carry-forward is a real decision the code already makes and it is
--    sound - a month with no new instruction continues the last plan somebody
--    set - so it stays. When there is no earlier line at all the column is
--    left NULL, which is what this schema already calls "unset": the column
--    is nullable and its own CHECK is named
--    ca_budget_is_a_number_or_nothing ("budget_diamonds IS NULL OR
--    (>= 0 AND <= 1000000000)"). fn_ca_diamond_budget_reality ALREADY reads
--    that correctly - verified on production 2026-10-04, it returns a NULL
--    ratio and the verdict "NO PLAN SET. Refuses nobody either way (ruling
--    21); this is simply unstated." - so the health function needs no change
--    to stop judging against fiction; it only needed the trigger to stop
--    manufacturing a plan. Nothing else reads budget_diamonds in a way a NULL
--    breaks: fn_ca_diamond_engine_spent reads spent_diamonds (NOT NULL
--    DEFAULT 0) and fn_ca_diamond_trial_balance does not use the budget as a
--    divisor or a sum.
--
--    The 2,500,000 lines already on the table (daily_mission_milestones for
--    2026-09 and 2026-10, signup for 2026-05, 2026-07 and 2026-08) are NOT
--    touched. They are section 6 item 7, "three reward budget lines are
--    fiction ... they refuse nobody and are Dan's to set", and rewriting a
--    recorded line to make a number look tidy is what CLAUDE.md 10.9 forbids.
--    This migration stops the next one being invented.
--
-- Both edits are made IN PLACE on the live definition, with the live md5
-- pinned before the substitution and the reverse substitution proved
-- afterwards, so every other line of both functions is provably unchanged.
-- Neither function is on fn_ca_guard_watchlist() (checked 2026-10-04), so no
-- guard redefinition is declared. One transaction, one PostgREST reload
-- (section 2 rule 1). No cron, sweep, backfill or reconciler: 10.12.
--
-- Pinned by tests/a-house-credit-is-registered.law.test.ts and
-- tests/an-unset-budget-is-not-a-number.law.test.ts.
-- docs/changelog/2026-10-04-the-diamond-books-do-not-invent-a-number.md.

-- This migration creates no persistent object: both edits are in-place
-- redefinitions, so a reader needs to be told what to look at
-- (a-merged-migration-must-be-live).
-- @live-proof: (SELECT position('trivia-tournament-cut:' IN pg_get_functiondef('public.enter_trivia_tournament_v2(uuid,uuid)'::regprocedure)) > 0 AND position('2500000' IN pg_get_functiondef('public.fn_ca_diamond_earn_ledger()'::regprocedure)) = 0)

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 1. A TRIVIA ENTRY'S HOUSE CUT IS REGISTERED, NOT ONLY BANKED
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid; v_def text; v_old text; v_new text; v_n integer;
BEGIN
  v_oid := to_regprocedure('public.enter_trivia_tournament_v2(uuid,uuid)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'enter_trivia_tournament_v2(uuid,uuid) does not exist';
  END IF;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> 'e636c45d5552ce1484e602bbb5d07917' THEN
    RAISE EXCEPTION 'enter_trivia_tournament_v2 is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := E'            VALUES (v_cut, v_house_after, ''trivia_tournament_entry_cut'',\n'
        || E'                    ''trivia_tourn_cut_''||p_tournament_id::text||''_''||p_user_id::text,\n'
        || E'                    p_user_id, p_tournament_id);\n';
  v_new := v_old
        || E'            -- R2 (DIAMOND-DESTINATIONS-DESIGN-2026-09-21 section 3.1): a Diamond\n'
        || E'            -- crossing from a player to the house is a registered PAIR in one\n'
        || E'            -- transaction - the payer''s spend journal row above, which the\n'
        || E'            -- register retires from the player, and a house mint row here, which\n'
        || E'            -- issues it to the house. ca_diamond_house_ledger is the house''s own\n'
        || E'            -- balance history and the register does not see it, so without this\n'
        || E'            -- row the house held Diamonds the register had never issued and\n'
        || E'            -- fn_ca_diamond_register_vs_supply() read a difference equal to the\n'
        || E'            -- cut. Same shape as fn_poker_diamond_tournament_settle_fee, the\n'
        || E'            -- estate''s other Diamond house credit. The op_id is the house\n'
        || E'            -- ledger''s own idempotency reference, and ca_mint_ledger.op_id is\n'
        || E'            -- UNIQUE, so a replay cannot issue the cut twice.\n'
        || E'            INSERT INTO public.ca_mint_ledger\n'
        || E'                (op_id, action, asset, holder_type, holder_id, holder_label,\n'
        || E'                 amount, balance_before, balance_after, supply_after, reason)\n'
        || E'            VALUES (''trivia-tournament-cut:''||p_tournament_id::text||'':''||p_user_id::text,\n'
        || E'                    ''mint'', ''diamonds'', ''house'',\n'
        || E'                    ''00000000-0000-0000-0000-00000000d1a0''::uuid, ''the house'',\n'
        || E'                    v_cut, v_house_after - v_cut, v_house_after,\n'
        || E'                    (SELECT COALESCE(SUM(CASE WHEN m.action = ''mint'' THEN m.amount\n'
        || E'                                              ELSE -m.amount END), 0)\n'
        || E'                       FROM public.ca_mint_ledger m WHERE m.asset = ''diamonds'') + v_cut,\n'
        || E'                    ''Trivia tournament entry fee cut banked to the house out of the ''\n'
        || E'                    ||''player''''s retired fee, DR14 (trivia_tournament_entry_cut)'');\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the trivia house ledger write occurs % times, expected 1', v_n;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
  IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> 'e636c45d5552ce1484e602bbb5d07917' THEN
    RAISE EXCEPTION 'trivia entry: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- The grants the door had are the grants it keeps: service_role only.
REVOKE ALL ON FUNCTION public.enter_trivia_tournament_v2(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enter_trivia_tournament_v2(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. AN UNSET REWARD BUDGET IS UNSET, NOT 2,500,000
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_oid oid; v_def text; v_old text; v_new text; v_n integer;
BEGIN
  v_oid := to_regprocedure('public.fn_ca_diamond_earn_ledger()');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'fn_ca_diamond_earn_ledger() does not exist';
  END IF;
  v_def := pg_get_functiondef(v_oid);
  IF md5(v_def) <> '348f0603eaec4a1f91c7a6102eb9fcd2' THEN
    RAISE EXCEPTION 'fn_ca_diamond_earn_ledger is not the pinned text (md5 %)', md5(v_def);
  END IF;
  v_old := E'                COALESCE((SELECT b.budget_diamonds FROM public.diamond_reward_budgets b\n'
        || E'                           WHERE b.engine = v_engine AND b.period < v_period\n'
        || E'                           ORDER BY b.period DESC LIMIT 1), 2500000),\n';
  v_new := E'                -- CLAUDE.md 10.86 rule 1: "I could not tell" is a distinct outcome\n'
        || E'                -- and must have its own name. A new period carries forward the last\n'
        || E'                -- plan somebody set for this engine; when nobody ever set one the\n'
        || E'                -- line is created UNSET (NULL, which ca_budget_is_a_number_or_nothing\n'
        || E'                -- admits) and fn_ca_diamond_budget_reality reports "NO PLAN SET"\n'
        || E'                -- instead of judging real issuance against a plan no one approved.\n'
        || E'                -- This used to fall back to a hard-coded two and a half million\n'
        || E'                -- Diamonds that nobody had approved and that read, afterwards, as\n'
        || E'                -- an approved plan.\n'
        || E'                (SELECT b.budget_diamonds FROM public.diamond_reward_budgets b\n'
        || E'                  WHERE b.engine = v_engine AND b.period < v_period\n'
        || E'                  ORDER BY b.period DESC LIMIT 1),\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'the invented budget fallback occurs % times, expected 1', v_n;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
  IF md5(replace(pg_get_functiondef(v_oid), v_new, v_old)) <> '348f0603eaec4a1f91c7a6102eb9fcd2' THEN
    RAISE EXCEPTION 'earn ledger: the reverse substitution does not reproduce the pinned text';
  END IF;
END $m$;

-- ---------------------------------------------------------------------------
-- 3. THE ESTATE IS AS IT WAS
-- ---------------------------------------------------------------------------
DO $m$
DECLARE
  v_txt text; v_bad text; r record;
BEGIN
  v_txt := pg_get_functiondef('public.enter_trivia_tournament_v2(uuid,uuid)'::regprocedure);
  IF position('INSERT INTO public.ca_mint_ledger' IN v_txt) = 0
     OR position('''trivia-tournament-cut:''' IN v_txt) = 0
     OR position('INSERT INTO public.ca_diamond_house_ledger' IN v_txt) = 0
     OR position('DR14:house_account_missing' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the trivia entry does not register its house cut as this migration states';
  END IF;
  v_txt := pg_get_functiondef('public.fn_ca_diamond_earn_ledger()'::regprocedure);
  IF position('2500000' IN v_txt) > 0 THEN
    RAISE EXCEPTION 'the earn ledger still invents a budget';
  END IF;
  IF position('ORDER BY b.period DESC LIMIT 1),' IN v_txt) = 0
     OR position('DR7:user_over_daily_cap' IN v_txt) = 0
     OR position('DR7:ledger_write_failed' IN v_txt) = 0 THEN
    RAISE EXCEPTION 'the earn ledger lost its carry-forward or one of its rules';
  END IF;
  -- The health function was already honest about an unset plan; prove it still is.
  IF position('NO PLAN SET.' IN pg_get_functiondef('public.fn_ca_diamond_budget_reality(text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'fn_ca_diamond_budget_reality no longer names an unset plan';
  END IF;
  -- 10.5: neither door branches on horse status.
  FOR r IN SELECT p.oid, p.proname FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('enter_trivia_tournament_v2','fn_ca_diamond_earn_ledger')
  LOOP
    IF position('is_horse' IN pg_get_functiondef(r.oid)) > 0 THEN
      RAISE EXCEPTION '% branches on horse status', r.proname;
    END IF;
    IF has_function_privilege('anon', r.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% is reachable from a browser', r.proname;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.ca_arena_settings WHERE tournaments_enabled OR cash_games_enabled) THEN
    RAISE EXCEPTION 'this migration must not open the arena doors';
  END IF;
  IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN
    RAISE EXCEPTION 'the Diamond identity is not whole';
  END IF;
  SELECT string_agg(w.fn, ', ') INTO v_bad
    FROM unnest(public.fn_ca_guard_watchlist()) AS w(fn)
    LEFT JOIN public.ca_guard_defs d ON d.proname = w.fn
    LEFT JOIN (
      SELECT p.proname, md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.oid)) AS h
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY (public.fn_ca_guard_watchlist())
       GROUP BY p.proname) live ON live.proname = w.fn
   WHERE d.def_hash IS DISTINCT FROM live.h;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'watched guards off their baseline: %', v_bad;
  END IF;
  RAISE NOTICE 'the Diamond books do not invent a number: a trivia house cut is registered as a mint, and an engine with no earlier budget line gets an unset one';
END $m$;

COMMIT;
