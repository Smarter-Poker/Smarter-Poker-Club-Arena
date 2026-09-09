/*
 * ═══════════════════════════════════════════════════════════════════════════
 *  UNCLASSIFIED FLOW IS WHAT STAYED, NOT WHAT PASSED THROUGH
 *  2026-09-09
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The dashboard tile read 82,229.96 today. Nothing was missing. Net movement
 * through settlement_suspense today was 0.00 - at every hour, for every
 * counterparty, across all 116 rows, with no mint and no burn leg among them.
 *
 * chip_ledger is a TRANSFER journal: one row is one from_type -> to_type move.
 * A chip that enters suspense and later leaves it writes TWO rows, and
 * `sum(amount)` counts both. Inflow 41,114.98 + outflow 41,114.98 is the
 * 82,229.96 the tile was showing.
 *
 * The tile therefore behaved backwards in the worst possible way. It stood at
 * 41,474.98 all morning while 28 payments really were double-journalled, and
 * it DOUBLED to 82,229.96 at 11:00:50 - the exact minute the corrections that
 * fixed them were posted, because a cancelling row also touches suspense.
 * Fixing the drift made the alarm louder, which teaches an operator to
 * distrust the board.
 *
 * fn_ca_quick_reconcile section 3g learned this earlier today and already
 * nets. The dashboard metric was missed, so the raiser and the board have
 * been disagreeing since. Same expression here, and the two now agree.
 *
 * Everything else in this function is unchanged.
 */

CREATE OR REPLACE FUNCTION public.fn_ca_drift_metrics()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_mgmt boolean := true;
  v jsonb;
BEGIN
  IF v_uid IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.ca_incident_recipients r WHERE r.user_id = v_uid AND r.active
      UNION ALL
      SELECT 1 FROM public.club_members cm WHERE cm.user_id = v_uid AND cm.role = 'owner'
      UNION ALL
      SELECT 1 FROM public.unions u WHERE u.owner_id = v_uid
      UNION ALL
      SELECT 1 FROM public.profiles p WHERE p.id = v_uid AND p.role IN ('admin','god')
    ) INTO v_mgmt;
    IF NOT v_mgmt THEN RETURN '{}'::jsonb; END IF;
  END IF;

  SELECT jsonb_build_object(
    'open_total',        count(*) FILTER (WHERE status <> 'resolved'),
    'open_critical',     count(*) FILTER (WHERE status <> 'resolved' AND severity = 'critical'),
    'past_target',       count(*) FILTER (WHERE status <> 'resolved' AND past_target),
    'auto_repairing',    count(*) FILTER (WHERE status <> 'resolved' AND auto_repair_status = 'running'),
    'resolved_today',    count(*) FILTER (WHERE status = 'resolved' AND resolved_at > CURRENT_DATE),
    'median_resolve_min', (SELECT round(percentile_cont(0.5) WITHIN GROUP (
                             ORDER BY extract(epoch FROM (resolved_at - detected_at))/60)::numeric, 1)
                            FROM public.ca_drift_incidents
                           WHERE status = 'resolved' AND resolved_at > now() - interval '7 days'),
    'worst_open_drift',  COALESCE(max(abs(discrepancy_amount))
                           FILTER (WHERE status <> 'resolved'), 0)
  ) INTO v
  FROM public.ca_drift_incidents;

  v := v || jsonb_build_object(
    /* NET, not gross: what is still sitting in suspense from today's flow.
       A round trip through suspense leaves nothing behind and must read 0. */
    'suspense_today', (SELECT COALESCE(sum(CASE WHEN to_type = 'settlement_suspense'
                                                THEN amount ELSE -amount END), 0)
                         FROM public.chip_ledger
                        WHERE (from_type = 'settlement_suspense' OR to_type = 'settlement_suspense')
                          AND created_at > CURRENT_DATE),
    /* Kept alongside it so an operator can still see the traffic that produced
       the net, without the traffic being mistaken for the exposure. */
    'suspense_today_gross', (SELECT COALESCE(sum(amount), 0) FROM public.chip_ledger
                              WHERE (from_type = 'settlement_suspense' OR to_type = 'settlement_suspense')
                                AND created_at > CURRENT_DATE),
    'ledger_write_failures_24h', (SELECT count(*) FROM public.ca_ledger_write_failures
                                   WHERE occurred_at > now() - interval '24 hours'),
    'supply_unexplained_last', (SELECT unexplained FROM public.ca_supply_snapshots
                                 ORDER BY taken_at DESC LIMIT 1),
    'ledger_rows_today', (SELECT count(*) FROM public.chip_ledger WHERE created_at > CURRENT_DATE));
  RETURN v;
END $function$;

REVOKE ALL ON FUNCTION public.fn_ca_drift_metrics() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_ca_drift_metrics() FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_drift_metrics() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_drift_metrics() TO service_role;
