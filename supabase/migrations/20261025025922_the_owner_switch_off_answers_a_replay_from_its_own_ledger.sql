-- @live-proof: (SELECT count(*) = 2 FROM public.cash_games g WHERE g.id IN ('56d5d6f0-23e9-41b0-b407-852aa1026c2a', '681eb9e8-e9fd-4026-8ec6-64075b911d33') AND NOT g.enabled AND NOT g.lightning_enabled) AND (SELECT count(*) = 2 FROM public.cash_game_switch_off_requests r JOIN public.cash_cluster_events e ON e.id = r.event_id WHERE e.kind = 'game_switched_off_by_owner' AND e.request_id = r.request_id AND e.game_id = r.game_id AND r.request_id IN ('5b0f8f3e-6a7c-4a9e-9d51-2c4b7e1f0a11', 'c3e2d7a9-1f84-4b6d-8a2e-9b7c5d0e4f22'))
-- @live-proof: (SELECT position('cash_game_switch_off_requests' IN pg_get_functiondef('public.fn_cash_game_switch_off(uuid,uuid,text)'::regprocedure)) > 0 AND position('FROM public.cash_cluster_events' IN pg_get_functiondef('public.fn_cash_game_switch_off(uuid,uuid,text)'::regprocedure)) = 0)
-- @live-proof: (SELECT count(*) = 3 FROM public.cash_game_switch_off_requests r WHERE r.event_id IN (621709, 1170409, 1170410))
-- 20261025025922_the_owner_switch_off_answers_a_replay_from_its_own_ledger.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- SUPERSEDES 20261024213143 (lightning_pilot_games_switch_off_so_the_horses_stand_up),
-- which never installed: apply-merged-migration runs 40147104607 and
-- 40149074985 were both REFUSED after ~8.1 s with
--   ERROR 57014: canceling statement due to statement timeout
--   SQL statement "SELECT * FROM public.cash_cluster_events e
--     WHERE e.game_id = p_game_id AND e.kind = 'game_switched_off_by_owner'
--       AND e.request_id = p_request_id LIMIT 1"
--   PL/pgSQL function fn_cash_game_switch_off(uuid,uuid,text) line 31
-- Nothing committed either time.
--
-- THE ROOT CAUSE IS IN THE OWNER'S DOOR, NOT IN THE PILOT MIGRATION.
-- fn_cash_game_switch_off (20261017144031) answers a replayed request by
-- reading the cluster event log through cash_cluster_events_by_game
-- (game_id, at DESC), filtering kind and request_id in the heap. That log is
-- 4 GB and ~5.0 M rows, and one Lightning game is a large share of it.
-- Measured read-only 2026-10-25 02:5x UTC with EXPLAIN (ANALYZE, BUFFERS) on
-- game 56d5d6f0: the index returns 1,199,527 rows, 71,919 heap blocks are
-- read, and the lookup takes 41,788 ms - to find nothing. authenticated's
-- statement_timeout is 8 s, so the same door refused the club owner from the
-- app too, for any busy game, while holding that game's row FOR UPDATE.
-- An index on (game_id, request_id) would have to read the whole 4 GB heap
-- under a SHARE lock on a table the cluster tick writes ~1,800 rows a minute
-- into; that cannot fit any install budget and would stall the controller.
--
-- THE FIX (10.11, at the line that was slow). The door keeps its own small
-- ledger, cash_game_switch_off_requests, keyed (game_id, request_id) - the
-- same key the lookup used, so the idempotency rule is unchanged: the same
-- request answers the same way, and a reused id with another actor or reason
-- is refused. It writes the ledger row in the same transaction as the event,
-- and answers a replay by primary key. No foreign key (CLAUDE.md section 2
-- rule 7): it must never lock cash_games or the event log.
--
-- BACKFILL. A full read of the event log (2026-10-25, kind =
-- 'game_switched_off_by_owner', every row) found exactly three switch-offs,
-- events 621709, 1170409 and 1170410; they are copied by primary key and
-- asserted. A switch-off sent between that read and this install is caught by
-- reading only games disabled since 2026-10-25 02:00 UTC and only their events
-- since then (5 ms, 0 games, when probed).
--
-- THEN STEP 2 OF 3 OF THE PILOT CLOSE, UNCHANGED FROM 20261024213143.
-- OWNER ORDER. Dan, 2026-10-24: "Two horses-only Lightning games are still
-- running in the old 'Lightning Internal Pilot' club, not Midway: NLH
-- 0.01/0.02 and NLH 0.02/0.04 ... FINISH THIS UP." Every game launches from
-- Midway Union only (20261024053530). 20261024201850 drained both games
-- through the operator door to must_move with every horse on its anchor seat
-- and stack. This switches each game off through the owner's own door, as the
-- club owner, with the same request ids and reason as 20261024213143. The door
-- writes enabled=false and its audit event; it moves no chip and no seat. The
-- horses stand up at the end of their hand through the ordinary per-seat
-- cash-out into their own club wallets, exactly as a person leaving a
-- switched-off game (#7841, CLAUDE.md 10.5); no table_seats row is deleted or
-- edited here (11.5 rule 3), and fn_cash_cluster_tick closes each table once it
-- is empty.
--
-- IDENTITY. Claims carry only sub (no role), which fn_caller_session_is_live
-- treats as the trusted migration context.
--
-- PROBED read-only 2026-10-25 (one DO block, transaction_read_only, ending in
-- RAISE): precondition 2 games (14 ms); session live (1 ms); owner may create
-- games (9 ms); seated 5 and 3 (6 ms); legacy events 3 (9 ms); catch-up 0
-- (5 ms); every post-assert false (41 ms). The one slow statement is the one
-- this file replaces.
--
-- REFUSES WHOLE unless the door is exactly the 20261017144031 body (md5
-- 805ef1821e0aa2e2f580a35cb290283a), both drains are complete and both games
-- read must_move with Lightning off and still enabled. Asserted after: both
-- games off with ledgered events, the door is exactly this file's body (md5
-- 3322d26f75e4f187a30cd15f398f1715, computed on native PostgreSQL 16, whose
-- pg_get_functiondef reproduces production's pre-image md5 byte for byte)
-- and no longer reads the event log, and
-- - by this transaction's own xid - no other game, no wallet, no treasury, no
-- seat and no table was written. No hot table is locked beyond the two game
-- rows the door already locks, so no install window is needed.

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '8s';

DO $guard$
BEGIN
  IF md5(pg_get_functiondef('public.fn_cash_game_switch_off(uuid,uuid,text)'::regprocedure))
     <> '805ef1821e0aa2e2f580a35cb290283a' THEN
    RAISE EXCEPTION 'fn_cash_game_switch_off is not the 20261017144031 body; re-read it before replacing';
  END IF;
  IF to_regclass('public.cash_game_switch_off_requests') IS NOT NULL THEN
    RAISE EXCEPTION 'cash_game_switch_off_requests already exists';
  END IF;
END $guard$;

CREATE TABLE public.cash_game_switch_off_requests (
  game_id uuid NOT NULL,
  request_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  reason text NOT NULL,
  event_id bigint NOT NULL,
  seated_at_switch_off integer,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, request_id)
);

