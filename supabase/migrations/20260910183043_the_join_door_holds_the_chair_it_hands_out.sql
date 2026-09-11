-- 20260910183043_the_join_door_holds_the_chair_it_hands_out
--
-- Version reserved by scripts/reserve-migration-version.sh (CLAUDE.md 4.5).
-- Lane B follow-up of the 2026-09-09 must-move audit, finding F6
-- (docs/audits/2026-09-09-must-move-audit/lane-B.md, follow-up 2026-09-10).
-- NOT applied by the lane; probed ROLLED BACK with psql and handed over.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  THE JOIN DOOR HOLDS THE CHAIR IT HANDS OUT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT WAS WRONG. `fn_cash_game_join` answered `action: 'seat'` with a
-- `table_id` and left the browser to call `atomic_table_buyin` for a chair at
-- that table. Between the two calls nothing held the chair: no
-- `table_waitlist` row, no reservation of any kind. Two players told about the
-- same last chair both got 'seat', and the second to reach the buy-in door was
-- refused (SQLSTATE 23505 on the seat uniqueness index, or `TABLE_SIZE: table
-- is full`). The 2026-09-09 client work recovers from that refusal, which is a
-- net; CLAUDE.md 10.12 says a net is not a fix and the live path must not hand
-- one chair to two people.
--
-- WHAT THIS DOES. On the 'seat' branch the door now writes the SAME hold the
-- open-seat offer path writes (`fn_offer_open_seat`): a `table_waitlist` row
-- `status = 'notified'`, `notified_at = now()`, `hold_expires_at = now() + 60s`
-- for that table and that player. Nothing else on the platform changes,
-- because everything else already honours that row:
--
--   - `atomic_table_buyin_before_maintenance_announcement_gate` counts live
--     notified holds of OTHER players against `max_players` and raises
--     `SEAT_RESERVED` when the chair is spoken for (its `w.user_id <>
--     p_user_id` is what admits the holder);
--   - `fn_cash_game_open_seats` and `fn_cash_cluster_census` subtract live
--     holds, so the planner, the lobby, the break step and this door itself
--     all read one chair fewer;
--   - the buy-in gate and the AFTER INSERT trigger `fn_seat_insert_cancel_waitlist`
--     both flip the holder's row to 'seated' when they sit;
--   - a lapsed hold stops counting the moment `hold_expires_at` passes (both
--     readers compare against the clock), and `fn_sweep_stale_waitlists` /
--     `fn_offer_open_seat` retire the row to 'expired' on their own sweeps.
--
-- THE THREE QUESTIONS, answered from the live bodies and then probed:
--
-- (a) THE SAME CALLER BUYING IN WITHIN THE MINUTE IS ADMITTED. The gate's hold
--     count is `WHERE w.status = 'notified' AND w.user_id <> p_user_id AND
--     COALESCE(w.hold_expires_at, w.notified_at + 60s) > now()`: the holder's
--     own row is excluded, so seats_taken + holds(others) < max_players and
--     they sit; their row becomes 'seated'. Probe S17.
--
-- (b) A SECOND CALLER IN THAT MINUTE IS TOLD THE TRUTH. This door selects only
--     tables with `fn_cash_game_open_seats(tb.id) > 0`, and that function
--     subtracts the first caller's live hold, so the held last chair is not
--     offered: the second caller gets the next table with a free chair, or the
--     game waitlist with the existing 'waitlisted' payload and copy. Probe S18.
--     And two callers in the SAME INSTANT cannot both be handed the chair: each
--     candidate is locked with `pg_advisory_xact_lock(hashtextextended(
--     'table_seat:' || id, 0))` - the very key the buy-in gate takes - and
--     re-read under the lock before the hold is written. Probe S21 runs the
--     race on two psql sessions.
--
-- (c) HORSES ARE PLAYERS (CLAUDE.md 10.5). A horse is seated by
--     HorseFleetManager through `atomic_table_buyin` - the SAME door, with the
--     same `SEAT_RESERVED` refusal, which `HorseBuyInRefusal.ts` already
--     classifies (`seat_reserved`) as an expected, counted seeding-race
--     outcome. A horse's own hold (an offer from `fn_offer_open_seat`, which
--     has offered chairs to horses since 2026-08-31) refuses a human exactly
--     the same way. The fleet never calls `fn_cash_game_join` (service_role
--     has no auth.uid(), and the door says NOT_AUTHENTICATED), so it neither
--     writes nor needs this hold. The fleet's "humans waiting" read
--     (`humansWaitingByTable`) counts a notified row as a person waiting for
--     that table, which is true, and it is bounded by the 60 s TTL. There is no
--     `is_horse` anywhere in this migration or in the bodies it relies on.
--
-- ASKING TWICE IS ONE HOLD. A caller who already holds a live chair in this
-- game is told the SAME table again and the hold is refreshed, never a second
-- row: without this, `fn_cash_game_open_seats` would subtract their own hold
-- and the second click would move them to another table while the first hold
-- still stood. When a caller is handed a chair on table X, any live hold they
-- held on another table of the same game is expired in the same statement.
-- One live hold per player per game, enforced in the door; one live row per
-- player per TABLE is already the partial unique index
-- `table_waitlist_one_active_per_player_uidx`. Probe S19.
--
-- WHAT `position = 0` MEANS. A row this door writes carries `position = 0` -
-- a place in a table's line is 1-based (`join_waitlist`), so 0 identifies the
-- join door's hold as DATA without a schema change. An existing 'waiting' row
-- at that table keeps its own position when it is turned into the hold.
--
-- WHAT IS DELIBERATELY UNCHANGED, and said so:
--   - The buy-in gate does not count the planner's pending must-move
--     reservations (`cash_seat_moves` pending, unlinked) as holds - so a
--     browser can still take a chair the controller has planned a move into,
--     and the move is refused `destination_full` (117 such cancellations in
--     the 24 h before the 2026-09-09 audit). Same defect class, different
--     door, a money path with fifteen migrations on it: measured and reported
--     in lane-B.md as F10, not folded in here.
--   - The lapsed-offer notification `fn_sweep_stale_waitlists` sends
--     ("Seat Offer Expired ... Join The Waitlist Again To Get Back In.") is
--     generic copy and lands on a lapsed join-door hold too. It is in-app only
--     (`_push: skip`) and true in substance (the offer expired); the second
--     sentence is lane G's copy to sharpen if Dan wants ("Tap Join Game Again").
--   - The response gains one additive key, `hold_expires_at`. No action and no
--     copy changes; `src/services/cashGameLobby.ts` (lane G) needs no edit -
--     the client navigates to `table_id` on 'seat' and ignores unknown keys.
--
-- MEASURED BEFORE. `fn_cash_game_join` live md5 65c5304a59da3882a540794de16fe9a7
-- (unchanged since 20260905064000). table_waitlist: 0 rows with position = 0.
--
-- ROLLBACK: restore `fn_cash_game_join` from
--   20260905064000_booted_for_low_vpip_is_barred_for_two_hours.sql. Holds this
--   door wrote lapse on their own within 60 s; none needs deleting.
--
-- ONE transaction (production DDL policy, CLAUDE.md section 2).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $migration$
BEGIN
  IF position('THE DOOR HOLDS THE CHAIR IT HANDS OUT' in
      (SELECT prosrc FROM pg_proc WHERE oid = 'public.fn_cash_game_join(uuid)'::regprocedure)) > 0 THEN
    RAISE NOTICE 'join door already applied';
    RETURN;
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fn_cash_game_join(uuid)'::regprocedure)
     <> '65c5304a59da3882a540794de16fe9a7' THEN
    RAISE EXCEPTION 'fn_cash_game_join is not the body this migration reviewed; re-read it before applying';
  END IF;

  EXECUTE $body$
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
  $body$;
