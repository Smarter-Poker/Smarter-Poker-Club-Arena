-- Exact retained0519/0532 baseline supplement. SOURCE ONLY / UNRUN.
DO $guard$ BEGIN IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL THEN RAISE EXCEPTION 'isolated browser observer baseline required';END IF;END$guard$;
DO $guard$ BEGIN IF to_regprocedure('public.fn_open_settlement_period(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'browser observer baseline already defines fn_open_settlement_period(uuid)';END IF;END$guard$;
CREATE OR REPLACE FUNCTION public.fn_open_settlement_period(p_club_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_caller uuid := (SELECT auth.uid());
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM clubs c WHERE c.id = p_club_id AND (
      c.owner_id = v_caller
      OR EXISTS (SELECT 1 FROM club_members cm WHERE cm.club_id = p_club_id
                 AND cm.user_id = v_caller AND cm.role IN ('owner','co_owner','admin'))))
  THEN RAISE EXCEPTION 'not authorized to manage this club''s settlement periods'; END IF;

  IF EXISTS (SELECT 1 FROM settlement_periods WHERE club_id = p_club_id AND status = 'open') THEN
    RAISE EXCEPTION 'an open settlement period already exists for this club';
  END IF;

  INSERT INTO settlement_periods
    (club_id, status, start_at, year, period_number, created_at, updated_at)
  VALUES
    (p_club_id, 'open', now(), EXTRACT(YEAR FROM now())::int,
     COALESCE((SELECT max(period_number) FROM settlement_periods WHERE club_id = p_club_id), 0) + 1,
     now(), now())
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$function$;
ALTER FUNCTION public.fn_open_settlement_period(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_open_settlement_period(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_open_settlement_period(uuid) TO authenticated,service_role;
DO $guard$ BEGIN IF to_regprocedure('public.fn_set_settlement_period_status(uuid,text)') IS NOT NULL THEN RAISE EXCEPTION 'browser observer baseline already defines fn_set_settlement_period_status(uuid,text)';END IF;END$guard$;
CREATE OR REPLACE FUNCTION public.fn_set_settlement_period_status(p_period_id uuid, p_status text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_club uuid;
  v_union uuid;
  v_caller uuid := (SELECT auth.uid());
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'authentication required'); END IF;
  IF p_status NOT IN ('open','processing','settled','disputed') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid status'); END IF;

  SELECT club_id, union_id INTO v_club, v_union FROM settlement_periods WHERE id = p_period_id;
  IF v_club IS NULL AND v_union IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'period not found'); END IF;

  IF NOT (
    (v_club IS NOT NULL AND EXISTS (
      SELECT 1 FROM clubs c WHERE c.id = v_club AND (
        c.owner_id = v_caller
        OR EXISTS (SELECT 1 FROM club_members cm WHERE cm.club_id = v_club
                   AND cm.user_id = v_caller AND cm.role IN ('owner','co_owner','admin')))))
    OR (v_union IS NOT NULL AND EXISTS (
      SELECT 1 FROM unions u WHERE u.id = v_union AND u.owner_id = v_caller))
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'not authorized'); END IF;

  UPDATE settlement_periods SET
    status = p_status,
    end_at = CASE WHEN p_status IN ('processing','settled') THEN COALESCE(end_at, now()) ELSE end_at END,
    settled_at = CASE WHEN p_status = 'settled' THEN now() ELSE settled_at END,
    settled_by = CASE WHEN p_status = 'settled' THEN v_caller ELSE settled_by END,
    updated_at = now()
  WHERE id = p_period_id;

  RETURN jsonb_build_object('success', true, 'period_id', p_period_id, 'status', p_status);
END;
$function$;
ALTER FUNCTION public.fn_set_settlement_period_status(uuid,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_set_settlement_period_status(uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fn_set_settlement_period_status(uuid,text) TO authenticated,service_role;
DO $guard$ BEGIN IF to_regprocedure('public.get_current_settlement_period()') IS NOT NULL THEN RAISE EXCEPTION 'browser observer baseline already defines get_current_settlement_period()';END IF;END$guard$;
CREATE OR REPLACE FUNCTION public.get_current_settlement_period()
 RETURNS TABLE(id uuid, period_start timestamp with time zone, period_end timestamp with time zone, status text, total_rake numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_now timestamptz := now();
  v_start timestamptz;
  v_end timestamptz;
  v_union uuid;
  v_union_count int;
BEGIN
  -- Existing open period wins.
  RETURN QUERY SELECT sp.id, sp.start_at, sp.end_at, sp.status::text,
                      COALESCE(sp.total_rake_collected, 0)
    FROM settlement_periods sp WHERE sp.status = 'open'
   ORDER BY sp.start_at DESC LIMIT 1;
  IF FOUND THEN RETURN; END IF;

  -- None open: create one, WITH AN OWNER. A period belonging to nobody can
  -- never be settled and poisons the lookup above for everybody.
  SELECT count(*) INTO v_union_count FROM unions;
  IF v_union_count <> 1 THEN
    RETURN;  -- no single obvious owner; create nothing rather than guess
  END IF;
  SELECT u.id INTO v_union FROM unions u LIMIT 1;

  /* THE UNION'S OWN WEEK (2026-09-09). This was a Sunday-to-Sunday UTC
     week; the settlement runs on fn_union_week_start, Monday midnight
     Pacific, and refuses any other boundary with
     period_not_closed_union_weeks. A period minted on the wrong boundary
     can never be settled and blocks the lookup above for everybody. */
  v_start := public.fn_union_week_start(v_now);
  v_end := v_start + interval '7 days';
  INSERT INTO settlement_periods (id, union_id, start_at, end_at, status,
                                  total_rake_collected, period_number, year)
  VALUES (gen_random_uuid(), v_union, v_start, v_end, 'open', 0,
          EXTRACT(week FROM v_start)::int, EXTRACT(isoyear FROM v_start)::int)
  ON CONFLICT DO NOTHING;

  -- Re-select (works whether our insert won or a concurrent one did).
  RETURN QUERY SELECT sp.id, sp.start_at, sp.end_at, sp.status::text,
                      COALESCE(sp.total_rake_collected, 0)
    FROM settlement_periods sp WHERE sp.status = 'open'
   ORDER BY sp.start_at DESC LIMIT 1;
END;
$function$;
ALTER FUNCTION public.get_current_settlement_period() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_current_settlement_period() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_current_settlement_period() TO authenticated,service_role;
DO $guard$ BEGIN IF to_regprocedure('public.get_current_settlement_period(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'browser observer baseline already defines get_current_settlement_period(uuid)';END IF;END$guard$;
CREATE OR REPLACE FUNCTION public.get_current_settlement_period(p_club_id uuid)
 RETURNS TABLE(id uuid, club_id uuid, union_id uuid, scope text, period_number integer, year integer, period_start timestamp with time zone, period_end timestamp with time zone, status text, total_rake numeric, total_bbj numeric, total_player_winnings numeric, total_player_losses numeric, total_hands_dealt bigint, settled_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_union uuid;
BEGIN
  IF p_club_id IS NULL THEN
    RETURN;
  END IF;
  -- Any member may see which period their club is in; the money inside it is
  -- gated by the reads that return it, not by this lookup.
  IF NOT public.ca_can_view_club(p_club_id) THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  SELECT c.union_id INTO v_union FROM clubs c WHERE c.id = p_club_id;

  RETURN QUERY
  WITH candidates AS (
    SELECT sp.*,
           CASE
             WHEN sp.club_id = p_club_id AND sp.status = 'open'                   THEN 1
             WHEN sp.club_id = p_club_id AND sp.status IN ('processing','disputed') THEN 2
             WHEN sp.club_id IS NULL AND v_union IS NOT NULL
                  AND sp.union_id = v_union AND sp.status = 'open'                THEN 3
             WHEN sp.club_id = p_club_id                                          THEN 4
           END AS rank
      FROM settlement_periods sp
     WHERE sp.club_id = p_club_id
        OR (sp.club_id IS NULL AND v_union IS NOT NULL AND sp.union_id = v_union
            AND sp.status = 'open')
  )
  SELECT c.id, c.club_id, c.union_id,
         CASE WHEN c.club_id = p_club_id THEN 'club' ELSE 'union' END,
         c.period_number, c.year, c.start_at, c.end_at, c.status::text,
         COALESCE(c.total_rake_collected, 0),
         COALESCE(c.total_bbj_contributions, 0),
         COALESCE(c.total_player_winnings, 0),
         COALESCE(c.total_player_losses, 0),
         COALESCE(c.total_hands_dealt, 0)::bigint,
         c.settled_at
    FROM candidates c
   WHERE c.rank IS NOT NULL
   ORDER BY c.rank, c.start_at DESC
   LIMIT 1;
END;
$function$;
ALTER FUNCTION public.get_current_settlement_period(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_current_settlement_period(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_current_settlement_period(uuid) TO authenticated,service_role;
DO $guard$ BEGIN IF to_regprocedure('public.ca_can_view_club(uuid)') IS NOT NULL THEN RAISE EXCEPTION 'browser observer baseline already defines ca_can_view_club(uuid)';END IF;END$guard$;
CREATE OR REPLACE FUNCTION public.ca_can_view_club(p_club_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    session_user IN ('postgres', 'supabase_admin')
    OR coalesce(auth.role(), '') = 'service_role'
    OR (
      auth.uid() IS NOT NULL
      AND (
        EXISTS (
          SELECT 1 FROM club_members cm
          WHERE cm.club_id = p_club_id
            AND cm.user_id = auth.uid()
            AND coalesce(cm.status, 'active') NOT IN ('banned', 'suspended')
        )
        OR EXISTS (
          SELECT 1 FROM clubs c WHERE c.id = p_club_id AND c.owner_id = auth.uid()
        )
        OR EXISTS (
          SELECT 1 FROM profiles pr
          WHERE pr.id = auth.uid() AND coalesce(pr.is_admin, false)
        )
      )
    );
$function$;
ALTER FUNCTION public.ca_can_view_club(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ca_can_view_club(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ca_can_view_club(uuid) TO authenticated,service_role;
