-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260501164748 "retrocredit_orphaned_daily_login_claims_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 cadd2449cf8d5a2c9d421e935e1e6564 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Pre-flight: count orphans by reference_id (the canonical idempotency key)
DO $$
DECLARE v_orphan_count integer;
BEGIN
    SELECT COUNT(*) INTO v_orphan_count
    FROM diamond_reward_claims drc
    WHERE drc.reward_type = 'daily_login'
      AND drc.claimed_at > NOW() - INTERVAL '14 days'
      AND NOT EXISTS (
        SELECT 1 FROM diamond_transactions dt
        WHERE dt.reference_id = 'daily_login_' || drc.user_id::text || '_' || drc.claim_date::text
      );

    IF v_orphan_count = 0 THEN
        RAISE EXCEPTION 'Pre-flight: 0 orphans found — already credited?';
    END IF;
    RAISE NOTICE 'Pre-flight: % orphans by reference_id', v_orphan_count;
END $$;

-- Credit each orphan via canonical RPC. The function's own idempotency check
-- (on reference_id) will dedup if anything was already credited.
DO $$
DECLARE r RECORD; v_result jsonb; v_credited integer := 0; v_dup integer := 0;
BEGIN
    FOR r IN
        SELECT drc.user_id, drc.claim_date, drc.diamonds_awarded
        FROM diamond_reward_claims drc
        WHERE drc.reward_type = 'daily_login'
          AND drc.claimed_at > NOW() - INTERVAL '14 days'
          AND NOT EXISTS (
            SELECT 1 FROM diamond_transactions dt
            WHERE dt.reference_id = 'daily_login_' || drc.user_id::text || '_' || drc.claim_date::text
          )
        ORDER BY drc.claimed_at
    LOOP
        SELECT add_diamonds_to_balance(
            p_user_id := r.user_id,
            p_amount := r.diamonds_awarded,
            p_type := 'daily_login',
            p_description := 'Retro-credit for orphaned daily_login claim ' || r.claim_date::text
                             || ' (rollback-bug victim, pre-fix 4d75febb62)',
            p_reference_id := 'daily_login_' || r.user_id::text || '_' || r.claim_date::text
        ) INTO v_result;

        IF (v_result->>'success')::boolean THEN
            v_credited := v_credited + 1;
        ELSE
            v_dup := v_dup + 1;
        END IF;
    END LOOP;

    RAISE NOTICE 'Credited: %, dedup-skipped: %', v_credited, v_dup;
END $$;

-- Post-apply: 0 orphans by reference_id should remain
DO $$
DECLARE v_remaining integer;
BEGIN
    SELECT COUNT(*) INTO v_remaining
    FROM diamond_reward_claims drc
    WHERE drc.reward_type = 'daily_login'
      AND drc.claimed_at > NOW() - INTERVAL '14 days'
      AND NOT EXISTS (
        SELECT 1 FROM diamond_transactions dt
        WHERE dt.reference_id = 'daily_login_' || drc.user_id::text || '_' || drc.claim_date::text
      );

    IF v_remaining > 0 THEN
        RAISE EXCEPTION 'Post-apply: % orphans still remain', v_remaining;
    END IF;
END $$;
