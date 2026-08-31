-- Applied to production via Supabase MCP on 2026-08-31 (zero-drift round 2).
-- Byte-exact mirror of the applied migration.
-- ZERO-DRIFT round 2d: fn_ca_incident_dashboard(p_status := NULL) now returns
-- ALL incidents (resolved included) — the dashboard filters client-side and
-- its Resolved tab and resolution stats need the full picture. Pass a status
-- to filter server-side as before.
CREATE OR REPLACE FUNCTION public.fn_ca_incident_dashboard(
  p_status text DEFAULT NULL,
  p_limit  int DEFAULT 100
) RETURNS SETOF jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_mgmt boolean;
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
    IF NOT v_mgmt THEN RETURN; END IF;
  END IF;
  RETURN QUERY
  SELECT to_jsonb(i) ||
         jsonb_build_object(
           'club_name',  (SELECT name FROM public.clubs  c WHERE c.id = i.club_id),
           'union_name', (SELECT name FROM public.unions u WHERE u.id = i.union_id),
           'age_minutes', floor(extract(epoch FROM now() - i.detected_at)/60),
           'events', (SELECT COALESCE(jsonb_agg(to_jsonb(e)), '[]'::jsonb)
                        FROM (SELECT at, kind, actor, detail
                                FROM public.ca_incident_events e2
                               WHERE e2.incident_id = i.id
                               ORDER BY at DESC LIMIT 30) e))
  FROM public.ca_drift_incidents i
  WHERE p_status IS NULL OR i.status = p_status
  ORDER BY (i.status = 'resolved'), i.detected_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit,100),1), 500);
END $$;