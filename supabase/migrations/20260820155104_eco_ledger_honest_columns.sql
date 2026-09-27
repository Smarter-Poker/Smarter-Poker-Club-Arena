-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820155104 "eco_ledger_honest_columns"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 d0d13cf3e3d03aebd377954f73a4420a of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ECO LEDGER: honest column name + record the mode (2026-08-20)
--
-- Two problems found reviewing my own work:
--
-- 1. MISNAMED COLUMN. union_eco_ledger.settle_net actually received
--    fn_union_eco_adjustment.eco_base. Those are not the same number in ANY
--    mode — in the default mode eco_base = settle_net + the rakeback credit.
--    A money ledger whose column name misdescribes its contents is how a
--    future reader reaches a wrong conclusion with total confidence.
--    Renamed to eco_base.
--
-- 2. NOT ACTUALLY REPRODUCIBLE. The ledger exists so an issued invoice can be
--    reproduced later, but it never recorded WHICH base mode produced the
--    figure. Since the mode is configurable per union
--    (net_invoice_position / winnings_plus_rake / winnings_only) and each
--    yields a materially different number — measured on one club in one week:
--    -120,317 vs -146,326 vs -175,224 — a stored row could not be explained
--    after a mode change. eco_base_mode is now stored alongside it.
--
-- Safe to do now: the ledger is empty (0 rows), ECO is disabled by default,
-- and only two functions reference the table.
ALTER TABLE public.union_eco_ledger RENAME COLUMN settle_net TO eco_base;
ALTER TABLE public.union_eco_ledger ADD COLUMN IF NOT EXISTS eco_base_mode text;

CREATE OR REPLACE FUNCTION public.fn_union_eco_record(
  p_union_id uuid, p_start timestamptz, p_end timestamptz,
  p_settlement_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_rows int;
  v_mode text := fn_union_eco_base_mode(p_union_id);
BEGIN
  IF v_caller IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM unions u WHERE u.id = p_union_id AND u.owner_id = v_caller)
     AND NOT EXISTS (SELECT 1 FROM union_admins ua
                      WHERE ua.union_id = p_union_id AND ua.user_id = v_caller) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized');
  END IF;

  INSERT INTO union_eco_ledger (union_id, club_id, period_start, period_end,
                                eco_base, eco_rate, eco_amount, eco_base_mode,
                                settlement_id)
  SELECT p_union_id, e.club_id, p_start, p_end, e.eco_base, e.eco_rate,
         e.eco_amount, v_mode, p_settlement_id
    FROM fn_union_eco_adjustment(p_union_id, p_start, p_end) e
  ON CONFLICT (union_id, club_id, period_start) DO UPDATE
    SET period_end    = EXCLUDED.period_end,
        eco_base      = EXCLUDED.eco_base,
        eco_rate      = EXCLUDED.eco_rate,
        eco_amount    = EXCLUDED.eco_amount,
        eco_base_mode = EXCLUDED.eco_base_mode,
        settlement_id = COALESCE(EXCLUDED.settlement_id, union_eco_ledger.settlement_id),
        computed_at   = now();
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  RETURN jsonb_build_object('success', true, 'clubs', v_rows, 'eco_base_mode', v_mode,
                            'period_start', p_start, 'period_end', p_end);
END;
$function$;
