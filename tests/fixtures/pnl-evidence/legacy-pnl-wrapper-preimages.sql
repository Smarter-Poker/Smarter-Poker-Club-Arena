-- Captured original wrapper definitions from the read-only September 14
-- captured-pnl-metadata.json writers[] evidence in this fixture. Fixture input
-- only; these are NOT alternate production writers or changes to wrappers.
-- Protected qualification must check source-binding.json and compare this
-- input with the captured snapshot before loading it, before the candidate.
-- Wrapper owner and ACL were NOT captured. These fixture-only definitions
-- belong to the disposable loader and are deliberately unavailable to every
-- client role. This does not reproduce or qualify production wrapper access.
BEGIN;
CREATE OR REPLACE FUNCTION public.fn_union_settle_player_pnl_guarded(p_union_id uuid, p_start timestamp with time zone, p_end timestamp with time zone, p_tolerance numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_preview jsonb; v_bad int := 0; v_detail jsonb; v_id uuid;
  v_residual numeric; v_turnover numeric; v_tol numeric;
BEGIN
  v_preview := fn_union_settle_player_pnl(p_union_id, p_start, p_end, true);
  IF NOT COALESCE((v_preview->>'success')::boolean, false) THEN
    RETURN v_preview;
  END IF;

  SELECT count(*), jsonb_agg(e) INTO v_bad, v_detail
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

  v_residual := COALESCE((v_preview->>'house_residual')::numeric, 0);
  SELECT COALESCE(SUM(COALESCE((e->>'buyins')::numeric,0)
                    + COALESCE((e->>'cashouts')::numeric,0)), 0)
    INTO v_turnover FROM jsonb_array_elements(v_preview->'clubs') e;
  v_tol := COALESCE(p_tolerance, GREATEST(100, round(v_turnover * 0.01, 2)));

  IF abs(v_residual) > v_tol THEN
    INSERT INTO union_pnl_settlements (union_id, period_start, period_end, status,
                                       total_collected, total_paid, total_unpaid, club_results)
    VALUES (p_union_id, p_start, p_end, 'needs_review', 0, 0, 0,
            COALESCE(v_preview->'clubs', '[]'::jsonb))
    ON CONFLICT DO NOTHING RETURNING id INTO v_id;
    RETURN jsonb_build_object('success', false, 'needs_review', true,
      'reason', 'does_not_reconcile', 'residual', v_residual, 'tolerance', v_tol,
      'turnover', v_turnover, 'settlement_id', v_id,
      'message', 'Club win/loss did not net out across the union, so the basis is not '
                 || 'trustworthy and NO chips were moved. Weekly 90% rakeback is unaffected '
                 || 'and pays normally - it is computed from rake contributions, not from '
                 || 'this identity.');
  END IF;

  RETURN fn_union_settle_player_pnl(p_union_id, p_start, p_end, false);
END $function$;

CREATE OR REPLACE FUNCTION public.fn_union_settle_player_pnl_weekly(p_union_id uuid, p_min_hours numeric DEFAULT 12)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_start timestamptz; v_end timestamptz := now();
BEGIN
  SELECT period_end INTO v_start
    FROM union_pnl_settlements
   WHERE union_id = p_union_id AND status IN ('settled','baseline')
   ORDER BY period_start DESC LIMIT 1;

  IF v_start IS NULL THEN v_start := v_end - interval '7 days'; END IF;

  IF EXTRACT(EPOCH FROM (v_end - v_start)) / 3600.0 < p_min_hours THEN
    RETURN jsonb_build_object('success', true, 'skipped', true,
      'reason', 'period_too_short',
      'hours', round((EXTRACT(EPOCH FROM (v_end - v_start)) / 3600.0)::numeric, 2),
      'period_start', v_start, 'period_end', v_end);
  END IF;

  RETURN fn_union_settle_player_pnl_guarded(p_union_id, v_start, v_end);
END $function$;
REVOKE ALL ON FUNCTION public.fn_union_settle_player_pnl_guarded(uuid,timestamptz,timestamptz,numeric),
 public.fn_union_settle_player_pnl_weekly(uuid,numeric) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
