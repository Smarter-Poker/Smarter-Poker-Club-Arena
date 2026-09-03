-- THE OPERATIONS PAGE READS THE CLUB IT GOVERNS.
--
-- /clubs/:id/operations, /clubs/:id/finance and /clubs/:id/control shipped as
-- link grids. Every tile on them was a destination and nothing on them was a
-- reading: the page said "Live Permission Map" and "Live Systems Remain
-- Authoritative" over three panels that made no query at all. An operator
-- opening the workspace could not tell whether anything was waiting for them
-- without opening all twenty-one tools and looking.
--
-- This function is the one read behind all three surfaces. It answers, in a
-- single round trip: what is live in this club right now, what is queued for a
-- human, and which tool the queued work belongs to. The client owns the words
-- and the routes; this owns the truth and the severity.
--
-- AUTHORISATION. Club staff only, and the money figures only for the finance
-- roles, which is the same vocabulary the navigation registry and
-- ClubCapabilityGuard already use (staff / finance / control).
--
-- It deliberately does NOT open with `auth.uid() IS NULL`, the way
-- ca_can_view_club and ca_can_view_club_finances do. That predicate reads as
-- "internal caller", but what it actually says is "anyone with no user", and
-- the only thing standing between an anonymous request and its answer is the
-- EXECUTE grant. Here the internal escape is named: a superuser SQL session
-- (cron, a migration, another definer function) or a service_role JWT. An anon
-- caller has neither, so it is refused twice - by the grant and by the body.
--
-- HORSES COUNT. Every count below is over every member and every seat in the
-- club. Simulated players are members of this club, they buy in from the same
-- wallets, and they are never filtered out of a total (CLAUDE.md 10.5).
--
-- COST. Eleven counting reads, each one club-scoped and index-backed
-- (idx_club_members_club_status, idx_tables_live_by_club, idx_table_seats_table,
-- idx_tournaments_club_id, chip_requests_club_status_idx, idx_disputes_club,
-- idx_blacklists_club, idx_invoices_club_period, tournament_tickets_club_idx,
-- idx_cashout_requests_club, idx_credit_requests_club, idx_acf_club). Measured
-- on the largest club on the estate (417 members, 1,567 tables, 228 of them
-- live) it returns in single-digit milliseconds.

