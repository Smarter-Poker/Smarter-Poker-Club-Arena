-- 20261023094000_a_lapsed_game_seat_offer_leaves_the_waitlist.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- public.cash_game_waitlist rows could stay 'notified' forever. The vacancy
-- offer (fn_offer_open_seat) moves a game row waiting -> notified and holds a
-- chair for sixty seconds, but it only ever expires or offers 'waiting' rows,
-- and fn_cash_game_join treated any 'notified' row as a live place in line.
-- Once that hold lapsed, or the player sat down through the offer and later
-- left, the row was neither offered again nor replaced, so the player could
-- never be offered a seat in that game again and rejoining said 'waitlisted'.
-- Verified 2026-10-23 09:35 UTC on row 6955c265 (notified since 2026-10-22
-- 09:23:17; seated at 09:23 through the offer, left at 09:57).
--
-- 1. fn_offer_open_seat: where it already expires lapsed table holds, a game
--    row 'notified' whose player is seated at the game becomes 'seated', and
--    one whose player holds no live chair there (same TTL rule) and sits
--    nowhere in it becomes 'expired'. Rows are claimed nonblocking.
-- 2. fn_cash_game_join: before queueing, a lapsed 'notified' row of the
--    caller expires, so the caller is queued afresh as 'waiting'.
-- 3. The existing lapsed rows are expired once (bounded, idempotent).
--
-- Unchanged: fairness among waiting players, hold durations, caps, money
-- paths, owners, SECURITY DEFINER, search_path and grants.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $preimage$
BEGIN
  IF md5(pg_get_functiondef('public.fn_offer_open_seat(uuid,interval,interval)'::regprocedure)) <> '6510bc1bcf94ebee1e7a609487a5cfe0'
     OR md5(pg_get_functiondef('public.fn_cash_game_join(uuid)'::regprocedure)) <> '74509184cb5f86df8056088e02228f0d' THEN
    RAISE EXCEPTION 'lapsed_game_offer_preimage_changed' USING ERRCODE='55000';
  END IF;
END $preimage$;
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
$function$;

CREATE OR REPLACE FUNCTION public.fn_offer_open_seat(p_table_id uuid, p_offer_ttl interval DEFAULT '00:01:00'::interval, p_entry_ttl interval DEFAULT '24:00:00'::interval)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tbl      record;
  v_next     record;
  v_notif_id uuid;
  v_expired  int := 0;
  v_cap      int := 1;
  v_selected boolean := false;
  v_game_id uuid;
  v_table_entry_id uuid;
  v_legacy_holds integer := 0;
  v_sweep_game uuid;
  v_sweep record;