COMMENT ON TABLE public.cash_game_switch_off_requests IS
  'One row per request fn_cash_game_switch_off has acted on, written in the same transaction as its game_switched_off_by_owner event (event_id). The door answers a replayed request from here by primary key; reading the cluster event log for it took 41 s on a busy game. No foreign keys: it must never lock cash_games or cash_cluster_events.';

ALTER TABLE public.cash_game_switch_off_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cash_game_switch_off_requests FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.cash_game_switch_off_requests TO service_role;

-- Every switch-off the door has made so far, read in full on 2026-10-25.
INSERT INTO public.cash_game_switch_off_requests
  (game_id, request_id, actor_id, reason, event_id, seated_at_switch_off, at)
SELECT e.game_id, e.request_id, (e.payload ->> 'actor_id')::uuid, e.payload ->> 'reason',
       e.id, (e.payload ->> 'seated_at_switch_off')::integer, e.at
  FROM public.cash_cluster_events e
 WHERE e.id IN (621709, 1170409, 1170410)
   AND e.kind = 'game_switched_off_by_owner';

-- Any sent after that read and before this install.
INSERT INTO public.cash_game_switch_off_requests
  (game_id, request_id, actor_id, reason, event_id, seated_at_switch_off, at)
SELECT e.game_id, e.request_id, (e.payload ->> 'actor_id')::uuid, e.payload ->> 'reason',
       e.id, (e.payload ->> 'seated_at_switch_off')::integer, e.at
  FROM public.cash_games g
  JOIN public.cash_cluster_events e
    ON e.game_id = g.id AND e.at >= timestamptz '2026-10-25 02:00:00+00'
 WHERE NOT g.enabled
   AND g.updated_at >= timestamptz '2026-10-25 02:00:00+00'
   AND e.kind = 'game_switched_off_by_owner'
   AND e.request_id IS NOT NULL
   AND e.id > 1170410
