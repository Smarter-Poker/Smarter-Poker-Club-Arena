-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260511163440 "rpc_hg_tournaments_fix_columns"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 efad2e9cab1aa0753993019bf713f15b of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Fix column references: commander_home_groups uses is_active + is_private,
-- not status + visibility. Re-create rpc_hg_create_tournament and
-- rpc_hg_list_public_tournaments with the correct columns.

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
  v_is_active  boolean;
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  v_clean_name := NULLIF(trim(p_name), '');
  IF v_clean_name IS NULL                   THEN RAISE EXCEPTION 'NAME_REQUIRED'; END IF;
  IF char_length(v_clean_name) > 120        THEN RAISE EXCEPTION 'NAME_TOO_LONG'; END IF;

  IF p_buy_in IS NULL OR p_buy_in < 0       THEN RAISE EXCEPTION 'INVALID_BUY_IN'; END IF;
  IF p_buy_in > 1000000                     THEN RAISE EXCEPTION 'BUY_IN_TOO_LARGE'; END IF;

  IF p_starting_stack IS NOT NULL
     AND (p_starting_stack < 0 OR p_starting_stack > 100000000) THEN
    RAISE EXCEPTION 'INVALID_STARTING_STACK';
  END IF;

  IF p_structure IS NOT NULL
     AND p_structure NOT IN ('turbo','standard','deep','bounty','rebuy') THEN
    RAISE EXCEPTION 'INVALID_STRUCTURE';
  END IF;

  IF p_scheduled_date IS NULL OR p_scheduled_time IS NULL THEN
    RAISE EXCEPTION 'SCHEDULE_REQUIRED';
  END IF;
  IF p_scheduled_date < CURRENT_DATE THEN
    RAISE EXCEPTION 'PAST_DATE';
  END IF;

  IF p_entries_cap IS NOT NULL AND (p_entries_cap < 2 OR p_entries_cap > 10000) THEN
    RAISE EXCEPTION 'INVALID_ENTRIES_CAP';
  END IF;

  IF p_address_visible_to NOT IN ('public','rsvp','members') THEN
    RAISE EXCEPTION 'INVALID_ADDRESS_VISIBILITY';
  END IF;

  SELECT is_active INTO v_is_active
    FROM commander_home_groups WHERE id = p_group_id;
  IF NOT FOUND      THEN RAISE EXCEPTION 'GROUP_NOT_FOUND'; END IF;
  IF NOT v_is_active THEN RAISE EXCEPTION 'GROUP_NOT_ACTIVE'; END IF;

  IF NOT public.fn_home_is_group_staff(v_caller, p_group_id) THEN
    RAISE EXCEPTION 'NOT_GROUP_STAFF';
  END IF;

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

CREATE OR REPLACE FUNCTION public.rpc_hg_list_public_tournaments(p_group_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_result jsonb;
BEGIN
  -- Group must exist and be active
  IF NOT EXISTS (
    SELECT 1 FROM commander_home_groups
    WHERE id = p_group_id AND is_active = true
  ) THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT COALESCE(jsonb_agg(sub.j ORDER BY sub.scheduled_date, sub.start_time), '[]'::jsonb) INTO v_result
  FROM (
    SELECT
      jsonb_build_object(
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
      g.scheduled_date,
      g.start_time
    FROM commander_home_games g
    WHERE g.group_id = p_group_id
      AND g.format = 'tournament'
      AND g.status = 'scheduled'
      AND g.scheduled_date >= CURRENT_DATE
  ) sub;

  RETURN v_result;
END;
$$;