BEGIN
  -- Share the actual seat admission key with cash-game joins and buy-ins.
  -- A busy table is left untouched; a caller may already hold sweep rows,
  -- so waiting for another claimant here can invert that caller's locks.
  IF p_table_id IS NOT NULL AND NOT pg_try_advisory_xact_lock(
       hashtextextended('table_seat:' || p_table_id::text, 0)) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_claim_busy');
  END IF;

  SELECT COALESCE(max_concurrent_holds, 1) INTO v_cap FROM public.waitlist_policy WHERE id;
  IF v_cap IS NULL THEN v_cap := 1; END IF;

  SELECT t.id, t.name, t.tournament_id, t.max_players, t.current_players
    INTO v_tbl
    FROM public.tables t
   WHERE t.id = p_table_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_not_found');
  END IF;

  IF v_tbl.tournament_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'tournament_table');
  END IF;

  -- The cached lobby count cannot authorize an exclusive chair offer.
  v_tbl.current_players := (SELECT count(*) FROM public.table_seats s
                            WHERE s.table_id=p_table_id AND s.left_at IS NULL);
  IF v_tbl.current_players >= COALESCE(v_tbl.max_players, 9) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'table_full');
  END IF;

  WITH dead AS (
    UPDATE public.table_waitlist
       SET status = 'expired'
     WHERE table_id = p_table_id
       AND status = 'notified'
       AND COALESCE(hold_expires_at, notified_at + p_offer_ttl) < now()
    RETURNING user_id
  )
  -- A lapsed hold is not a notification (Dan 2026-10-14).
  SELECT count(*) INTO v_expired FROM dead;

  -- A LAPSED GAME OFFER IS NO PLACE IN LINE (2026-10-23). A game list row
  -- moves waiting -> notified when this pass hands its player a chair. Once
  -- that chair is taken the row is 'seated'; once every hold of theirs in
  -- this game has lapsed and they sit nowhere in it, the row is 'expired',
  -- by the same TTL that just expired the table holds above. Left 'notified',
  -- the player could never be offered a seat in this game again and Join Game
  -- answered 'waitlisted' forever. Players genuinely waiting are untouched.
  -- Each row is claimed nonblocking, as the game queue below claims its
  -- candidates, so this pass never waits while it owns the table key.
  SELECT t.cluster_id INTO v_sweep_game FROM public.tables t WHERE t.id = p_table_id;
  IF v_sweep_game IS NOT NULL THEN
    FOR v_sweep IN
      SELECT w.id, w.user_id FROM public.cash_game_waitlist w
       WHERE w.game_id = v_sweep_game AND w.status = 'notified'
       ORDER BY w.created_at, w.id
    LOOP
      CONTINUE WHEN NOT pg_try_advisory_xact_lock(
        hashtextextended('waitlist_offer_user:' || v_sweep.user_id::text, 0));
      PERFORM 1 FROM public.cash_game_waitlist w
       WHERE w.id = v_sweep.id AND w.status = 'notified' FOR UPDATE SKIP LOCKED;
      CONTINUE WHEN NOT FOUND;
      UPDATE public.cash_game_waitlist w SET status = 'seated', updated_at = now()
       WHERE w.id = v_sweep.id AND w.status = 'notified'
         AND EXISTS (SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id = s.table_id
                      WHERE s.user_id = w.user_id AND s.left_at IS NULL
                        AND t.cluster_id = v_sweep_game AND t.lifecycle <> 'closed');
      CONTINUE WHEN FOUND;
      UPDATE public.cash_game_waitlist w SET status = 'expired', updated_at = now()
       WHERE w.id = v_sweep.id AND w.status = 'notified'
         AND NOT EXISTS (SELECT 1 FROM public.table_waitlist h JOIN public.tables t ON t.id = h.table_id
                          WHERE h.user_id = w.user_id AND h.status = 'notified'
                            AND COALESCE(h.hold_expires_at, h.notified_at + p_offer_ttl) > now()
                            AND t.cluster_id = v_sweep_game AND NOT COALESCE(t.is_deleted, false)
                            AND t.lifecycle <> 'closed');
    END LOOP;
  END IF;

  UPDATE public.table_waitlist
     SET status = 'expired'
   WHERE table_id = p_table_id
     AND status = 'waiting'
     AND created_at < now() - p_entry_ttl;

  UPDATE public.table_waitlist w
     SET status = 'seated'
   WHERE w.table_id = p_table_id
     AND w.status = 'waiting'
     AND EXISTS (
       SELECT 1 FROM public.table_seats s
        WHERE s.table_id = p_table_id
          AND s.left_at IS NULL
          AND s.user_id = w.user_id
     );

  -- This same reader also reserves pending non-swap seat moves. Re-read it
  -- after expiry and under the common table key, just like the join door.
  -- Pre-column offers retain their original notified_at + TTL reservation.
  -- The shared reader counts explicit hold_expires_at values only.
  SELECT count(*) INTO v_legacy_holds FROM public.table_waitlist h
   WHERE h.table_id=p_table_id AND h.status='notified'
     AND h.hold_expires_at IS NULL AND h.notified_at+p_offer_ttl>now();
  IF COALESCE(public.fn_cash_game_open_seats(p_table_id),0) <= v_legacy_holds THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'open_seats_already_held', 'offers_expired', v_expired
    );
  END IF;

  -- THE HEAD OF THE QUEUE, LOCKED, AND NOT ALREADY HOLDING A SEAT ELSEWHERE.
  -- A hold is exclusive, so handing one player several at once takes seats
  -- away from everybody behind them. Skipping a capped player leaves their
  -- place in line untouched: they are passed over for THIS seat only.
  --
  -- 2026-08-31 (Dan, binding: horses are never skipped): the is_horse
  -- exclusion that used to sit in this predicate is GONE. Whoever is first in
  -- line is offered the seat. The JOIN to profiles stays: it is no longer read
  -- to exclude anyone, but dropping it would newly qualify waitlist rows whose
  -- user has no profile row at all.
  FOR v_next IN
  SELECT w.id, w.user_id, COALESCE(p.is_horse, false) AS is_horse
    FROM public.table_waitlist w
    JOIN public.profiles p ON p.id = w.user_id
   WHERE w.table_id = p_table_id
     AND w.status = 'waiting'
     AND (
       v_cap = 0
       OR (
         SELECT count(*) FROM public.table_waitlist h
          WHERE h.user_id = w.user_id
            AND h.status = 'notified'
            AND COALESCE(h.hold_expires_at, h.notified_at + p_offer_ttl) > now()
       ) < v_cap
     )
   ORDER BY w.created_at, w.id
     FOR UPDATE OF w SKIP LOCKED
  LOOP
    -- Queue-row locks on different tables do not serialize this player's
    -- offer allowance. A nonblocking claim preserves other queue members'
    -- progress without waiting while this transaction owns a table key.
    CONTINUE WHEN NOT pg_try_advisory_xact_lock(
      hashtextextended('waitlist_offer_user:' || v_next.user_id::text, 0));
    CONTINUE WHEN v_cap > 0 AND (
      SELECT count(*) FROM public.table_waitlist h
       WHERE h.user_id=v_next.user_id AND h.status='notified'
         AND COALESCE(h.hold_expires_at,h.notified_at+p_offer_ttl)>now()
    ) >= v_cap;
    -- NO CHAIR IS HELD FOR A PLAYER WHO CANNOT PAY FOR IT (Dan 2026-10-12).
    -- A player in line whose wallets cannot cover this table's minimum is
    -- passed over for THIS seat and keeps their place, exactly as a capped
    -- player is above; the same rule for every player in line (10.5).
    CONTINUE WHEN NOT public.fn_ca_cash_wallet_covers(
      v_next.user_id, p_table_id, NULL,
      public.fn_ca_cash_entry_need(v_next.user_id, p_table_id));
    v_selected := true;
    EXIT;
  END LOOP;


  -- A game queue is admitted by this same vacancy event, not by another
  -- Join Game click or a repair worker. Table-specific FIFO keeps its priority.
  IF NOT v_selected THEN
    SELECT g.id INTO v_game_id
      FROM public.tables t JOIN public.cash_games g ON g.id=t.cluster_id
     WHERE t.id=p_table_id AND g.enabled
       AND t.lifecycle IN ('live','opening') AND t.status IN ('waiting','running','active')
       AND NOT coalesce(t.is_deleted,false);
    IF v_game_id IS NOT NULL THEN
      UPDATE public.cash_game_waitlist SET status='expired',updated_at=now()
       WHERE game_id=v_game_id AND status='waiting' AND created_at<=now()-p_entry_ttl;
      FOR v_next IN
        SELECT w.id,w.user_id,coalesce(p.is_horse,false) AS is_horse
          FROM public.cash_game_waitlist w JOIN public.profiles p ON p.id=w.user_id
         WHERE w.game_id=v_game_id AND w.status='waiting'
           AND w.created_at > now()-p_entry_ttl
         ORDER BY w.created_at,w.id
      LOOP
        -- Lock one candidate at a time. A cursor that locks the entire list
        -- would hide later eligible buyers from a simultaneous vacancy.
        PERFORM 1 FROM public.cash_game_waitlist w
         WHERE w.id=v_next.id AND w.status='waiting' FOR UPDATE SKIP LOCKED;
        CONTINUE WHEN NOT FOUND;
        CONTINUE WHEN NOT pg_try_advisory_xact_lock(
          hashtextextended('waitlist_offer_user:' || v_next.user_id::text,0));
        CONTINUE WHEN EXISTS(
          SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id=s.table_id
           WHERE s.user_id=v_next.user_id AND s.left_at IS NULL AND t.cluster_id=v_game_id);
        CONTINUE WHEN EXISTS(
          SELECT 1 FROM public.table_waitlist h JOIN public.tables t ON t.id=h.table_id
           WHERE h.user_id=v_next.user_id AND h.status='notified'
             AND coalesce(h.hold_expires_at,h.notified_at+p_offer_ttl)>now()
             AND t.cluster_id=v_game_id);
        CONTINUE WHEN v_cap>0 AND (
          SELECT count(*) FROM public.table_waitlist h
           WHERE h.user_id=v_next.user_id AND h.status='notified'
             AND coalesce(h.hold_expires_at,h.notified_at+p_offer_ttl)>now())>=v_cap;
        CONTINUE WHEN public.fn_cash_game_barred_seconds(v_game_id,v_next.user_id) IS NOT NULL;
        CONTINUE WHEN EXISTS(
          SELECT 1 FROM public.cash_games g WHERE g.id=v_game_id
            AND (coalesce((g.ruleset_snapshot #>> '{options,is_private}')::boolean,false)
                 OR EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=g.club_id AND c.is_public=false))
            AND NOT EXISTS(SELECT 1 FROM public.clubs c WHERE c.id=g.club_id AND c.owner_id=v_next.user_id)
            AND NOT EXISTS(SELECT 1 FROM public.club_members m WHERE m.club_id=g.club_id
                 AND m.user_id=v_next.user_id AND m.status IN ('active','approved')));
        CONTINUE WHEN NOT public.fn_ca_cash_wallet_covers(
          v_next.user_id,p_table_id,NULL,public.fn_ca_cash_entry_need(v_next.user_id,p_table_id));
        UPDATE public.cash_game_waitlist SET status='notified',updated_at=now()
         WHERE id=v_next.id AND status='waiting';
        INSERT INTO public.table_waitlist(table_id,user_id,position,status)
          VALUES(p_table_id,v_next.user_id,0,'waiting')
          ON CONFLICT (table_id,user_id) WHERE status IN ('waiting','notified')
          DO UPDATE SET status='waiting'
          RETURNING id INTO v_table_entry_id;
        v_next.id := v_table_entry_id;
        v_selected := true;
        EXIT;
      END LOOP;
    END IF;
  END IF;

  IF NOT v_selected THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'nobody_waiting', 'offers_expired', v_expired
    );
  END IF;

  UPDATE public.table_waitlist
     SET status = 'notified',
         notified_at = now(),
         hold_expires_at = now() + p_offer_ttl
   WHERE id = v_next.id;

  -- The notification row is written for every player alike, so the queue's
  -- audit trail is identical. Only the PUSH flag differs: a horse has no
  -- device to push to, which is the sanctioned identification-for-display use,
  -- and it reuses the `_push:skip` marker the expiry notification above
  -- already uses. It decides how a message is delivered, never whether a seat
  -- is offered.
  INSERT INTO public.notifications (user_id, type, title, message, data)
  VALUES (
    v_next.user_id,
    'waitlist_seat_open',
    'Seat Open',
    'A Seat Just Opened At ' || COALESCE(v_tbl.name, 'Your Waitlisted Table') ||
      '. It Is Held For You For 60 Seconds. Sit Down Now To Claim It.',
    CASE WHEN v_next.is_horse
         THEN jsonb_build_object('table_id', p_table_id, '_push', 'skip')
         ELSE jsonb_build_object('table_id', p_table_id)
    END
  )
  RETURNING id INTO v_notif_id;

  RETURN jsonb_build_object(
    'ok', true,
    'user_id', v_next.user_id,
    'table_name', v_tbl.name,
    'notification_id', v_notif_id,
    'hold_expires_in_seconds', EXTRACT(epoch FROM p_offer_ttl)::int,
    'offers_expired', v_expired
  );
