-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260501165230 "retrocredit_all_reward_type_orphans_v2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 529042cef8571b5a73d72cd5bd2795df of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Define orphan = (no exact reference_id match) AND (no ±1d adjacent same-type txn)
-- Use the SAME criterion for pre-flight, retro-credit loop, AND post-apply.

DO $$
DECLARE
    v_pre integer;
    v_post integer;
    v_credited integer := 0;
    v_dup integer := 0;
    r RECORD;
    v_result jsonb;
    v_ref_id text;
BEGIN
    -- PRE-FLIGHT
    SELECT COUNT(*) INTO v_pre
    FROM diamond_reward_claims drc
    WHERE NOT EXISTS (
        SELECT 1 FROM diamond_transactions dt
        WHERE dt.reference_id = drc.reward_type || '_' || drc.user_id::text || '_' || drc.claim_date::text
    )
    AND NOT EXISTS (
        SELECT 1 FROM diamond_transactions dt
        WHERE dt.user_id = drc.user_id
          AND dt.transaction_type = drc.reward_type
          AND dt.created_at::date BETWEEN drc.claim_date::date - 1 AND drc.claim_date::date + 1
    );
    RAISE NOTICE 'Pre-flight: % orphans', v_pre;

    -- LOOP: credit each
    FOR r IN
        SELECT drc.user_id, drc.reward_type, drc.claim_date, drc.diamonds_awarded
        FROM diamond_reward_claims drc
        WHERE NOT EXISTS (
            SELECT 1 FROM diamond_transactions dt
            WHERE dt.reference_id = drc.reward_type || '_' || drc.user_id::text || '_' || drc.claim_date::text
        )
        AND NOT EXISTS (
            SELECT 1 FROM diamond_transactions dt
            WHERE dt.user_id = drc.user_id
              AND dt.transaction_type = drc.reward_type
              AND dt.created_at::date BETWEEN drc.claim_date::date - 1 AND drc.claim_date::date + 1
        )
        ORDER BY drc.claimed_at
    LOOP
        v_ref_id := r.reward_type || '_' || r.user_id::text || '_' || r.claim_date::text;
        SELECT add_diamonds_to_balance(
            p_user_id := r.user_id,
            p_amount := r.diamonds_awarded,
            p_type := r.reward_type,
            p_description := 'Retro-credit for orphaned ' || r.reward_type || ' claim '
                             || r.claim_date::text || ' — Cowork audit 2026-05-01',
            p_reference_id := v_ref_id
        ) INTO v_result;

        IF (v_result->>'success')::boolean THEN
            v_credited := v_credited + 1;
        ELSE
            v_dup := v_dup + 1;
        END IF;
    END LOOP;

    RAISE NOTICE 'Credited: %, dedup-skipped: %', v_credited, v_dup;

    -- POST-APPLY (same criterion)
    SELECT COUNT(*) INTO v_post
    FROM diamond_reward_claims drc
    WHERE NOT EXISTS (
        SELECT 1 FROM diamond_transactions dt
        WHERE dt.reference_id = drc.reward_type || '_' || drc.user_id::text || '_' || drc.claim_date::text
    )
    AND NOT EXISTS (
        SELECT 1 FROM diamond_transactions dt
        WHERE dt.user_id = drc.user_id
          AND dt.transaction_type = drc.reward_type
          AND dt.created_at::date BETWEEN drc.claim_date::date - 1 AND drc.claim_date::date + 1
    );
    RAISE NOTICE 'Post-apply: % orphans remain (was % pre-flight)', v_post, v_pre;

    IF v_post > 0 THEN
        RAISE EXCEPTION 'Post-apply: % orphans still remain after retro-credit', v_post;
    END IF;
END $$;
