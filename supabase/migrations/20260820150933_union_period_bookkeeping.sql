-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260820150933 "union_period_bookkeeping"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 c7c6c4a3de437ef3d1cbf80808153bd6 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- CLOSING THE WEEKLY CYCLE (2026-08-20)
--
-- Two loose ends left the weekly cycle open:
--   1. ECO was computed on demand but never persisted, so an invoice issued
--      today could not be reproduced tomorrow once live data moved on. The
--      union_eco_not_recorded invariant flags this but nothing satisfied it.
--   2. union_presettlements.applied_settlement_id was never set by anything,
--      so a presettlement would offset the running balance forever instead of
--      being consumed by the settlement it paid for.
--
-- DELIBERATELY NOT PUT INSIDE fn_union_settle_player_pnl. ECO recording calls
-- the reconciliation report, which calls fn_union_pnl_all_clubs (~7s over a
-- week). Putting that inside the settlement transaction would add seven
-- seconds to a window holding FOR UPDATE locks on union_wallets and
-- clubs.chip_treasury, contending with live horse funding — the same mistake
-- I already had to undo with the rake rollup. These run OUTSIDE the money
-- transaction.

-- Idempotent per (union, club, week). Safe to call every settler cycle: it
-- refreshes the current week's figures until the week closes, and no-ops
-- entirely while ECO is disabled.
CREATE OR REPLACE FUNCTION public.fn_union_eco_record_current_week(
  p_union_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  u record;
  v_start timestamptz := fn_union_week_start();
  v_out jsonb := '[]'::jsonb;
  v_res jsonb;
BEGIN
  FOR u IN
    SELECT un.id FROM unions un
     WHERE (p_union_id IS NULL OR un.id = p_union_id)
       AND COALESCE((un.settings->>'eco_enabled')::boolean, false)
       AND EXISTS (SELECT 1 FROM union_clubs uc WHERE uc.union_id = un.id)
  LOOP
    BEGIN
      v_res := fn_union_eco_record(u.id, v_start, now(), NULL);
      v_out := v_out || jsonb_build_array(v_res);
    EXCEPTION WHEN OTHERS THEN
      v_out := v_out || jsonb_build_array(
        jsonb_build_object('union_id', u.id, 'success', false, 'error', SQLERRM));
    END;
  END LOOP;

  RETURN jsonb_build_object('week_start', v_start, 'unions', v_out);
END;
$function$;

-- Consume presettlements against a settlement. Explicit, not automatic:
-- deciding that a given payment settles a given period is a business act, and
-- once applied the money stops offsetting the running balance.
CREATE OR REPLACE FUNCTION public.fn_union_apply_presettlements(
  p_union_id uuid, p_settlement_id uuid,
  p_club_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_period_start timestamptz;
  v_period_end   timestamptz;
  v_rows int;
  v_total numeric;
BEGIN
  IF v_caller IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM unions u WHERE u.id = p_union_id AND u.owner_id = v_caller)
     AND NOT EXISTS (SELECT 1 FROM union_admins ua
                      WHERE ua.union_id = p_union_id AND ua.user_id = v_caller) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized');
  END IF;

  SELECT s.period_start, s.period_end INTO v_period_start, v_period_end
    FROM union_pnl_settlements s
   WHERE s.id = p_settlement_id AND s.union_id = p_union_id;

  IF v_period_start IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'settlement not found for this union');
  END IF;

  WITH upd AS (
    UPDATE union_presettlements p
       SET applied_settlement_id = p_settlement_id
     WHERE p.union_id = p_union_id
       AND p.applied_settlement_id IS NULL
       AND p.received_at < v_period_end
       AND (p_club_id IS NULL OR p.club_id = p_club_id)
    RETURNING p.amount
  )
  SELECT count(*), COALESCE(round(SUM(amount), 2), 0) INTO v_rows, v_total FROM upd;

  RETURN jsonb_build_object('success', true, 'settlement_id', p_settlement_id,
                            'presettlements_applied', v_rows, 'total_applied', v_total,
                            'period_start', v_period_start, 'period_end', v_period_end);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_union_eco_record_current_week(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_union_apply_presettlements(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fn_union_apply_presettlements(uuid, uuid, uuid) TO authenticated;
