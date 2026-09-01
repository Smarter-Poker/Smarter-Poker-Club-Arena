-- Byte-exact mirror of the applied production migration (statements as
-- recorded in supabase_migrations.schema_migrations, rejoined with ";").

-- ZERO-DRIFT PHASE 5: read-only RPCs for the Drift Incidents dashboard.
-- fn_ca_gate_panel: burn-in gate status + 24h supply/diamond trend series.
-- fn_ca_balance_asof_admin: management wrapper over the point-in-time
-- balance reconstructor. Both consult the caller (same management check as
-- fn_ca_incident_dashboard); neither writes anything.
CREATE OR REPLACE FUNCTION public.fn_ca_gate_panel()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_mgmt boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN NULL; END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.ca_incident_recipients r WHERE r.user_id = v_uid AND r.active
    UNION ALL
    SELECT 1 FROM public.club_members cm WHERE cm.user_id = v_uid AND cm.role = 'owner'
    UNION ALL
    SELECT 1 FROM public.unions u WHERE u.owner_id = v_uid
    UNION ALL
    SELECT 1 FROM public.profiles p WHERE p.id = v_uid AND p.role IN ('admin','god')
  ) INTO v_mgmt;
  IF NOT v_mgmt THEN RETURN NULL; END IF;

  RETURN jsonb_build_object(
    'gate', (SELECT to_jsonb(g) FROM (
               SELECT run_at, pass, window_hours, failing, result
                 FROM public.ca_gate_runs ORDER BY run_at DESC LIMIT 1) g),
    'supply_series', (SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.taken_at), '[]'::jsonb) FROM (
               SELECT taken_at, round(unexplained,2) AS unexplained, round(total,2) AS total,
                      round(cert_wallets,2) AS cert_wallets,
                      round(leaderboard_liability,2) AS leaderboard_liability
                 FROM public.ca_supply_snapshots
                WHERE taken_at > now() - interval '24 hours'
                ORDER BY taken_at DESC LIMIT 48) s),
    'diamond_series', (SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.taken_at), '[]'::jsonb) FROM (
               SELECT taken_at, round(unexplained,2) AS unexplained, round(total,2) AS total
                 FROM public.ca_diamond_snapshots
                WHERE taken_at > now() - interval '24 hours'
                ORDER BY taken_at DESC LIMIT 48) d),
    'open_counts', (SELECT jsonb_object_agg(severity, n) FROM (
               SELECT severity, count(*) AS n FROM public.ca_drift_incidents
                WHERE status <> 'resolved' GROUP BY severity) c),
    'generated_at', now());
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_gate_panel() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_gate_panel() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_balance_asof_admin(
  p_entity_type text, p_entity_id uuid, p_asof timestamp with time zone)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_mgmt boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN NULL; END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.ca_incident_recipients r WHERE r.user_id = v_uid AND r.active
    UNION ALL
    SELECT 1 FROM public.profiles p WHERE p.id = v_uid AND p.role IN ('admin','god')
  ) INTO v_mgmt;
  IF NOT v_mgmt THEN RETURN NULL; END IF;
  RETURN public.fn_ca_balance_asof(p_entity_type, p_entity_id, p_asof);
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_balance_asof_admin(text, uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ca_balance_asof_admin(text, uuid, timestamptz) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';;
