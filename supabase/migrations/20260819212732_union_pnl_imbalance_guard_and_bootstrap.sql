-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819212732 "union_pnl_imbalance_guard_and_bootstrap"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 0f7ea143bce91cf42be8162a2cbb4408 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- UNION P&L SAFETY GUARD + BASELINE BOOTSTRAP (2026-08-19, audit fix pass 5)
--
-- The settlement is only correct when the zero-sum invariant holds
-- (sum of club settle_net ~= 0). It does NOT hold on the very first run,
-- because there is no prior seated-stack baseline so every stack_delta is
-- forced to 0 — the first live dry run showed an imbalance of ~273,886.
-- Settling that would have moved six figures of chips on a known-wrong basis.
--
-- Two protections:
--   1. fn_union_pnl_bootstrap  — records current seated stacks as a baseline
--      with zero money movement, so the next run has real deltas.
--   2. fn_union_settle_player_pnl_guarded — the entry point the weekly job
--      calls. Computes first, refuses to move chips when the books do not
--      balance within tolerance, and records the run as 'needs_review'
--      instead. A settlement that cannot be proven correct is never paid.
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_union_pnl_bootstrap(p_union_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_results jsonb;
  v_id uuid;
  v_now timestamptz := now();
BEGIN
  SELECT jsonb_agg(jsonb_build_object(
           'club_id', uc.club_id,
           'seated_end', COALESCE((
             SELECT SUM(ts.stack) FROM table_seats ts
              JOIN tables t ON t.id = ts.table_id AND t.union_id = p_union_id
              JOIN (
                SELECT DISTINCT ON (cm.user_id) cm.user_id, cm.club_id
                  FROM club_members cm
                  JOIN union_clubs u2 ON u2.club_id = cm.club_id AND u2.union_id = p_union_id
                 ORDER BY cm.user_id, cm.joined_at ASC NULLS LAST, cm.club_id
              ) a ON a.user_id = ts.user_id AND a.club_id = uc.club_id
              WHERE ts.left_at IS NULL), 0),
           'net', 0, 'bootstrap', true))
    INTO v_results
    FROM union_clubs uc WHERE uc.union_id = p_union_id;

  INSERT INTO union_pnl_settlements (union_id, period_start, period_end, status,
                                     total_collected, total_paid, total_unpaid, club_results)
  VALUES (p_union_id, v_now, v_now + interval '1 second', 'settled', 0, 0, 0,
          COALESCE(v_results, '[]'::jsonb))
  ON CONFLICT (union_id, period_start) DO NOTHING
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('success', true, 'bootstrap_id', v_id,
                            'baseline_at', v_now, 'clubs', COALESCE(v_results, '[]'::jsonb));
END $$;

CREATE OR REPLACE FUNCTION fn_union_settle_player_pnl_guarded(
  p_union_id uuid,
  p_start timestamptz,
  p_end timestamptz,
  p_tolerance numeric DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_preview jsonb;
  v_imbalance numeric;
  v_gross numeric;
  v_tol numeric;
  v_id uuid;
BEGIN
  v_preview := fn_union_settle_player_pnl(p_union_id, p_start, p_end, true);
  IF NOT COALESCE((v_preview->>'success')::boolean, false) THEN
    RETURN v_preview;
  END IF;

  v_imbalance := COALESCE((v_preview->>'imbalance')::numeric, 0);

  SELECT COALESCE(SUM(abs((e->>'net')::numeric)), 0) INTO v_gross
    FROM jsonb_array_elements(v_preview->'clubs') e;

  -- Tolerance: rounding noise only. 0.5% of gross, floor 100 chips.
  v_tol := COALESCE(p_tolerance, GREATEST(100, round(v_gross * 0.005, 2)));

  IF abs(v_imbalance) > v_tol THEN
    INSERT INTO union_pnl_settlements (union_id, period_start, period_end, status,
                                       total_collected, total_paid, total_unpaid, club_results)
    VALUES (p_union_id, p_start, p_end, 'needs_review', 0, 0, 0,
            COALESCE(v_preview->'clubs', '[]'::jsonb))
    ON CONFLICT (union_id, period_start) DO NOTHING
    RETURNING id INTO v_id;

    RETURN jsonb_build_object(
      'success', false,
      'needs_review', true,
      'reason', 'zero_sum_invariant_violated',
      'imbalance', v_imbalance,
      'tolerance', v_tol,
      'settlement_id', v_id,
      'message', 'Club P&L did not net to zero across the union; no chips were moved. '
                 || 'Usual cause: missing seated-stack baseline (run fn_union_pnl_bootstrap) '
                 || 'or rake attribution gaps in the period.',
      'clubs', v_preview->'clubs'
    );
  END IF;

  RETURN fn_union_settle_player_pnl(p_union_id, p_start, p_end, false);
END $$;

REVOKE ALL ON FUNCTION fn_union_pnl_bootstrap(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_union_settle_player_pnl_guarded(uuid, timestamptz, timestamptz, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_union_pnl_bootstrap(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION fn_union_settle_player_pnl_guarded(uuid, timestamptz, timestamptz, numeric) TO service_role;

-- Seed baselines for every existing union so the first real run has deltas.
DO $$
DECLARE u record;
BEGIN
  FOR u IN SELECT id FROM unions LOOP
    PERFORM fn_union_pnl_bootstrap(u.id);
  END LOOP;
END $$;
