CREATE OR REPLACE FUNCTION public.fn_cash_cluster_begin_pending_on(p_game_id uuid, p_request_id uuid DEFAULT gen_random_uuid())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  g        record;
  v_state  jsonb;
  v_prior  record;
  v_halted integer;
  v_halted_total integer;
  v_cancel integer;
BEGIN
  -- IDEMPOTENCY IS ASKED FIRST, BEFORE THE FREEZE AND BEFORE THE LOCK. A
  -- worker retrying a request that already succeeded must be told so even
  -- during a break; answering 'platform_frozen' to a retry makes it keep
  -- retrying for the length of the window, which is the opposite of what the
  -- freeze is for. The read is cheap and does not queue behind a tick.
  --
  -- AND cluster_id = p_game_id IS NOT DECORATION. Without it, a request id
  -- belonging to Cluster A, replayed against Cluster B, answered
  -- {"ok": true, "status": "pending", "cluster_mode": "pending_on"} - about A -
  -- while B was never touched and stayed must_move. The caller was told a
  -- conversion was in progress on a Cluster that had none.
  SELECT * INTO v_prior FROM public.cash_cluster_conversion
   WHERE conversion_request_id = p_request_id AND cluster_id = p_game_id;
  IF FOUND THEN
    -- 'pending' IS THIS FUNCTION'S 'converted', AND IT EXISTS FOR THE SAME
    -- REASON. An earlier cut answered ok: true / already_known on ANY status,
    -- so a request id whose conversion had since been ABORTED was reported as
    -- one in flight, about a Cluster sitting back in must_move. The failure is
    -- a worker that times out before reading this reply, aborts, retries the
    -- same id, is told true, and then polls commit_lightning for ever - which
    -- answers conversion_already_closed every time, so that Cluster is never
    -- converted again under that id. commit_lightning grew a 'converted'
    -- boolean against exactly this class; its sibling had been left without
    -- one. The truth was always in the payload, but a caller should not have
    -- to parse a status string to learn whether ok means what it says.
    RETURN jsonb_build_object(
      'ok', v_prior.status <> 'aborted',
      'pending', v_prior.status = 'pending',
      'reason', CASE v_prior.status
                  WHEN 'pending'   THEN 'already_known'
                  WHEN 'committed' THEN 'already_committed'
                  ELSE 'conversion_already_aborted' END,
      'conversion_id', v_prior.id, 'status', v_prior.status,
      'abort_reason', v_prior.abort_reason,
      'cluster_mode', (SELECT cluster_mode FROM public.cash_games WHERE id = p_game_id));
  END IF;

  -- The same id against a DIFFERENT Cluster is a caller bug, not a retry, and
  -- it is named rather than silently opening a second conversion - which the
  -- unique index would refuse anyway, with an error nobody could read.
  IF EXISTS (SELECT 1 FROM public.cash_cluster_conversion
              WHERE conversion_request_id = p_request_id) THEN
    RETURN jsonb_build_object('ok', false, 'pending', false, 'reason', 'request_id_belongs_to_another_cluster');
  END IF;

  -- THE FREEZE IS TOTAL. server/src/maintenance/theFreezeIsTotal.law.test.ts
  -- forbids any path that seats, registers or moves chips during the break.
  -- A conversion moves no chips, but it stops every table in a Cluster from
  -- dealing, which is emphatically an engine-affecting act, and the break
  -- exists so that the engine is doing exactly one thing at a time.
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'pending', false, 'reason', 'platform_frozen');
  END IF;

  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'pending', false, 'reason', 'not_found');
  END IF;

  -- AND THE FREEZE IS ASKED AGAIN, NOW THAT THE LOCK IS HELD (2026-09-25).
  -- The pre-lock check above is what keeps a frozen platform from queueing
  -- behind a tick at all, and it stays. But this call can wait on that lock
  -- for as long as a tick holds it, and a break beginning inside that window
  -- was missed entirely - the Cluster was then halted, and its conversion
  -- opened, during the maintenance break the freeze exists to keep the engine
  -- out of.
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'pending', false, 'reason', 'platform_frozen');
  END IF;

  -- Step 2: verify current state = MUST_MOVE. A Cluster already in pending_on
  -- is not an error to the caller - it is the answer to "is a conversion in
  -- progress" - so it is reported as such rather than raised.
  -- ASK AGAIN, NOW THAT THE LOCK IS HELD. The pre-read above runs under READ
  -- COMMITTED on a snapshot taken before the lock, so two callers sharing a
  -- request id can both miss the row: the first inserts and commits, the
  -- second blocks on the lock, wakes, and would answer 'wrong_state' about the
  -- conversion IT asked for - in precisely the case the unique
  -- conversion_request_id exists to make idempotent. A worker told wrong_state
  -- retries; a worker told already_known stops.
  SELECT * INTO v_prior FROM public.cash_cluster_conversion
   WHERE conversion_request_id = p_request_id AND cluster_id = p_game_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', v_prior.status <> 'aborted',
      'pending', v_prior.status = 'pending',
      'reason', CASE v_prior.status
                  WHEN 'pending'   THEN 'already_known'
                  WHEN 'committed' THEN 'already_committed'
                  ELSE 'conversion_already_aborted' END,
      'conversion_id', v_prior.id, 'status', v_prior.status,
      'abort_reason', v_prior.abort_reason,
      'cluster_mode', g.cluster_mode);
  END IF;

  IF g.cluster_mode <> 'must_move' THEN
    -- 'pending' IS READ OFF THE CLUSTER HERE, NOT OFF A RECORD THIS CALLER HAS
    -- NONE OF. A second caller arriving with a FRESH request id while a
    -- conversion is already in flight is refused - correctly, the lock and the
    -- partial unique index both say so - but it was being told pending: false
    -- about a Cluster sitting in pending_on with every table halted. That is
    -- the same record-versus-Cluster confusion commit_lightning's 'converted'
    -- was re-cut to avoid, and it contradicted this function's own comment
    -- four lines down, which says a Cluster already in pending_on "is the
    -- answer to 'is a conversion in progress'". ok stays false, because this
    -- caller's request did not open anything; pending says what is true of the
    -- Cluster.
    RETURN jsonb_build_object('ok', false,
      'pending', g.cluster_mode IN ('pending_on', 'pending_off'),
      'reason', 'wrong_state', 'cluster_mode', g.cluster_mode);
  END IF;

  -- LIGHTNING PHASE 7 REMEDIATION (20261007222717): AN OPEN CONVERSION IS AN
  -- ANSWER, NOT AN EXCEPTION. A pending conversion this request id does not
  -- name - an orphan an operator path left behind, or a caller bug - used to
  -- reach the INSERT below and die on the one-open-per-cluster unique index,
  -- which the tick's drive then recorded as lightning_drive_error every pass.
  -- It is named structurally instead, so the caller can see what blocks it.
  SELECT * INTO v_prior FROM public.cash_cluster_conversion
   WHERE cluster_id = g.id AND status = 'pending';
  IF FOUND THEN
    RETURN jsonb_build_object('ok', false, 'pending', true,
      'reason', 'conversion_already_open',
      'conversion_id', v_prior.id, 'conversion_request_id', v_prior.conversion_request_id,
      'to_mode', v_prior.to_mode, 'cluster_mode', g.cluster_mode);
  END IF;

  -- Steps 3 and 4. The verdict is the one reader the lobby already embeds, so
  -- the number that triggers a conversion is the same number a player was
  -- shown. It answers in pending_on as well as must_move, which is what makes
  -- step 10's re-ask possible at all - before 20260921142954 it did not, and
  -- this function would have aborted every conversion it ever started.
  v_state := public.fn_cash_cluster_lightning_state(g.id);
  IF NOT coalesce((v_state -> 'verdict' ->> 'would_turn_on')::boolean, false) THEN
    RETURN jsonb_build_object('ok', false, 'pending', false, 'reason', 'threshold_not_reached',
      'verdict', v_state -> 'verdict', 'thresholds', v_state -> 'thresholds');
  END IF;

  -- Step 5. NO EPOCH BUMP HERE. The specification creates the next Epoch at
  -- step 13, after the re-check, and that ordering is the whole reason an
  -- abort is cheap: an aborted conversion leaves the epoch where it was, so
  -- nothing that binds to an epoch - a pool session, an instance, a hand - can
  -- have been created against an epoch that then has to be unwound.
  UPDATE public.cash_games SET cluster_mode = 'pending_on', updated_at = now()
   WHERE id = g.id;

  -- Step 6, and the reason this file exists. Stop the tables dealing. Seats,
  -- stacks and sessions are not touched; a table already halted for some other
  -- reason is left as it is rather than overwritten.
  UPDATE public.tables
     SET dealing_halted_at = clock_timestamp(), dealing_halted_reason = 'lightning_pending_on'
   WHERE cluster_id = g.id
     AND dealing_halted_at IS NULL
     AND coalesce(is_deleted, false) = false
     AND coalesce(lifecycle, '') <> 'closed';
  GET DIAGNOSTICS v_halted = ROW_COUNT;
  -- tables_halted COUNTS TABLES THAT ARE HALTED (2026-09-25). The ROW_COUNT
  -- above is of an UPDATE carrying AND dealing_halted_at IS NULL, so it is the
  -- number of boards this call NEWLY stopped - which is not the number of
  -- boards that are stopped whenever one of them was already halted for some
  -- other reason, which this function deliberately leaves alone. Both numbers
  -- are now in the answer and in the event: the one whose name was wrong, and
  -- the one nobody had.
  SELECT count(*)::integer INTO v_halted_total FROM public.tables
   WHERE cluster_id = g.id
     AND coalesce(is_deleted, false) = false
     AND coalesce(lifecycle, '') <> 'closed'
     AND dealing_halted_at IS NOT NULL;

  -- The hole the engine cannot close. Its start-up wait loop - where a table
  -- below minPlayersToDeal() lives - never re-reads its table row, so it can
  -- neither see this halt set nor see it lifted, and it still runs
  -- executeIdleSeatMoves(). A move planned a second before PENDING_ON would
  -- otherwise execute mid-conversion and write table_seats. Cancelling is
  -- correct rather than merely convenient: the destination table is about to
  -- stop dealing, so the move has nowhere useful to land.
  UPDATE public.cash_seat_moves
     SET state = 'cancelled', resolved_at = clock_timestamp(),
         note = coalesce(note || ' | ', '') || 'cancelled by lightning pending_on'
   WHERE game_id = g.id AND state = 'pending';
  GET DIAGNOSTICS v_cancel = ROW_COUNT;

  INSERT INTO public.cash_cluster_conversion (
    cluster_id, conversion_request_id, from_mode, to_mode, trigger_population,
    on_threshold, off_threshold, epoch_before)
  VALUES (
    g.id, p_request_id, 'must_move', 'lightning',
    coalesce((v_state -> 'verdict' ->> 'live_eligible')::integer, 0),
    coalesce((v_state -> 'thresholds' ->> 'on')::integer, 0),
    coalesce((v_state -> 'thresholds' ->> 'off')::integer, 0),
    g.cluster_epoch)
  RETURNING * INTO v_prior;

  -- FORENSICS (2026-09-26): the chips on the Cluster's seats at the instant
  -- its tables were halted, beside the ones the commit will record.
  UPDATE public.cash_cluster_conversion cc
     SET chips_at_begin = (SELECT coalesce(sum(ts.stack), 0)
                             FROM public.table_seats ts
                             JOIN public.tables tb ON tb.id = ts.table_id
                            WHERE tb.cluster_id = g.id AND ts.left_at IS NULL)
   WHERE cc.id = v_prior.id;

  INSERT INTO public.cash_cluster_events (game_id, kind, payload)
  VALUES (g.id, 'lightning_pending_on', jsonb_build_object(
    'conversion_id', v_prior.id, 'conversion_request_id', p_request_id,
    'trigger_population', v_prior.trigger_population,
    'on_threshold', v_prior.on_threshold, 'off_threshold', v_prior.off_threshold,
    'epoch_before', g.cluster_epoch,
    'tables_halted', v_halted_total, 'tables_newly_halted', v_halted,
    'seat_moves_cancelled', v_cancel));

  RETURN jsonb_build_object('ok', true, 'pending', true, 'reason', 'pending_on',
    'conversion_id', v_prior.id, 'conversion_request_id', p_request_id,
    'cluster_mode', 'pending_on', 'tables_halted', v_halted_total,
    'tables_newly_halted', v_halted,
    'seat_moves_cancelled', v_cancel,
    'trigger_population', v_prior.trigger_population,
    'thresholds', v_state -> 'thresholds');
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_commit_lightning(p_game_id uuid, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  g          record;
  v_conv     record;
  v_state    jsonb;
  v_inflight integer;
  v_before   numeric;
  v_after    numeric;
  v_locked_seats uuid[];
  v_seated   integer;
  v_pool     integer;
  v_orphan   integer;
  v_stranded integer;
  v_epoch    integer;
  v_unobserved        integer;
  v_unobserved_tables jsonb;
  v_stragglers        integer;
BEGIN
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'converted', false, 'reason', 'platform_frozen');
  END IF;

  -- LIGHTNING PHASE 7 REMEDIATION (20261007222717): THE HAND BOUNDARY IS
  -- POLLED BEFORE THE LOCK. The tick asks this every pass while the member
  -- tables finish their hands, and the cheap not-ready answer does not need,
  -- and no longer takes, the Cluster row every formation, tick and conversion
  -- serialises on. The authoritative count below still runs under the lock.
  SELECT count(*)::integer INTO v_inflight
    FROM public.hand_state_snapshots h
    JOIN public.tables tb ON tb.id = h.table_id
   WHERE tb.cluster_id = p_game_id
     AND coalesce(tb.is_deleted, false) = false
     AND coalesce(tb.lifecycle, '') <> 'closed'
     AND h.is_complete = false
     AND h.updated_at > clock_timestamp() - interval '6 hours';
  IF v_inflight > 0 THEN
    RETURN jsonb_build_object('ok', false, 'converted', false, 'reason', 'hands_in_flight',
      'hands_in_flight', v_inflight);
  END IF;

  SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'converted', false, 'reason', 'not_found');
  END IF;

  SELECT * INTO v_conv FROM public.cash_cluster_conversion
   WHERE cluster_id = g.id AND conversion_request_id = p_request_id;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.cash_cluster_conversion
                WHERE conversion_request_id = p_request_id) THEN
      RETURN jsonb_build_object('ok', false, 'converted', false,
        'reason', 'request_id_belongs_to_another_cluster');
    END IF;
    RETURN jsonb_build_object('ok', false, 'converted', false, 'reason', 'no_such_conversion');
  END IF;

  -- F13, the half a lock cannot give you. A retry of a request that already
  -- committed is answered with what happened, not refused: a worker that is
  -- told "no" retries, and a worker that is told "committed at epoch 3"
  -- stops.
  IF v_conv.status = 'committed' THEN
    -- converted IS READ OFF THE CLUSTER, NOT OFF THE RECORD. An earlier cut
    -- asserted converted: true from v_conv.status alone, before any test of
    -- the mode. The record says what this conversion DID; the mode says what
    -- the Cluster IS, and Phase 10's revert will make those two different by
    -- design - a Cluster back in must_move whose conversion row still says
    -- committed. Answering converted: true about it would be the same defect
    -- begin_pending_on carried: the truth in the payload and the boolean
    -- wrong. ok stays true because the request did succeed; converted says
    -- whether the Cluster is Lightning now.
    RETURN jsonb_build_object('ok', true,
      'converted', g.cluster_mode = 'lightning',
      'reason', 'already_committed',
      'conversion_id', v_conv.id, 'epoch_after', v_conv.epoch_after,
      'cluster_mode', g.cluster_mode);
  END IF;
  IF v_conv.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'converted', false,
      'reason', 'conversion_already_closed',
      'status', v_conv.status, 'abort_reason', v_conv.abort_reason,
      'cluster_mode', g.cluster_mode);
  END IF;
  IF g.cluster_mode <> 'pending_on' THEN
    RETURN jsonb_build_object('ok', false, 'converted', false, 'reason', 'wrong_state',
      'cluster_mode', g.cluster_mode);
  END IF;

  -- Step 9.
  SELECT count(*)::integer INTO v_inflight
    FROM public.hand_state_snapshots h
    JOIN public.tables tb ON tb.id = h.table_id
   WHERE tb.cluster_id = g.id
     -- THE SAME TABLE FILTERS THE REST OF THIS FILE CARRIES. Without them an
     -- abandoned ended_at IS NULL row on a CLOSED or soft-deleted table blocks
     -- the conversion for six hours and no operator can clear it, because
     -- nothing will ever end a hand at a table that is gone. That is the exact
     -- wedge the six-hour window was chosen to prevent, arriving by a
     -- different door.
     AND coalesce(tb.is_deleted, false) = false
     AND coalesce(tb.lifecycle, '') <> 'closed'
     AND h.is_complete = false
     AND h.updated_at > clock_timestamp() - interval '6 hours';
  IF v_inflight > 0 THEN
    RETURN jsonb_build_object('ok', false, 'converted', false, 'reason', 'hands_in_flight',
      'hands_in_flight', v_inflight);
  END IF;

  -- THE HALT IS A STOP ONLY ONCE THE ENGINE HAS SEEN IT (2026-09-26). A member
  -- table that is not halted at all is halted now; then every live member
  -- table an engine holds an unexpired lease on must have observed its halt.
  UPDATE public.tables tb
     SET dealing_halted_at = clock_timestamp(), dealing_halted_reason = 'lightning_pending_on'
   WHERE tb.cluster_id = g.id
     AND tb.dealing_halted_at IS NULL
     AND coalesce(tb.is_deleted, false) = false
     AND coalesce(tb.lifecycle, '') <> 'closed';
  GET DIAGNOSTICS v_stragglers = ROW_COUNT;

  SELECT count(*)::integer, coalesce(jsonb_agg(tb.id ORDER BY tb.id), '[]'::jsonb)
    INTO v_unobserved, v_unobserved_tables
    FROM public.tables tb
    JOIN public.engine_table_leases l ON l.table_id = tb.id
   WHERE tb.cluster_id = g.id
     AND coalesce(tb.is_deleted, false) = false
     AND coalesce(tb.lifecycle, '') <> 'closed'
     AND l.heartbeat_at >= clock_timestamp() - make_interval(secs => public.fn_engine_lease_stale_seconds())
     AND (tb.dealing_halted_at IS NULL
          OR tb.dealing_halt_observed_at IS NULL
          OR tb.dealing_halt_observed_at < tb.dealing_halted_at);
  IF v_unobserved > 0 OR v_stragglers > 0 THEN
    RETURN jsonb_build_object('ok', false, 'converted', false, 'reason', 'halt_not_observed',
      'tables_not_observed', v_unobserved, 'tables', v_unobserved_tables,
      'tables_newly_halted', v_stragglers);
  END IF;

  -- Steps 10 and 11.
  v_state := public.fn_cash_cluster_lightning_state(g.id);
  IF NOT coalesce((v_state -> 'verdict' ->> 'would_turn_on')::boolean, false) THEN
    -- 'converted' EXISTS BECAUSE 'ok' CANNOT CARRY THIS. A successful abort is
    -- ok: the function did exactly what it should. But a caller that branches
    -- on ok alone would read a self-abort as a conversion, so the one question
    -- a caller actually has - did this Cluster become Lightning - is answered
    -- by its own boolean rather than by reading a reason string.
    RETURN public.fn_cash_cluster_abort_pending_on(
      g.id, p_request_id, 'population_fell_below_on_threshold_at_boundary')
      || jsonb_build_object('ok', false, 'converted', false);
  END IF;

  -- A pool session MUST name a cash session; the column is NOT NULL, and the
  -- subordination is the point: "Entering/exiting Lightning does not create a
  -- new cash session." So a seated eligible player with no open Cluster
  -- session cannot enter the pool, and this refuses the whole conversion
  -- rather than converting around them - leaving an eligible player seated at
  -- a table that has stopped dealing, in a Cluster that believes it is a pool,
  -- is the stranding the specification forbids.
  --
  -- Measured before this was written: on the busiest live Cluster, all 34
  -- eligible players carry an open session with cluster_id set, and the estate
  -- has 174 open Cluster sessions against 169 live Cluster chairs. This is
  -- therefore a refusal that should never fire, which is exactly the kind that
  -- must be counted rather than assumed.
  -- PER PLAYER, NOT PER SEAT, AND ASKING THE INSERT'S OWN QUESTION. An earlier
  -- cut counted seat ROWS, so a player seated on two member boards whose only
  -- open session was scoped to one of them was counted an orphan against the
  -- other seat - and refused the whole Cluster's conversion while the INSERT
  -- would happily have found their session. Both now ask: does this PLAYER
  -- have an open session reachable from ANY of their seats in this Cluster.
  SELECT count(*)::integer INTO v_orphan FROM (
    SELECT ts.user_id
      FROM public.table_seats ts
      JOIN public.tables tb ON tb.id = ts.table_id
     WHERE tb.cluster_id = g.id AND coalesce(tb.is_deleted, false) = false
       AND coalesce(tb.lifecycle, '') <> 'closed'
       AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
       AND coalesce(ts.is_sitting_out, false) = false
       AND coalesce(ts.leave_pending, false) = false
       AND coalesce(ts.stack, 0) > 0
     GROUP BY ts.user_id
    HAVING NOT EXISTS (
       SELECT 1 FROM public.cash_player_session s
        WHERE s.player_id = ts.user_id AND s.closed_at IS NULL
          AND (s.cluster_id = g.id
               OR s.scope_id IN (SELECT id FROM public.tables WHERE cluster_id = g.id)
               OR s.table_id IN (SELECT id FROM public.tables WHERE cluster_id = g.id)))
  ) o;
  IF v_orphan > 0 THEN
    RETURN public.fn_cash_cluster_abort_pending_on(
      g.id, p_request_id, format('%s eligible seated player(s) have no open cash session', v_orphan))
      || jsonb_build_object('ok', false, 'converted', false);
  END IF;

  -- A CONVERSION LOCKS THE SEATS IT ENTERS (2026-10-09, Phase 12 load and
  -- chaos): the live seats FOR SHARE in seat-id order, the order
  -- fn_cash_cluster_commit_must_move takes, before anything below reads
  -- them. A player standing up at this moment either finishes first (and is
  -- then no longer live here) or waits for this commit (and the seat
  -- trigger then closes the pool session it can now see). Without it the
  -- departing seat entered the pool after its own trigger had run, and the
  -- ghost session refused every later reversion. The chip total is taken
  -- over exactly the seats locked here (and any row this transaction wrote),
  -- so an arrival committing in between is not mistaken for moved money.
  SELECT coalesce(array_agg(x.id ORDER BY x.id), ARRAY[]::uuid[]) INTO v_locked_seats FROM (
    SELECT ts.id FROM public.table_seats ts
     WHERE ts.left_at IS NULL
       AND ts.table_id IN (SELECT tb.id FROM public.tables tb WHERE tb.cluster_id = g.id)
     ORDER BY ts.id
       FOR SHARE) x;

  -- THE MODE CHANGES UNDER THE CLUSTER'S MODE LOCK (2026-10-15, Lightning
  -- Phase 12 load and chaos): EXCLUSIVE, after the seat FOR SHARE above (a
  -- seat writer holds its row until its commit, where its deferred trigger
  -- asks for this lock SHARED; waiting for a seat while holding this would
  -- deadlock with it) and before anything below reads the seats into the
  -- pool. Every arrival whose seat trigger got in first has committed by the
  -- time this returns, and each statement below takes a fresh snapshot, so
  -- the pool INSERT enters it; every arrival after waits for this commit and
  -- reads 'lightning' itself. Nothing below takes a seat row lock.
  PERFORM pg_advisory_xact_lock(
    pg_catalog.hashtextextended('lightning_cluster_mode:' || g.id::text, 0));

  -- Step 12, first half.
  SELECT coalesce(sum(ts.stack), 0) INTO v_before
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = g.id AND ts.left_at IS NULL
     AND (ts.id = ANY (v_locked_seats) OR ts.xmin = pg_current_xact_id()::xid);

  -- Step 13. ca.epoch_reason is read by fn_cash_cluster_epoch_follows_its_game
  -- for cash_cluster_epoch.started_by; without it the row records 'unstated',
  -- and an epoch nobody can explain is an epoch nobody can audit.
  PERFORM set_config('ca.epoch_reason', 'lightning_on', true);
  -- The epoch writer records cluster_epoch_started with this request.
  PERFORM set_config('ca.request_id', p_request_id::text, true);
  v_epoch := g.cluster_epoch + 1;
  -- 20261008043021: A STALE DWELL SIGHTING DOES NOT SURVIVE RE-CONVERSION.
  -- A sighting recorded in a previous Lightning epoch would otherwise let the
  -- new epoch open PENDING_OFF on one observation.
  UPDATE public.cash_games
     SET cluster_mode = 'lightning', cluster_epoch = v_epoch, lightning_off_condition_since = NULL, updated_at = now()
   WHERE id = g.id;

  -- Steps 14 to 19. THE ONLY WRITE THAT CREATES ANYTHING FOR A PLAYER, AND IT
  -- POINTS AT WHAT THEY ALREADY HAD. cash_player_session_id is the player's
  -- EXISTING open session - not a new one. "A Lightning Pool Session is
  -- subordinate to the continuous Cash Player Session. Entering/exiting
  -- Lightning does not create a new cash session."
  --
  -- The eligibility predicate is fn_cash_cluster_live_eligible's seated half,
  -- restated here because that function returns a COUNT and this needs the
  -- SET. They must agree exactly: a player counted toward the threshold who
  -- did not enter the pool is a player the conversion left behind, and one who
  -- entered without being counted is a player who arrived from nowhere. The
  -- read-back asserts the two agree rather than trusting that they do.
  --
  -- NO is_horse ANYWHERE. Law 10.5: a horse counts exactly like a human, and
  -- is pinned twice in TheTablesOpenAndCloseThemselves.law.test.ts against the
  -- worklist and the balancer. A horse over the threshold enters the pool like
  -- anyone else.
  INSERT INTO public.lightning_pool_session (
    cluster_id, cluster_epoch, player_id, cash_player_session_id,
    state, entered_at, starting_stack, anchor_seat_id)
  SELECT DISTINCT ON (ts.user_id)
         g.id, v_epoch, ts.user_id,
         (SELECT s.id FROM public.cash_player_session s
           WHERE s.player_id = ts.user_id AND s.closed_at IS NULL
             AND (s.cluster_id = g.id
                  OR s.scope_id IN (SELECT id FROM public.tables WHERE cluster_id = g.id)
                  OR s.table_id IN (SELECT id FROM public.tables WHERE cluster_id = g.id))
           -- coalesce, NOT a bare boolean DESC. cash_player_session.cluster_id
           -- is a nullable added column, so for a session matched only by its
           -- table scope the key is NULL - and DESC implies NULLS FIRST, which
           -- put exactly the session this ORDER BY exists to deprioritise at
           -- the top. A player holding both an open cluster-scoped session and
           -- an open table-scoped one - a shape cash_player_session_one_open
           -- explicitly permits - got the wrong parent on their pool session.
           ORDER BY coalesce(s.cluster_id = g.id, false) DESC, s.opened_at DESC, s.id LIMIT 1),
         'active', clock_timestamp(), ts.stack, ts.id
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = g.id AND coalesce(tb.is_deleted, false) = false
     AND coalesce(tb.lifecycle, '') <> 'closed'
     AND ts.left_at IS NULL
     AND ts.user_id IS NOT NULL
     AND coalesce(ts.is_sitting_out, false) = false
     AND coalesce(ts.leave_pending, false) = false
     AND coalesce(ts.stack, 0) > 0
   ORDER BY ts.user_id, ts.joined_at, ts.id;
  GET DIAGNOSTICS v_pool = ROW_COUNT;

  -- pool_player_joined, one per player the conversion entered (2026-09-26).
  INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
  SELECT g.id, 'pool_player_joined', jsonb_build_object(
           'cluster_id', g.id, 'cluster_epoch', v_epoch, 'player_id', ps.player_id,
           'pool_session_id', ps.id, 'anchor_seat_id', ps.anchor_seat_id,
           'starting_stack', ps.starting_stack, 'cash_player_session_id', ps.cash_player_session_id,
           'via', 'fn_cash_cluster_commit_lightning', 'conversion_id', v_conv.id, 'at', ps.entered_at),
         v_epoch, p_request_id
    FROM public.lightning_pool_session ps
   WHERE ps.cluster_id = g.id AND ps.cluster_epoch = v_epoch AND ps.exited_at IS NULL
   ORDER BY ps.entered_at, ps.id;

  -- The halt is re-stamped rather than lifted. The tables are still not
  -- dealing, and now they are not dealing because the Cluster IS Lightning
  -- rather than because it is deciding - which is the difference Phase 10's
  -- revert will match on.
  --
  -- IT ALSO CATCHES A TABLE THAT ARRIVED AFTER step 6. An earlier cut matched
  -- only rows already carrying 'lightning_pending_on', so a table opened
  -- between PENDING_ON and here would have joined a Lightning Cluster and gone
  -- on dealing. The stood-down tick should make that unreachable; "should be
  -- unreachable" is the reason a guard is cheap, not the reason to omit it.
  UPDATE public.tables
     SET dealing_halted_at = coalesce(dealing_halted_at, clock_timestamp()),
         dealing_halted_reason = 'lightning'
   WHERE cluster_id = g.id
     AND coalesce(is_deleted, false) = false
     AND coalesce(lifecycle, '') <> 'closed'
     -- ONLY A HALT THIS CONVERSION PLACED, OR NO HALT AT ALL. `IS DISTINCT FROM
     -- 'lightning'` alone would rewrite a halt somebody else put there into
     -- one of ours, and Phase 10's revert - which matches on the reason -
     -- would then lift it. begin_pending_on already leaves a foreign halt
     -- alone and abort_pending_on already lifts only its own; this is the
     -- third of the three and it was the one that did not.
     AND (dealing_halted_at IS NULL OR dealing_halted_reason = 'lightning_pending_on');

  -- Step 12, second half. This cannot fail as written; it is here so that it
  -- starts failing the day somebody adds a write to table_seats above it.
  SELECT coalesce(sum(ts.stack), 0) INTO v_after
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = g.id AND ts.left_at IS NULL
     AND (ts.id = ANY (v_locked_seats) OR ts.xmin = pg_current_xact_id()::xid);
  IF v_after IS DISTINCT FROM v_before THEN
    RAISE EXCEPTION 'LIGHTNING_CONVERSION_MOVED_MONEY: cluster % chip total went from % to %, and a mode change is a seating transition, not an economic transaction',
      g.id, v_before, v_after USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(DISTINCT ts.user_id)::integer INTO v_seated
    FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = g.id AND coalesce(tb.is_deleted, false) = false
     AND coalesce(tb.lifecycle, '') <> 'closed'
     AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
     AND coalesce(ts.is_sitting_out, false) = false
     AND coalesce(ts.leave_pending, false) = false
     AND coalesce(ts.stack, 0) > 0;

  -- Nobody eligible may be left behind. This is the F15 half that a count
  -- cannot see: a Fast Fold storm at the threshold changes who is eligible,
  -- and the set that entered the pool must be the set that was counted.
  IF v_pool <> v_seated THEN
    RAISE EXCEPTION 'LIGHTNING_CONVERSION_LEFT_SOMEBODY_BEHIND: cluster % counted % eligible seated players and created % pool sessions',
      g.id, v_seated, v_pool USING ERRCODE = 'check_violation';
  END IF;

  -- AND THE ASSERTION THAT COUNTING CANNOT MAKE. v_pool and v_seated share a
  -- predicate, so a predicate that wrongly EXCLUDES a table makes both numbers
  -- smaller and they still agree - which is exactly how the nullable
  -- tables.lifecycle nearly stranded people here: the halt coalesced the NULL
  -- and the player-set queries did not, so a NULL-lifecycle table was stopped
  -- while its seated players were left out of the pool, at a table that was no
  -- longer dealing, in a Cluster that believed it owned them.
  --
  -- This asks the question from the OTHER side, over the tables this
  -- conversion actually halted, and it cannot be satisfied by a filter that
  -- narrows: if we stopped a table, every eligible player sitting at it must
  -- have somewhere to play.
  SELECT count(DISTINCT ts.user_id)::integer INTO v_stranded
    FROM public.table_seats ts
    JOIN public.tables tb ON tb.id = ts.table_id
   WHERE tb.cluster_id = g.id
     AND coalesce(tb.is_deleted, false) = false
     AND coalesce(tb.lifecycle, '') <> 'closed'
     AND tb.dealing_halted_at IS NOT NULL
     AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
     AND coalesce(ts.is_sitting_out, false) = false
     AND coalesce(ts.leave_pending, false) = false
     AND coalesce(ts.stack, 0) > 0
     AND NOT EXISTS (SELECT 1 FROM public.lightning_pool_session s
                      WHERE s.cluster_id = g.id AND s.player_id = ts.user_id
                        AND s.cluster_epoch = v_epoch AND s.exited_at IS NULL);
  IF v_stranded > 0 THEN
    RAISE EXCEPTION 'LIGHTNING_CONVERSION_STRANDED_A_PLAYER: cluster % stopped a table with % eligible player(s) on it who have no pool session',
      g.id, v_stranded USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.cash_cluster_conversion
     SET status = 'committed', epoch_after = v_epoch, closed_at = clock_timestamp(),
         chips_at_commit = v_before
   WHERE id = v_conv.id;

  -- Step 22.
  INSERT INTO public.cash_cluster_events (game_id, kind, payload, request_id)
  VALUES (g.id, 'lightning_on', jsonb_build_object(
    'conversion_id', v_conv.id, 'conversion_request_id', p_request_id,
    'from_mode', 'must_move', 'to_mode', 'lightning',
    'trigger_population', coalesce((v_state -> 'verdict' ->> 'live_eligible')::integer, 0),
    'on_threshold', coalesce((v_state -> 'thresholds' ->> 'on')::integer, 0),
    'off_threshold', coalesce((v_state -> 'thresholds' ->> 'off')::integer, 0),
    'epoch_before', g.cluster_epoch, 'epoch_after', v_epoch,
    'pool_sessions', v_pool, 'chip_total', v_before), p_request_id);

  RETURN jsonb_build_object('ok', true, 'converted', true, 'reason', 'lightning',
    'conversion_id', v_conv.id, 'cluster_mode', 'lightning',
    'epoch_before', g.cluster_epoch, 'epoch_after', v_epoch,
    'pool_sessions', v_pool, 'chip_total', v_before,
    'trigger_population', coalesce((v_state -> 'verdict' ->> 'live_eligible')::integer, 0));
