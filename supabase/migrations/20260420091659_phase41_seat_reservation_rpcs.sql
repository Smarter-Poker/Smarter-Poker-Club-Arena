-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260420091659 "phase41_seat_reservation_rpcs"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 be94a00ba2ddd13e136a82bef37690a2 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Phase 41 Part G: business-logic RPCs for the seat-reservation flow.
-- All SECURITY DEFINER with explicit authz. Error codes are uppercase SNAKE_CASE
-- matching existing convention (GAME_CANCELLED, RSVPS_CLOSED, etc.).

-- ============================================================================
-- Helper: resolve caller's display name for auto-generated guest names (#3)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.fn_hg_caller_display_name(p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(
    NULLIF(trim(p.display_name), ''),
    NULLIF(trim(p.full_name),    ''),
    NULLIF(trim(p.username),     ''),
    'Player'
  )
  FROM public.profiles p
  WHERE p.id = p_user_id
  LIMIT 1
$$;

-- ============================================================================
-- RPC: list tables + reservations for a game (one call, JSON-shaped for UI)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.rpc_hg_list_tables_and_reservations(
  p_game_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_group_id uuid;
  v_is_member boolean;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  SELECT group_id INTO v_group_id FROM public.commander_home_games WHERE id = p_game_id;
  IF v_group_id IS NULL THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.commander_home_members
     WHERE group_id = v_group_id AND user_id = auth.uid() AND status = 'approved'
  ) OR EXISTS (
    SELECT 1 FROM public.commander_home_groups
     WHERE id = v_group_id AND owner_id = auth.uid()
  ) OR EXISTS (
    SELECT 1 FROM public.commander_home_group_follows
     WHERE group_id = v_group_id AND user_id = auth.uid()
  ) INTO v_is_member;

  IF NOT v_is_member THEN RAISE EXCEPTION 'NOT_A_MEMBER'; END IF;

  SELECT jsonb_build_object(
    'game_id', p_game_id,
    'tables', COALESCE(jsonb_agg(
      jsonb_build_object(
        'id', t.id,
        'table_number', t.table_number,
        'name', t.name,
        'game_type', t.game_type,
        'stakes', t.stakes,
        'format', t.format,
        'buyin_min', t.buyin_min,
        'buyin_max', t.buyin_max,
        'max_seats', t.max_seats,
        'status', t.status,
        'is_default', t.is_default,
        'started_at', t.started_at,
        'ended_at', t.ended_at,
        'reservations', (
          SELECT COALESCE(jsonb_agg(
            jsonb_build_object(
              'id', r.id,
              'seat_number', r.seat_number,
              'user_id', r.user_id,
              'member_id', r.member_id,
              'is_guest', r.is_guest,
              'guest_name', r.guest_name,
              'status', r.status,
              'claimed_by_user_id', r.claimed_by_user_id,
              'claimed_at', r.claimed_at,
              'display_name', COALESCE(
                r.guest_name,
                public.fn_hg_caller_display_name(r.user_id),
                'Player'
              ),
              'is_self', (r.user_id = auth.uid() OR r.claimed_by_user_id = auth.uid())
            ) ORDER BY r.seat_number
          ), '[]'::jsonb)
          FROM public.commander_home_seat_reservations r
          WHERE r.table_id = t.id AND r.status IN ('reserved','seated')
        )
      ) ORDER BY t.table_number
    ), '[]'::jsonb)
  ) INTO v_result
  FROM public.commander_home_game_tables t
  WHERE t.game_id = p_game_id;

  RETURN v_result;
END $$;

GRANT EXECUTE ON FUNCTION public.rpc_hg_list_tables_and_reservations(uuid) TO authenticated;

