-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820033633 "union_pnl_baseline_anchor_and_horse_rake"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 6eb7fc4cd62c9b8f759fb294c2977f61 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.


-- ============================================================================
-- Why the union P&L never reconciled, and why no chips ever moved.
--
-- (A) BASELINE ANCHORED AT THE WRONG END OF THE PERIOD.
--     fn_union_settle_player_pnl called fn_union_pnl_baseline(union, p_END).
--     That returns the last settled period before the END of the window - so
--     any baseline taken INSIDE the window wins, and seated_start was a
--     snapshot from minutes ago while the cash flows covered the whole period.
--     Two windows 5 hours apart returned byte-identical seated_start values,
--     which is what exposed it. Must be anchored at p_START.
--
-- (B) RAKE ATTRIBUTION EXCLUDED HORSES WHILE THE P&L INCLUDED THEM.
--     fn_union_pnl_all_clubs counts horse flows (p_include_horses defaults
--     true - Dan's model: horses generate real rake). fn_union_rake_paid_by_club
--     hard-filtered is_horse = false. Nearly all play is horses, so rake_paid
--     came back 0 for every club, the rake was never added back, and the entire
--     rake take showed up as an unexplained player loss.
--
-- (C) ONE MEMBER CLUB COULD NEVER BE INVOICED. (see next migration)
-- (D) BOOTSTRAP ROWS MASQUERADED AS SETTLEMENTS.
-- ============================================================================

UPDATE union_pnl_settlements
   SET status = 'baseline'
 WHERE status = 'settled'
   AND total_collected = 0 AND total_paid = 0
   AND period_end - period_start = interval '1 second';

DROP FUNCTION IF EXISTS public.fn_union_pnl_baseline(uuid, timestamptz);

CREATE FUNCTION public.fn_union_pnl_baseline(p_union_id uuid, p_at timestamptz)
 RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT club_results
    FROM union_pnl_settlements
   WHERE union_id = p_union_id
     AND status IN ('settled','baseline')
     AND period_start < p_at
   ORDER BY period_start DESC
   LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.fn_union_pnl_bootstrap(p_union_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_results jsonb; v_id uuid; v_now timestamptz := now();
BEGIN
  SELECT jsonb_agg(jsonb_build_object(
           'club_id', r.club_id, 'seated_end', r.seated_stack,
           'net', 0, 'bootstrap', true))
    INTO v_results
    FROM fn_union_pnl_all_clubs(p_union_id, v_now - interval '1 second', v_now, true) r;

  INSERT INTO union_pnl_settlements (union_id, period_start, period_end, status,
                                     total_collected, total_paid, total_unpaid, club_results)
  VALUES (p_union_id, v_now, v_now + interval '1 second', 'baseline', 0, 0, 0,
          COALESCE(v_results, '[]'::jsonb))
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('success', true, 'bootstrap_id', v_id,
                            'baseline_at', v_now, 'clubs', COALESCE(v_results, '[]'::jsonb));
END $function$;

DROP FUNCTION IF EXISTS public.fn_union_rake_paid_by_club(uuid, timestamptz, timestamptz);

CREATE FUNCTION public.fn_union_rake_paid_by_club(
  p_union_id uuid, p_start timestamptz, p_end timestamptz,
  p_include_horses boolean DEFAULT true)
 RETURNS TABLE(club_id uuid, rake_paid numeric)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH attributed AS (
    SELECT DISTINCT ON (cm.user_id) cm.user_id, cm.club_id
      FROM club_members cm
      JOIN union_clubs uc ON uc.club_id = cm.club_id AND uc.union_id = p_union_id
      JOIN profiles p ON p.id = cm.user_id
     WHERE p_include_horses OR COALESCE(p.is_horse, false) = false
     ORDER BY cm.user_id, cm.joined_at ASC NULLS LAST, cm.club_id
  ),
  ut AS (SELECT id FROM tables WHERE union_id = p_union_id),
  rr AS (
    SELECT r.id, r.rake_amount, r.player_contributions,
           (SELECT SUM(t.value::numeric)
              FROM jsonb_each_text(r.player_contributions) AS t(key, value)) AS total_contrib
      FROM rake_records r
      JOIN ut ON ut.id = r.table_id
     WHERE r.created_at >= p_start AND r.created_at < p_end
       AND r.player_contributions IS NOT NULL AND r.rake_amount > 0
  )
  SELECT a.club_id, round(SUM(rr.rake_amount * (e.value::numeric) / rr.total_contrib), 2)
    FROM rr
    CROSS JOIN LATERAL jsonb_each_text(rr.player_contributions) AS e(key, value)
    JOIN attributed a ON a.user_id = (e.key)::uuid
   WHERE rr.total_contrib > 0
   GROUP BY a.club_id;
$function$;

