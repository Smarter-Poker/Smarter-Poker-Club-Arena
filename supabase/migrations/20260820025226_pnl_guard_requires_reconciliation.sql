-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820025226 "pnl_guard_requires_reconciliation"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 84921416ea6f5394fd7c2eba16ab7d40 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- THE P&L SETTLEMENT WILL NOT PAY UNTIL IT RECONCILES (2026-08-19)
--
-- In a closed cash economy a club's players lose exactly the rake they pay:
--     player_net + rake_paid ~= inter-club transfers, summing to ~0 union-wide
-- Three real unit errors were found and fixed today chasing that identity
-- (tournament scrip counted as money in the seated stack; house horses
-- excluded from the P&L while included in the rake basis; tournament payouts
-- swept in as cash-outs through a legacy club-scoped fallback). Each one moved
-- the number a long way in the right direction.
--
-- A residual remains: over a clean 60-second window with matched baselines,
-- players netted +1,755.89 against 28.40 of rake — roughly 1,784 unaccounted.
-- I have not identified its source.
--
-- The rakeback half is unaffected and correct: it is driven by
-- fn_union_rake_basis_by_club off rake_records.player_contributions, which
-- does not depend on this identity at all. Clubs will get their 90% on Monday.
--
-- But the player win/loss half must NOT pay out on a basis that does not
-- balance. The guard therefore refuses again when the union-wide sum is
-- materially non-zero, recording 'needs_review' and moving nothing — the same
-- posture that stopped a 1,112,929 mis-settlement earlier today. It is far
-- better to owe a club a correct number late than to pay it a wrong one on
-- time.
--
-- Tolerance scales with activity, with a floor, so ordinary rounding passes
-- and a structural gap does not.
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_union_settle_player_pnl_guarded(
  p_union_id uuid,
  p_start timestamptz,
  p_end timestamptz,
  p_tolerance numeric DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_preview jsonb;
  v_bad int := 0;
  v_detail jsonb;
  v_id uuid;
  v_residual numeric;
  v_gross numeric;
  v_tol numeric;
BEGIN
  v_preview := fn_union_settle_player_pnl(p_union_id, p_start, p_end, true);
  IF NOT COALESCE((v_preview->>'success')::boolean, false) THEN
    RETURN v_preview;
  END IF;

  -- (a) a balance owed with nothing behind it means the inputs are broken
  SELECT count(*), jsonb_agg(e)
    INTO v_bad, v_detail
    FROM jsonb_array_elements(v_preview->'clubs') e
   WHERE abs(COALESCE((e->>'net')::numeric, 0)) > 1
     AND COALESCE((e->>'buyins')::numeric, 0) = 0
     AND COALESCE((e->>'cashouts')::numeric, 0) = 0
     AND COALESCE((e->>'stack_delta')::numeric, 0) = 0;

  IF v_bad > 0 THEN
    INSERT INTO union_pnl_settlements (union_id, period_start, period_end, status,
                                       total_collected, total_paid, total_unpaid, club_results)
    VALUES (p_union_id, p_start, p_end, 'needs_review', 0, 0, 0,
            COALESCE(v_preview->'clubs', '[]'::jsonb))
    ON CONFLICT DO NOTHING RETURNING id INTO v_id;
    RETURN jsonb_build_object('success', false, 'needs_review', true,
      'reason', 'net_without_activity', 'clubs_affected', v_bad, 'settlement_id', v_id,
      'message', 'One or more clubs show a balance owed with no buy-ins, cash-outs or '
                 || 'stack movement behind it. The inputs are wrong, so no chips were moved.',
      'detail', v_detail);
  END IF;

  -- (b) the books must balance union-wide before any chips move
  v_residual := COALESCE((v_preview->>'house_residual')::numeric, 0);
  SELECT COALESCE(SUM(abs((e->>'net')::numeric)), 0) INTO v_gross
    FROM jsonb_array_elements(v_preview->'clubs') e;
  v_tol := COALESCE(p_tolerance, GREATEST(100, round(v_gross * 0.02, 2)));

  IF abs(v_residual) > v_tol THEN
    INSERT INTO union_pnl_settlements (union_id, period_start, period_end, status,
                                       total_collected, total_paid, total_unpaid, club_results)
    VALUES (p_union_id, p_start, p_end, 'needs_review', 0, 0, 0,
            COALESCE(v_preview->'clubs', '[]'::jsonb))
    ON CONFLICT DO NOTHING RETURNING id INTO v_id;
    RETURN jsonb_build_object('success', false, 'needs_review', true,
      'reason', 'does_not_reconcile', 'residual', v_residual, 'tolerance', v_tol,
      'settlement_id', v_id,
      'message', 'Club win/loss did not net out across the union, so the basis is not '
                 || 'trustworthy and NO chips were moved. Weekly 90% rakeback is unaffected '
                 || 'and pays normally — it is computed from rake contributions, not from '
                 || 'this identity.');
  END IF;

  RETURN fn_union_settle_player_pnl(p_union_id, p_start, p_end, false);
END $$;

REVOKE ALL ON FUNCTION fn_union_settle_player_pnl_guarded(uuid, timestamptz, timestamptz, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_union_settle_player_pnl_guarded(uuid, timestamptz, timestamptz, numeric) TO service_role;
