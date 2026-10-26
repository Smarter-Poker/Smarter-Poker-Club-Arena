-- Read-only production pg_get_functiondef preimages for isolated PostgreSQL qualification.
-- Exact source MD5s are asserted by migration20261024053530 before replacement.
CREATE OR REPLACE FUNCTION public.fn_cash_game_create(p_club_id uuid, p_template text, p_variant text, p_sb numeric, p_bb numeric, p_handedness integer DEFAULT NULL::integer, p_overrides jsonb DEFAULT '{}'::jsonb, p_name text DEFAULT NULL::text, p_must_move boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_cash_game_create requires an authenticated caller'
      USING ERRCODE = '28000';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE = '28000';
  END IF;
  IF p_club_id IS NULL THEN
    RAISE EXCEPTION 'CLUB_REQUIRED';
  END IF;
  IF NOT public.fn_can_create_games(p_club_id, v_uid) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: this club is managed by its union';
  END IF;

  -- ca-commerce-admission: opening a NEW table, and offering insurance on
  -- it, are prospective owner actions (R2 4.3, 6.3, D22). Shadow records and
  -- proceeds; enforced refuses here, before anything is written.
  DECLARE
    v_ca_admission jsonb;
    v_ca_insurance boolean;
  BEGIN
    v_ca_admission := public.fn_ca_commerce_admit('club', p_club_id, 'open_table', 'fn_cash_game_create', NULL);
    IF NOT COALESCE((v_ca_admission->>'allowed')::boolean, true) THEN
      RAISE EXCEPTION '%', v_ca_admission->>'message' USING ERRCODE = 'P0001', HINT = 'operating_access_required';
    END IF;
    BEGIN
      v_ca_insurance := public.fn_cash_override_bool(COALESCE(p_overrides->'options', '{}'::jsonb), 'insurance_enabled', false);
    EXCEPTION WHEN OTHERS THEN
      v_ca_insurance := false;  -- the creator below refuses a malformed option in its own words
    END;
    IF v_ca_insurance THEN
      v_ca_admission := public.fn_ca_commerce_admit('club', p_club_id, 'club_insurance', 'fn_cash_game_create', NULL);
      IF NOT COALESCE((v_ca_admission->>'allowed')::boolean, true) THEN
        RAISE EXCEPTION '%', v_ca_admission->>'message' USING ERRCODE = 'P0001', HINT = 'operating_access_required';
      END IF;
    END IF;
  END;

  RETURN public.fn_cash_game_create_impl_20260905(
    p_club_id, CASE WHEN lower(p_template) IN ('action','madness','lightning') THEN 'madness' ELSE p_template END, p_variant, p_sb, p_bb, p_handedness,
    p_overrides, CASE WHEN lower(p_template) IN ('action','madness','lightning') THEN upper(p_variant)||' '||p_sb::text||'/'||p_bb::text||' Lightning Games' ELSE p_name END, p_must_move
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_cash_game_create_impl_20260905(p_club_id uuid, p_template text, p_variant text, p_sb numeric, p_bb numeric, p_handedness integer DEFAULT NULL::integer, p_overrides jsonb DEFAULT '{}'::jsonb, p_name text DEFAULT NULL::text, p_must_move boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_t text := lower(coalesce(p_template, ''));
  v_v text := lower(coalesce(p_variant, ''));
  v_def jsonb; v_snap jsonb; v_o jsonb := coalesce(p_overrides, '{}'::jsonb);
  v_lightning boolean := lower(coalesce(p_template,'')) IN ('action','madness','lightning');
  v_must_move boolean := coalesce(p_must_move, true);
  v_union uuid;
  v_seats integer; v_choices integer[];
  v_stay integer; v_rejoin integer;
  v_min_bb integer; v_max_bb integer;
  v_ante text; v_vpip integer; v_vpip_window integer;
  v_bombs jsonb; v_bomb_on boolean; v_bomb_trigger text; v_bomb_ante integer; v_bomb_boards integer;
  v_opts jsonb; v_oo jsonb;
  v_name text; v_label text;
  v_game_id uuid; v_table_id uuid;
  v_variant_label text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'fn_cash_game_create requires an authenticated caller' USING ERRCODE = '28000';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: this session is signed out - sign in again' USING ERRCODE = '28000';
  END IF;
  IF p_club_id IS NULL THEN
    RAISE EXCEPTION 'CLUB_REQUIRED';
  END IF;
  IF NOT (public.fn_can_create_games(p_club_id, v_uid) OR public.is_club_admin(p_club_id, v_uid)) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED: you cannot create games in this club';
  END IF;

  IF v_t NOT IN ('classic', 'action', 'madness') THEN
    RAISE EXCEPTION 'TEMPLATE_UNKNOWN: %', p_template;
  END IF;
  IF v_v NOT IN ('nlh','plo4','plo5','plo6','plo8','flo8','flh','short_deck','pineapple') THEN
    RAISE EXCEPTION 'VARIANT_UNAVAILABLE: % is not available yet', p_variant;
  END IF;
  IF p_sb IS NULL OR p_bb IS NULL OR p_sb = 'NaN'::numeric OR p_bb = 'NaN'::numeric
     OR p_sb <= 0 OR p_bb <= p_sb
     OR round(p_sb, 2) <> p_sb OR round(p_bb, 2) <> p_bb
     OR p_bb > 100000 THEN
    RAISE EXCEPTION 'STAKES_INVALID: sb=% bb=%', p_sb, p_bb;
  END IF;
  IF jsonb_typeof(v_o) <> 'object' THEN
    RAISE EXCEPTION 'OVERRIDE_INVALID: overrides must be an object';
  END IF;

  v_def := public.fn_cash_template_defaults(v_t, v_v);

  -- A LOCKED RULE THAT ARRIVES DIFFERENT IS REFUSED, NOT IGNORED (2026-09-09,
  -- 20260909181309). regular_ante, vpip_floor, vpip_window and bombs are the
  -- template's promise to the player. A caller may echo them back unchanged;
  -- a caller asking for something else is told so, never quietly overruled.
  DECLARE
    v_lk text;
  BEGIN
    FOREACH v_lk IN ARRAY ARRAY['regular_ante', 'vpip_floor', 'vpip_window'] LOOP
      IF v_o ? v_lk AND (v_o->>v_lk) IS DISTINCT FROM (v_def->>v_lk) THEN
        RAISE EXCEPTION 'OVERRIDE_LOCKED: % is set by the % template (sent %, template %)',
          v_lk, v_t, v_o->>v_lk, v_def->>v_lk;
      END IF;
    END LOOP;
    IF v_o ? 'bombs' AND jsonb_typeof(v_o->'bombs') = 'object' THEN
      IF (v_o->'bombs'->>'enabled') IS DISTINCT FROM (v_def->'bombs'->>'enabled')
         OR (coalesce((v_def->'bombs'->>'enabled')::boolean, false) AND (
              (v_o->'bombs'->>'trigger') IS DISTINCT FROM (v_def->'bombs'->>'trigger')
           OR (v_o->'bombs'->>'ante_bb') IS DISTINCT FROM (v_def->'bombs'->>'ante_bb')
           OR (v_o->'bombs'->>'boards')  IS DISTINCT FROM (v_def->'bombs'->>'boards'))) THEN
        RAISE EXCEPTION 'OVERRIDE_LOCKED: bombs is set by the % template (sent %, template %)',
          v_t, v_o->'bombs', v_def->'bombs';
      END IF;
    END IF;
  END;

  SELECT array_agg(x::integer) INTO v_choices FROM jsonb_array_elements_text(v_def->'seat_choices') x;
  IF (v_def->>'seats_locked')::boolean THEN
    v_seats := (v_def->>'seats')::integer;
  ELSE
    v_seats := coalesce(p_handedness, (v_def->>'seats')::integer);
    IF NOT (v_seats = ANY (v_choices)) THEN
      RAISE EXCEPTION 'HANDEDNESS_INVALID: % is not offered for % %', v_seats, v_t, v_v;
    END IF;
  END IF;

  v_min_bb := public.fn_cash_override_int(v_o, 'min_buyin_bb', (v_def->>'min_buyin_bb')::integer);
  v_max_bb := public.fn_cash_override_int(v_o, 'max_buyin_bb', (v_def->>'max_buyin_bb')::integer);
  IF v_min_bb < 1 OR v_max_bb < v_min_bb OR v_max_bb > 1000 THEN
    RAISE EXCEPTION 'BUYIN_BAND_INVALID: % - % bb', v_min_bb, v_max_bb;
  END IF;
  v_ante := v_def->>'regular_ante';
  IF v_ante NOT IN ('none', 'sb', 'bb') THEN
    RAISE EXCEPTION 'ANTE_INVALID: %', v_ante;
  END IF;
  v_vpip := (v_def->>'vpip_floor')::integer;
  IF v_vpip < 0 OR v_vpip > 100 THEN RAISE EXCEPTION 'VPIP_INVALID: %', v_vpip; END IF;
  v_vpip_window := (v_def->>'vpip_window')::integer;
  IF v_vpip_window < 10 OR v_vpip_window > 200 THEN RAISE EXCEPTION 'VPIP_WINDOW_INVALID: %', v_vpip_window; END IF;

  IF v_o ? 'bombs' AND jsonb_typeof(v_o->'bombs') <> 'object' THEN
    RAISE EXCEPTION 'OVERRIDE_INVALID: bombs must be an object';
  END IF;
  v_bombs := coalesce(v_def->'bombs', '{}'::jsonb);
  v_bomb_on := public.fn_cash_override_bool(v_bombs, 'enabled', false);
  v_bomb_trigger := v_bombs->>'trigger';
  v_bomb_ante := public.fn_cash_override_int(v_bombs, 'ante_bb', NULL);
  v_bomb_boards := public.fn_cash_override_int(v_bombs, 'boards', NULL);
  IF v_bomb_on THEN
    IF v_bomb_trigger IS NULL OR v_bomb_trigger NOT IN ('timed_10m', 'timed_15m', 'timed_20m', 'every_orbit') THEN
      RAISE EXCEPTION 'BOMB_TRIGGER_INVALID: %', v_bomb_trigger;
    END IF;
    IF v_bomb_ante IS NULL OR v_bomb_ante < 1 OR v_bomb_ante > 20 THEN
      RAISE EXCEPTION 'BOMB_ANTE_INVALID: %', v_bomb_ante;
    END IF;
    IF v_bomb_boards IS NULL OR v_bomb_boards < 2 OR v_bomb_boards > 3 THEN
      RAISE EXCEPTION 'BOMB_BOARDS_INVALID: %', v_bomb_boards;
    END IF;
  END IF;

  v_stay := public.fn_cash_override_int(v_o, 'stay_clock_min', (v_def->>'stay_clock_min')::integer);
  v_rejoin := public.fn_cash_override_int(v_o, 'rejoin_window_min', (v_def->>'rejoin_window_min')::integer);
  IF v_stay < (v_def->>'stay_clock_min')::integer THEN
    RAISE EXCEPTION 'STAY_CLOCK_BELOW_FLOOR: % minutes; the minimum is %', v_stay, v_def->>'stay_clock_min';
  END IF;
  IF v_rejoin < (v_def->>'rejoin_window_min')::integer THEN
    RAISE EXCEPTION 'REJOIN_WINDOW_BELOW_FLOOR: % minutes; the minimum is %', v_rejoin, v_def->>'rejoin_window_min';
  END IF;
  IF v_stay > 1440 OR v_rejoin > 10080 THEN
    RAISE EXCEPTION 'CLOCK_TOO_LONG';
  END IF;

  IF v_o ? 'options' AND jsonb_typeof(v_o->'options') <> 'object' THEN
    RAISE EXCEPTION 'OVERRIDE_INVALID: options must be an object';
  END IF;
  v_oo := coalesce(v_o->'options', '{}'::jsonb);
  v_opts := jsonb_build_object(
    'is_private',          public.fn_cash_override_bool(v_oo, 'is_private', false),
    'is_vip_only',         public.fn_cash_override_bool(v_oo, 'is_vip_only', false),
    'is_anonymous',        public.fn_cash_override_bool(v_oo, 'is_anonymous', false),
    'ban_chat',            public.fn_cash_override_bool(v_oo, 'ban_chat', false),
    'insurance_enabled',   public.fn_cash_override_bool(v_oo, 'insurance_enabled', false),
    'seven_deuce_enabled', public.fn_cash_override_bool(v_oo, 'seven_deuce_enabled', false) AND v_v = 'nlh',
    'action_time_seconds', LEAST(120, GREATEST(10, public.fn_cash_override_int(v_oo, 'action_time_seconds', 15)))
  );

  v_snap := v_def || jsonb_build_object(
    'seats', v_seats,
    'min_buyin_bb', v_min_bb,
    'max_buyin_bb', v_max_bb,
    'regular_ante', v_ante,
    'vpip_floor', v_vpip,
    'vpip_window', v_vpip_window,
    'bombs', jsonb_build_object('enabled', v_bomb_on, 'trigger', v_bomb_trigger, 'ante_bb', v_bomb_ante, 'boards', v_bomb_boards),
    'straddle', false,
    'stay_clock_min', v_stay,
    'rejoin_window_min', v_rejoin,
    'run_it_n_times', 'opt_in',
    'rake', 'existing',
    'options', v_opts,
    'table_mode', CASE WHEN v_must_move THEN 'must_move' ELSE 'manual' END,
    'sb', p_sb, 'bb', p_bb,
    'resolved_at', to_jsonb(clock_timestamp())
  );


  IF v_t IN ('action','madness') THEN
    v_snap:=jsonb_set(v_snap,'{lightning}',
      CASE WHEN jsonb_typeof(v_snap->'lightning')='object' THEN v_snap->'lightning' ELSE '{}'::jsonb END ||
      jsonb_build_object('always_on',true,'on_threshold',5,'off_threshold',4,'worker_mode','form'));
  END IF;
  v_variant_label := CASE v_v
    WHEN 'nlh' THEN 'NLH' WHEN 'plo4' THEN 'PLO4' WHEN 'plo5' THEN 'PLO5' WHEN 'plo6' THEN 'PLO6'
    WHEN 'plo8' THEN 'PLO8' WHEN 'flo8' THEN 'FLO8' WHEN 'flh' THEN 'FLH'
    WHEN 'short_deck' THEN 'Short Deck' WHEN 'pineapple' THEN 'Pineapple' END;
  v_label := public.fn_cash_stakes_label(p_sb, p_bb, v_v);
  v_name := btrim(coalesce(p_name, ''));
  IF v_name = '' THEN
    v_name := v_variant_label || ' ' || v_label || ' ' || initcap(v_t);
  END IF;
  v_name := left(replace(replace(v_name, '<', ''), '>', ''), 60);

  -- LIGHTNING 2.0 PHASE 3. The flag rides in p_overrides because this
  -- function is pinned by regprocedure at three sites and its argument
  -- list cannot move. jsonb_typeof rather than a cast: ::boolean on a
  -- non-boolean raises 22P02 out of a DECLARE-free context and the caller
  -- would see a type error instead of a named refusal.
  IF v_o ? 'lightning_enabled' THEN
    IF jsonb_typeof(v_o->'lightning_enabled') <> 'boolean' THEN
      RAISE EXCEPTION 'OVERRIDE_INVALID: lightning_enabled must be true or false';
    END IF;

    IF (v_o->>'lightning_enabled')::boolean IS DISTINCT FROM (v_t IN ('action','madness')) THEN
      RAISE EXCEPTION 'OVERRIDE_LOCKED: lightning_enabled follows the Classic or Lightning Games format';
    END IF;
    v_lightning := (v_o->>'lightning_enabled')::boolean;
  END IF;
  -- A Lightning game IS a Cluster: it grows tables, moves players between
  -- them and converts a population into a pool. A manual (R9) table has no
  -- controller and lives and dies with its host, so it can never get there.
  IF v_lightning AND NOT v_must_move THEN
    RAISE EXCEPTION 'LIGHTNING_NEEDS_MUST_MOVE: a Lightning-capable game is a Cluster; a manual table is not one';
  END IF;

  SELECT u.id INTO v_union
    FROM public.fn_club_union_context(p_club_id) ctx
    JOIN public.unions u ON u.id = COALESCE(ctx.own_union_id, ctx.member_union_id);


  IF v_t IN ('action','madness') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('lightning-game-key:'||p_club_id::text||':'||v_v||':'||round(p_sb,2)::text||':'||round(p_bb,2)::text,0));
    IF EXISTS(SELECT 1 FROM public.cash_games existing
       WHERE existing.club_id=p_club_id AND existing.variant=v_v
         AND existing.sb=p_sb AND existing.bb=p_bb AND existing.enabled
         AND existing.closed_at IS NULL AND existing.template_name IN ('action','madness')) THEN
      RAISE EXCEPTION 'GAME_EXISTS: this stake already has Lightning Games';
    END IF;
  END IF;
  BEGIN
    INSERT INTO public.cash_games
      (club_id, union_id, name, template_name, variant, sb, bb, handedness, ruleset_snapshot, created_by, must_move, lightning_enabled)
    VALUES
      (p_club_id, v_union, v_name, v_t, v_v, p_sb, p_bb, v_seats, v_snap, v_uid, v_must_move, v_lightning)
    RETURNING id INTO v_game_id;
  EXCEPTION WHEN unique_violation THEN
    -- zz_one_game_per_blind_category names the game HOLDING the band, which
    -- is not the stakes the caller picked. Its sentence goes through as it
    -- is (2026-09-09, 20260909181309); the exact-key index keeps GAME_EXISTS.
    IF SQLERRM LIKE 'ONE_GAME_PER_BLIND_CATEGORY:%' THEN
      RAISE;
    END IF;
    RAISE EXCEPTION 'GAME_EXISTS: this club already runs % % %', initcap(v_t), v_variant_label, v_label;
  END;

  -- The first table through the one cluster writer. A must-move game's
  -- Main 1 is kept open by the controller (R3); a manual table lives and
  -- dies with its host.
  --
  -- LIGHTNING 2.0 PHASE 3, the hard requirement: a Lightning-capable
  -- Cluster's ONE initial physical table has role = FEEDER. It becomes
  -- Main 1 the moment a second table opens beside it, through the tick's
  -- ordinary ROLES step, which is what keeps must-move unchanged.
  IF v_lightning THEN
    v_table_id := public.fn_cash_cluster_open_table(v_game_id, 'feeder', NULL, 'live', v_uid);
  ELSE
    v_table_id := public.fn_cash_cluster_open_table(v_game_id, 'main', 1, 'live', v_uid);
  END IF;


  IF v_lightning THEN
    -- Start the ORIGINAL conversion in the create transaction. A new anchor
    -- cannot become visible and deal ordinary cash before its pool takes over.
    PERFORM public.fn_cash_cluster_lightning_drive(v_game_id);
  END IF;
  RETURN jsonb_build_object('ok', true, 'game_id', v_game_id, 'table_id', v_table_id,
                            'name', v_name, 'must_move', v_must_move,
                            'lightning_enabled', v_lightning, 'snapshot', v_snap);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_cash_game_ensure(p_club_id uuid, p_variant text, p_sb numeric, p_bb numeric, p_template text DEFAULT 'classic'::text, p_handedness integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  g record; v_def jsonb; v_snap jsonb; v_id uuid; v_union uuid;
  v_t text := lower(coalesce(p_template, 'classic'));
  v_v text := lower(p_variant);
  v_label text; v_variant_label text; v_name text; v_seats integer; v_choices integer[];
BEGIN
  IF v_t NOT IN ('classic', 'action', 'madness') THEN v_t := 'classic'; END IF;

  -- THE TEMPLATE IS PART OF THE KEY (2026-09-09). Classic keeps every stake and
  -- Action and Madness run one game per blind band, so the same club can - and
  -- the platform club does, on 29 keys - hold all three at the same stakes. A
  -- key matched on (club, variant, sb, bb) alone returned whichever was oldest,
  -- and on that club the oldest was Action for NLH 1/2 and Madness for PLO6
  -- 2/5: an order for a Classic game was answered with a game that charges an
  -- ante. A game ensured under one template is never another.
  SELECT * INTO g FROM public.cash_games
   WHERE club_id = p_club_id AND variant = v_v AND sb = p_sb AND bb = p_bb
     AND template_name = v_t
   ORDER BY enabled DESC, created_at LIMIT 1;
  IF FOUND THEN
    IF NOT g.enabled THEN
      UPDATE public.cash_games SET enabled = true, closed_at = NULL, closed_by = NULL, updated_at = now()
       WHERE id = g.id;
      INSERT INTO public.cash_cluster_events (game_id, kind, payload)
      VALUES (g.id, 'game_woken', jsonb_build_object('by', 'fn_cash_game_ensure'));
    END IF;
    -- A game with no open table at all: Main 1 is opened, as at creation.
    IF NOT EXISTS (SELECT 1 FROM public.tables t WHERE t.cluster_id = g.id AND t.lifecycle <> 'closed'
                    AND coalesce(t.is_deleted, false) = false) THEN
      PERFORM public.fn_cash_cluster_open_table(g.id, 'main', 1, 'live', NULL);
    END IF;
    RETURN g.id;
  END IF;

  v_def := public.fn_cash_template_defaults(v_t, v_v);
  -- HANDEDNESS IS ONE OF THE TEMPLATE'S CHOICES, as fn_cash_game_create already
  -- requires of a host (HANDEDNESS_INVALID). A machine caller that asks for a
  -- size the template does not offer gets the template's default rather than a
  -- refusal that would strand the open order, and the event records both
  -- numbers so the difference is readable rather than silent.
  SELECT array_agg(x::integer) INTO v_choices FROM jsonb_array_elements_text(v_def->'seat_choices') x;
  IF (v_def->>'seats_locked')::boolean THEN
    v_seats := (v_def->>'seats')::integer;
  ELSIF p_handedness IS NOT NULL AND p_handedness = ANY (v_choices) THEN
    v_seats := p_handedness;
  ELSE
    v_seats := (v_def->>'seats')::integer;
  END IF;

  -- table_mode was missing from every snapshot this function wrote. must_move
  -- is the column of record and this function always creates a must-move game.
  v_snap := v_def || jsonb_build_object('seats', v_seats, 'sb', p_sb, 'bb', p_bb,
                                        'table_mode', 'must_move',
                                        'resolved_at', to_jsonb(clock_timestamp()),
                                        'created_by', 'fn_cash_game_ensure');
  v_variant_label := CASE v_v
    WHEN 'nlh' THEN 'NLH' WHEN 'plo4' THEN 'PLO4' WHEN 'plo5' THEN 'PLO5' WHEN 'plo6' THEN 'PLO6'
    WHEN 'plo8' THEN 'PLO8' WHEN 'flo8' THEN 'FLO8' WHEN 'flh' THEN 'FLH'
    WHEN 'short_deck' THEN 'Short Deck' WHEN 'pineapple' THEN 'Pineapple' ELSE upper(v_v) END;
  v_label := public.fn_cash_stakes_label(p_sb, p_bb, v_v);
  v_name := left(v_variant_label || ' ' || v_label || ' ' || initcap(v_t), 60);
  SELECT u.id INTO v_union
    FROM public.fn_club_union_context(p_club_id) ctx
    JOIN public.unions u ON u.id = COALESCE(ctx.own_union_id, ctx.member_union_id);

  INSERT INTO public.cash_games
    (club_id, union_id, name, template_name, variant, sb, bb, handedness, ruleset_snapshot, created_by, must_move)
  VALUES
    (p_club_id, v_union, v_name, v_t, v_v, p_sb, p_bb, v_seats, v_snap, NULL, true)
  RETURNING id INTO v_id;
  PERFORM public.fn_cash_cluster_open_table(v_id, 'main', 1, 'live', NULL);
  INSERT INTO public.cash_cluster_events (game_id, kind, payload)
  VALUES (v_id, 'game_created', jsonb_build_object('name', v_name, 'must_move', true,
                                                   'by', 'fn_cash_game_ensure',
                                                   'template', v_t,
                                                   'seats', v_seats, 'seats_asked', p_handedness));
  RETURN v_id;
END;
$function$
;
