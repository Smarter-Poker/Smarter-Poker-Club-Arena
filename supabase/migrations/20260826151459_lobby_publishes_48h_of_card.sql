-- ═════════════════════════════════════════════════════════════════════════════
-- THE LOBBY PUBLISHES 48 HOURS OF CARD (6 DAYS ABOVE A 200 BUY-IN)
-- Dan 2026-08-26
-- ═════════════════════════════════════════════════════════════════════════════
--
-- "INSIDE THE CLUB LOBBIES, MTT'S ARE NOT DISPLAYING ALL EVENTS. IT SHOULD BE
--  DISPLAYING ALL EVENTS THAT ARE SCHEDULED OVER THE NEXT 48 HOURS. ANY
--  TOURNAMENT WITH A BUY IN OF MORE THEN 200 THAT IS ON THE SCHEDULE CAN BE
--  SHOWN 6 DAYS OUT."
--
-- Two database facts were in the way. Neither is in the client, which is why
-- widening the client alone would have changed nothing visible.
--
-- 1. uq_scheduled_tournament_one_live_per_name is UNIQUE (tournament_type,
--    name) over pre-start rows. Four of this club's sixty schedules run EVERY
--    DAY ("$100 Freeroll - 12:00 AM" and friends), so publishing two days of
--    card means two pre-start rows sharing a name -- and the second insert
--    raises 23505. The spawner treats that as benign, releases its claim, and
--    tries again next minute, forever: the second day silently never appears.
--
--    The index's real intent is "never two copies of the SAME occurrence",
--    and the occurrence is identified by its START TIME, not by its name.
--    Adding start_time to the key keeps every duplicate it was built to stop
--    (the spawn_key claim in tournament_schedule_spawns is the primary guard;
--    this is the belt to that pair of braces, and it also covers rows created
--    by hand) while letting tomorrow's and Friday's editions coexist.
--
-- 2. get_club_home -- the lobby's fast path -- selected pre-start and running
--    tournaments with NO time bound and `ORDER BY start_time ASC LIMIT 200`.
--    A RUNNING event's start_time is in the PAST, so it sorts FIRST: with 93
--    running spins on club fade0000 the cap was already consuming the future
--    card, and doubling the published days would have made the cap, not the
--    policy, decide what a player sees. The window now bounds the set and the
--    cap only trims what nothing was going to show.
--
-- FILENAME VERSION = THE APPLIED VERSION. The Supabase MCP stamps its own
-- timestamp when it applies a migration, so this file was renamed from
-- 20260826120000 to match what `supabase_migrations.schema_migrations`
-- actually records (20260826151459). Leaving them different is not cosmetic:
-- a later `supabase db push` would not find 20260826120000 in the ledger,
-- would try to apply this file a second time, and the pre-flight assertion at
-- the top would abort on `uq_scheduled_tournament_one_live_per_name is
-- missing` -- correctly, but as a confusing failure rather than a no-op.
--
-- SAFETY: both changes are additive to what a player can SEE. No row is
-- hidden that was visible before -- the new bound is 6 days out, and before
-- today nothing existed beyond 24 hours to be bounded.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The uniqueness key gains the start time
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'tournaments'
      AND indexname = 'uq_scheduled_tournament_one_live_per_name'
  ) THEN
    RAISE EXCEPTION
      'uq_scheduled_tournament_one_live_per_name is missing - this migration is rewriting an index that is not there. Investigate before re-running.';
  END IF;
END $$;

DROP INDEX IF EXISTS public.uq_scheduled_tournament_one_live_per_name;

CREATE UNIQUE INDEX uq_scheduled_tournament_one_live_per_occurrence
  ON public.tournaments (tournament_type, name, start_time)
  WHERE status = ANY (ARRAY['ANNOUNCED'::text, 'REGISTERING'::text])
    AND tournament_type = ANY (ARRAY['MTT'::text, 'XMTT'::text]);

