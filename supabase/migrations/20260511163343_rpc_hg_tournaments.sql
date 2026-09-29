-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260511163343 "rpc_hg_tournaments"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 b7f968b34854af3cf623c637d10ea839 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- Tournament RPC suite for home-games.
-- Tournaments are commander_home_games rows with format='tournament'.
-- All RPCs are SECURITY DEFINER + auth.uid() gated + status-guarded per Phase 40.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────── CREATE ─────────────────────────
CREATE OR REPLACE FUNCTION public.rpc_hg_create_tournament(
  p_group_id       uuid,
  p_name           text,
  p_buy_in         integer,
  p_starting_stack integer,
  p_structure      text,
  p_scheduled_date date,
  p_scheduled_time time,
  p_entries_cap    integer DEFAULT NULL,
  p_description    text    DEFAULT NULL,
  p_address        text    DEFAULT NULL,
  p_address_visible_to text DEFAULT 'rsvp'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller     uuid := auth.uid();
  v_clean_name text;
  v_game_id    uuid;
  v_group_status text;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  -- Name validation
  v_clean_name := NULLIF(trim(p_name), '');
  IF v_clean_name IS NULL                   THEN RAISE EXCEPTION 'NAME_REQUIRED'; END IF;
  IF char_length(v_clean_name) > 120        THEN RAISE EXCEPTION 'NAME_TOO_LONG'; END IF;

  -- Buy-in validation
  IF p_buy_in IS NULL OR p_buy_in < 0       THEN RAISE EXCEPTION 'INVALID_BUY_IN'; END IF;
  IF p_buy_in > 1000000                     THEN RAISE EXCEPTION 'BUY_IN_TOO_LARGE'; END IF;

  -- Starting stack
  IF p_starting_stack IS NOT NULL
     AND (p_starting_stack < 0 OR p_starting_stack > 100000000) THEN
    RAISE EXCEPTION 'INVALID_STARTING_STACK';
  END IF;

  -- Structure
  IF p_structure IS NOT NULL
     AND p_structure NOT IN ('turbo','standard','deep','bounty','rebuy') THEN
    RAISE EXCEPTION 'INVALID_STRUCTURE';
  END IF;

  -- Schedule
  IF p_scheduled_date IS NULL OR p_scheduled_time IS NULL THEN
    RAISE EXCEPTION 'SCHEDULE_REQUIRED';
  END IF;
  IF p_scheduled_date < CURRENT_DATE THEN
    RAISE EXCEPTION 'PAST_DATE';
  END IF;

  -- Entries cap (NULL = unlimited)
  IF p_entries_cap IS NOT NULL AND (p_entries_cap < 2 OR p_entries_cap > 10000) THEN
    RAISE EXCEPTION 'INVALID_ENTRIES_CAP';
  END IF;

  -- Address visibility
  IF p_address_visible_to NOT IN ('public','rsvp','members') THEN
    RAISE EXCEPTION 'INVALID_ADDRESS_VISIBILITY';
  END IF;

  -- Host gate
  SELECT status INTO v_group_status
    FROM commander_home_groups WHERE id = p_group_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;
  IF v_group_status <> 'active' THEN RAISE EXCEPTION 'GROUP_NOT_ACTIVE'; END IF;

  IF NOT public.fn_home_is_group_staff(v_caller, p_group_id) THEN
    RAISE EXCEPTION 'NOT_GROUP_STAFF';
  END IF;

  -- Insert the tournament as a commander_home_games row
  INSERT INTO commander_home_games (
    group_id, host_id, title, description,
    format, game_type,
    buyin_min, buyin_max, starting_stack, structure,
    scheduled_date, start_time,
    max_players, status,
    address, address_visible_to
  ) VALUES (
    p_group_id, v_caller, v_clean_name, NULLIF(trim(p_description), ''),
    'tournament', 'nlhe',
    p_buy_in, p_buy_in, p_starting_stack, p_structure,
    p_scheduled_date, p_scheduled_time,
    p_entries_cap, 'scheduled',
    NULLIF(trim(p_address), ''), p_address_visible_to
  ) RETURNING id INTO v_game_id;

  -- Audit
  INSERT INTO commander_home_audit_log
    (group_id, actor_id, target_type, target_id, action, metadata)
  VALUES (
    p_group_id, v_caller, 'tournament', v_game_id, 'created',
    jsonb_build_object(
      'name', v_clean_name, 'buy_in', p_buy_in,
      'starting_stack', p_starting_stack, 'structure', p_structure,
      'date', p_scheduled_date, 'time', p_scheduled_time,
      'entries_cap', p_entries_cap
    )
  );

  RETURN v_game_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_hg_create_tournament(
  uuid, text, integer, integer, text, date, time, integer, text, text, text
) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_hg_create_tournament(
  uuid, text, integer, integer, text, date, time, integer, text, text, text
) FROM anon, public;


-- ───────────────────────── UPDATE ─────────────────────────
CREATE OR REPLACE FUNCTION public.rpc_hg_update_tournament(
  p_tournament_id  uuid,
  p_name           text     DEFAULT NULL,
  p_buy_in         integer  DEFAULT NULL,
  p_starting_stack integer  DEFAULT NULL,
  p_structure      text     DEFAULT NULL,
  p_scheduled_date date     DEFAULT NULL,
  p_scheduled_time time     DEFAULT NULL,
  p_entries_cap    integer  DEFAULT NULL,
  p_description    text     DEFAULT NULL,
  p_clear_entries_cap boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller   uuid := auth.uid();
  v_game     RECORD;
  v_changes  jsonb := '{}'::jsonb;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  SELECT * INTO v_game FROM commander_home_games WHERE id = p_tournament_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'TOURNAMENT_NOT_FOUND'; END IF;
  IF v_game.format <> 'tournament' THEN RAISE EXCEPTION 'NOT_A_TOURNAMENT'; END IF;
  IF v_game.status IN ('completed','cancelled','in_progress') THEN
    RAISE EXCEPTION 'TOURNAMENT_FINAL' USING HINT = 'cannot edit a tournament with status ' || v_game.status;
  END IF;

  IF NOT public.fn_home_is_group_staff(v_caller, v_game.group_id) THEN
    RAISE EXCEPTION 'NOT_GROUP_STAFF';
  END IF;

  -- Field-by-field validation + apply
  IF p_name IS NOT NULL THEN
    p_name := trim(p_name);
    IF char_length(p_name) = 0 OR char_length(p_name) > 120 THEN
      RAISE EXCEPTION 'INVALID_NAME';
    END IF;
    v_changes := v_changes || jsonb_build_object('name', p_name);
  END IF;

  IF p_buy_in IS NOT NULL THEN
    IF p_buy_in < 0 OR p_buy_in > 1000000 THEN RAISE EXCEPTION 'INVALID_BUY_IN'; END IF;
    v_changes := v_changes || jsonb_build_object('buy_in', p_buy_in);
  END IF;

  IF p_starting_stack IS NOT NULL THEN
    IF p_starting_stack < 0 OR p_starting_stack > 100000000 THEN
      RAISE EXCEPTION 'INVALID_STARTING_STACK';
    END IF;
    v_changes := v_changes || jsonb_build_object('starting_stack', p_starting_stack);
  END IF;

  IF p_structure IS NOT NULL THEN
    IF p_structure NOT IN ('turbo','standard','deep','bounty','rebuy') THEN
      RAISE EXCEPTION 'INVALID_STRUCTURE';
    END IF;
    v_changes := v_changes || jsonb_build_object('structure', p_structure);
  END IF;

  IF p_scheduled_date IS NOT NULL THEN
    IF p_scheduled_date < CURRENT_DATE THEN RAISE EXCEPTION 'PAST_DATE'; END IF;
    v_changes := v_changes || jsonb_build_object('scheduled_date', p_scheduled_date);
  END IF;

  IF p_scheduled_time IS NOT NULL THEN
    v_changes := v_changes || jsonb_build_object('scheduled_time', p_scheduled_time);
  END IF;

  IF p_entries_cap IS NOT NULL THEN
    IF p_entries_cap < 2 OR p_entries_cap > 10000 THEN RAISE EXCEPTION 'INVALID_ENTRIES_CAP'; END IF;
    v_changes := v_changes || jsonb_build_object('entries_cap', p_entries_cap);
  END IF;

  UPDATE commander_home_games SET
    title              = COALESCE(p_name,                title),
    description        = CASE WHEN p_description IS NOT NULL THEN NULLIF(trim(p_description),'') ELSE description END,
    buyin_min          = COALESCE(p_buy_in,              buyin_min),
    buyin_max          = COALESCE(p_buy_in,              buyin_max),
    starting_stack     = COALESCE(p_starting_stack,      starting_stack),
    structure          = COALESCE(p_structure,           structure),
    scheduled_date     = COALESCE(p_scheduled_date,      scheduled_date),
    start_time         = COALESCE(p_scheduled_time,      start_time),
    max_players        = CASE
      WHEN p_clear_entries_cap THEN NULL
      WHEN p_entries_cap IS NOT NULL THEN p_entries_cap
      ELSE max_players
    END,
    updated_at         = NOW()
   WHERE id = p_tournament_id;

  INSERT INTO commander_home_audit_log
    (group_id, actor_id, target_type, target_id, action, metadata)
  VALUES (
    v_game.group_id, v_caller, 'tournament', p_tournament_id, 'updated', v_changes
  );

  RETURN jsonb_build_object('success', true, 'tournament_id', p_tournament_id, 'changes', v_changes);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_hg_update_tournament(
  uuid, text, integer, integer, text, date, time, integer, text, boolean
) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_hg_update_tournament(
  uuid, text, integer, integer, text, date, time, integer, text, boolean
) FROM anon, public;


-- ───────────────────────── LIST (STAFF) ─────────────────────────
-- Returns ALL tournaments for the group regardless of status — for the host's
-- manage dashboard. Caller must be group staff.
CREATE OR REPLACE FUNCTION public.rpc_hg_list_tournaments(
  p_group_id     uuid,
  p_include_past boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_result jsonb;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.fn_home_is_group_staff(v_caller, p_group_id) THEN
    RAISE EXCEPTION 'NOT_GROUP_STAFF';
  END IF;

  SELECT COALESCE(jsonb_agg(t ORDER BY t.scheduled_date, t.start_time), '[]'::jsonb) INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'id', g.id,
      'group_id', g.group_id,
      'name', g.title,
      'description', g.description,
      'buy_in', g.buyin_min,
      'starting_stack', g.starting_stack,
      'structure', g.structure,
      'scheduled_date', g.scheduled_date,
      'start_time', g.start_time,
      'entries_cap', g.max_players,
      'status', g.status,
      'rsvp_yes', g.rsvp_yes,
      'rsvp_maybe', g.rsvp_maybe,
      'created_at', g.created_at,
      'cancelled_at', g.cancelled_at,
      'cancellation_reason', g.cancellation_reason,
      'scheduled_date_iso', g.scheduled_date::text,
      'scheduled_at_iso',
        (g.scheduled_date::text || 'T' || to_char(g.start_time, 'HH24:MI:SS') || 'Z')
    ) AS j,
    g.scheduled_date, g.start_time
    FROM commander_home_games g
    WHERE g.group_id = p_group_id
      AND g.format = 'tournament'
      AND (p_include_past OR g.scheduled_date >= CURRENT_DATE)
  ) AS sub(t, scheduled_date, start_time);

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_hg_list_tournaments(uuid, boolean) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.rpc_hg_list_tournaments(uuid, boolean) FROM anon, public;


-- ───────────────────────── LIST (PUBLIC) ─────────────────────────
-- Returns only future scheduled tournaments — for anonymous visitors to
-- public group pages. Hides addresses unless address_visible_to='public'.
CREATE OR REPLACE FUNCTION public.rpc_hg_list_public_tournaments(p_group_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
  v_visibility text;
BEGIN
  -- Only return tournaments for groups that are themselves public or visible
  SELECT visibility INTO v_visibility FROM commander_home_groups
   WHERE id = p_group_id AND status = 'active';
  IF NOT FOUND THEN RETURN '[]'::jsonb; END IF;

  SELECT COALESCE(jsonb_agg(t ORDER BY t.scheduled_date, t.start_time), '[]'::jsonb) INTO v_result
  FROM (
    SELECT jsonb_build_object(
      'id', g.id,
      'name', g.title,
      'description', g.description,
      'buy_in', g.buyin_min,
      'starting_stack', g.starting_stack,
      'structure', g.structure,
      'scheduled_date', g.scheduled_date,
      'start_time', g.start_time,
      'entries_cap', g.max_players,
      'rsvp_yes', g.rsvp_yes,
      'address', CASE WHEN g.address_visible_to = 'public' THEN g.address ELSE NULL END,
      'neighborhood', g.neighborhood,
      'scheduled_at_iso',
        (g.scheduled_date::text || 'T' || to_char(g.start_time, 'HH24:MI:SS') || 'Z')
    ) AS j,
    g.scheduled_date, g.start_time
    FROM commander_home_games g
    WHERE g.group_id = p_group_id
      AND g.format = 'tournament'
      AND g.status = 'scheduled'
      AND g.scheduled_date >= CURRENT_DATE
  ) AS sub(t, scheduled_date, start_time);

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.rpc_hg_list_public_tournaments(uuid) TO authenticated, anon;