END
$function$;


REVOKE ALL ON FUNCTION public.fn_offer_open_seat(uuid,interval,interval) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_offer_open_seat(uuid,interval,interval) TO service_role;

-- The rows already stranded: 'notified' with no live hold in the game and no
-- seat in it. Bounded and idempotent; a locked row is left for the offer pass.
DO $sweep$
DECLARE v_swept integer;
BEGIN
  WITH lapsed AS (
    SELECT w.id FROM public.cash_game_waitlist w
     WHERE w.status = 'notified'
       AND NOT EXISTS (SELECT 1 FROM public.table_waitlist h JOIN public.tables t ON t.id = h.table_id
                      WHERE h.user_id = w.user_id AND h.status = 'notified'
                        AND COALESCE(h.hold_expires_at, h.notified_at + interval '60 seconds') > now()
                        AND t.cluster_id = w.game_id AND NOT COALESCE(t.is_deleted, false)
                        AND t.lifecycle <> 'closed')
     AND NOT EXISTS (SELECT 1 FROM public.table_seats s JOIN public.tables t ON t.id = s.table_id
                      WHERE s.user_id = w.user_id AND s.left_at IS NULL
                        AND t.cluster_id = w.game_id AND t.lifecycle <> 'closed')
     ORDER BY w.updated_at
     LIMIT 5000
       FOR UPDATE OF w SKIP LOCKED
  ), swept AS (
    UPDATE public.cash_game_waitlist w SET status = 'expired', updated_at = now()
      FROM lapsed WHERE w.id = lapsed.id AND w.status = 'notified'
    RETURNING w.id
  )
  SELECT count(*) INTO v_swept FROM swept;
  RAISE NOTICE 'lapsed_game_offers_expired=%', v_swept;
END $sweep$;

COMMIT;