-- ============================================================================
-- RPC: player self-claim a seat (or their own guest seat)
-- Dan's spec #2 (every RSVP is a seat claim) + #3 (one guest, auto-named)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.rpc_hg_claim_seat(
  p_table_id    uuid,
  p_seat_number int,
  p_is_guest    boolean DEFAULT false
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id    uuid := auth.uid();
  v_table      RECORD;
  v_group_id   uuid;
  v_reservation_id uuid;
  v_guest_name text;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  SELECT t.id, t.game_id, t.status, t.max_seats, g.group_id
    INTO v_table
    FROM public.commander_home_game_tables t
    JOIN public.commander_home_games g ON g.id = t.game_id
   WHERE t.id = p_table_id;
  IF v_table.id IS NULL THEN RAISE EXCEPTION 'TABLE_NOT_FOUND'; END IF;
  IF v_table.status <> 'open_for_rsvp' THEN
    RAISE EXCEPTION 'TABLE_NOT_OPEN' USING HINT = v_table.status;
  END IF;
  IF p_seat_number < 1 OR p_seat_number > v_table.max_seats THEN
    RAISE EXCEPTION 'SEAT_OUT_OF_BOUNDS';
  END IF;

  v_group_id := v_table.group_id;

  -- Caller must be approved member of the group
  IF NOT EXISTS (
    SELECT 1 FROM public.commander_home_members
     WHERE group_id = v_group_id AND user_id = v_user_id AND status = 'approved'
  ) AND NOT EXISTS (
    SELECT 1 FROM public.commander_home_groups
     WHERE id = v_group_id AND owner_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'NOT_A_MEMBER';
  END IF;

  IF p_is_guest THEN
    -- Dan's #3: auto-name as "{caller} + Guest", DB partial-unique prevents 2nd guest
    v_guest_name := public.fn_hg_caller_display_name(v_user_id) || ' + Guest';
    INSERT INTO public.commander_home_seat_reservations
      (table_id, seat_number, user_id, guest_name, is_guest, claimed_by_user_id, status)
    VALUES (p_table_id, p_seat_number, NULL, v_guest_name, true, v_user_id, 'reserved')
    RETURNING id INTO v_reservation_id;
  ELSE
    INSERT INTO public.commander_home_seat_reservations
      (table_id, seat_number, user_id, is_guest, claimed_by_user_id, status)
    VALUES (p_table_id, p_seat_number, v_user_id, false, v_user_id, 'reserved')
    RETURNING id INTO v_reservation_id;

    -- Shadow-write to commander_home_rsvps for back-compat with existing
    -- counters (games_attended, flake tracking, check-in surfaces).
    INSERT INTO public.commander_home_rsvps
      (game_id, user_id, response, seat_number, is_confirmed, responded_at)
    VALUES (v_table.game_id, v_user_id, 'yes', p_seat_number, false, now())
    ON CONFLICT (game_id, user_id) DO UPDATE
      SET response = 'yes',
          seat_number = EXCLUDED.seat_number,
          responded_at = now(),
          updated_at = now();
  END IF;

  RETURN v_reservation_id;
END $$;

GRANT EXECUTE ON FUNCTION public.rpc_hg_claim_seat(uuid, int, boolean) TO authenticated;

-- ============================================================================
-- RPC: release own seat (or own guest seat)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.rpc_hg_release_seat(
  p_reservation_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_res     RECORD;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  SELECT r.*, t.game_id
    INTO v_res
    FROM public.commander_home_seat_reservations r
    JOIN public.commander_home_game_tables t ON t.id = r.table_id
   WHERE r.id = p_reservation_id;
  IF v_res.id IS NULL THEN RAISE EXCEPTION 'RESERVATION_NOT_FOUND'; END IF;

  -- Caller must own the reservation (self or claimant for a guest)
  IF v_res.user_id <> v_user_id AND v_res.claimed_by_user_id <> v_user_id THEN
    RAISE EXCEPTION 'NOT_YOUR_RESERVATION';
  END IF;

  IF v_res.status NOT IN ('reserved','seated') THEN
    RAISE EXCEPTION 'RESERVATION_ALREADY_INACTIVE' USING HINT = v_res.status;
  END IF;

  UPDATE public.commander_home_seat_reservations
     SET status = 'released', released_at = now()
   WHERE id = p_reservation_id;

  -- Shadow: if this was the user's own (non-guest) seat, flip rsvp to 'no'.
  IF v_res.is_guest = false AND v_res.user_id IS NOT NULL THEN
    UPDATE public.commander_home_rsvps
       SET response = 'no', seat_number = NULL, updated_at = now()
     WHERE game_id = v_res.game_id AND user_id = v_res.user_id;
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION public.rpc_hg_release_seat(uuid) TO authenticated;

-- ============================================================================
-- RPC: change seat (atomic release-then-claim to avoid double-booking race)
-- Dan's spec #4 — players can request seat change live
-- ============================================================================
CREATE OR REPLACE FUNCTION public.rpc_hg_change_seat(
  p_reservation_id uuid,
  p_new_seat_number int
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_res     RECORD;
  v_table   RECORD;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  SELECT r.*, t.max_seats, t.status AS table_status, t.game_id AS game_id
    INTO v_res
    FROM public.commander_home_seat_reservations r
    JOIN public.commander_home_game_tables t ON t.id = r.table_id
   WHERE r.id = p_reservation_id;
  IF v_res.id IS NULL THEN RAISE EXCEPTION 'RESERVATION_NOT_FOUND'; END IF;
  IF v_res.user_id <> v_user_id AND v_res.claimed_by_user_id <> v_user_id THEN
    RAISE EXCEPTION 'NOT_YOUR_RESERVATION';
  END IF;
  IF v_res.status NOT IN ('reserved','seated') THEN
    RAISE EXCEPTION 'RESERVATION_INACTIVE';
  END IF;
  IF p_new_seat_number < 1 OR p_new_seat_number > v_res.max_seats THEN
    RAISE EXCEPTION 'SEAT_OUT_OF_BOUNDS';
  END IF;
  IF p_new_seat_number = v_res.seat_number THEN
    RETURN p_reservation_id; -- no-op
  END IF;

  -- Atomic move: UPDATE will fail on unique-violation if target seat taken.
  UPDATE public.commander_home_seat_reservations
     SET seat_number = p_new_seat_number, updated_at = now()
   WHERE id = p_reservation_id;

  -- Shadow update
  IF v_res.is_guest = false AND v_res.user_id IS NOT NULL THEN
    UPDATE public.commander_home_rsvps
       SET seat_number = p_new_seat_number, updated_at = now()
     WHERE game_id = v_res.game_id AND user_id = v_res.user_id;
  END IF;

  RETURN p_reservation_id;
END $$;

GRANT EXECUTE ON FUNCTION public.rpc_hg_change_seat(uuid, int) TO authenticated;

-- ============================================================================
-- RPC: host creates a non-user roster member (Dan's #7 "save to list once")
-- ============================================================================
CREATE OR REPLACE FUNCTION public.rpc_hg_host_add_roster_member(
  p_group_id     uuid,
  p_display_name text,
  p_phone        text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_member_id uuid;
  v_clean_name text;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  v_clean_name := NULLIF(trim(p_display_name), '');
  IF v_clean_name IS NULL OR char_length(v_clean_name) > 120 THEN
    RAISE EXCEPTION 'DISPLAY_NAME_INVALID';
  END IF;

  IF NOT public.fn_home_is_group_staff(v_user_id, p_group_id)
     AND NOT EXISTS (SELECT 1 FROM public.commander_home_groups
                      WHERE id = p_group_id AND owner_id = v_user_id)
  THEN
    RAISE EXCEPTION 'NOT_GROUP_STAFF';
  END IF;

  -- De-dupe by name within the group's roster (idempotent add)
  SELECT id INTO v_member_id
    FROM public.commander_home_members
   WHERE group_id = p_group_id
     AND is_roster_only = true
     AND lower(display_name) = lower(v_clean_name)
   LIMIT 1;

  IF v_member_id IS NOT NULL THEN
    -- Update phone if newly provided
    IF p_phone IS NOT NULL THEN
      UPDATE public.commander_home_members SET phone = p_phone WHERE id = v_member_id;
    END IF;
    RETURN v_member_id;
  END IF;

  INSERT INTO public.commander_home_members
    (group_id, user_id, display_name, phone, role, status,
     is_roster_only, added_by_user_id, joined_at)
  VALUES
    (p_group_id, NULL, v_clean_name, p_phone, 'member', 'approved',
     true, v_user_id, now())
  RETURNING id INTO v_member_id;

  RETURN v_member_id;
END $$;

GRANT EXECUTE ON FUNCTION public.rpc_hg_host_add_roster_member(uuid, text, text) TO authenticated;

-- ============================================================================
-- RPC: host claims a seat on behalf of a member (user or roster-only)
-- Dan's spec #7 — "host so can manually reserve and add members"
-- ============================================================================
CREATE OR REPLACE FUNCTION public.rpc_hg_host_claim_for_member(
  p_table_id    uuid,
  p_seat_number int,
  p_member_id   uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_table   RECORD;
  v_member  RECORD;
  v_reservation_id uuid;
  v_name_for_guest text;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  SELECT t.id, t.game_id, t.status, t.max_seats, g.group_id
    INTO v_table
    FROM public.commander_home_game_tables t
    JOIN public.commander_home_games g ON g.id = t.game_id
   WHERE t.id = p_table_id;
  IF v_table.id IS NULL THEN RAISE EXCEPTION 'TABLE_NOT_FOUND'; END IF;
  IF v_table.status NOT IN ('open_for_rsvp','running') THEN
    RAISE EXCEPTION 'TABLE_NOT_CLAIMABLE';
  END IF;
  IF p_seat_number < 1 OR p_seat_number > v_table.max_seats THEN
    RAISE EXCEPTION 'SEAT_OUT_OF_BOUNDS';
  END IF;

  IF NOT public.fn_home_is_group_staff(v_user_id, v_table.group_id)
     AND NOT EXISTS (SELECT 1 FROM public.commander_home_groups
                      WHERE id = v_table.group_id AND owner_id = v_user_id)
  THEN
    RAISE EXCEPTION 'NOT_GROUP_STAFF';
  END IF;

  SELECT id, group_id, user_id, display_name, is_roster_only
    INTO v_member
    FROM public.commander_home_members
   WHERE id = p_member_id;
  IF v_member.id IS NULL THEN RAISE EXCEPTION 'MEMBER_NOT_FOUND'; END IF;
  IF v_member.group_id <> v_table.group_id THEN
    RAISE EXCEPTION 'MEMBER_WRONG_GROUP';
  END IF;

  IF v_member.is_roster_only THEN
    -- Roster-only: store display_name as guest_name, no user_id
    v_name_for_guest := v_member.display_name;
    INSERT INTO public.commander_home_seat_reservations
      (table_id, seat_number, user_id, member_id, guest_name,
       is_guest, claimed_by_user_id, status)
    VALUES (p_table_id, p_seat_number, NULL, p_member_id, v_name_for_guest,
            false, v_user_id, 'reserved')
    RETURNING id INTO v_reservation_id;
  ELSE
    INSERT INTO public.commander_home_seat_reservations
      (table_id, seat_number, user_id, member_id,
       is_guest, claimed_by_user_id, status)
    VALUES (p_table_id, p_seat_number, v_member.user_id, p_member_id,
            false, v_user_id, 'reserved')
    RETURNING id INTO v_reservation_id;

    INSERT INTO public.commander_home_rsvps
      (game_id, user_id, response, seat_number, is_confirmed, responded_at)
    VALUES (v_table.game_id, v_member.user_id, 'yes', p_seat_number, true, now())
    ON CONFLICT (game_id, user_id) DO UPDATE
      SET response = 'yes', seat_number = EXCLUDED.seat_number,
          is_confirmed = true, responded_at = now(), updated_at = now();
  END IF;

  RETURN v_reservation_id;
END $$;

GRANT EXECUTE ON FUNCTION public.rpc_hg_host_claim_for_member(uuid, int, uuid) TO authenticated;

-- ============================================================================
-- RPC: host creates an additional table (Dan's #5 — Commander-only surface)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.rpc_hg_create_table(
  p_game_id     uuid,
  p_game_type   text,
  p_stakes      text,
  p_format      text DEFAULT 'cash',
  p_buyin_min   integer DEFAULT NULL,
  p_buyin_max   integer DEFAULT NULL,
  p_max_seats   integer DEFAULT 9,
  p_name        text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_game    RECORD;
  v_next    int;
  v_id      uuid;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  SELECT id, group_id, host_id, cancelled_at, scheduled_date, start_time, status
    INTO v_game
    FROM public.commander_home_games
   WHERE id = p_game_id;
  IF v_game.id IS NULL THEN RAISE EXCEPTION 'GAME_NOT_FOUND'; END IF;
  IF v_game.cancelled_at IS NOT NULL THEN RAISE EXCEPTION 'GAME_CANCELLED'; END IF;

  IF NOT public.fn_home_is_group_staff(v_user_id, v_game.group_id)
     AND v_game.host_id <> v_user_id
     AND NOT EXISTS (SELECT 1 FROM public.commander_home_groups
                      WHERE id = v_game.group_id AND owner_id = v_user_id)
  THEN
    RAISE EXCEPTION 'NOT_GROUP_STAFF';
  END IF;

  IF p_max_seats IS NULL OR p_max_seats < 2 OR p_max_seats > 10 THEN
    RAISE EXCEPTION 'MAX_SEATS_OUT_OF_BOUNDS';
  END IF;

  SELECT COALESCE(MAX(table_number), 0) + 1 INTO v_next
    FROM public.commander_home_game_tables WHERE game_id = p_game_id;

  INSERT INTO public.commander_home_game_tables
    (game_id, table_number, name, game_type, stakes, format,
     buyin_min, buyin_max, max_seats, status, is_default, created_by)
  VALUES
    (p_game_id, v_next, NULLIF(trim(p_name),''),
     COALESCE(NULLIF(trim(p_game_type),''),'NLH'),
     NULLIF(trim(p_stakes),''),
     CASE WHEN p_format IN ('cash','tournament','sitngo','mixed') THEN p_format ELSE 'cash' END,
     p_buyin_min, p_buyin_max, p_max_seats,
     'open_for_rsvp', false, v_user_id)
  RETURNING id INTO v_id;

  RETURN v_id;
END $$;

GRANT EXECUTE ON FUNCTION public.rpc_hg_create_table(uuid, text, text, text, integer, integer, integer, text) TO authenticated;

-- ============================================================================
-- RPC: host starts a table (flips open_for_rsvp -> running)
-- Dan's spec #6 — start_time is the cutoff, after which Commander owns seating
-- ============================================================================
CREATE OR REPLACE FUNCTION public.rpc_hg_start_table(
  p_table_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_table   RECORD;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  SELECT t.id, t.status, t.game_id, g.group_id, g.host_id
    INTO v_table
    FROM public.commander_home_game_tables t
    JOIN public.commander_home_games g ON g.id = t.game_id
   WHERE t.id = p_table_id;
  IF v_table.id IS NULL THEN RAISE EXCEPTION 'TABLE_NOT_FOUND'; END IF;

  IF NOT public.fn_home_is_group_staff(v_user_id, v_table.group_id)
     AND v_table.host_id <> v_user_id
     AND NOT EXISTS (SELECT 1 FROM public.commander_home_groups
                      WHERE id = v_table.group_id AND owner_id = v_user_id)
  THEN
    RAISE EXCEPTION 'NOT_GROUP_STAFF';
  END IF;

  IF v_table.status <> 'open_for_rsvp' THEN
    RAISE EXCEPTION 'TABLE_NOT_IN_OPEN_STATE' USING HINT = v_table.status;
  END IF;

  UPDATE public.commander_home_game_tables
     SET status = 'running', started_at = now()
   WHERE id = p_table_id;

  -- Materialize the live-seating rows in commander_home_seats so the
  -- existing tablet display code can render them.
  INSERT INTO public.commander_home_seats
    (game_id, table_id, seat_number, user_id, player_name,
     status, seated_at, reservation_id)
  SELECT
    v_table.game_id,
    r.table_id,
    r.seat_number,
    r.user_id,
    COALESCE(r.guest_name, public.fn_hg_caller_display_name(r.user_id), 'Player'),
    'seated',
    now(),
    r.id
  FROM public.commander_home_seat_reservations r
  WHERE r.table_id = p_table_id AND r.status = 'reserved';

  UPDATE public.commander_home_seat_reservations
     SET status = 'seated', seated_at = now()
   WHERE table_id = p_table_id AND status = 'reserved';
END $$;

GRANT EXECUTE ON FUNCTION public.rpc_hg_start_table(uuid) TO authenticated;

-- ============================================================================
-- RPC: list the group's roster (users + roster-only) for the "seat a member" UI
-- ============================================================================
CREATE OR REPLACE FUNCTION public.rpc_hg_list_roster(
  p_group_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_result  jsonb;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  IF NOT public.fn_home_is_group_staff(v_user_id, p_group_id)
     AND NOT EXISTS (SELECT 1 FROM public.commander_home_groups
                      WHERE id = p_group_id AND owner_id = v_user_id)
  THEN
    RAISE EXCEPTION 'NOT_GROUP_STAFF';
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id', m.id,
      'user_id', m.user_id,
      'is_roster_only', m.is_roster_only,
      'display_name', COALESCE(
        m.display_name,
        public.fn_hg_caller_display_name(m.user_id),
        'Member'
      ),
      'phone', m.phone,
      'games_attended', m.games_attended,
      'last_attended', m.last_attended
    ) ORDER BY
      -- roster-only first? no — users first (most commonly seated), then roster by name
      CASE WHEN m.is_roster_only THEN 1 ELSE 0 END,
      COALESCE(m.display_name, public.fn_hg_caller_display_name(m.user_id), 'Member')
  ), '[]'::jsonb) INTO v_result
  FROM public.commander_home_members m
  WHERE m.group_id = p_group_id AND m.status = 'approved';

  RETURN v_result;
END $$;

GRANT EXECUTE ON FUNCTION public.rpc_hg_list_roster(uuid) TO authenticated;