ON CONFLICT (game_id, request_id) DO NOTHING;

DO $backfill$
BEGIN
  IF (SELECT count(*) FROM public.cash_game_switch_off_requests
       WHERE event_id IN (621709, 1170409, 1170410)) <> 3 THEN
    RAISE EXCEPTION 'the three recorded switch-offs did not all copy into the ledger';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cash_game_switch_off_requests
              WHERE reason IS NULL OR length(btrim(reason)) < 12) THEN
    RAISE EXCEPTION 'a ledgered switch-off carries no reason';
  END IF;
END $backfill$;

CREATE OR REPLACE FUNCTION public.fn_cash_game_switch_off(
  p_game_id uuid,
  p_request_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  g record;
  v_prior record;
  v_event_id bigint;
  v_seated integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT public.fn_caller_session_is_live() THEN
    RAISE EXCEPTION 'SESSION_REVOKED: this session is signed out - sign in again'
      USING ERRCODE = '28000';
  END IF;
  IF p_game_id IS NULL OR p_request_id IS NULL OR length(v_reason) < 12 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_request');
  END IF;

  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'game_not_found');
  END IF;
  IF NOT public.fn_can_create_games(g.club_id, v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authorized');
  END IF;

  -- The same request answers the same way; a reused id with another actor or
  -- reason is refused rather than read as permission. Answered from the
  -- door's own ledger by primary key: the cluster event log holds over a
  -- million rows for one busy game, and reading it here took 41 s.
  SELECT * INTO v_prior FROM public.cash_game_switch_off_requests r
   WHERE r.game_id = p_game_id AND r.request_id = p_request_id;
  IF FOUND THEN
    IF v_prior.actor_id IS DISTINCT FROM v_uid
       OR v_prior.reason IS DISTINCT FROM v_reason THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'idempotency_conflict');
    END IF;
    RETURN jsonb_build_object('ok', true, 'game_id', p_game_id, 'enabled', g.enabled,
                              'replayed', true, 'event_id', v_prior.event_id);
  END IF;

  IF NOT g.enabled THEN
    RETURN jsonb_build_object('ok', true, 'game_id', p_game_id, 'enabled', false,
                              'already', true);
  END IF;
  IF coalesce(g.lightning_enabled, false) OR g.cluster_mode IS DISTINCT FROM 'must_move' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lightning_state_requires_operator_drain',
                              'cluster_mode', g.cluster_mode,
                              'lightning_enabled', g.lightning_enabled);
  END IF;

  SELECT count(*)::integer INTO v_seated
    FROM public.table_seats ts JOIN public.tables t ON t.id = ts.table_id
   WHERE t.cluster_id = g.id AND ts.left_at IS NULL;

  UPDATE public.cash_games SET enabled = false, updated_at = now() WHERE id = g.id;
  INSERT INTO public.cash_cluster_events (game_id, kind, request_id, cluster_epoch, payload)
  VALUES (g.id, 'game_switched_off_by_owner', p_request_id, g.cluster_epoch,
          jsonb_build_object('actor_id', v_uid::text, 'reason', v_reason,
                             'seated_at_switch_off', v_seated))
  RETURNING id INTO v_event_id;
  INSERT INTO public.cash_game_switch_off_requests
    (game_id, request_id, actor_id, reason, event_id, seated_at_switch_off)
  VALUES (g.id, p_request_id, v_uid, v_reason, v_event_id, v_seated);

  RETURN jsonb_build_object('ok', true, 'game_id', g.id, 'enabled', false,
                            'replayed', false, 'event_id', v_event_id,
                            'seated_at_switch_off', v_seated);
END;
$fn$;

COMMENT ON FUNCTION public.fn_cash_game_switch_off(uuid, uuid, text) IS
  'The club owner''s switch for a running cash game (OPORD 18.4: no seeding, no opening; empties close). Sets enabled = false only: never stands anyone up, moves a seat, touches a stack, closes a table or writes money; fn_cash_cluster_tick closes each table once it is empty. Refuses any Lightning state. Idempotent on (p_game_id, p_request_id) through cash_game_switch_off_requests.';

