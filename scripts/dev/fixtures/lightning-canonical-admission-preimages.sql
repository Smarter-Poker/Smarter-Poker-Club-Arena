CREATE OR REPLACE FUNCTION public.fn_cash_game_join(p_game_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  g record; s record; t record; h record;
  v_position integer; v_count integer;
  v_hold_ttl CONSTANT interval := interval '60 seconds';
  v_hold_until timestamptz;
  v_probe_table uuid;
  v_need numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED: sign in to join a game' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND: %', p_game_id; END IF;

  -- Share the offer-user claim before reading/expiring holds. A vacancy on
  -- another table cannot create a second hold between this read and insert.
  -- The offer takes this key nonblocking while it owns a table claim.
  PERFORM pg_advisory_xact_lock(hashtextextended('waitlist_offer_user:' || v_uid::text,0));
  -- A private game is a club boundary, not permission to use another club wallet.
  IF (coalesce((g.ruleset_snapshot #>> '{options,is_private}')::boolean, false)
      OR EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=g.club_id AND c.is_public=false))
     AND NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=g.club_id AND c.owner_id=v_uid)
     AND NOT EXISTS(SELECT 1 FROM public.club_members cm WHERE cm.club_id=g.club_id
                    AND cm.user_id=v_uid AND cm.status IN ('active','approved')) THEN
    RAISE EXCEPTION 'PRIVATE_MEMBERSHIP_REQUIRED: approved club membership required'
      USING ERRCODE='42501';
  END IF;
  IF NOT g.enabled THEN
    RAISE EXCEPTION 'GAME_CLOSED: this game is not taking players' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=g.club_id AND c.asset='diamonds') THEN
    IF NOT public.fn_caller_session_is_live() THEN
      RAISE EXCEPTION 'SESSION_REVOKED: sign in again to join this game' USING ERRCODE='28000';
    END IF;
  END IF;
  -- Booted for low VPIP: no seat in this game until the bar lifts (Dan 2026-09-05).
  IF public.fn_cash_game_barred_seconds(g.id, v_uid) IS NOT NULL THEN
    RAISE EXCEPTION 'GAME_BARRED:%', public.fn_cash_game_barred_seconds(g.id, v_uid) USING ERRCODE = 'check_violation';
  END IF;

  -- Already in the game: say where.
  SELECT ts.table_id, ts.seat_number, tb.name, tb.role, tb.main_index
    INTO s
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE ts.user_id = v_uid AND ts.left_at IS NULL AND tb.cluster_id = g.id AND tb.lifecycle <> 'closed'
   LIMIT 1;
  IF FOUND THEN
    UPDATE public.cash_game_waitlist SET status = 'seated', updated_at = now()
     WHERE game_id = g.id AND user_id = v_uid AND status IN ('waiting', 'notified');
    RETURN jsonb_build_object('ok', true, 'action', 'seated', 'table_id', s.table_id,
                              'seat_number', s.seat_number, 'table_name', s.name,
                              'role', s.role, 'main_index', s.main_index);
  END IF;

  IF EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=g.club_id AND c.asset='diamonds')
     AND g.cluster_mode IS DISTINCT FROM 'must_move' THEN
    RAISE EXCEPTION 'GAME_CLOSED: this Diamond game is not taking new players' USING ERRCODE='23514';
  END IF;
  -- NO CHAIR IS HELD FOR A PLAYER WHO CANNOT PAY FOR IT (Dan 2026-10-12: "A
  -- player should not be able to hold a seat if they don't have sufficient
  -- chips. That should be checked before the seat is reserved."). The door
  -- used to hold a chair for sixty seconds first and let the buy-in refuse
  -- afterwards, which kept the chair from everyone behind them for nothing.
  -- Any wallet the buy-in could spend counts (fn_ca_cash_wallet_covers), and
  -- the figure is the game's own minimum for this player, rejoin floor
  -- included. Nothing has been written yet, so the refusal leaves no hold and
  -- no place in line.
  SELECT tb.id INTO v_probe_table
    FROM public.tables tb
   WHERE tb.cluster_id = g.id AND coalesce(tb.is_deleted, false) = false
     AND tb.lifecycle <> 'closed'
   ORDER BY (tb.lifecycle IN ('live', 'opening')) DESC, tb.created_at ASC
   LIMIT 1;
  IF v_probe_table IS NOT NULL THEN
    v_need := public.fn_ca_cash_entry_need(v_uid, v_probe_table);
    IF NOT public.fn_ca_cash_wallet_covers(v_uid, v_probe_table, NULL, v_need) THEN
      IF EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=g.club_id AND c.asset='diamonds') THEN
        IF EXISTS(SELECT 1 FROM public.diamond_debts d WHERE d.user_id=v_uid
           AND d.settled_at IS NULL AND d.amount>0) THEN
          RAISE EXCEPTION 'diamond_debt_requires_settlement' USING ERRCODE='55000';
        END IF;
        RAISE EXCEPTION 'INSUFFICIENT_SETTLED_DIAMONDS:%',v_need
          USING ERRCODE='check_violation',HINT='Settle or add Diamonds through the Diamond Wallet, then join the game.';
      END IF;
      RAISE EXCEPTION 'INSUFFICIENT_CHIPS:%', v_need
        USING ERRCODE = 'check_violation',
              HINT = 'Add chips through the cashier, then join the game.';
    END IF;
  END IF;

  -- THE DOOR HOLDS THE CHAIR IT HANDS OUT (2026-09-10). A 'seat' answer used
  -- to hold nothing, so two players told about the same last chair both got
  -- it and the second was refused at the buy-in door. The chair is held now
  -- with the same row the open-seat offer writes (notified, 60 s), which the
  -- buy-in gate, the open-seat count and the census already honour.
  --
  -- ASKING TWICE IS ONE HOLD. A caller already holding a live chair in this
  -- game is told the same table again and the hold is refreshed. (Their own
  -- hold is subtracted by fn_cash_game_open_seats, so without this a second
  -- click would move them to another table while the first hold stood.)
  SELECT w.id, w.table_id, tb.name, tb.role, tb.main_index
    INTO h
    FROM public.table_waitlist w JOIN public.tables tb ON tb.id = w.table_id
   WHERE w.user_id = v_uid AND w.status = 'notified' AND w.hold_expires_at > now()
     AND tb.cluster_id = g.id AND coalesce(tb.is_deleted, false) = false
     AND tb.status IN ('waiting', 'running', 'active') AND tb.lifecycle IN ('live', 'opening')
   ORDER BY w.hold_expires_at DESC LIMIT 1;
  IF FOUND THEN
    v_hold_until := now() + v_hold_ttl;
    UPDATE public.table_waitlist SET hold_expires_at = v_hold_until WHERE id = h.id;
    -- ONE LIVE HOLD PER PLAYER PER GAME, on this branch too: any other hold
    -- of theirs in this game lapses now.
    UPDATE public.table_waitlist w SET status = 'expired'
      FROM public.tables tb
     WHERE tb.id = w.table_id AND tb.cluster_id = g.id AND w.id <> h.id
       AND w.user_id = v_uid AND w.status = 'notified';
    UPDATE public.cash_game_waitlist SET status = 'notified', updated_at = now()
     WHERE game_id = g.id AND user_id = v_uid AND status IN ('waiting', 'notified');
    RETURN jsonb_build_object('ok', true, 'action', 'seat', 'table_id', h.table_id, 'table_name', h.name,
                              'role', h.role, 'main_index', h.main_index,
                              -- the chairs open TO THIS CALLER: the one they hold counts
                              'open_seats', public.fn_cash_game_open_seats(h.table_id) + 1,
                              'hold_expires_at', v_hold_until);
  END IF;

  -- The shortest live Main with an unreserved open chair, then the feeder
  -- (opening or live). Never a breaking or closed table. Each candidate is
  -- LOCKED on the key the buy-in gate takes for that table and re-read under
  -- the lock, so two callers in the same instant cannot both be handed the
  -- last chair: the second sees the first's hold and moves to the next
  -- candidate, or to the waitlist.
  FOR t IN
    SELECT tb.id, tb.name, tb.role, tb.main_index,
           (SELECT count(*) FROM public.table_seats ts WHERE ts.table_id = tb.id AND ts.left_at IS NULL) AS seated
      FROM public.tables tb
     WHERE tb.cluster_id = g.id AND coalesce(tb.is_deleted, false) = false
       AND tb.status IN ('waiting', 'running', 'active') AND tb.lifecycle IN ('live', 'opening')
       AND public.fn_cash_game_open_seats(tb.id) > 0
     ORDER BY (tb.role = 'feeder') ASC, seated ASC, tb.main_index ASC NULLS LAST, tb.created_at ASC
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('table_seat:' || t.id::text, 0));
    CONTINUE WHEN public.fn_cash_game_open_seats(t.id) <= 0;
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM public.tables tb WHERE tb.id = t.id
                                 AND tb.status IN ('waiting', 'running', 'active')
                                 AND tb.lifecycle IN ('live', 'opening'));
    v_hold_until := now() + v_hold_ttl;
    -- ONE LIVE HOLD PER PLAYER PER GAME: a hold of theirs on any other table
    -- of this game lapses now.
    UPDATE public.table_waitlist w SET status = 'expired'
      FROM public.tables tb
     WHERE tb.id = w.table_id AND tb.cluster_id = g.id AND w.table_id <> t.id
       AND w.user_id = v_uid AND w.status = 'notified';
    -- The hold: a live row of theirs at this table becomes it (keeping the
    -- place in line it already had), else one is written with position 0 -
    -- a line is 1-based, so 0 says "the join door's hold" without a schema change.
    UPDATE public.table_waitlist
       SET status = 'notified', notified_at = now(), hold_expires_at = v_hold_until
     WHERE table_id = t.id AND user_id = v_uid AND status IN ('waiting', 'notified');
    IF NOT FOUND THEN
      INSERT INTO public.table_waitlist (table_id, user_id, position, status, notified_at, hold_expires_at)
      VALUES (t.id, v_uid, 0, 'notified', now(), v_hold_until);
    END IF;
    UPDATE public.cash_game_waitlist SET status = 'notified', updated_at = now()
     WHERE game_id = g.id AND user_id = v_uid AND status IN ('waiting', 'notified');
    RETURN jsonb_build_object('ok', true, 'action', 'seat', 'table_id', t.id, 'table_name', t.name,
                              'role', t.role, 'main_index', t.main_index,
                              'open_seats', public.fn_cash_game_open_seats(t.id) + 1,
                              'hold_expires_at', v_hold_until);
  END LOOP;

  -- A LAPSED GAME OFFER IS NOT A PLACE IN LINE (2026-10-23). The caller sits
  -- nowhere in this game (answered above) and holds no live chair in it, so a
  -- 'notified' row of theirs is an offer that lapsed. It expires here and the
  -- caller joins the line afresh below, instead of being told 'waitlisted'
  -- by a row no offer pass will ever pick up again.
  UPDATE public.cash_game_waitlist w SET status = 'expired', updated_at = now()
   WHERE w.game_id = g.id AND w.user_id = v_uid AND w.status = 'notified'
     AND NOT EXISTS (SELECT 1 FROM public.table_waitlist hw JOIN public.tables tb ON tb.id = hw.table_id
                      WHERE hw.user_id = v_uid AND hw.status = 'notified'
                        AND coalesce(hw.hold_expires_at, hw.notified_at + v_hold_ttl) > now()
                        AND tb.cluster_id = g.id AND coalesce(tb.is_deleted, false) = false
                        AND tb.lifecycle <> 'closed');

  -- Nothing open anywhere: hold the place. One live row per game per player.
  INSERT INTO public.cash_game_waitlist (game_id, user_id, status)
  VALUES (g.id, v_uid, 'waiting')
  ON CONFLICT DO NOTHING;
  SELECT count(*) + 1 INTO v_position FROM public.cash_game_waitlist w
   WHERE w.game_id = g.id AND w.status IN ('waiting', 'notified')
     AND w.created_at < (SELECT created_at FROM public.cash_game_waitlist x
                          WHERE x.game_id = g.id AND x.user_id = v_uid AND x.status IN ('waiting', 'notified') LIMIT 1);
  SELECT count(*) INTO v_count FROM public.cash_game_waitlist w
   WHERE w.game_id = g.id AND w.status IN ('waiting', 'notified');
  RETURN jsonb_build_object('ok', true, 'action', 'waitlisted', 'position', v_position, 'waiting', v_count,
                            'opening_hold_since', g.opening_hold_since,
                            'tables', (SELECT count(*) FROM public.tables tb WHERE tb.cluster_id = g.id AND tb.lifecycle <> 'closed'
                                          AND coalesce(tb.is_deleted, false) = false));
END;
$function$

;

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
  v_lightning boolean := false;
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

  RETURN jsonb_build_object('ok', true, 'game_id', v_game_id, 'table_id', v_table_id,
                            'name', v_name, 'must_move', v_must_move,
                            'lightning_enabled', v_lightning, 'snapshot', v_snap);
END;
$function$;

