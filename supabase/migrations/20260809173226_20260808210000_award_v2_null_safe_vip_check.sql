-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260809173226 "20260808210000_award_v2_null_safe_vip_check"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 eca0ebdf417849aa12b39d88c412b074 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- award_diamonds_v2 v3 granted VIP earning caps to 470 accounts that are not VIP.
--
-- The VIP downgrade guard reads:
--   IF NOT (v_is_vip AND (v_vip_tier = 'lifetime'
--           OR (v_vip_expires_at IS NOT NULL AND v_vip_expires_at > v_now))) THEN
--       v_is_vip := false;
--   END IF;
--
-- For a profile with is_vip = true, vip_tier = NULL, vip_expires_at = NULL:
--   v_vip_tier = 'lifetime'        -> NULL   (not false! NULL = anything is NULL)
--   (expires IS NOT NULL AND ...)  -> false
--   NULL OR false                  -> NULL
--   true AND NULL                  -> NULL
--   NOT NULL                       -> NULL
--   IF NULL THEN ...               -> body does NOT execute
--
-- So the downgrade never runs and v_is_vip stays TRUE. Classic three-valued
-- logic trap: the guard fails OPEN. Measured on production: 473 profiles carry
-- is_vip = true, of which only 3 have a genuine lifetime tier or a future
-- expiry. The other 470 were being given the VIP ceilings — 150/day and
-- 4,500/month instead of 110 and 3,300. Up to 1,200 extra diamonds per user
-- per month, ~$5.6k/month of liability at the ceiling.
--
-- Found by running a real award through the function against a test account
-- and noticing daily_remaining came back 140 (= 150 - 10) for an account whose
-- tier and expiry are both NULL, where 100 (= 110 - 10) was expected.
--
-- The app's own truth function, /api/vip/check-status, already treats a
-- non-lifetime tier with no expiry as EXPIRED, so this was SQL disagreeing
-- with the rest of the platform, not a deliberate grandfathering rule.
--
-- vip_stipend is unaffected: its eligibility check tests
-- vip_tier IN ('monthly','annual','yearly','lifetime') explicitly, and NULL
-- fails an IN test, so the 500-diamond stipend was never leaking.
--
-- FIX: COALESCE both operands so every comparison is two-valued.

DO $patch$
DECLARE
    v_def text;
    v_new text;
    v_old constant text :=
        'IF NOT (v_is_vip AND (v_vip_tier = ''lifetime'' OR (v_vip_expires_at IS NOT NULL AND v_vip_expires_at > v_now))) THEN';
    v_fixed constant text :=
        'IF NOT (COALESCE(v_is_vip, false) AND (COALESCE(v_vip_tier, '''') = ''lifetime'' OR (v_vip_expires_at IS NOT NULL AND v_vip_expires_at > v_now))) THEN';
BEGIN
    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'award_diamonds_v2';

    IF v_def IS NULL THEN
        RAISE EXCEPTION 'patch failed: award_diamonds_v2 not found';
    END IF;
    IF position(v_old in v_def) = 0 THEN
        RAISE EXCEPTION 'patch failed: the VIP guard line was not found verbatim';
    END IF;

    v_new := replace(v_def, v_old, v_fixed);
    IF v_new = v_def THEN
        RAISE EXCEPTION 'patch failed: replacement was a no-op';
    END IF;

    EXECUTE v_new;
END
$patch$;

DO $postcheck$
DECLARE
    v_src  text;
    v_user uuid;
    r      jsonb;
    v_daily integer;
BEGIN
    SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'award_diamonds_v2';
    IF position('COALESCE(v_vip_tier, '''') = ''lifetime''' in v_src) = 0 THEN
        RAISE EXCEPTION 'post-apply failed: null-safe VIP guard not present';
    END IF;

    -- Behavioural assertion, not just a text match: award a cap-counting action
    -- to an account with is_vip = true but NULL tier and NULL expiry, and
    -- confirm it is now measured against the FREE ceiling of 110.
    SELECT id INTO v_user
      FROM public.profiles
     WHERE is_vip AND vip_tier IS NULL AND vip_expires_at IS NULL
     LIMIT 1;

    IF v_user IS NOT NULL THEN
        r := public.award_diamonds_v2(
                v_user, 'social_post',
                'nullvip_probe_' || to_char(clock_timestamp(), 'HH24MISSMS'),
                'probe', '{}'::jsonb);
        v_daily := (r->>'daily_remaining')::int;
        -- social_post pays 10, so a free user must have 100 left, not 140.
        IF v_daily IS NOT NULL AND v_daily > 100 THEN
            RAISE EXCEPTION
              'post-apply failed: fake-VIP still on the VIP ceiling (daily_remaining=%)', v_daily;
        END IF;
    END IF;

    -- Roll the probe award back — this migration must not move real balances.
    RAISE EXCEPTION 'ROLLBACK_PROBE_OK';
EXCEPTION
    WHEN others THEN
        IF SQLERRM = 'ROLLBACK_PROBE_OK' THEN
            RAISE NOTICE 'VIP guard verified null-safe';
        ELSE
            RAISE;
        END IF;
END
$postcheck$;