REVOKE ALL ON FUNCTION public.fn_cash_game_switch_off(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_cash_game_switch_off(uuid, uuid, text) TO authenticated, service_role;

DO $switch_off$
DECLARE
  c_club  constant uuid := 'e14bc9f7-736d-425f-8f2c-e78305ebac1d';
  c_owner constant uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
  c_games constant uuid[] := ARRAY[
    '56d5d6f0-23e9-41b0-b407-852aa1026c2a', -- NLH 0.01/0.02 Lightning Games
    '681eb9e8-e9fd-4026-8ec6-64075b911d33'  -- NLH 0.02/0.04 Lightning Games
  ]::uuid[];
  c_requests constant uuid[] := ARRAY[
    '5b0f8f3e-6a7c-4a9e-9d51-2c4b7e1f0a11',
    'c3e2d7a9-1f84-4b6d-8a2e-9b7c5d0e4f22'
  ]::uuid[];
  c_reason constant text :=
    'Owner order 2026-10-24: every game launches from Midway Union only; the Lightning Internal Pilot games stop and close. Switched off after the operator drain; players leave through the normal cash-out.';
  v_me xid := pg_current_xact_id()::xid;
  v_n integer;
  v_answer jsonb;
  k integer;
BEGIN
  SELECT count(*) INTO v_n FROM public.cash_games g
   WHERE g.id = ANY (c_games) AND g.club_id = c_club AND g.enabled AND g.closed_at IS NULL
     AND NOT coalesce(g.lightning_enabled, false) AND g.cluster_mode = 'must_move'
     AND EXISTS (SELECT 1 FROM public.lightning_cluster_drain d
                  WHERE d.cluster_id = g.id
                    AND d.request_id IN ('9c321e6b-83a0-4548-8304-7f107c36a48c', '0492c919-d84a-404e-ab32-1f0d8f2190f2')
                    AND d.completed_at IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM public.lightning_cluster_drain d
                      WHERE d.cluster_id = g.id AND d.completed_at IS NULL);
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'expected both pilot games drained to must_move and still enabled, found %', v_n;
  END IF;

  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', c_owner::text)::text, true);
  FOR k IN 1 .. 2 LOOP
    v_answer := public.fn_cash_game_switch_off(c_games[k], c_requests[k], c_reason);
    IF coalesce((v_answer ->> 'ok')::boolean, false) IS NOT TRUE
       OR coalesce((v_answer ->> 'replayed')::boolean, true) THEN
      RAISE EXCEPTION 'the owner door did not switch off %: %', c_games[k], v_answer;
    END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claims', '', true);

  SELECT count(*) INTO v_n FROM public.cash_games g
   WHERE g.id = ANY (c_games) AND NOT g.enabled AND g.closed_at IS NULL;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'the two pilot games are not both switched off (%)', v_n;
  END IF;
  SELECT count(*) INTO v_n
    FROM public.cash_game_switch_off_requests r
    JOIN public.cash_cluster_events e ON e.id = r.event_id
   WHERE r.game_id = ANY (c_games) AND r.request_id = ANY (c_requests)
     AND e.game_id = r.game_id AND e.request_id = r.request_id
     AND e.kind = 'game_switched_off_by_owner' AND r.actor_id = c_owner;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'the two switch-offs are not both ledgered against their events (%)', v_n;
  END IF;
  IF md5(pg_get_functiondef('public.fn_cash_game_switch_off(uuid,uuid,text)'::regprocedure))
     <> '3322d26f75e4f187a30cd15f398f1715' THEN
    RAISE EXCEPTION 'the owner door is not the body this file wrote';
  END IF;
  IF position('FROM public.cash_cluster_events' IN
       pg_get_functiondef('public.fn_cash_game_switch_off(uuid,uuid,text)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'the owner door still reads the cluster event log';
  END IF;
  IF EXISTS (SELECT 1 FROM public.cash_games WHERE xmin = v_me AND NOT (id = ANY (c_games))) THEN
    RAISE EXCEPTION 'a game outside the two pilot games changed';
  END IF;
  IF EXISTS (SELECT 1 FROM public.club_members WHERE xmin = v_me)
     OR EXISTS (SELECT 1 FROM public.clubs WHERE xmin = v_me)
     OR EXISTS (SELECT 1 FROM public.table_seats WHERE left_at IS NULL AND xmin = v_me)
     OR EXISTS (SELECT 1 FROM public.tables t WHERE t.cluster_id = ANY (c_games) AND t.xmin = v_me) THEN
    RAISE EXCEPTION 'the switch-off wrote a wallet, treasury, seat or table row';
  END IF;
END $switch_off$;

COMMIT;