END;
$function$
;

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_lightning_drive(p_game_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  g        record;
  v_state  jsonb;
  v_conv   record;
  v_n      integer;
  v_live   integer;
  v_off    integer;
  v_on_ok  boolean;
  v_off_ok boolean;
  v_live_ok boolean;
  v_action text;
  v_res    jsonb;
  v_mode   text;
  v_sqlstate text;
  v_message  text;
  v_drain    jsonb;
BEGIN
  SELECT cg.id, cg.cluster_mode, cg.cluster_epoch, cg.lightning_enabled, cg.enabled, cg.must_move
    INTO g FROM public.cash_games cg WHERE cg.id = p_game_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- ONE CLUSTER'S FAILURE IS ITS OWN. Everything below runs in this block's
  -- sub-transaction: a lock wait past the pass's lock_timeout, or any error,
  -- rolls back only this Cluster's step and is answered as a row and an
  -- event, and the tick pass goes on to the next Cluster.
  BEGIN

  -- ONE READER. The verdict is fn_cash_cluster_live_eligible against the
  -- configured thresholds; the hysteresis is the gap between ON and OFF, and
  -- nothing here re-derives either number.
  v_state  := public.fn_cash_cluster_lightning_state(g.id);
  v_on_ok  := coalesce((v_state -> 'verdict' ->> 'would_turn_on')::boolean, false);
  v_off_ok := coalesce((v_state -> 'verdict' ->> 'would_turn_off')::boolean, false);
  v_live   := coalesce((v_state -> 'verdict' ->> 'live_eligible')::integer, 0);
  v_off    := coalesce((v_state -> 'thresholds' ->> 'off')::integer, 0);
  v_live_ok := coalesce(g.lightning_enabled, false) AND g.enabled IS NOT DISTINCT FROM true;

  SELECT * INTO v_conv FROM public.cash_cluster_conversion cc
   WHERE cc.cluster_id = g.id AND cc.status = 'pending';
  SELECT count(*)::integer INTO v_n FROM public.cash_cluster_conversion cc WHERE cc.cluster_id = g.id;

  IF g.cluster_mode = 'must_move' THEN
    IF v_on_ok AND coalesce(g.must_move, false) THEN
      v_action := 'begin_pending_on';
      -- THE REQUEST ID IS THE CLUSTER, ITS EPOCH, THE DIRECTION AND HOW MANY
      -- CONVERSIONS IT HAS HAD, so two passes racing here ask for the same
      -- conversion and the second is told already_known. An abort adds a row,
      -- so the next attempt gets a new id.
      v_res := public.fn_cash_cluster_begin_pending_on(g.id,
        md5(format('lightning-drive:%s:%s:lightning:%s', g.id, g.cluster_epoch, v_n))::uuid);
    ELSE
      v_action := 'hold';
    END IF;
  ELSIF g.cluster_mode = 'pending_on' THEN
    IF v_conv.id IS NULL THEN
      v_action := 'no_open_conversion';
    ELSIF NOT v_on_ok THEN
      v_action := 'abort_pending_on';
      v_res := public.fn_cash_cluster_abort_pending_on(g.id, v_conv.conversion_request_id,
        CASE WHEN coalesce(g.lightning_enabled, false) = false THEN 'lightning_disabled'
             WHEN g.enabled IS DISTINCT FROM true THEN 'game_disabled'
             ELSE 'population_fell_below_on_threshold' END);
    ELSE
      v_action := 'commit_lightning';
      v_res := public.fn_cash_cluster_commit_lightning(g.id, v_conv.conversion_request_id);
    END IF;
  ELSIF g.cluster_mode = 'lightning' THEN
    IF v_off_ok OR NOT v_live_ok THEN
      v_action := 'begin_pending_off';
      v_res := public.fn_cash_cluster_begin_pending_off(g.id,
        md5(format('lightning-drive:%s:%s:must_move:%s', g.id, g.cluster_epoch, v_n))::uuid,
        'fn_cash_cluster_lightning_drive');
    ELSE
      v_action := 'hold';
      -- 20261007222717: THE DWELL SIGHTING IS CONSECUTIVE-PASS STATE. A pass
      -- that does not see the OFF condition clears the first sighting, so an
      -- oscillating population never accumulates one.
      UPDATE public.cash_games cg SET lightning_off_condition_since = NULL
       WHERE cg.id = g.id AND cg.lightning_off_condition_since IS NOT NULL;
    END IF;
  ELSIF g.cluster_mode = 'pending_off' THEN
    IF v_conv.id IS NULL THEN
      v_action := 'no_open_conversion';
    ELSIF v_live_ok AND v_live > v_off THEN
      v_action := 'abort_pending_off';
      v_res := public.fn_cash_cluster_abort_pending_off(g.id, v_conv.conversion_request_id,
        'population_rose_above_off_threshold');
    ELSE
      v_action := 'commit_must_move';
      v_res := public.fn_cash_cluster_commit_must_move(g.id, v_conv.conversion_request_id);
    END IF;
  ELSIF g.cluster_mode = 'draining' THEN
    -- LIGHTNING PHASE 13 (20261009235505): the emergency drain's own mode;
    -- its step is the advance below.
    v_action := 'drain';
  ELSE
    v_action := 'mode_not_driven';
  END IF;

  -- LIGHTNING PHASE 13 (20261009235505): THE EMERGENCY DRAIN ADVANCES HERE,
  -- after the Cluster's own step (a pending_off committed, a pending_on
  -- aborted), so a drain whose reversion just landed closes in the same
  -- pass.
  IF EXISTS (SELECT 1 FROM public.lightning_cluster_drain d
              WHERE d.cluster_id = g.id AND d.completed_at IS NULL) THEN
    v_drain := public.fn_lightning_drain_advance(g.id);
  END IF;

  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_message = MESSAGE_TEXT;
    INSERT INTO public.cash_cluster_events (game_id, kind, payload)
    VALUES (g.id, 'lightning_drive_error', jsonb_build_object(
      'cluster_id', g.id, 'mode', g.cluster_mode, 'action', v_action,
      'sqlstate', v_sqlstate, 'message', v_message, 'at', clock_timestamp()));
    RETURN jsonb_build_object('ok', false, 'cluster_id', g.id, 'action', v_action,
      'mode_before', g.cluster_mode,
      'error', jsonb_build_object('sqlstate', v_sqlstate, 'message', v_message));
  END;

  SELECT cg.cluster_mode INTO v_mode FROM public.cash_games cg WHERE cg.id = g.id;
  RETURN jsonb_build_object('ok', true, 'cluster_id', g.id, 'action', v_action,
    'mode_before', g.cluster_mode, 'cluster_mode', v_mode,
    'live_eligible', v_live, 'thresholds', v_state -> 'thresholds',
    'lightning_enabled', g.lightning_enabled)
    || CASE WHEN v_res IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('result', v_res) END
    || CASE WHEN v_drain IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('drain', v_drain) END;
END;
$function$
;

