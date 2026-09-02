-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830173522; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- SIGNUP GRANTED A WELCOME BONUS TO ONE HALF OF A MIRRORED PAIR
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Found 2026-08-30 while chasing why CHECK 10 of the Pre-Deploy Safety Checks
-- ("Diamond economy invariants") was failing on EVERY World Hub pull request.
--
-- `profiles.diamonds` and `profiles.diamond_balance` are a MIRRORED PAIR. That
-- is not folklore: two of the invariants CHECK 10 enforces are named
-- `add_diamonds_writes_both_balance_columns` and
-- `deduct_diamonds_writes_both_balance_columns`, and a third,
-- `no_profiles_balance_drift`, fails the build whenever any profile has the
-- two disagreeing.
--
-- `initialize_player_profile` inserts the 500 diamond welcome bonus into
-- `diamonds` and never mentions `diamond_balance`, which takes its column
-- default of 0. So every profile it creates is born in violation of the
-- invariant its own repo enforces.
--
-- WHY THAT IS WORSE THAN IT SOUNDS. The failure does not land on the person
-- who caused it. It lands on whoever opens the next pull request, as a red
-- "Diamond economy invariants" check that reads exactly like a live currency
-- defect, and it stays red for the whole estate until somebody hand-corrects
-- the row. It did today: one account created at 17:00:14 by the post-deploy
-- E2E blocked World-Hub #1008, and the account was gone from nobody's mind
-- because the workflow that created it had already finished.
--
-- ON CONFLICT is deliberately left alone. Its DO UPDATE branch never touches
-- diamonds or diamond_balance, so a returning player's balance is not
-- rewritten by a re-initialise. Only the INSERT branch, which is the one that
-- mints the bonus, is corrected.
--
-- THIS CREATES NO CURRENCY. It writes the SAME 500 to the second column of a
-- pair that is required to hold one value. Aligning at insert is the
-- representation the invariants already demand of every other write path.
--
-- Edited via pg_get_functiondef with asserted replacements rather than
-- retyping ~90 lines of profile bootstrap, referral and VIP logic: a silent
-- no-op replacement in a signup path is exactly the kind of quiet bug this
-- function has already produced once.

DO $$
DECLARE
    v_src  text;
    v_new  text;
    v_oid  oid;
BEGIN
    SELECT p.oid, pg_get_functiondef(p.oid) INTO v_oid, v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'initialize_player_profile';

    IF v_src IS NULL THEN
        RAISE EXCEPTION 'initialize_player_profile not found';
    END IF;

    -- Already fixed (re-run, or someone got there first). Nothing to do.
    IF position('diamond_balance' in v_src) > 0 THEN
        RAISE NOTICE 'initialize_player_profile already writes diamond_balance; no change';
        RETURN;
    END IF;

    -- 1. The column list.
    IF position('diamonds, diamond_multiplier, streak_count,' in v_src) = 0 THEN
        RAISE EXCEPTION 'column-list anchor not found; the function has changed shape, edit it by hand';
    END IF;
    v_new := replace(v_src,
        'diamonds, diamond_multiplier, streak_count,',
        'diamonds, diamond_balance, diamond_multiplier, streak_count,');

    -- 2. The matching VALUES row. Anchored on the literal tuple so it cannot
    --    land on some other "500, 1.0, 0," elsewhere in the body.
    IF position('        500, 1.0, 0,' in v_new) = 0 THEN
        RAISE EXCEPTION 'values anchor not found; the function has changed shape, edit it by hand';
    END IF;
    v_new := replace(v_new, '        500, 1.0, 0,', '        500, 500, 1.0, 0,');

    IF v_new = v_src THEN
        RAISE EXCEPTION 'replacements produced no change';
    END IF;

    EXECUTE v_new;

    -- POST-CONDITIONS. Re-read from the catalog: what we intended to write is
    -- not evidence of what is now installed.
    SELECT pg_get_functiondef(p.oid) INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'initialize_player_profile';

    IF position('diamond_balance' in v_src) = 0 THEN
        RAISE EXCEPTION 'post-condition failed: diamond_balance still absent';
    END IF;
    IF position('ON CONFLICT (id) DO UPDATE' in v_src) = 0 THEN
        RAISE EXCEPTION 'post-condition failed: the ON CONFLICT branch was lost';
    END IF;

    RAISE NOTICE 'initialize_player_profile now seeds both diamond columns';
END $$;
