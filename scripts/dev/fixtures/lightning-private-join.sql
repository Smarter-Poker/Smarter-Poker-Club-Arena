\set ON_ERROR_STOP on
CREATE SCHEMA auth;
CREATE ROLE authenticated;
CREATE ROLE anon;
CREATE ROLE service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE TABLE public.clubs(id uuid PRIMARY KEY,owner_id uuid,is_public boolean,asset text);
CREATE TABLE public.club_members(club_id uuid,user_id uuid,status text);
CREATE TABLE public.cash_games(id uuid PRIMARY KEY,club_id uuid,enabled boolean,cluster_mode text,ruleset_snapshot jsonb,opening_hold_since timestamptz);
CREATE TABLE public.tables(id uuid PRIMARY KEY,cluster_id uuid,name text,role text,main_index integer,lifecycle text,status text,is_deleted boolean,created_at timestamptz);
CREATE TABLE public.table_seats(table_id uuid,user_id uuid,left_at timestamptz,seat_number integer);
CREATE TABLE public.table_waitlist(id uuid DEFAULT gen_random_uuid(),table_id uuid,user_id uuid,position integer,status text,notified_at timestamptz,hold_expires_at timestamptz);
CREATE TABLE public.cash_game_waitlist(game_id uuid,user_id uuid,status text,updated_at timestamptz DEFAULT now(),created_at timestamptz DEFAULT now(),UNIQUE(game_id,user_id));
CREATE TABLE public.diamond_debts(user_id uuid,settled_at timestamptz,amount numeric);
CREATE FUNCTION public.fn_caller_session_is_live() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE FUNCTION public.fn_cash_game_barred_seconds(uuid,uuid) RETURNS integer LANGUAGE sql AS $$ SELECT NULL::integer $$;
CREATE FUNCTION public.fn_ca_cash_entry_need(uuid,uuid) RETURNS numeric LANGUAGE sql AS $$ SELECT 1::numeric $$;
-- Fixture models the demonstrated unrelated funded wallet: authorization must stop BEFORE it.
CREATE TABLE public.wallet_reads(n integer);
CREATE FUNCTION public.fn_ca_cash_wallet_covers(uuid,uuid,uuid,numeric) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN INSERT INTO wallet_reads VALUES(1); RETURN true; END $$;
CREATE FUNCTION public.fn_cash_game_open_seats(uuid) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
INSERT INTO clubs VALUES('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001',false,'chips');
INSERT INTO cash_games VALUES('30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',true,'must_move','{"options":{"is_private":true}}',NULL);
INSERT INTO tables VALUES('40000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','fixture','main',1,'live','waiting',false,now());
INSERT INTO club_members VALUES
('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002','active'),
('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000003','approved'),
('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000004','pending');

-- Exact current production predecessor, read without executing the door.
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


GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_join(uuid) TO authenticated;
CREATE SCHEMA witness;
GRANT USAGE ON SCHEMA witness TO authenticated;
CREATE FUNCTION witness.expect_denied(actor integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE result jsonb;
BEGIN
 PERFORM set_config('request.jwt.claim.sub','20000000-0000-0000-0000-'||lpad(actor::text,12,'0'),true);
 BEGIN
  result:=public.fn_cash_game_join('30000000-0000-0000-0000-000000000001');
  RAISE EXCEPTION 'PRIVATE_JOIN_EXPOSED: %',result->>'action';
 EXCEPTION WHEN insufficient_privilege THEN
  IF SQLERRM NOT LIKE 'PRIVATE_MEMBERSHIP_REQUIRED:%' THEN RAISE; END IF;
 END;
END $$;
CREATE FUNCTION witness.expect_allowed(actor integer) RETURNS void LANGUAGE plpgsql AS $$
DECLARE result jsonb;
BEGIN
 PERFORM set_config('request.jwt.claim.sub','20000000-0000-0000-0000-'||lpad(actor::text,12,'0'),true);
 result:=public.fn_cash_game_join('30000000-0000-0000-0000-000000000001');
 IF result->>'ok'<>'true' OR result->>'action'<>'seat' THEN RAISE EXCEPTION 'qualified actor refused'; END IF;
END $$;