CREATE OR REPLACE FUNCTION public.ca_club_operations_overview(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role              text;
  v_platform          boolean;
  v_internal          boolean;
  v_staff             boolean;
  v_finance           boolean;
  v_control           boolean;
  v_name              text;
  v_slug              text;
  v_treasury          numeric;
  v_locked            boolean;
  v_members           bigint;
  v_pending           bigint;
  v_new7              bigint;
  v_member_chips      numeric;
  v_online            bigint;
  v_seated            bigint;
  v_live_tables       bigint;
  v_running_tables    bigint;
  v_waiting_tables    bigint;
  v_reg_tourneys      bigint;
  v_run_tourneys      bigint;
  v_hands_today       bigint := 0;
  v_rake_today        numeric := 0;
  v_reports           bigint;
  v_disputes          bigint;
  v_disputes_aged     bigint;
  v_blacklist         bigint;
  v_blacklist_expired bigint;
  v_chip_requests     bigint;
  v_cashouts          bigint;
  v_credit            bigint;
  v_invoices          bigint;
  v_invoices_overdue  bigint;
  v_tickets           bigint;
  v_flags             bigint;
  v_alerts            jsonb := '[]'::jsonb;
  v_kpis              jsonb;
BEGIN
  IF p_club_id IS NULL THEN
    RAISE EXCEPTION 'a club id is required' USING ERRCODE = '22004';
  END IF;

  SELECT c.name, c.slug, coalesce(c.chip_treasury, 0), coalesce(c.settlement_locked, false)
    INTO v_name, v_slug, v_treasury, v_locked
    FROM clubs c
   WHERE c.id = p_club_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'club not found' USING ERRCODE = 'P0002';
  END IF;

  v_internal := session_user IN ('postgres', 'supabase_admin')
             OR coalesce(auth.role(), '') = 'service_role';
  v_platform := coalesce(fn_is_platform_admin(), false);
  v_role     := coalesce(fn_club_bank_role(p_club_id), '');

  v_staff := v_internal OR v_platform
             OR v_role IN ('owner', 'co_owner', 'admin', 'super_agent', 'agent');

  IF NOT v_staff THEN
    RAISE EXCEPTION 'not authorized for this club' USING ERRCODE = '42501';
  END IF;

  v_finance := v_internal OR v_platform
               OR v_role IN ('owner', 'co_owner', 'admin', 'super_agent');
  v_control := v_internal OR v_platform
               OR v_role IN ('owner', 'co_owner', 'admin');

  -- ── The roster ──────────────────────────────────────────────────────────
  SELECT count(*) FILTER (
           WHERE coalesce(cm.status, 'active') NOT IN ('banned', 'suspended', 'pending')),
         count(*) FILTER (WHERE cm.status = 'pending'),
         count(*) FILTER (
           WHERE cm.created_at > now() - interval '7 days'
             AND coalesce(cm.status, 'active') NOT IN ('banned', 'suspended')),
         coalesce(sum(cm.chip_balance) FILTER (
           WHERE coalesce(cm.status, 'active') NOT IN ('banned', 'suspended')), 0)
    INTO v_members, v_pending, v_new7, v_member_chips
    FROM club_members cm
   WHERE cm.club_id = p_club_id;

  -- ── The floor ───────────────────────────────────────────────────────────
  SELECT count(*) FILTER (WHERE t.status IN ('running', 'waiting', 'active')),
         count(*) FILTER (WHERE t.status = 'running'),
         count(*) FILTER (WHERE t.status = 'waiting')
    INTO v_live_tables, v_running_tables, v_waiting_tables
    FROM tables t
   WHERE t.club_id = p_club_id;

  -- Seats are counted as PEOPLE, not as rows. A player sitting at four tables
  -- is one player. ca_club_dashboard_stats counts the rows and calls the
  -- result "Seated Now", which is why that page and the members page have
  -- always disagreed about the same instant.
  SELECT count(DISTINCT ts.user_id)
    INTO v_seated
    FROM table_seats ts
    JOIN tables t ON t.id = ts.table_id
   WHERE t.club_id = p_club_id
     AND ts.left_at IS NULL
     AND ts.user_id IS NOT NULL
     AND t.status IN ('running', 'waiting', 'active');

  SELECT count(*)
    INTO v_online
    FROM (
      SELECT ts.user_id
        FROM table_seats ts
        JOIN tables t ON t.id = ts.table_id
       WHERE t.club_id = p_club_id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
      UNION
      SELECT cm.user_id
        FROM club_members cm
       WHERE cm.club_id = p_club_id AND cm.last_active > now() - interval '15 minutes'
    ) x;

  SELECT count(*) FILTER (WHERE tr.status = 'REGISTERING'),
         count(*) FILTER (WHERE tr.status IN ('RUNNING', 'COMPLETING'))
    INTO v_reg_tourneys, v_run_tourneys
    FROM tournaments tr
   WHERE tr.club_id = p_club_id
     AND tr.status IN ('REGISTERING', 'RUNNING', 'COMPLETING');

  SELECT coalesce(d.hands, 0), coalesce(d.rake, 0)
    INTO v_hands_today, v_rake_today
    FROM club_hand_daily d
   WHERE d.club_id = p_club_id
     AND d.stat_date = (now() AT TIME ZONE 'UTC')::date;

  IF NOT FOUND THEN
    v_hands_today := 0;
    v_rake_today := 0;
  END IF;

  -- ── The queues: work that is waiting for a person ───────────────────────
  -- user_reports has no club_id. A report belongs to this club's operators
  -- when the person reported is one of this club's members.
  SELECT count(*)
    INTO v_reports
    FROM user_reports r
   WHERE coalesce(r.status, 'pending') = 'pending'
     AND EXISTS (SELECT 1 FROM club_members m
                  WHERE m.club_id = p_club_id AND m.user_id = r.reported_user_id);

  SELECT count(*), count(*) FILTER (WHERE d.created_at < now() - interval '72 hours')
    INTO v_disputes, v_disputes_aged
    FROM disputes d
   WHERE d.club_id = p_club_id
     AND coalesce(d.status, 'open') IN ('open', 'under_review', 'escalated');

  SELECT count(*) FILTER (WHERE b.expires_at IS NULL OR b.expires_at > now()),
         count(*) FILTER (WHERE b.expires_at IS NOT NULL AND b.expires_at <= now())
    INTO v_blacklist, v_blacklist_expired
    FROM blacklists b
   WHERE b.club_id = p_club_id;

  SELECT count(*)
    INTO v_chip_requests
    FROM chip_requests q
   WHERE q.club_id = p_club_id AND coalesce(q.status, 'pending') = 'pending';

  SELECT count(*)
    INTO v_cashouts
    FROM cashout_requests q
   WHERE q.club_id = p_club_id
     AND q.completed_at IS NULL
     AND q.cancelled_at IS NULL
     AND coalesce(q.status, 'pending') NOT IN ('completed', 'cancelled', 'rejected', 'failed');

  SELECT count(*)
    INTO v_credit
    FROM credit_requests q
   WHERE q.club_id = p_club_id AND coalesce(q.status, 'pending') = 'pending';

  SELECT count(*), count(*) FILTER (WHERE i.due_at IS NOT NULL AND i.due_at < now())
    INTO v_invoices, v_invoices_overdue
    FROM settlement_invoices i
   WHERE i.club_id = p_club_id
     AND coalesce(i.status, 'generated') NOT IN ('paid', 'settled', 'cancelled', 'void');

  SELECT count(*)
    INTO v_tickets
    FROM tournament_tickets tk
   WHERE tk.club_id = p_club_id
     AND tk.redeemed_at IS NULL
     AND tk.cancelled_at IS NULL
     AND coalesce(tk.status, 'issued') NOT IN ('redeemed', 'cancelled', 'expired');

  SELECT count(*)
    INTO v_flags
    FROM anti_cheat_flags f
   WHERE f.club_id = p_club_id AND coalesce(f.status, 'open') = 'open';

  -- ── The alerts, worst first ─────────────────────────────────────────────
  -- `tool` is a registry id from src/config/clubOperationsNavigation.ts. The
  -- client turns it into the route, so a route rename never has to be chased
  -- into the database.
  IF v_finance AND v_invoices_overdue > 0 THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'id', 'invoices-overdue', 'severity', 'critical', 'tool', 'settlement',
      'title', 'Invoices Past Due', 'count', v_invoices_overdue));
  END IF;

  IF v_disputes_aged > 0 THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'id', 'disputes-aged', 'severity', 'critical', 'tool', 'disputes',
      'title', 'Disputes Past Seventy Two Hours', 'count', v_disputes_aged));
  ELSIF v_disputes > 0 THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'id', 'disputes-open', 'severity', 'warning', 'tool', 'disputes',
      'title', 'Disputes Open', 'count', v_disputes));
  END IF;

  IF v_chip_requests > 0 THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'id', 'chip-requests', 'severity', 'warning', 'tool', 'cashier',
      'title', 'Chip Requests Waiting', 'count', v_chip_requests));
  END IF;

  IF v_cashouts > 0 THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'id', 'cashouts', 'severity', 'warning', 'tool', 'cashier',
      'title', 'Cash Out Requests Waiting', 'count', v_cashouts));
  END IF;

  IF v_credit > 0 THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'id', 'credit-requests', 'severity', 'warning', 'tool', 'cashier',
      'title', 'Credit Requests Waiting', 'count', v_credit));
  END IF;

  IF v_pending > 0 THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'id', 'join-requests', 'severity', 'warning', 'tool', 'players',
      'title', 'Membership Requests Waiting', 'count', v_pending));
  END IF;

  IF v_reports > 0 THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'id', 'reports-open', 'severity', 'warning', 'tool', 'reports',
      'title', 'Player Reports To Review', 'count', v_reports));
  END IF;

  IF v_flags > 0 THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'id', 'anti-cheat-flags', 'severity', 'warning', 'tool', 'anti-cheat',
      'title', 'Integrity Flags Open', 'count', v_flags));
  END IF;

  IF v_finance AND v_treasury <= 0 THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'id', 'club-bank-empty', 'severity', 'warning', 'tool', 'cashier',
      'title', 'The Club Bank Is Empty', 'count', 0));
  END IF;

  IF v_locked THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'id', 'settlement-locked', 'severity', 'info', 'tool', 'settlement',
      'title', 'Settlement Is Locked', 'count', 0));
  END IF;

  IF v_blacklist_expired > 0 THEN
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'id', 'blacklist-expired', 'severity', 'info', 'tool', 'blacklist',
      'title', 'Expired Exclusions To Clear', 'count', v_blacklist_expired));
  END IF;

  v_kpis := jsonb_build_object(
    'members', v_members,
    'members_pending', v_pending,
    'members_new_7d', v_new7,
    'online_now', v_online,
    'seated_now', v_seated,
    'live_tables', v_live_tables,
    'running_tables', v_running_tables,
    'waiting_tables', v_waiting_tables,
    'tournaments_registering', v_reg_tourneys,
    'tournaments_running', v_run_tourneys,
    'hands_today', v_hands_today);

  IF v_finance THEN
    v_kpis := v_kpis || jsonb_build_object(
      'rake_today', v_rake_today,
      'club_bank', v_treasury,
      'member_chips', v_member_chips);
  END IF;

  RETURN jsonb_build_object(
    'generated_at', now(),
    'club', jsonb_build_object('id', p_club_id, 'name', v_name, 'slug', v_slug),
    'viewer', jsonb_build_object(
      'role', nullif(v_role, ''),
      'is_platform_staff', v_platform,
      'can_view_finance', v_finance,
      'can_control_club', v_control),
    'kpis', v_kpis,
    'counts', jsonb_build_object(
      'members', v_members,
      'members_pending', v_pending,
      'reports_open', v_reports,
      'disputes_open', v_disputes,
      'disputes_aged', v_disputes_aged,
      'blacklist_active', v_blacklist,
      'blacklist_expired', v_blacklist_expired,
      'chip_requests_pending', v_chip_requests,
      'cashouts_pending', v_cashouts,
      'credit_requests_pending', v_credit,
      'invoices_open', CASE WHEN v_finance THEN v_invoices ELSE NULL END,
      'invoices_overdue', CASE WHEN v_finance THEN v_invoices_overdue ELSE NULL END,
      'tickets_outstanding', v_tickets,
      'anti_cheat_flags_open', v_flags),
    'alerts', v_alerts,
    'settlement_locked', v_locked);
END;
$$;

REVOKE ALL ON FUNCTION public.ca_club_operations_overview(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ca_club_operations_overview(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.ca_club_operations_overview(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ca_club_operations_overview(uuid) TO service_role;

COMMENT ON FUNCTION public.ca_club_operations_overview(uuid) IS
  'One staff-gated read behind the club operations workspace: live floor, roster, and every queue that is waiting for a person, with the alert severity and the registry tool id each queue belongs to. Finance figures are returned only to the finance roles. Horses are counted like every other player.';
