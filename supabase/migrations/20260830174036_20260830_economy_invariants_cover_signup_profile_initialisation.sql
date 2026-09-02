-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830174036; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Two new checks in `economy_invariants`, the function CHECK 10 of the
-- Pre-Deploy Safety Checks calls. Both cover defects found and fixed on
-- 2026-08-30 in `initialize_player_profile`:
--
--  1. It granted the 500 diamond welcome bonus to `profiles.diamonds` alone,
--     leaving `diamond_balance` at its default 0. Every account it created was
--     therefore born violating `no_profiles_balance_drift` -- which turns red
--     for the WHOLE ESTATE, on whoever opens the next pull request, reading
--     exactly like a live currency defect. That is what it did today.
--
--  2. It allocated `player_number` with a raw NEXTVAL on a sequence that had
--     fallen behind the numbers already in use, instead of the canonical
--     `fn_next_player_number()` which loops until it finds a free one. It hit
--     `uq_profiles_player_number`, CAUGHT ITS OWN EXCEPTION, and returned
--     success=false in a result column -- so profile creation failed with
--     nothing raised and nothing alerted.
--
-- `no_profiles_balance_drift` already existed and did catch (1), but only
-- AFTER an affected account existed, and it names the symptom rather than the
-- cause. These name the cause, in the same run, before an account is made.
--
-- Comments are stripped from prosrc before searching. The first attempt at the
-- allocator fix aborted on its own post-condition because the comment
-- EXPLAINING the fix mentioned the retired sequence. An assertion must read
-- code, never prose.

DO $mig$
DECLARE
    v_src  text;
    v_new  text;
    v_old  text;
    v_rep  text;
    v_code text;
BEGIN
    SELECT pg_get_functiondef(p.oid) INTO v_src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'economy_invariants';

    IF v_src IS NULL THEN
        RAISE EXCEPTION 'economy_invariants not found';
    END IF;

    IF position('signup_seeds_both_diamond_columns' in v_src) > 0 THEN
        RAISE NOTICE 'signup invariants already present; no change';
        RETURN;
    END IF;

    v_old := E'    check_name := ''no_profiles_balance_drift'';';
    IF position(v_old in v_src) = 0 THEN
        RAISE EXCEPTION 'anchor not found; economy_invariants changed shape, edit by hand';
    END IF;

    v_rep :=
        E'    SELECT regexp_replace(prosrc, ''--[^'' || chr(10) || '']*'', '''', ''g'') INTO v_src\n'
     || E'      FROM pg_proc WHERE proname = ''initialize_player_profile'' LIMIT 1;\n'
     || E'    check_name := ''signup_seeds_both_diamond_columns'';\n'
     || E'    ok := v_src IS NOT NULL AND position(''diamond_balance'' in v_src) > 0;\n'
     || E'    detail := ''initialize_player_profile must seed profiles.diamond_balance alongside profiles.diamonds. Granting the welcome bonus to one half of the pair makes every new account violate no_profiles_balance_drift, which blocks deploys estate-wide.'';\n'
     || E'    RETURN NEXT;\n'
     || E'\n'
     || E'    check_name := ''signup_allocates_a_free_player_number'';\n'
     || E'    ok := v_src IS NOT NULL\n'
     || E'          AND position(''fn_next_player_number'' in v_src) > 0\n'
     || E'          AND position(''public_player_number_seq'' in v_src) = 0;\n'
     || E'    detail := ''profiles.player_number is UNIQUE across everyone and only fn_next_player_number() loops until it finds a free value. A raw nextval made initialize_player_profile raise uq_profiles_player_number and swallow it into success=false, so profile creation failed silently.'';\n'
     || E'    RETURN NEXT;\n'
     || E'\n'
     || v_old;

    v_new := replace(v_src, v_old, v_rep);
    IF v_new = v_src THEN
        RAISE EXCEPTION 'replacement produced no change';
    END IF;

    EXECUTE v_new;

    SELECT pg_get_functiondef(p.oid) INTO v_code
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'economy_invariants';

    IF position('signup_seeds_both_diamond_columns' in v_code) = 0
       OR position('signup_allocates_a_free_player_number' in v_code) = 0 THEN
        RAISE EXCEPTION 'post-condition failed: the new invariants are not installed';
    END IF;
    IF position('no_profiles_balance_drift' in v_code) = 0 THEN
        RAISE EXCEPTION 'post-condition failed: an existing invariant was lost';
    END IF;

    RAISE NOTICE 'economy_invariants now covers signup profile initialisation';
END $mig$;
