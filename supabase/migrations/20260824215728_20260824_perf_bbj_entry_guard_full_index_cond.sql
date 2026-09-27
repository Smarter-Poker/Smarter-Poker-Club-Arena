-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260824215728 "20260824_perf_bbj_entry_guard_full_index_cond"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 7de97641a4e1c30aa41639e20ffc515e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- PERFORMANCE 2026-08-24 (part 3 - completes part 2)
--
-- Part 2 got the entry guard onto idx_bbj_contrib_pool_nullhand, but EXPLAIN
-- ANALYZE showed the win was only partial:
--
--   Index Scan using idx_bbj_contrib_pool_nullhand  (actual time=1201.713)
--     Index Cond: (pool_id = ...)
--     Filter: ((NOT (table_id IS DISTINCT FROM ...)) AND
--              (NOT (hand_number IS DISTINCT FROM ...)))
--     Rows Removed by Filter: 108096
--     Buffers: shared hit=78939 read=391
--   Execution Time: 1201.840 ms
--
-- Only pool_id became an index condition. `IS NOT DISTINCT FROM` on table_id
-- and hand_number stays a post-index filter, so the scan still walks 108k
-- index entries and 79k buffers per call.
--
-- In production both p_table_id and p_hand_number are always supplied on this
-- path (a hand always knows its table and its number). Branching on that lets
-- all three columns become index conditions and turns the walk into a point
-- lookup. The NULL-argument shapes keep the exact original semantics.

CREATE OR REPLACE FUNCTION public.bbj_record_contribution(
    p_pool_id uuid,
    p_hand_id uuid DEFAULT NULL::uuid,
    p_table_id uuid DEFAULT NULL::uuid,
    p_amount numeric DEFAULT 0,
    p_main_portion numeric DEFAULT 0,
    p_backup_portion numeric DEFAULT 0,
    p_promo_portion numeric DEFAULT 0,
    p_big_blind numeric DEFAULT 2.00,
    p_hand_number integer DEFAULT NULL::integer,
    p_club_id uuid DEFAULT NULL::uuid)
 RETURNS bbj_contributions
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_contribution bbj_contributions;
    v_prev_cum numeric;
    v_next_cum numeric;
    v_main     numeric;
    v_backup   numeric;
    v_promo    numeric;
BEGIN
    IF p_hand_id IS NULL THEN
        IF p_table_id IS NOT NULL AND p_hand_number IS NOT NULL THEN
            -- FAST PATH. All three predicates are plain equalities, so the
            -- whole of idx_bbj_contrib_pool_nullhand
            -- (pool_id, table_id, hand_number) WHERE hand_id IS NULL
            -- becomes the index condition. Point lookup, a handful of buffers.
            SELECT * INTO v_contribution FROM bbj_contributions
             WHERE pool_id = p_pool_id
               AND hand_id IS NULL
               AND table_id = p_table_id
               AND hand_number = p_hand_number
             ORDER BY created_at
             LIMIT 1;
        ELSE
            -- Original NULL-tolerant semantics, preserved verbatim for the
            -- rare shapes where table_id or hand_number is absent.
            SELECT * INTO v_contribution FROM bbj_contributions
             WHERE pool_id = p_pool_id
               AND hand_id IS NULL
               AND table_id IS NOT DISTINCT FROM p_table_id
               AND hand_number IS NOT DISTINCT FROM p_hand_number
             ORDER BY created_at
             LIMIT 1;
        END IF;

        IF v_contribution.id IS NOT NULL THEN
            RETURN v_contribution;
        END IF;
    END IF;

    -- RESIDUAL CARRY 2026-08-23. p_main_portion / p_backup_portion /
    -- p_promo_portion are ADVISORY ONLY - the caller's per-hand rounding is
    -- what pushed promo 1,456.30 short of its 25%. Lock the pool row so two
    -- concurrent hands cannot read the same cumulative figure.
    SELECT COALESCE(alloc_cum_amount, 0) INTO v_prev_cum
      FROM bbj_pools WHERE id = p_pool_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'bbj_record_contribution: pool % not found', p_pool_id;
    END IF;

    v_next_cum := v_prev_cum + COALESCE(p_amount, 0);
    v_main   := round(v_next_cum * 0.50, 2) - round(v_prev_cum * 0.50, 2);
    v_backup := (round(v_next_cum * 0.75, 2) - round(v_next_cum * 0.50, 2))
              - (round(v_prev_cum * 0.75, 2) - round(v_prev_cum * 0.50, 2));
    v_promo  := COALESCE(p_amount, 0) - v_main - v_backup;

    INSERT INTO bbj_contributions (
        pool_id, hand_id, table_id, club_id, amount,
        main_portion, backup_portion, promo_portion, big_blind, hand_number
    ) VALUES (
        p_pool_id, p_hand_id, p_table_id, p_club_id, p_amount,
        v_main, v_backup, v_promo, p_big_blind, p_hand_number
    )
    ON CONFLICT (pool_id, hand_id) WHERE hand_id IS NOT NULL DO NOTHING
    RETURNING * INTO v_contribution;

    IF v_contribution.id IS NULL THEN
        IF p_hand_id IS NOT NULL THEN
            SELECT * INTO v_contribution FROM bbj_contributions
             WHERE pool_id = p_pool_id AND hand_id = p_hand_id
             LIMIT 1;
        ELSIF p_table_id IS NOT NULL AND p_hand_number IS NOT NULL THEN
            SELECT * INTO v_contribution FROM bbj_contributions
             WHERE pool_id = p_pool_id AND hand_id IS NULL
               AND table_id = p_table_id AND hand_number = p_hand_number
             LIMIT 1;
        ELSE
            SELECT * INTO v_contribution FROM bbj_contributions
             WHERE pool_id = p_pool_id AND hand_id IS NULL
             LIMIT 1;
        END IF;
        RETURN v_contribution;
    END IF;

    UPDATE bbj_pools
    SET
        main_balance      = main_balance   + v_main,
        backup_balance    = backup_balance + v_backup,
        promo_balance     = promo_balance  + v_promo,
        total_contributed = total_contributed + p_amount,
        alloc_cum_amount  = v_next_cum,
        hands_contributed = COALESCE(hands_contributed, 0) + 1,
        updated_at        = now()
    WHERE id = p_pool_id;

    RETURN v_contribution;
END;
$function$;