END;
$migration$;

-- The door states who may call it (2026-09-05): unchanged, restated.
REVOKE ALL ON FUNCTION public.fn_cash_game_join(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_join(uuid) TO authenticated, service_role;

-- ── POST-APPLY ASSERTIONS ───────────────────────────────────────────────────
DO $assert$
DECLARE v_join text; v_gate text; v_open text;
BEGIN
  v_join := (SELECT prosrc FROM pg_proc WHERE oid = 'public.fn_cash_game_join(uuid)'::regprocedure);
  v_gate := (SELECT prosrc FROM pg_proc WHERE oid = 'public.atomic_table_buyin_before_maintenance_announcement_gate(uuid,uuid,integer,numeric,boolean,uuid,uuid)'::regprocedure);
  v_open := (SELECT prosrc FROM pg_proc WHERE oid = 'public.fn_cash_game_open_seats(uuid)'::regprocedure);

  IF position('THE DOOR HOLDS THE CHAIR IT HANDS OUT' in v_join) = 0
     OR position($q$INSERT INTO public.table_waitlist (table_id, user_id, position, status, notified_at, hold_expires_at)$q$ in v_join) = 0 THEN
    RAISE EXCEPTION 'the join door does not write the hold';
  END IF;
  IF position($q$pg_advisory_xact_lock(hashtextextended('table_seat:' || t.id::text, 0))$q$ in v_join) = 0 THEN
    RAISE EXCEPTION 'the join door does not take the buy-in gate''s table lock';
  END IF;
  -- The two readers this migration relies on must still honour the row, or
  -- the hold is a row nobody reads (CLAUDE.md 10.86 rule 3).
  IF position($q$w.user_id <> p_user_id$q$ in v_gate) = 0 OR position('SEAT_RESERVED' in v_gate) = 0 THEN
    RAISE EXCEPTION 'the buy-in gate no longer honours a notified hold the way this door relies on';
  END IF;
  IF position($q$w.status = 'notified' AND w.hold_expires_at > clock_timestamp()$q$ in v_open) = 0 THEN
    RAISE EXCEPTION 'fn_cash_game_open_seats no longer subtracts a live hold';
  END IF;
  IF position('is_horse' in v_join) > 0 THEN
    RAISE EXCEPTION 'the join door must not read is_horse (CLAUDE.md 10.5)';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.fn_cash_game_join(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a signed-in player can no longer call the join door';
  END IF;
  IF has_function_privilege('anon', 'public.fn_cash_game_join(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can call the join door';
  END IF;
END;
$assert$;

COMMIT;
