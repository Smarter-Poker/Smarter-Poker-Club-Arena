CREATE OR REPLACE FUNCTION public.fn_club_table_daily_catchup(p_days integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_n int := GREATEST(LEAST(COALESCE(p_days, 3), 30), 1);
  d date;
  v_done jsonb := '[]'::jsonb;
  v_stored bigint;
  v_actual bigint;
  v_ledger numeric;
  v_rollup numeric;
  v_reconciled jsonb := '[]'::jsonb;
  v_today_drift numeric;
BEGIN
  FOR d IN SELECT gs::date FROM generate_series(v_today - (v_n - 1), v_today, interval '1 day') gs LOOP
    SELECT COALESCE(SUM(c.source_rows), 0) INTO v_stored
      FROM club_table_daily c WHERE c.stat_date = d;

    -- The same reading of contributions the refresh uses (uuid-keyed rows,
    -- plus one synthetic row per hand with no usable contribution), so a
    -- stored count matches an actual count exactly when nothing has changed.
    SELECT (
      SELECT COUNT(*)
        FROM rake_records r
        JOIN tables t ON t.id = r.table_id AND t.tournament_id IS NULL
        CROSS JOIN LATERAL jsonb_each_text(r.player_contributions) e(key, value)
       WHERE r.created_at >= (d::timestamp AT TIME ZONE 'UTC')
         AND r.created_at <  ((d + 1)::timestamp AT TIME ZONE 'UTC')
         AND r.player_contributions IS NOT NULL
         AND r.rake_amount > 0
         AND e.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         AND EXISTS (
           SELECT 1
             FROM jsonb_each_text(CASE WHEN jsonb_typeof(r.player_contributions) = 'object'
                                       THEN r.player_contributions ELSE '{}'::jsonb END) x
            WHERE x.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
              AND (CASE WHEN x.value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN x.value::numeric ELSE 0 END) > 0)
    ) + (
      SELECT COUNT(*)
        FROM rake_records r
        JOIN tables t ON t.id = r.table_id AND t.tournament_id IS NULL
       WHERE r.created_at >= (d::timestamp AT TIME ZONE 'UTC')
         AND r.created_at <  ((d + 1)::timestamp AT TIME ZONE 'UTC')
         AND r.rake_amount > 0
         AND NOT EXISTS (
           SELECT 1
             FROM jsonb_each_text(CASE WHEN jsonb_typeof(r.player_contributions) = 'object'
                                       THEN r.player_contributions ELSE '{}'::jsonb END) e
            WHERE e.key ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
              AND (CASE WHEN e.value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN e.value::numeric ELSE 0 END) > 0)
    ) INTO v_actual;

    IF d >= v_today - 1 OR v_stored IS DISTINCT FROM v_actual THEN
      PERFORM fn_club_table_daily_refresh_day(d);
      v_done := v_done || jsonb_build_array(jsonb_build_object('day', d, 'refreshed', true));
    END IF;

    -- Rake is conserved across attribution, so a COMPLETE day's rollup total
    -- must equal the ledger's cash rake for that day. Today is excluded on
    -- purpose: the triggers are exact on a live day and a recount is not.
    IF d < v_today THEN
      v_ledger := public.fn_ca_club_rake_daily_ledger_total(d);
      SELECT COALESCE(SUM(x.rake), 0) INTO v_rollup
        FROM ca_club_rake_daily x WHERE x.stat_date = d;
      IF abs(v_ledger - v_rollup) > 0.005 THEN
        PERFORM fn_ca_club_rake_daily_rebuild_range(d, d, false);
        v_reconciled := v_reconciled || jsonb_build_array(jsonb_build_object(
          'day', d, 'ledger', v_ledger, 'rollup_was', v_rollup));
      END IF;
    END IF;
  END LOOP;

  -- Today is reported, never rewritten. A drift that survives the day is a
  -- trigger that stopped landing, and it will be recounted at midnight.
  v_today_drift := round(public.fn_ca_club_rake_daily_ledger_total(v_today)
                         - COALESCE((SELECT SUM(x.rake) FROM ca_club_rake_daily x
                                      WHERE x.stat_date = v_today), 0), 4);

  RETURN jsonb_build_object('success', true, 'days', v_done,
                            'rake_daily_rebuilt', v_reconciled,
                            'today_drift', v_today_drift);
END;
$function$
