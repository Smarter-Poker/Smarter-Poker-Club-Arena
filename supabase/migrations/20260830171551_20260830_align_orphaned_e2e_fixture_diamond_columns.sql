-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830171551; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- AN ORPHANED CI FIXTURE WAS FAILING THE DIAMOND ECONOMY INVARIANT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Found 2026-08-30 while shipping an unrelated push fix: CHECK 10 of the
-- Pre-Deploy Safety Checks ("Diamond economy invariants") was failing on
-- `no_profiles_balance_drift` -- profiles where diamonds <> diamond_balance.
--
-- It was not a real economy defect. Exactly one profile drifted:
--
--   username club-arena-prod-e2e-2-20260830115258
--   created  2026-08-30 17:00:14
--   diamonds 500,  diamond_balance 0
--
-- A throwaway account created by the "Post-Deploy E2E (production)" workflow.
-- Its seeding writes `diamonds` ALONE, while every sanctioned path writes both
-- columns together -- which is precisely what the neighbouring invariants
-- `add_diamonds_writes_both_balance_columns` and
-- `deduct_diamonds_writes_both_balance_columns` exist to require. That run
-- ended "skipped" and never cleaned the account up, so the violation stopped
-- being transient and became permanent: CHECK 10 fails on EVERY pull request
-- in the World Hub repo, with a message that reads like a live currency
-- defect. That is a deploy-blocking false alarm for the whole estate.
--
-- WHICH DIRECTION, AND WHY. The columns are aligned DOWN, to diamond_balance,
-- never up to diamonds. Aligning up would MINT 500 diamonds into an account
-- from a migration, which is exactly the kind of unledgered currency creation
-- the economy invariants exist to catch. Aligning down removes a phantom
-- balance that no ledger entry ever backed.
--
-- SCOPE. Only accounts whose username matches the CI fixture pattern, only
-- where the two columns actually disagree, and only where the account is at
-- least 10 minutes old so a fixture belonging to an IN-FLIGHT test run is
-- never touched mid-test. A real player's balance cannot match any of these.
--
-- NOT THE WHOLE FIX. The fixture should seed through the same RPC real code
-- uses, and the workflow should clean up on every exit path, not just success.
-- Both are reported to Dan as follow-ups; neither is repairable from SQL.

DO $$
DECLARE
    v_target int;
    v_fixed  int;
    v_left   int;
BEGIN
    SELECT count(*) INTO v_target
      FROM profiles
     WHERE username LIKE 'club-arena-prod-e2e%'
       AND coalesce(diamonds, 0) <> coalesce(diamond_balance, 0)
       AND created_at < now() - interval '10 minutes';

    -- If this ever matches a crowd, the pattern is wrong and the guard is
    -- about to rewrite balances it was never meant to touch.
    IF v_target > 25 THEN
        RAISE EXCEPTION
            'refusing to rewrite % fixture profiles: that is not a stray test account', v_target;
    END IF;

    UPDATE profiles
       SET diamonds = coalesce(diamond_balance, 0),
           updated_at = now()
     WHERE username LIKE 'club-arena-prod-e2e%'
       AND coalesce(diamonds, 0) <> coalesce(diamond_balance, 0)
       AND created_at < now() - interval '10 minutes';
    GET DIAGNOSTICS v_fixed = ROW_COUNT;

    IF v_fixed <> v_target THEN
        RAISE EXCEPTION 'aligned % rows but had targeted %', v_fixed, v_target;
    END IF;

    -- POST-CONDITION: the invariant CHECK 10 asserts must now hold platform
    -- wide. If anything still drifts it is NOT a fixture and must be looked at
    -- by a person, so fail loudly rather than reporting a partial success.
    SELECT count(*) INTO v_left
      FROM profiles
     WHERE coalesce(diamonds, 0) <> coalesce(diamond_balance, 0);

    IF v_left > 0 THEN
        RAISE EXCEPTION
            'aligned % fixture row(s) but % profile(s) still drift -- these are not CI fixtures, investigate before deploying',
            v_fixed, v_left;
    END IF;

    RAISE NOTICE 'aligned % orphaned fixture profile(s); no balance drift remains', v_fixed;
END $$;
