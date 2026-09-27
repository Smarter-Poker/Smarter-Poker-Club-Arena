-- A RECORDED BUST THAT NOBODY CAN RECORD STOPS THE WHOLE EVENT (2026-09-27).
--
-- Incident: three large MTTs stopped dealing with hundreds of players seated.
-- The engine logged `f06_movement_admission_unproven` 210x/2min. That token is
-- the engine's mask for ANY error out of `fn_f06_admit_parked_movement`
-- (TournamentManager.ts: `if (!current() || error) throw`). Reproduced on the
-- live rows, the database's own refusal is
-- `F06_MOVEMENT_ELIMINATION_UNPROVEN` from `smarter_private.f06_movement_prior`:
--
--   IF seat.stack=0 THEN
--     IF seat.left_at IS NULL OR registration.status<>'eliminated'
--        OR registration.eliminated_at IS NULL THEN
--       RAISE EXCEPTION 'F06_MOVEMENT_ELIMINATION_UNPROVEN';
--
-- A table cannot hand over its movement proof while one chair it dealt to
-- holds zero chips and the roster still calls that player `playing`. So the
-- break never admits, the table never breaks, and the event stops.
--
-- WHY THOSE ROWS EXIST. A bust writes a `tournament_knockout_candidates` row
-- in state `pending`; the manager's elimination sweep then records it through
-- `fn_eliminate_tournament_player_atomic`. That sweep reads its whole backlog
-- before its first mutation, and the read phase is bounded by
-- SWEEP_WORK_BUDGET_MS (5s) with a single 5s grace "so this sweep commits at
-- least one finish". With a backlog of hundreds the reads spend the budget and
-- the pass commits ~1 finish, while new busts arrive faster. Measured on
-- production 2026-09-27 22:4x: c775d008 committed exactly one elimination in
-- eight minutes with 20 players queued; 618741a5 (212 queued) and ac10f59a
-- (96 queued) committed none. The backlog is self-sustaining, and every
-- un-recorded bust is one more chair the F06 proof refuses.
--
-- `fn_ca_release_broke_seats` and `fn_ca_eliminate_absent_tournament_players`
-- both step aside for exactly these players ("THE KNOCKOUT DOOR OWNS EVERY
-- BUST A HAND TOOK"), so no janitor reaches them either.
--
-- WHAT THIS DOES. It drives the SAME door the manager drives, with the SAME
-- ladder rule, so a backlog drains in one bounded transaction instead of one
-- finish per sweep. It invents no elimination logic: every proof
-- (settlement receipt wrote 0, knockout chain clean, no live seat with chips,
-- event RUNNING, not a bounty event) is `fn_eliminate_tournament_player_atomic`'s
-- own, unchanged.
--
-- WHAT IT REFUSES TO DO. It never assigns a place that is IN THE MONEY. The
-- place handed out while recording is provisional -- `fn_settle_tournament_places`
-- re-derives every place from bust commit time before it pays -- but a paid
-- place is priced by the manager from the live ladder pool, and this function
-- does not price money. It stops the moment the next free place reaches the
-- deepest paid place. It moves no chips, writes no ledger row, voids nothing.

CREATE TABLE IF NOT EXISTS smarter_private.ca_bust_backlog_drains (
  receipt_id      uuid PRIMARY KEY,
  tournament_id   uuid NOT NULL,
  requested_limit integer NOT NULL,
  dry_run         boolean NOT NULL,
  result          jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ca_bust_backlog_drains_tournament_idx
  ON smarter_private.ca_bust_backlog_drains (tournament_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.fn_ca_drain_recorded_bust_backlog(
  p_tournament_id uuid,
  p_receipt_id    uuid,
  p_limit         integer DEFAULT 25,
  p_dry_run       boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, smarter_private, extensions, pg_temp
AS $fn$
DECLARE
  v_prior   smarter_private.ca_bust_backlog_drains;
  v_t       public.tournaments%ROWTYPE;
  v_lim     integer;
  v_deep    integer;
  v_taken   integer[];
  v_unplaced integer;
  v_playing  integer;
  v_queued   integer;
  v_backlog  integer;
  v_seed     integer;
  v_place    integer;
  v_up       integer;
  v_ceiling  integer;
  v_res      jsonb;
  v_done     integer := 0;
  v_first    integer;
  v_last     integer;
  v_stop     text := 'backlog_drained';
  v_recorded jsonb := '[]'::jsonb;
  r          record;
  v_out      jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'CA_BUST_DRAIN_SERVICE_REQUIRED' USING ERRCODE='42501'; END IF;
  IF p_tournament_id IS NULL OR p_receipt_id IS NULL THEN
    RAISE EXCEPTION 'CA_BUST_DRAIN_IDENTITY' USING ERRCODE='22023'; END IF;
  v_lim := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);

  -- Replay is answered from the receipt, never re-run.
  SELECT * INTO v_prior FROM smarter_private.ca_bust_backlog_drains
   WHERE receipt_id = p_receipt_id;
  IF FOUND THEN
    IF (v_prior.tournament_id, v_prior.requested_limit, v_prior.dry_run)
       IS DISTINCT FROM (p_tournament_id, v_lim, COALESCE(p_dry_run,false)) THEN
      RAISE EXCEPTION 'CA_BUST_DRAIN_CHANGED_REPLAY' USING ERRCODE='22023'; END IF;
    RETURN v_prior.result;
  END IF;

  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION 'PLATFORM_FROZEN: bust backlog drain refused' USING ERRCODE='55000'; END IF;

  -- Same lane, same order, as the door this function drives.
  PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);

  SELECT * INTO v_t FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND OR v_t.status <> 'RUNNING' THEN
    RAISE EXCEPTION 'CA_BUST_DRAIN_EVENT_CHANGED' USING ERRCODE='55000'; END IF;
  IF COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false)
     OR COALESCE(v_t.is_mystery_bounty,false) THEN
    -- A bounty head is settled by the outbox claim, in hand-number order.
    RAISE EXCEPTION 'CA_BUST_DRAIN_BOUNTY_EVENT' USING ERRCODE='55000'; END IF;

  -- The money rail. An unreadable payout ladder is UNKNOWN, not "nothing paid".
  BEGIN
    SELECT max((e->>'place')::int) INTO v_deep
      FROM jsonb_array_elements(v_t.payout_structure::jsonb) e;
  EXCEPTION WHEN OTHERS THEN
    v_deep := NULL;
  END;
  IF v_deep IS NULL OR v_deep < 1 THEN
    RAISE EXCEPTION 'CA_BUST_DRAIN_PAYOUT_LADDER_UNREADABLE' USING ERRCODE='55000'; END IF;

  SELECT COALESCE(array_agg(position),'{}') INTO v_taken
    FROM public.tournament_players
   WHERE tournament_id = p_tournament_id AND position IS NOT NULL;
  SELECT count(*) INTO v_unplaced FROM public.tournament_players
   WHERE tournament_id = p_tournament_id AND position IS NULL;
  SELECT count(*) INTO v_playing FROM public.tournament_players
   WHERE tournament_id = p_tournament_id AND status = 'playing';

  -- The generation the door will bind (latest by hand number, then id) and
  -- only when it is still `pending`: the same binding as bustOrder.ts.
  SELECT count(*) INTO v_backlog FROM (
    SELECT DISTINCT ON (c.eliminated_user_id) c.state, c.resolved_at
      FROM public.tournament_knockout_candidates c
     WHERE c.tournament_id = p_tournament_id
     ORDER BY c.eliminated_user_id, c.hand_number DESC, c.id DESC) q
   WHERE q.state = 'pending' AND q.resolved_at IS NULL;
  v_queued := LEAST(v_backlog, v_lim);

  IF v_queued = 0 THEN
    v_stop := 'nothing_queued';
  ELSE
    -- The engine's seed, unchanged: the number of players holding no place.
    v_seed := GREATEST(v_unplaced, v_playing, v_queued + 1);
    FOR r IN
      SELECT l.eliminated_user_id AS uid, l.hand_number, l.stack_before
        FROM (
          SELECT DISTINCT ON (c.eliminated_user_id) c.*
            FROM public.tournament_knockout_candidates c
           WHERE c.tournament_id = p_tournament_id
           ORDER BY c.eliminated_user_id, c.hand_number DESC, c.id DESC
        ) l
       WHERE l.state = 'pending' AND l.resolved_at IS NULL
       ORDER BY l.hand_number, l.stack_before, l.eliminated_user_id
       LIMIT v_lim
    LOOP
      v_place := v_seed;
      WHILE v_place >= 2 AND v_place = ANY(v_taken) LOOP v_place := v_place - 1; END LOOP;
      IF v_place < 2 THEN
        -- Ladder corrupt downward: take the lowest free place above the seed,
        -- exactly as the sweep does, rather than stranding the player.
        v_up := v_seed + 1;
        v_ceiling := v_seed + COALESCE(array_length(v_taken,1),0) + 2;
        WHILE v_up <= v_ceiling AND v_up = ANY(v_taken) LOOP v_up := v_up + 1; END LOOP;
        IF v_up > v_ceiling THEN v_stop := 'no_free_finishing_place'; EXIT; END IF;
        v_place := v_up;
      END IF;
      IF v_place <= v_deep THEN
        -- Priced places belong to the manager's ladder pool, not to a janitor.
        v_stop := 'place_in_the_money'; EXIT; END IF;

      IF COALESCE(p_dry_run,false) THEN
        v_res := jsonb_build_object('ok',true,'dry_run',true);
      ELSE
        v_res := public.fn_eliminate_tournament_player_atomic(
                   p_tournament_id, r.uid, v_place, 0::numeric, 0::numeric);
      END IF;
      IF COALESCE((v_res->>'ok')::boolean,false) IS NOT TRUE THEN
        -- The ladder this pass built is now stale; stop and let the next
        -- receipt rebuild it from persisted positions.
        v_stop := 'door_refused:'||COALESCE(v_res->>'reason','unnamed');
        EXIT;
      END IF;
      v_taken := v_taken || v_place;
      v_seed  := LEAST(v_seed, v_place) - 1;
      IF v_done = 0 THEN v_first := v_place; END IF;
      v_last  := v_place;
      v_done  := v_done + 1;
      v_recorded := v_recorded || jsonb_build_array(jsonb_build_object(
        'user_id', r.uid, 'hand_number', r.hand_number, 'place', v_place));
    END LOOP;
    IF v_done = v_queued AND v_stop = 'backlog_drained' THEN v_stop := 'batch_complete'; END IF;
  END IF;

  v_out := jsonb_build_object(
    'ok', true, 'tournament_id', p_tournament_id, 'receipt_id', p_receipt_id,
    'dry_run', COALESCE(p_dry_run,false), 'limit', v_lim,
    'queued', v_queued, 'recorded', v_done,
    'first_place', v_first, 'last_place', v_last,
    'deepest_paid_place', v_deep, 'stopped', v_stop,
    'remaining', GREATEST((SELECT count(*) FROM (
        SELECT DISTINCT ON (c.eliminated_user_id) c.state, c.resolved_at
          FROM public.tournament_knockout_candidates c
         WHERE c.tournament_id = p_tournament_id
         ORDER BY c.eliminated_user_id, c.hand_number DESC, c.id DESC) q
       WHERE q.state='pending' AND q.resolved_at IS NULL), 0),
    'places', v_recorded);

  INSERT INTO smarter_private.ca_bust_backlog_drains
    (receipt_id, tournament_id, requested_limit, dry_run, result)
  VALUES (p_receipt_id, p_tournament_id, v_lim, COALESCE(p_dry_run,false), v_out);

  RETURN v_out;
END
$fn$;

REVOKE ALL ON FUNCTION public.fn_ca_drain_recorded_bust_backlog(uuid,uuid,integer,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_ca_drain_recorded_bust_backlog(uuid,uuid,integer,boolean) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_drain_recorded_bust_backlog(uuid,uuid,integer,boolean) TO service_role;
