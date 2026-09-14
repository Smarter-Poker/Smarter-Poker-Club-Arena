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
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED: sign in to join a game' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'GAME_NOT_FOUND: %', p_game_id; END IF;
  IF NOT g.enabled THEN
    RAISE EXCEPTION 'GAME_CLOSED: this game is not taking players' USING ERRCODE = 'check_violation';
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

CREATE OR REPLACE FUNCTION public.fn_cash_game_open_seats(p_table_id uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT GREATEST(0,
           coalesce(t.max_players, 9)
           - (SELECT count(*) FROM public.table_seats ts WHERE ts.table_id = t.id AND ts.left_at IS NULL)
           - (SELECT count(*) FROM public.table_waitlist w
               WHERE w.table_id = t.id AND w.status = 'notified' AND w.hold_expires_at > clock_timestamp())
           - (SELECT count(*) FROM public.cash_seat_moves m
               WHERE m.to_table_id = t.id AND m.state = 'pending' AND m.swap_move_id IS NULL))::integer
    FROM public.tables t WHERE t.id = p_table_id;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_sweep_stale_waitlists(p_offer_ttl interval DEFAULT '00:01:00'::interval, p_entry_ttl interval DEFAULT '24:00:00'::interval)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_offers_expired  int := 0;
  v_entries_expired int := 0;
  v_seated_retired  int := 0;
  v_reoffered       int := 0;
  v_tables          uuid[] := '{}';
  v_tid             uuid;
  v_res             jsonb;
BEGIN
  -- 1. LAPSED OFFERS. Judged by the row's own hold_expires_at, falling back to
  --    notified_at + TTL for rows written before the hold column existed.
  WITH dead AS (
    UPDATE public.table_waitlist w
       SET status = 'expired'
     WHERE w.status = 'notified'
       AND COALESCE(w.hold_expires_at, w.notified_at + p_offer_ttl) < now()
    RETURNING w.user_id, w.table_id
  ), ins AS (
    INSERT INTO public.notifications (user_id, type, title, message, data)
    SELECT d.user_id,
           'waitlist_offer_expired',
           'Seat Offer Expired',
           'Your Seat At ' || COALESCE(t.name, 'The Table') ||
             ' Went To The Next Player In Line. Join The Waitlist Again To Get Back In.',
           jsonb_build_object('table_id', d.table_id, '_push', 'skip')
      FROM dead d
      LEFT JOIN public.tables t ON t.id = d.table_id
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM ins),
         COALESCE((SELECT array_agg(DISTINCT d.table_id) FROM dead d), '{}')
    INTO v_offers_expired, v_tables;

  -- 2. ABANDONED PLACES IN LINE.
  UPDATE public.table_waitlist
     SET status = 'expired'
   WHERE status = 'waiting'
     AND created_at < now() - p_entry_ttl;
  GET DIAGNOSTICS v_entries_expired = ROW_COUNT;

  -- 3. ALREADY SITTING.
  UPDATE public.table_waitlist w
     SET status = 'seated'
   WHERE w.status = 'waiting'
     AND EXISTS (
       SELECT 1 FROM public.table_seats s
        WHERE s.table_id = w.table_id
          AND s.left_at IS NULL
          AND s.user_id = w.user_id
     );
  GET DIAGNOSTICS v_seated_retired = ROW_COUNT;

  -- 4. STALLED QUEUES. Any table with people waiting and no live hold is a
  --    queue that is not moving. Include the tables we just expired an offer
  --    on, so the "went to the next player" notification is true.
  SELECT COALESCE(array_agg(DISTINCT tid), '{}')
    INTO v_tables
    FROM (
      SELECT unnest(v_tables) AS tid
      UNION
      SELECT w.table_id
        FROM public.table_waitlist w
       WHERE w.status = 'waiting'
         AND NOT EXISTS (
           SELECT 1 FROM public.table_waitlist h
            WHERE h.table_id = w.table_id
              AND h.status = 'notified'
              AND COALESCE(h.hold_expires_at, h.notified_at + p_offer_ttl) > now()
         )
       LIMIT 200
    ) s;

  -- 5. ADVANCE THE QUEUE through the ONE function that makes an offer.
  FOREACH v_tid IN ARRAY v_tables LOOP
    v_res := public.fn_offer_open_seat(v_tid, p_offer_ttl, p_entry_ttl);
    IF COALESCE((v_res ->> 'ok')::boolean, false) THEN
      v_reoffered := v_reoffered + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', true,
    'offers_expired', v_offers_expired,
    'entries_expired', v_entries_expired,
    'seated_retired', v_seated_retired,
    'seats_reoffered', v_reoffered,
    'tables_scanned', COALESCE(array_length(v_tables, 1), 0)
  );
END
$function$
;

CREATE OR REPLACE FUNCTION public.fn_cash_game_barred_seconds(p_game_id uuid, p_user_id uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT ceil(extract(epoch FROM (max(c.barred_until) - now())))::integer
    FROM public.cash_games g
    JOIN public.cash_rejoin_constraints c
      ON c.player_id = p_user_id AND c.club_id = g.club_id AND c.variant = g.variant
     AND c.sb = g.sb AND c.bb = g.bb AND c.barred_until > now()
   WHERE g.id = p_game_id
  HAVING max(c.barred_until) IS NOT NULL;
$function$
;
