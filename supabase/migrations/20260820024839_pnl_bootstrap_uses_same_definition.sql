-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820024839 "pnl_bootstrap_uses_same_definition"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 93e98b71dacd4a23160d4161d9f13e1d of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- THE BASELINE MUST BE MEASURED THE SAME WAY AS THE PERIOD (2026-08-19)
--
-- The weekly statement showed players WINNING 76,316 in a window where they
-- paid 38,896 of rake. In a closed system players lose the rake, so that is
-- 115k of chips arriving from nowhere.
--
-- Cause: fn_union_pnl_bootstrap carried its OWN inline seated-stack query,
-- written when the P&L excluded horses and counted tournament seats. The P&L
-- has since been corrected on both points (horses are a club's own players;
-- tournament stacks are scrip). So the stored baseline and the live figure
-- were measured by two different rules, and their difference was meaningless.
--
-- Exactly the non-comparability already fixed in the chip-supply monitor
-- today, in a second place. The lesson generalises: a stored baseline must be
-- produced by the SAME function that later reads it, never by a copy of its
-- logic. The bootstrap now delegates to fn_union_pnl_all_clubs so the two can
-- never drift apart again.
-- ============================================================================

CREATE OR REPLACE FUNCTION fn_union_pnl_bootstrap(p_union_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_results jsonb; v_id uuid; v_now timestamptz := now();
BEGIN
  -- Same source of truth the settlement and the statement read.
  SELECT jsonb_agg(jsonb_build_object(
           'club_id', r.club_id,
           'seated_end', r.seated_stack,
           'net', 0, 'bootstrap', true))
    INTO v_results
    FROM fn_union_pnl_all_clubs(p_union_id, v_now - interval '1 second', v_now, true) r;

  INSERT INTO union_pnl_settlements (union_id, period_start, period_end, status,
                                     total_collected, total_paid, total_unpaid, club_results)
  VALUES (p_union_id, v_now, v_now + interval '1 second', 'settled', 0, 0, 0,
          COALESCE(v_results, '[]'::jsonb))
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('success', true, 'bootstrap_id', v_id,
                            'baseline_at', v_now, 'clubs', COALESCE(v_results, '[]'::jsonb));
END $$;

REVOKE ALL ON FUNCTION fn_union_pnl_bootstrap(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_union_pnl_bootstrap(uuid) TO service_role;

-- Re-baseline every union on the corrected definition.
DO $$
DECLARE u record;
BEGIN
  FOR u IN SELECT id FROM unions LOOP
    PERFORM fn_union_pnl_bootstrap(u.id);
  END LOOP;
END $$;
