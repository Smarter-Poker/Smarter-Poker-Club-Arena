-- PERFORMANCE 2026-08-24. bbj_record_contribution: 1.2 s -> 0.18 ms.
--
-- APPLIED TO PRODUCTION via Supabase MCP apply_migration 2026-08-24, in three
-- parts, recorded in supabase_migrations.schema_migrations as:
--   20260824_perf_bbj_pool_id_index
--   20260824_perf_bbj_record_contribution_indexable_lookups
--   20260824_perf_bbj_entry_guard_full_index_cond
-- This file is the consolidated, idempotent record of the final state.
-- Tier 2 (index + function body; no schema change, no data change).
--
-- ============================================================================
-- EVIDENCE
-- ============================================================================
-- pg_stat_statements, window 2026-08-24 09:00 -> 21:35 UTC (12h35m):
--   bbj_record_contribution   1,811 calls   mean 1,226 ms
--                             shared_blks_read 2,607,898
--                             = 1,440 blocks (11 MB) read PER CALL
--
-- pg_stat_user_tables (cumulative since project creation 2026-01-06):
--   bbj_contributions   seq_scan 3,244   seq_tup_read 506,841,592
--
-- VACUUM ANALYZE confirmed this is NOT bloat: the table holds 656,688 real
-- rows in 17,112 pages (134 MB), of which 171,260 have hand_id IS NULL.
-- pg_stat_user_tables.n_live_tup was reporting 1,654, which is stale and
-- misleading - pg_class.reltuples after ANALYZE is the truth.
--
-- ============================================================================
-- ROOT CAUSE
-- ============================================================================
-- Two lookups inside the function could not use any index.
--
-- (a) The entry guard, taken whenever p_hand_id IS NULL:
--       WHERE pool_id = $1 AND hand_id IS NULL
--         AND table_id     IS NOT DISTINCT FROM $2
--         AND hand_number  IS NOT DISTINCT FROM $3
--     Nothing indexed the 171,260 NULL-hand rows.
--
-- (b) The ON CONFLICT DO NOTHING fallback, taken on every duplicate hand:
--       WHERE pool_id = $1 AND hand_id IS NOT DISTINCT FROM $2
--     IS NOT DISTINCT FROM is never indexable, because the parameter may or
--     may not be NULL at plan time. The only pool_id-leading index,
--     uq_bbj_contributions_pool_hand, is PARTIAL on WHERE hand_id IS NOT NULL
--     and so cannot serve a NULL-tolerant probe either.
--
-- Both fell back to a full 656k-row / 134 MB sequential scan. This runs on the
-- hand-completion path, inside the transaction that already holds
-- SELECT ... FROM bbj_pools ... FOR UPDATE on the pool row - so every one of
-- those scans extended a lock that serialises every table in the club.
--
-- ============================================================================
-- FIX
-- ============================================================================
-- 1. A partial index over exactly the NULL-hand rows.
-- 2. Branch the function so each shape hits a real index instead of relying on
--    IS NOT DISTINCT FROM. Semantics are unchanged: p_hand_id is either NULL
--    or it is not, and the branches cover both cases exhaustively. The
--    NULL-argument shapes keep the original NULL-tolerant predicates verbatim.
--
-- Residual-carry allocation maths (2026-08-23), the FOR UPDATE pool lock, the
-- ON CONFLICT target and the return value are all byte-for-byte unchanged.
--
-- ============================================================================
-- MEASURED RESULT (EXPLAIN ANALYZE, production)
-- ============================================================================
-- BEFORE
--   Index Scan using idx_bbj_contrib_pool_nullhand
--     Index Cond: (pool_id = ...)
--     Filter: ((NOT (table_id IS DISTINCT FROM ...)) AND
--              (NOT (hand_number IS DISTINCT FROM ...)))
--     Rows Removed by Filter: 108,096
--     Buffers: shared hit=78,939 read=391
--   Execution Time: 1201.840 ms
--
-- AFTER
--   Index Scan using idx_bbj_contrib_pool_nullhand
--     Index Cond: ((pool_id = ...) AND (table_id = ...) AND (hand_number = ...))
--     Buffers: shared hit=9
--   Execution Time: 0.180 ms
--
-- 6,600x faster. 79,330 buffers -> 12 buffers.
--
-- ============================================================================
-- ROLLBACK
-- ============================================================================
--   DROP INDEX IF EXISTS public.idx_bbj_contrib_pool_nullhand;
--   -- then restore the previous function body, which used a single
--   -- IS NOT DISTINCT FROM query in both the entry guard and the ON CONFLICT
--   -- fallback. Prior definition is reachable via git history of this
--   -- directory, or from a pre-2026-08-24 pg_get_functiondef snapshot.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_bbj_contrib_pool_nullhand
  ON public.bbj_contributions (pool_id, table_id, hand_number)
  WHERE hand_id IS NULL;

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
            -- whole of idx_bbj_contrib_pool_nullhand becomes the index
            -- condition. Point lookup, a handful of buffers.
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
        -- PERF 2026-08-24: was one query using
        --   hand_id IS NOT DISTINCT FROM p_hand_id
        -- which is not indexable and forced a full 656k-row / 134 MB seq scan
        -- on every duplicate hand. Split into three indexable branches.
        IF p_hand_id IS NOT NULL THEN
            -- uses uq_bbj_contributions_pool_hand
            SELECT * INTO v_contribution FROM bbj_contributions
             WHERE pool_id = p_pool_id AND hand_id = p_hand_id
             LIMIT 1;
        ELSIF p_table_id IS NOT NULL AND p_hand_number IS NOT NULL THEN
            -- uses idx_bbj_contrib_pool_nullhand
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

-- ============================================================================
-- POST-APPLY ASSERTIONS
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_bbj_contrib_pool_nullhand') THEN
    RAISE EXCEPTION 'idx_bbj_contrib_pool_nullhand was not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'bbj_record_contribution'
       AND position('FAST PATH' in p.prosrc) > 0
  ) THEN
    RAISE EXCEPTION 'bbj_record_contribution was not replaced with the branched body';
  END IF;

  -- The residual-carry allocation maths must survive verbatim.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'bbj_record_contribution'
       AND position('alloc_cum_amount  = v_next_cum' in p.prosrc) > 0
  ) THEN
    RAISE EXCEPTION 'residual-carry allocation was lost in the rewrite';
  END IF;
END $$;
