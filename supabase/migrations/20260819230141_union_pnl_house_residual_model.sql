-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819230141 "union_pnl_house_residual_model"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 4864f79805d7353679cc5f76ea1cc3c9 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- UNION P&L — THE HOUSE RESIDUAL (2026-08-19, decision implemented)
--
-- THE QUESTION THIS SETTLES
-- Real players do not only play each other; they also play the house horses.
-- Summed across a union, transfers BETWEEN real players cancel, so whatever is
-- left over is by definition the net flow between real players and the house:
--
--     sum(club nets) == net real-player-vs-house flow  ==  the "imbalance"
--
-- v2 treated any non-zero sum as a fault and parked the whole run as
-- needs_review. That was right while the number was unexplained — it stopped a
-- 1.1M mis-settlement — but as a permanent rule it is wrong: it would park
-- EVERY week forever and the weekly billing would never actually run.
--
-- THE DECISION
-- The union is the clearing house, so the union absorbs the house flow. That
-- is already what the mechanism does: collect from losing clubs, pay winning
-- clubs, and the union wallet ends up holding the difference. The residual is
-- therefore a legitimate, expected line item — not an error. It is now named,
-- recorded on the settlement row, and written to the union ledger as its own
-- transaction so it is auditable instead of hidden in a rounding gap.
--
-- WHAT STILL BLOCKS A PAYOUT
-- The guard is kept, but pointed at what actually indicates broken data rather
-- than at normal house flow: a club showing a non-zero net with NO supporting
-- activity at all (no buy-ins, no cash-outs, no stack movement). That can only
-- mean the inputs are wrong, and paying on it would be paying on garbage.
-- ============================================================================

ALTER TABLE union_pnl_settlements ADD COLUMN IF NOT EXISTS house_residual numeric NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION fn_union_settle_player_pnl_guarded(
  p_union_id uuid,
  p_start timestamptz,
  p_end timestamptz,
  p_tolerance numeric DEFAULT NULL   -- retained for call compatibility; unused
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_preview jsonb;
  v_bad int := 0;
  v_detail jsonb;
  v_id uuid;
BEGIN
  v_preview := fn_union_settle_player_pnl(p_union_id, p_start, p_end, true);
  IF NOT COALESCE((v_preview->>'success')::boolean, false) THEN
    RETURN v_preview;
  END IF;

  -- Integrity check: a net with no supporting activity means the inputs are
  -- broken. Normal house flow is NOT an error and no longer blocks.
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
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_id;

    RETURN jsonb_build_object(
      'success', false, 'needs_review', true,
      'reason', 'net_without_activity',
      'clubs_affected', v_bad,
      'settlement_id', v_id,
      'message', 'One or more clubs show a balance owed with no buy-ins, cash-outs '
                 || 'or stack movement behind it. The inputs are wrong, so no chips '
                 || 'were moved.',
      'detail', v_detail);
  END IF;

  RETURN fn_union_settle_player_pnl(p_union_id, p_start, p_end, false);
END $$;

REVOKE ALL ON FUNCTION fn_union_settle_player_pnl_guarded(uuid, timestamptz, timestamptz, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_union_settle_player_pnl_guarded(uuid, timestamptz, timestamptz, numeric) TO service_role;