COMMENT ON INDEX public.uq_scheduled_tournament_one_live_per_occurrence IS
  'One pre-start MTT per (type, name, start_time). Replaced the (type, name) form on 2026-08-26: that key made a 48-hour board impossible for any schedule that runs daily, because two editions of the same event share a name and differ only in when they start.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. get_club_home publishes the same window the client filters on
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_club_home(p_club_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_club           public.clubs%ROWTYPE;
  v_uid            uuid := auth.uid();
  v_union_id       uuid;
  v_union_club_ids uuid[];
  v_member_count   integer;
  v_playing        integer;
  v_membership     jsonb;
  v_tables         jsonb;
  v_tournaments    jsonb;
  v_bbj            jsonb;
  v_club_names     jsonb;
BEGIN
  IF p_club_key ~ '^[0-9a-fA-F]{8}-' THEN
    SELECT * INTO v_club FROM public.clubs WHERE id = p_club_key::uuid LIMIT 1;
  ELSIF p_club_key ~ '^[0-9]+$' THEN
    SELECT * INTO v_club FROM public.clubs WHERE club_id = p_club_key::integer LIMIT 1;
  ELSE
    SELECT * INTO v_club FROM public.clubs WHERE slug = p_club_key LIMIT 1;
  END IF;

  IF v_club.id IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT uc.union_id INTO v_union_id
  FROM public.union_clubs uc WHERE uc.club_id = v_club.id LIMIT 1;
  IF v_union_id IS NULL THEN
    v_union_id := v_club.union_id;
  END IF;

  IF v_union_id IS NOT NULL THEN
    SELECT array_agg(uc.club_id) INTO v_union_club_ids
    FROM public.union_clubs uc WHERE uc.union_id = v_union_id;
  END IF;
  v_union_club_ids := COALESCE(v_union_club_ids, ARRAY[]::uuid[]) || v_club.id;

  -- THIS CLUB'S MEMBERS. Not the union's. See the header.
  SELECT count(*)::int INTO v_member_count
  FROM public.club_members cm
  WHERE cm.club_id = v_club.id
    AND cm.status IN ('active', 'approved');

  -- Everyone in a seat at a live table, right now, anywhere on the platform.
  -- Counted from the seats, never from clubs.online_count.
  SELECT count(DISTINCT ts.user_id)::int INTO v_playing
  FROM public.table_seats ts
  JOIN public.tables tb ON tb.id = ts.table_id
  WHERE ts.left_at IS NULL
    AND tb.status IN ('waiting', 'running');

  IF v_uid IS NOT NULL THEN
    SELECT jsonb_build_object('chip_balance', cm.chip_balance, 'role', cm.role)
      INTO v_membership
    FROM public.club_members cm
    WHERE cm.club_id = v_club.id AND cm.user_id = v_uid LIMIT 1;
  END IF;

  -- id -> name for every club whose games can appear on this board.
  SELECT COALESCE(jsonb_object_agg(c.id::text, c.name), '{}'::jsonb) INTO v_club_names
  FROM public.clubs c WHERE c.id = ANY (v_union_club_ids);

  SELECT COALESCE(jsonb_agg(t ORDER BY t.created_at DESC), '[]'::jsonb) INTO v_tables
  FROM (
    SELECT id, name, game_variant, stakes, current_players, max_players, status,
           small_blind, big_blind, min_buy_in, max_buy_in, created_at, club_id,
           -- Rule medallions
           run_it_twice, run_it_twice_enabled, allow_run_it_twice, run_it_mode,
           insurance_enabled, straddle_enabled, straddle_type, auto_utg_straddle,
           bomb_pot_enabled, bomb_pot_frequency, bomb_pot_double_board,
           ante_enabled, ante, seven_deuce_enabled, seven_deuce_amount,
           time_bank_enabled, all_in_or_fold,
           cap_enabled, cap_bb, no_rathole, pineapple_holdem,
           is_anonymous, ban_chat, restrict_observers, auto_start_players,
           -- Lobby flags. is_private is not here: it decides whether the row
           -- is returned at all, in fn_club_home_in_scope below.
           is_vip_only, label_as_new, is_featured, hide_club_name,
           -- NIT GAME: the switch and the three numbers it governs.
           nit_game, career_percent_min, maintain_percent_min, maintain_hands
    FROM public.tables
    WHERE is_deleted = false
      AND status NOT IN ('closed', 'deleted')
      AND tournament_id IS NULL
      -- A template is a saved SHAPE, not a game. Without this the
      -- Save button put an empty joinable table on the board.
      AND COALESCE(is_template, false) = false
      AND public.fn_club_home_in_scope(club_id, is_private, union_id,
                                       v_union_id, v_club.id, v_union_club_ids)
    ORDER BY created_at DESC LIMIT 200
  ) t;

  SELECT COALESCE(jsonb_agg(x ORDER BY x.start_time ASC), '[]'::jsonb) INTO v_tournaments
  FROM (
    SELECT id, name, game_type, variant, table_size, buy_in_amount, buy_in_fee,
           guaranteed_prize, start_time, status, current_players, max_players,
           starting_chips, club_id, union_id, is_xmtt, late_reg_mins,
           late_reg_levels, started_at, current_level,
           is_vip_only, label_as_new, hide_club_name, is_pinned
    FROM public.tournaments
    WHERE status IN ('REGISTERING', 'RUNNING', 'LATE_REG', 'STARTING_SOON')
      -- THE PUBLISHED WINDOW (2026-08-26). Everything already under way or
      -- starting inside 48 hours, plus anything above a 200 total buy-in for
      -- 6 days. The client applies the identical rule row by row
      -- (src/utils/tournamentScheduleWindow.ts); this bound exists so the
      -- LIMIT below can never be what decides, since a running event's
      -- start_time is in the past and therefore sorts ahead of the whole
      -- future card.
      AND start_time <= now() + interval '48 hours'
             + CASE
                 WHEN COALESCE(buy_in_amount, 0) + COALESCE(buy_in_fee, 0) > 200
                   THEN interval '4 days'
                 ELSE interval '0'
               END
      AND public.fn_club_home_in_scope(club_id, is_private, union_id,
                                       v_union_id, v_club.id, v_union_club_ids)
    ORDER BY start_time ASC LIMIT 500
  ) x;

  SELECT jsonb_build_object('id', bp.id, 'main_balance', bp.main_balance) INTO v_bbj
  FROM public.bbj_pools bp
  WHERE CASE WHEN v_union_id IS NOT NULL
             THEN (bp.union_id = v_union_id OR bp.club_id = ANY (v_union_club_ids))
             ELSE bp.club_id = v_club.id END
  ORDER BY (bp.union_id IS NOT NULL) DESC LIMIT 1;

  RETURN jsonb_build_object(
    'found', true,
    'club', jsonb_build_object(
      'id', v_club.id,
      'club_id', v_club.club_id,
      'name', v_club.name,
      'description', v_club.description,
      'avatar_url', v_club.avatar_url,
      'logo_url', v_club.logo_url,
      -- Both counts come from this one place so the header cannot flip
      -- between two writers again.
      'member_count', v_member_count,
      'online_count', v_playing,
      'owner_id', v_club.owner_id,
      'level', v_club.level,
      'hierarchy_units_rounded_up', v_club.hierarchy_units_rounded_up,
      'player_threshold_current', v_club.player_threshold_current,
      'player_threshold_next', v_club.player_threshold_next,
      'hierarchy_threshold_current', v_club.hierarchy_threshold_current,
      'hierarchy_threshold_next', v_club.hierarchy_threshold_next,
      'created_at', v_club.created_at
    ),
    'membership', v_membership,
    'union_id', v_union_id,
    'union_club_ids', to_jsonb(v_union_club_ids),
    'club_names', v_club_names,
    'member_count', v_member_count,
    'players_playing', v_playing,
    'tables', v_tables,
    'tournaments', v_tournaments,
    'bbj', v_bbj
  );
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- POST-APPLY ASSERTIONS
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'tournaments'
      AND indexname = 'uq_scheduled_tournament_one_live_per_occurrence'
  ) THEN
    RAISE EXCEPTION 'uq_scheduled_tournament_one_live_per_occurrence was not created';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'tournaments'
      AND indexname = 'uq_scheduled_tournament_one_live_per_name'
  ) THEN
    RAISE EXCEPTION 'the old (type, name) unique index is still present';
  END IF;

  IF (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'get_club_home')
     NOT LIKE '%interval ''48 hours''%' THEN
    RAISE EXCEPTION 'get_club_home does not carry the published window';
  END IF;
END $$;

-- ROLLBACK
--   DROP INDEX IF EXISTS public.uq_scheduled_tournament_one_live_per_occurrence;
--   CREATE UNIQUE INDEX uq_scheduled_tournament_one_live_per_name
--     ON public.tournaments (tournament_type, name)
--     WHERE status = ANY (ARRAY['ANNOUNCED'::text, 'REGISTERING'::text])
--       AND tournament_type = ANY (ARRAY['MTT'::text, 'XMTT'::text]);
--   -- and re-apply the previous get_club_home body (no start_time bound,
--   -- LIMIT 200) from migration history.
