-- Owner October 26: halve cash supply throughout the day; only the strongest half plays cash.
-- No wallet, seat, tournament registration, activity counter or retirement mutation.
-- Existing cluster transactions retain their hand-boundary moves and empty-table close authority.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='15s';
DO $admit$ BEGIN
  IF md5(pg_get_functiondef('public.fn_ca_horse_roster_refresh(integer,integer,integer,numeric,integer)'::regprocedure)) <> 'e2709e7ccac97891fcbdd06ef8593a1c'
  OR md5(pg_get_functiondef('public.fn_cash_cluster_tick(uuid,integer)'::regprocedure)) <> '31e8b874323ec041173ef2591dfb0210'
  OR md5(pg_get_functiondef('public.fn_ca_horse_roster_seat_guard()'::regprocedure)) <> 'ff66e90a1add7a1280d72d9ad7b8f0c8' THEN
    RAISE EXCEPTION 'cash policy predecessor changed: inspect the current owner before installation';
  END IF;
END $admit$;
CREATE OR REPLACE FUNCTION public.fn_ca_horse_roster_refresh(p_size integer DEFAULT NULL::integer, p_min_hands integer DEFAULT 5000, p_min_plo integer DEFAULT 5000, p_min_plo_bb100 numeric DEFAULT 1.0, p_days integer DEFAULT 30)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_size integer; v_active integer; v_result jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('fn_ca_horse_roster_refresh'));
  IF p_days < 1 OR p_days > 90 OR p_min_hands < 5000 THEN
    RAISE EXCEPTION 'cash ranking requires a 1..90 day window and at least 5000 hands';
  END IF;
  DROP TABLE IF EXISTS _cand;
  CREATE TEMP TABLE _cand ON COMMIT DROP AS
  WITH perf AS (
    SELECT horse_user_id id, sum(hands)::bigint hands, sum(net_bb) net
    FROM public.horse_daily_nets
    WHERE (format IN ('cash','hu_cash') OR format LIKE 'lightning_%')
      AND day >= current_date - p_days
    GROUP BY horse_user_id
  )
  SELECT p.id, coalesce(f.hands,0) hands,
    CASE WHEN f.hands > 0 THEN f.net * 100.0 / f.hands END bb100
  FROM public.profiles p LEFT JOIN perf f ON f.id=p.id
  WHERE p.is_horse AND coalesce(p.status,'active')='active'
    AND coalesce(p.horse_status,'available') <> 'disabled'
    AND EXISTS (SELECT 1 FROM public.ca_horse_fleet_register r WHERE r.horse_id=p.id AND r.retired_at IS NULL);

  SELECT greatest(1, floor(count(*) * 0.5)::integer) INTO v_size FROM _cand;
  -- The owner asks for the strongest half. An optional old size argument cannot widen it.
  IF p_size IS NOT NULL THEN v_size := least(v_size, greatest(1,p_size)); END IF;
  DELETE FROM public.ca_horse_active_roster WHERE true;
  INSERT INTO public.ca_horse_active_roster(horse_id,rank,hands,bb100)
  SELECT id,rn,hands,bb100 FROM (
    SELECT id,hands,bb100,row_number() OVER (ORDER BY bb100 DESC NULLS LAST, hands DESC, id) rn
    FROM _cand WHERE hands >= greatest(5000, p_min_hands)
  ) ranked WHERE rn <= v_size;
  GET DIAGNOSTICS v_active = ROW_COUNT;
  IF v_active=0 THEN RAISE EXCEPTION 'no sufficiently sampled cash performers; roster unchanged'; END IF;

  -- PLO has the same cash eligibility; its ordinary bankroll checks remain authoritative.
  DELETE FROM public.ca_horse_plo_roster WHERE true;
  INSERT INTO public.ca_horse_plo_roster(horse_id,rank,plo_hands,plo_bb100)
  SELECT a.horse_id,a.rank,coalesce(p.hands,0),
    CASE WHEN p.hands>0 THEN p.net*100.0/p.hands END
  FROM public.ca_horse_active_roster a LEFT JOIN (
    SELECT horse_user_id,sum(hands)::bigint hands,sum(net_bb) net
    FROM public.horse_daily_nets
    WHERE (format IN ('cash','hu_cash') OR format LIKE 'lightning_%')
      AND game_variant LIKE 'plo%' AND day >= current_date-p_days
    GROUP BY horse_user_id
  ) p ON p.horse_user_id=a.horse_id;

  -- Restore exactly the cash tag values saved by a previous bench.
  UPDATE public.stable_hand_membership_tags t
  SET mode=b.mode,cash_freeroll=b.cash_freeroll,persona_cash=b.persona_cash,
      persona_mtt=b.persona_mtt,variants=b.variants,preferred_stakes=b.preferred_stakes,max_tables=b.max_tables
  FROM public.ca_horse_roster_cash_tag_backup b
  WHERE b.horse_id=t.horse_id AND b.club_id=t.club_id
    AND EXISTS(SELECT 1 FROM public.ca_horse_active_roster a WHERE a.horse_id=t.horse_id);
  DELETE FROM public.ca_horse_roster_cash_tag_backup b
  WHERE EXISTS(SELECT 1 FROM public.ca_horse_active_roster a WHERE a.horse_id=b.horse_id);

  INSERT INTO public.ca_horse_roster_cash_tag_backup
    (horse_id,club_id,mode,cash_freeroll,persona_cash,persona_mtt,variants,preferred_stakes,max_tables)
  SELECT horse_id,club_id,mode,cash_freeroll,persona_cash,persona_mtt,variants,preferred_stakes,max_tables
  FROM public.stable_hand_membership_tags t
  WHERE t.mode IN ('cash','both')
    AND NOT EXISTS(SELECT 1 FROM public.ca_horse_active_roster a WHERE a.horse_id=t.horse_id)
  ON CONFLICT(horse_id,club_id) DO NOTHING;
  UPDATE public.stable_hand_membership_tags t
  -- The live tag contract couples tournament-only mode to an absent cash persona,
  -- no cash-only freeroll flag and one table. Original cash fields are backed up above.
  SET mode='tourney',persona_cash=NULL,cash_freeroll=false,max_tables=1
  WHERE t.mode IN ('cash','both')
    AND NOT EXISTS(SELECT 1 FROM public.ca_horse_active_roster a WHERE a.horse_id=t.horse_id);

  v_result := jsonb_build_object('ok',true,'size',v_size,'active',v_active,
    'selection','top_half_cash_bb100','minimum_hands',p_min_hands,'days',p_days);
  INSERT INTO public.ca_horse_roster_log(size,demand,active,plo,result)
  VALUES(v_size,(SELECT count(*) FROM public.cash_games WHERE enabled AND closed_at IS NULL AND state='live'),
    ARRAY(SELECT horse_id FROM public.ca_horse_active_roster ORDER BY rank),
    ARRAY(SELECT horse_id FROM public.ca_horse_plo_roster ORDER BY rank),v_result);
  RETURN v_result;
END
$function$;


CREATE OR REPLACE FUNCTION public.fn_ca_horse_roster_seat_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog','public','pg_temp'
AS $function$
BEGIN
  IF NEW.left_at IS NOT NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.left_at IS NULL
     AND OLD.user_id IS NOT DISTINCT FROM NEW.user_id
     AND OLD.table_id IS NOT DISTINCT FROM NEW.table_id THEN RETURN NEW; END IF;
  -- Existing seats and settlement updates remain legal. Tournaments are unchanged.
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id=NEW.user_id AND p.is_horse)
     OR EXISTS (SELECT 1 FROM public.tables t WHERE t.id=NEW.table_id AND t.tournament_id IS NOT NULL)
  THEN RETURN NEW; END IF;
  -- A game's already-owned seat move must complete before the normal safe exit.
  IF NEW.active_game_scope IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.table_seats s WHERE s.user_id=NEW.user_id AND s.left_at IS NULL
      AND s.active_game_scope=NEW.active_game_scope AND s.table_id IS DISTINCT FROM NEW.table_id)
  THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.ca_horse_active_roster r WHERE r.horse_id=NEW.user_id) THEN
    RAISE EXCEPTION USING ERRCODE='42501',
      MESSAGE='horse_not_on_cash_roster: only the top cash performance roster plays cash games';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.fn_cash_cluster_tick(p_game_id uuid, p_eligible_horses integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  g record; t record; r record;
  g_mode record;
  v_front uuid;
  v_census public.cash_cluster_census_row[];
  v_actions jsonb := '[]'::jsonb;
  v_now timestamptz := clock_timestamp();
  v_seated_total integer := 0;
  v_live_tables integer := 0;
  v_open_unreserved integer := 0;
  v_buyers integer;
  v_waiting integer;
  v_prev_feeder record;
  v_candidate record;
  v_floor integer;
  v_remaining_capacity integer;
  v_remaining_tables integer;
  v_main1 record;
  v_new_state text;
  v_moves integer := 0;
  v_n integer;
  v_idx integer;
  v_shortest uuid;
  v_table_cap integer;
  v_classic boolean := false;
  v_hands integer;
  v_orbit integer;
  v_window interval;
BEGIN
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'skipped', 'frozen');
  END IF;

  -- STAND DOWN BEFORE THE LOCK (2026-09-26). A plain read of the mode; a
  -- Cluster that is converting or converted is left without its row being
  -- taken, so the tick never holds a Lightning Cluster's row against a
  -- formation.
  SELECT cg.must_move, cg.cluster_mode, cg.cluster_epoch INTO g_mode
    FROM public.cash_games cg WHERE cg.id = p_game_id;
  IF FOUND AND g_mode.must_move AND g_mode.cluster_mode IS DISTINCT FROM 'must_move' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lightning_cluster_stands_down',
      'cluster_mode', g_mode.cluster_mode, 'cluster_epoch', g_mode.cluster_epoch,
      'locked', false);
  END IF;

  /* A WAKE DOES NOT QUEUE BEHIND THE PASS (2026-10-03). Called by the pass
     (fn_cash_clusters_tick_all publishes ca.cluster_pass_deadline), the tick
     waits for its row as before, bounded by the pass's lock_timeout. Called
     alone, as the engine's per-game wake, it takes the row only if nobody
     holds it: a held row means the pass (or another wake) is ticking this
     game now, and the next pass ticks it again in five seconds. Waiting
     cost 27,682 wakes 8,486 s in 100 minutes (mean 307 ms, max 5.8 s),
     almost all of it behind the pass's transaction. */
  IF COALESCE(current_setting('ca.cluster_pass_deadline', true), '') = '' THEN
    SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      IF EXISTS (SELECT 1 FROM public.cash_games cg WHERE cg.id = p_game_id) THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'ticking_elsewhere', 'locked', false);
      END IF;
      RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
    END IF;
  ELSE
    SELECT * INTO g FROM public.cash_games WHERE id = p_game_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  END IF;
  IF NOT g.must_move THEN RETURN jsonb_build_object('ok', false, 'reason', 'manual_game'); END IF;
  -- A CLASSIC GAME NEVER MOVES ITS PLAYERS (Dan 2026-10-24: "PLAYERS SHOULD
  -- NOT BE MOVING ON CLASSIC GAMES PERIOD"). The tick still manages its
  -- tables; it plans no must-move, breaks only an empty table, and withdraws
  -- a break started under seated players. cash_seat_moves refuses the rest.
  v_classic := public.fn_cash_game_never_moves_players(g.template_name, g.ruleset_snapshot);
  -- LIGHTNING 2.0 PHASE 5. must_move is the CAPABILITY - does this game use
  -- must-move seating at all - and cluster_mode is the STATE. A Cluster that
  -- is converting, or has converted, keeps the capability and changes the
  -- state, because Phase 10 reverts to must-move seating using these very
  -- rules and a Cluster that had turned the capability off would have nothing
  -- to turn back on. This function read the capability and never the state,
  -- so it would have gone on opening feeders, planning moves, balancing and
  -- reconciling Main 1 underneath a Lightning pool.
  IF g.cluster_mode IS DISTINCT FROM 'must_move' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lightning_cluster_stands_down',
      'cluster_mode', g.cluster_mode, 'cluster_epoch', g.cluster_epoch);
  END IF;

  -- ── 1. RECONCILE ─────────────────────────────────────────────────────────
  -- AN EXPIRED MOVE SAYS WHAT IT WAS WAITING FOR (2026-09-07). Three
  -- different failures land here and the row could not tell them apart.
  -- A DEADLINE DOES NOT RUN WHILE THE PLATFORM IS PARKING (2026-09-09).
  -- fn_platform_frozen() (checked at the top of this function) is the :55-:00
  -- freeze. fn_entry_purchases_frozen() is WIDER: it is also true from :53,
  -- when the break is announced and the last hand is called, and through the
  -- post-thaw release boundary. fn_cash_seat_move_execute refuses on the wider
  -- one. So in that window the tick is awake and the executor cannot act, and
  -- expiring a move there blames the engine for a refusal the platform made
  -- (CLAUDE.md 10.86 rule 1). Measured: 38% of all expiries fell in the two
  -- five-minute buckets either side of :55.
  --
  -- So the deadline is held instead, forward to the three minutes
  -- fn_cash_seat_move_window guarantees as its floor. GREATEST never shortens
  -- a longer window. fn_thaw_platform then shifts what is still pending at
  -- :00, exactly as CLAUDE.md 13 rule 4 requires.
  IF public.fn_entry_purchases_frozen() THEN
    UPDATE public.cash_seat_moves m
       SET expires_at = GREATEST(m.expires_at, v_now + interval '3 minutes')
     WHERE m.game_id = g.id AND m.state = 'pending'
       AND m.expires_at <= v_now + interval '3 minutes';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN v_actions := v_actions || jsonb_build_object('moves_held_for_maintenance', v_n); END IF;
  ELSE
    UPDATE public.cash_seat_moves m SET state = 'expired',
           note = CASE
                    WHEN NOT EXISTS (SELECT 1 FROM public.table_seats ts
                                      WHERE ts.table_id = m.from_table_id
                                        AND ts.user_id = m.player_id AND ts.left_at IS NULL)
                      THEN 'player_left_before_boundary'
                    WHEN EXISTS (SELECT 1 FROM public.table_seats ts
                                  WHERE ts.table_id = m.from_table_id
                                    AND ts.user_id = m.player_id AND ts.left_at IS NULL
                                    AND coalesce(ts.stack, 0) = 0)
                      THEN 'player_busted_before_boundary'
                    ELSE 'engine_did_not_execute_before_expiry'
                  END
     WHERE m.game_id = g.id AND m.state = 'pending' AND m.expires_at <= v_now;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN v_actions := v_actions || jsonb_build_object('moves_expired', v_n); END IF;
  END IF;

  -- THE SNAPSHOT IS THE RULE (Gate 5, 2026-09-05). Every open table of the
  -- game carries exactly the rules its snapshot says; a table that drifted
  -- (54 did, on the VPIP floor alone) is corrected here, every tick.
  v_n := public.fn_cash_apply_ruleset(g.id);
  IF v_n > 0 THEN v_actions := v_actions || jsonb_build_object('ruleset_applied', v_n); END IF;

  -- THE ROSTER AND THE SEAT-CHANGE LIST (Dan 2026-09-05). A roster row whose
  -- player holds no chair in the game and has no move planned is closed (the
  -- seat trigger closes most of them; this catches a chair that emptied
  -- while a move was pending and the move then died). A seat change whose
  -- move was cancelled or expired goes back on the list, at its old place;
  -- the back-off in the planner gives the refusal its minute.
  UPDATE public.cash_game_roster ro SET left_at = v_now
   WHERE ro.game_id = g.id AND ro.left_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
                      WHERE ts.user_id = ro.user_id AND ts.left_at IS NULL AND tb.cluster_id = g.id AND tb.lifecycle <> 'closed')
     AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves mv WHERE mv.player_id = ro.user_id AND mv.game_id = g.id AND mv.state = 'pending');
  UPDATE public.cash_seat_change_requests rq SET status = 'cancelled', resolved_at = v_now, note = 'left_game'
   WHERE rq.game_id = g.id AND rq.status = 'requested'
     AND NOT EXISTS (SELECT 1 FROM public.cash_game_roster ro WHERE ro.game_id = g.id AND ro.user_id = rq.user_id AND ro.left_at IS NULL);
  -- THE REQUEST COMES BACK WHEREVER THEY ARE SITTING (2026-09-09). This
  -- asked whether the player was still in the table they REQUESTED FROM, so a
  -- request whose move died after a must-move or a break had already taken
  -- them elsewhere in the same game stayed 'moved' for ever, with the
  -- allowance spent and no change delivered. The player is asked for by GAME
  -- now, and the request is re-listed from the chair they are actually in, so
  -- the planner reads a from_table_id that is true.
  -- (a scalar subquery, not a LATERAL: Postgres refuses a lateral reference to
  --  the UPDATE target from the FROM list, 42P10. The EXISTS keeps the NOT NULL
  --  column honest - a player with no chair at all in the game is the roster
  --  trigger's case, not this one.)
  UPDATE public.cash_seat_change_requests rq
     SET status = 'requested', resolved_at = NULL, move_id = NULL, note = 'move_' || mv.state,
         from_table_id = (SELECT ts.table_id FROM public.table_seats ts
                            JOIN public.tables tb ON tb.id = ts.table_id
                           WHERE ts.user_id = rq.user_id AND ts.left_at IS NULL
                             AND tb.cluster_id = g.id AND tb.lifecycle <> 'closed'
                           ORDER BY ts.joined_at LIMIT 1)
    FROM public.cash_seat_moves mv
   WHERE rq.game_id = g.id AND rq.status = 'moved' AND rq.move_id = mv.id AND mv.state IN ('cancelled', 'expired')
     AND EXISTS (SELECT 1 FROM public.table_seats ts
                   JOIN public.tables tb ON tb.id = ts.table_id
                  WHERE ts.user_id = rq.user_id AND ts.left_at IS NULL
                    AND tb.cluster_id = g.id AND tb.lifecycle <> 'closed');

  -- THE GAME WAITLIST (Gate 4, 2026-09-05). A row whose player now holds a
  -- seat in the game is `seated`; a `notified` row (the join door told them
  -- a seat was open) that has not turned into a seat in three minutes is
  -- `expired` - their browser asks again if they are still there, and the
  -- OPEN rule stops counting a buyer who left.
  UPDATE public.cash_game_waitlist w SET status = 'seated', updated_at = v_now
   WHERE w.game_id = g.id AND w.status IN ('waiting', 'notified')
     AND EXISTS (SELECT 1 FROM public.table_seats ts JOIN public.tables tb ON tb.id = ts.table_id
                  WHERE ts.user_id = w.user_id AND ts.left_at IS NULL AND tb.cluster_id = g.id AND tb.lifecycle <> 'closed');
  UPDATE public.cash_game_waitlist w SET status = 'expired', updated_at = v_now
   WHERE w.game_id = g.id AND w.status = 'notified' AND w.updated_at < v_now - interval '3 minutes';

  -- Active seats cannot commit against a closed parent; no reopen repair is needed.

  -- Duplicate committed chairs are rejected by one_committed_seat_per_game_player.
  -- The cluster planner never pays away a chair outside its engine hand boundary.

  -- AN OPENING FEEDER NOBODY CAME TO (2026-09-05, window raised the same
  -- night). It was opened for two buyers; SIX minutes with nobody on it
  -- means they went elsewhere. It closes, the live feeder it was going to
  -- promote stays the feeder, and OPEN below waits two minutes before
  -- trying again.
  --
  -- WHY SIX AND NOT THREE. The buyers are horses, and the fleet that seats
  -- them reads the open-table list ONCE at the top of a cycle that takes 57
  -- to 118 seconds (HorseFleetManager: "Seeding cycle took 118s and 3 30s
  -- tick(s) were dropped while it ran"), on a 30-second tick. Three minutes
  -- is shorter than one worst-case cycle plus a full tick interval, so a
  -- feeder could be closed before the fleet's next cycle ever reached it -
  -- and the fleet then bought into the closed row and was refused
  -- TABLE_CLOSING. Measured 2026-09-05 20:45 CDT: 22 feeder_opened, 4
  -- feeder_live, 20 feeder_abandoned in one hour; NLH 0.05/0.10 Classic
  -- abandoned 11 in 90 minutes. 118s + 30s is 148s, so six minutes is that
  -- with a full cycle of margin on top. The two-minute rest after an abandon
  -- and the 60-second opening hold are unchanged.
  FOR t IN SELECT tb.id FROM public.tables tb
            WHERE tb.cluster_id = g.id AND tb.lifecycle = 'opening'
              AND coalesce(tb.is_deleted, false) = false
              AND coalesce(tb.opened_at, tb.created_at) < v_now - interval '6 minutes'
              AND NOT EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.table_id = tb.id AND ts.left_at IS NULL)
  LOOP
    UPDATE public.tables SET status = 'closed', lifecycle = 'closed', current_players = 0, updated_at = now()
     WHERE id = t.id;
    UPDATE public.tables SET promote_pending = false
     WHERE cluster_id = g.id AND role = 'feeder' AND promote_pending;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'feeder_abandoned');
    v_actions := v_actions || jsonb_build_object('feeder_abandoned', t.id);
  END LOOP;

  -- A TABLE CLOSED BY STATUS BUT NOT BY LIFECYCLE (2026-09-05). Fifteen
  -- cluster tables carried status = 'closed' with lifecycle still 'live'
  -- (an operator's close-game action and the pre-controller close path
  -- write status only). The census reads status and drops them, the roles
  -- step reads lifecycle and still counts them, so a game could hold a
  -- Main 1 nobody could see and a feeder with nobody to feed. With no seat
  -- on it, the lifecycle follows the status; with a seat on it, the closed
  -- table sweep above has already put it back to breaking.
  UPDATE public.tables SET lifecycle = 'closed', current_players = 0, updated_at = now()
   WHERE cluster_id = g.id AND status = 'closed' AND lifecycle <> 'closed'
     AND coalesce(is_deleted, false) = false
     -- An enabled game's Main 1 is not followed down: R3 below repairs it in
     -- place (same id, same lobby links) instead of opening a replacement.
     AND NOT (g.enabled AND role = 'main' AND main_index = 1)
     AND NOT EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.table_id = public.tables.id AND ts.left_at IS NULL);
  -- AND THE SAME SPLIT IN THE OTHER DIRECTION (2026-09-09).
  -- The statement above repairs `status closed / lifecycle live`. The mirror -
  -- `lifecycle closed / status waiting` - had no repair at all, and it is the
  -- one that reaches a PLAYER: the lobby and every status-based read treat the
  -- table as joinable while fn_cash_apply_ruleset skips it as closed, so it can
  -- be sat at while carrying a ruleset nobody is reconciling. Measured
  -- 2026-09-09: 32 fleet tables in exactly that state, five of them still
  -- advertising an ante or a bomb pot their game had already dropped.
  -- Only EMPTY ones are followed down; a closed-lifecycle table with a seat on
  -- it is already sent back to `breaking` by the sweep further up, which is the
  -- path that walks it empty first.
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload) VALUES (g.id, 'lifecycle_followed_status', jsonb_build_object('tables', v_n));
    v_actions := v_actions || jsonb_build_object('lifecycle_followed_status', v_n);
  END IF;

  UPDATE public.tables SET status = 'closed', lifecycle = 'closed', current_players = 0, updated_at = now()
   WHERE cluster_id = g.id AND lifecycle = 'closed' AND status <> 'closed'
     AND coalesce(is_deleted, false) = false
     AND NOT EXISTS (SELECT 1 FROM public.table_seats ts WHERE ts.table_id = public.tables.id AND ts.left_at IS NULL);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 0 THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload)
      VALUES (g.id, 'status_followed_lifecycle', jsonb_build_object('tables', v_n));
    v_actions := v_actions || jsonb_build_object('status_followed_lifecycle', v_n);
  END IF;

  -- THE HEADCOUNT COLUMN IS THE SEATS (2026-09-05, 15:05). tables.current_players
  -- is what every per-table surface paints and the engine writes it only
  -- when it loads seats to deal; a table with one seated player and no
  -- engine said 0 (22 of them live). The seats are the truth; the column
  -- follows them here, every tick, for this game's open tables.
  UPDATE public.tables tb SET current_players = s.n
    FROM (SELECT tx.id, (SELECT count(*) FROM public.table_seats ts WHERE ts.table_id = tx.id AND ts.left_at IS NULL)::integer AS n
            FROM public.tables tx WHERE tx.cluster_id = g.id AND tx.lifecycle <> 'closed' AND coalesce(tx.is_deleted, false) = false) s
   WHERE tb.id = s.id AND tb.current_players IS DISTINCT FROM s.n;

  v_census := public.fn_cash_cluster_census(g.id, v_now);
  SELECT coalesce(sum(c.seated), 0), count(*) INTO v_seated_total, v_live_tables FROM unnest(v_census) c;

  -- R3: an enabled game always has Main 1 open. Anything that closed it
  -- (a stray close, the pre-controller lifecycle pass, a restart) is undone
  -- here rather than by a row flag.
  --
  -- THE LOOKUP READS THE LIVE BOARD, NOT THE OLDEST ROW (2026-09-05, 14:45).
  -- This used to select the oldest table ever numbered Main 1, closed or not.
  -- On NLH 0.05/0.10 Classic the original Main 1 was closed for good, so
  -- every tick found a closed row, took the "open a new one" branch, and
  -- opened a fresh Main 1: 3,000 tables in 148 minutes (08:01 to 10:29),
  -- every one of them then broken and renumbered by the steps below, 10,989
  -- moves planned to shuffle 43 players through them. Now: a Main 1 that is
  -- live or opening on a waiting/running table is the game's; a game with
  -- ANY live table but no such Main 1 leaves it to the ROLES step, which
  -- promotes the oldest live table (that is what Main 1 means, 1.3 s9.2);
  -- only a game with no live table at all opens one. The status-only repair
  -- (a live-lifecycle Main 1 whose status got set to closed) stays.
  SELECT * INTO v_main1 FROM public.tables
   WHERE cluster_id = g.id AND role = 'main' AND main_index = 1 AND coalesce(is_deleted, false) = false
     AND lifecycle IN ('live', 'opening')
   ORDER BY created_at LIMIT 1;
  IF g.enabled AND v_main1.id IS NOT NULL AND v_main1.status NOT IN ('waiting', 'running', 'active') THEN
    UPDATE public.tables SET status = 'waiting', lifecycle = 'live', current_players = 0, updated_at = now()
     WHERE id = v_main1.id;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, v_main1.id, 'main1_reopened');
    v_actions := v_actions || jsonb_build_object('main1', 'reopened');
    v_census := public.fn_cash_cluster_census(g.id, v_now);
    SELECT coalesce(sum(c.seated), 0), count(*) INTO v_seated_total, v_live_tables FROM unnest(v_census) c;
  ELSIF g.enabled AND v_main1.id IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.tables
                         WHERE cluster_id = g.id AND coalesce(is_deleted, false) = false
                           AND lifecycle IN ('live', 'opening', 'breaking') AND status IN ('waiting', 'running', 'active')) THEN
    IF coalesce(g.lightning_enabled, false) THEN
      PERFORM public.fn_cash_cluster_open_table(g.id, 'feeder', NULL, 'live', NULL);
      v_actions := v_actions || jsonb_build_object('feeder1', 'opened');
    ELSE
      PERFORM public.fn_cash_cluster_open_table(g.id, 'main', 1, 'live', NULL);
      v_actions := v_actions || jsonb_build_object('main1', 'opened');
    END IF;
    -- Recount after the repair; the rest of the tick sees the real board.
    v_census := public.fn_cash_cluster_census(g.id, v_now);
    SELECT coalesce(sum(c.seated), 0), count(*) INTO v_seated_total, v_live_tables FROM unnest(v_census) c;
  END IF;

  -- ── 2. MUST-MOVE (1.3 s9.5) ──────────────────────────────────────────────
  -- For every Main with an unreserved open seat, the longest-seated player on
  -- the feeder (or on a breaking table) is planned onto it, one per seat,
  -- one per player. The engine executes at the player's next hand boundary.
  FOR t IN SELECT * FROM unnest(v_census) c
            WHERE NOT v_classic AND c.role = 'main' AND c.lifecycle = 'live' AND c.open_unreserved > 0
            ORDER BY c.main_index
  LOOP
    v_n := t.open_unreserved
         - (SELECT count(*) FROM public.cash_seat_moves m WHERE m.to_table_id = t.id AND m.state = 'pending' AND m.swap_move_id IS NULL);
    FOR r IN
      SELECT ts.user_id, ts.table_id
        FROM public.table_seats ts
        JOIN unnest(v_census) c ON c.id = ts.table_id
       WHERE ts.left_at IS NULL AND ts.user_id IS NOT NULL
         -- A Main 1 seat draws from the WHOLE list (every table but Main 1);
         -- a Main N seat draws from the feeder and any breaking table.
         AND (c.role = 'feeder' OR c.breaking OR (t.main_index = 1 AND c.id <> t.id))
         AND c.id <> t.id
         -- NOT WITH NOTHING, NOT WHILE LEAVING (2026-09-05): a busted seat is
         -- in its rebuy window, a leave_pending seat is on its way out.
         AND coalesce(ts.stack, 0) > 0
         AND coalesce(ts.leave_pending, false) = false
         -- Never onto a table they are already sitting at.
         AND NOT EXISTS (SELECT 1 FROM public.table_seats d WHERE d.table_id = t.id AND d.user_id = ts.user_id AND d.left_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = ts.user_id AND m.state = 'pending')
         -- BACK-OFF (2026-09-05): a move the engine just refused (cancelled
         -- with a note) is not re-planned every 5 s; the refusal gets a minute.
         AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = ts.user_id AND m.state = 'cancelled' AND coalesce(m.resolved_at, m.created_at) > v_now - interval '60 seconds')
       -- THE ORDER YOU JOINED THE GAME (Dan 2026-09-05): the roster's
       -- joined_at, which survives every move; the chair's own joined_at
       -- only for a chair that predates the roster.
       ORDER BY c.breaking DESC,
                coalesce((SELECT r2.joined_at FROM public.cash_game_roster r2
                           WHERE r2.game_id = g.id AND r2.user_id = ts.user_id AND r2.left_at IS NULL), ts.joined_at) ASC,
                ts.joined_at ASC
       LIMIT GREATEST(v_n, 0)
    LOOP
      INSERT INTO public.cash_seat_moves (game_id, player_id, from_table_id, to_table_id, reason)
      VALUES (g.id, r.user_id, r.table_id, t.id, 'must_move');
      v_moves := v_moves + 1;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (g.id, t.id, 'move_planned', jsonb_build_object('player_id', r.user_id, 'from_table_id', r.table_id, 'reason', 'must_move'));
    END LOOP;
  END LOOP;
  IF v_moves > 0 THEN v_actions := v_actions || jsonb_build_object('moves_planned', v_moves); END IF;

  -- ── 2b. SEAT CHANGES (Dan 2026-09-05) ────────────────────────────────────
  -- After Main seats are filled in must-move order and before a feeder is
  -- opened: a requested table change takes the next unreserved chair on a
  -- table that is not Main 1, oldest request first; two requests that would
  -- take each other's table are swapped.
  v_n := public.fn_cash_seat_change_plan(g.id, v_now);
  IF v_n > 0 THEN v_actions := v_actions || jsonb_build_object('seat_changes_planned', v_n); END IF;

  -- ── 3. OPEN (18.3) ───────────────────────────────────────────────────────
  SELECT coalesce(sum(c.open_unreserved), 0) INTO v_open_unreserved
    FROM unnest(v_census) c WHERE c.lifecycle IN ('live', 'opening') AND NOT c.breaking;
  SELECT count(*) INTO v_waiting FROM public.cash_game_waitlist w
   WHERE w.game_id = g.id AND w.status IN ('waiting', 'notified');
  v_buyers := v_waiting + GREATEST(coalesce(p_eligible_horses, 0), 0);
  -- (a CASE ... THEN inside an IF condition ends the condition early in
  --  PL/pgSQL, so the cap is computed first)
  v_table_cap := g.cap_mains + 1;
  IF g.allow_second_feeder THEN v_table_cap := v_table_cap + 1; END IF;
  -- Owner October 26: halve total table supply at every hour, including feeders.
  v_table_cap := greatest(1, floor(v_table_cap * 0.5)::integer);

  IF g.enabled AND v_open_unreserved = 0 AND v_live_tables > 0
     AND NOT EXISTS (SELECT 1 FROM unnest(v_census) c WHERE c.lifecycle = 'opening')
     AND v_live_tables < v_table_cap
     -- Two minutes after a feeder was abandoned, not before.
     AND NOT EXISTS (SELECT 1 FROM public.cash_cluster_events e
                      WHERE e.game_id = g.id AND e.kind = 'feeder_abandoned' AND e.at > v_now - interval '2 minutes') THEN
    IF v_buyers >= 2 THEN
      UPDATE public.tables SET promote_pending = true
       WHERE cluster_id = g.id AND role = 'feeder' AND lifecycle = 'live';
      PERFORM public.fn_cash_cluster_open_table(g.id, 'feeder', NULL, 'opening', NULL);
      UPDATE public.cash_games SET opening_hold_since = NULL WHERE id = g.id;
      v_actions := v_actions || jsonb_build_object('feeder', 'opened', 'buyers', v_buyers);
    ELSIF v_buyers = 1 THEN
      -- One buyer holds for 60 s; the fleet's next cycle usually brings a
      -- partner. No ghost table.
      -- AN EXPIRED HOLD RESTS (2026-09-05): five minutes before the next.
      IF g.opening_hold_since IS NULL
         AND (g.opening_hold_rested_until IS NULL OR g.opening_hold_rested_until <= v_now) THEN
        UPDATE public.cash_games SET opening_hold_since = v_now WHERE id = g.id;
        INSERT INTO public.cash_cluster_events (game_id, kind) VALUES (g.id, 'table_opening_hold');
        v_actions := v_actions || jsonb_build_object('opening_hold', 'started');
      ELSIF g.opening_hold_since IS NOT NULL AND g.opening_hold_since < v_now - interval '60 seconds' THEN
        UPDATE public.cash_games SET opening_hold_since = NULL, opening_hold_rested_until = v_now + interval '5 minutes' WHERE id = g.id;
        INSERT INTO public.cash_cluster_events (game_id, kind) VALUES (g.id, 'table_opening_hold_expired');
        v_actions := v_actions || jsonb_build_object('opening_hold', 'expired');
      END IF;
    END IF;
  ELSIF g.opening_hold_since IS NOT NULL THEN
    UPDATE public.cash_games SET opening_hold_since = NULL WHERE id = g.id;
  END IF;

  -- ── 4. PROMOTE (18.3) ────────────────────────────────────────────────────
  -- An opening feeder with two seated is live. The feeder before it, marked
  -- promote_pending, becomes Main N+1.
  FOR t IN SELECT * FROM unnest(v_census) c WHERE c.lifecycle = 'opening' AND c.seated >= 2 LOOP
    UPDATE public.tables SET lifecycle = 'live', live_at = v_now WHERE id = t.id;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'feeder_live');
    SELECT coalesce(max(main_index), 0) + 1 INTO v_idx FROM public.tables
     WHERE cluster_id = g.id AND role = 'main' AND lifecycle <> 'closed' AND coalesce(is_deleted, false) = false;
    FOR v_prev_feeder IN SELECT id, name FROM public.tables
                          WHERE cluster_id = g.id AND role = 'feeder' AND promote_pending AND id <> t.id
                            AND lifecycle = 'live' ORDER BY created_at
    LOOP
      UPDATE public.tables SET role = 'main', main_index = v_idx, promote_pending = false,
             name = left(g.name, 50) || ' Main ' || v_idx
       WHERE id = v_prev_feeder.id;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (g.id, v_prev_feeder.id, 'feeder_promoted_to_main', jsonb_build_object('main_index', v_idx));
      v_idx := v_idx + 1;
    END LOOP;
    v_actions := v_actions || jsonb_build_object('feeder_live', t.id);
  END LOOP;

  -- Refresh the census for the steps that read roles (the counts are the
  -- tick's own snapshot and stay).
  SELECT coalesce(array_agg(
           (tb.id, tb.role, tb.main_index, tb.lifecycle, c.status, c.created_at, c.max_players,
            c.seated, c.reserved, c.open_unreserved, c.breaking)::public.cash_cluster_census_row
           ORDER BY c.created_at), '{}'::public.cash_cluster_census_row[])
    INTO v_census
    FROM unnest(v_census) c JOIN public.tables tb ON tb.id = c.id;

  -- ── 5. BREAK (18.3) ──────────────────────────────────────────────────────
  -- Candidate: newest table first (feeder, then the highest main), never
  -- Main 1, never a table still opening. Condition: everyone fits in the
  -- rest at or above the floor. It breaks when that has held for the
  -- SHORTER of two completed orbits on the candidate or five minutes
  -- (OPORD 1.4 18.3). An orbit is one hand per seated player; a table
  -- with fewer than two seated deals no hands, so only the clock runs
  -- for it. Until 2026-09-05 only the clock ran for everyone, and a
  -- six-handed feeder that dealt twenty hands in four minutes with the
  -- whole game fitting elsewhere still sat there for the fifth.
  v_floor := CASE WHEN g.handedness <= 6 THEN 3 ELSE 4 END;
  -- EMPTY FIRST (2026-09-05, 14:50). An empty table has nobody to move and
  -- nothing to interrupt; it is the cheapest table to close and the one the
  -- lobby least wants to see. Then the newest.
  v_front := public.fn_cash_cluster_front_table(g.id);
  SELECT * INTO v_candidate FROM unnest(v_census) c
   WHERE c.id IS DISTINCT FROM v_front AND c.lifecycle = 'live'
     AND (NOT v_classic OR (c.seated = 0 AND c.reserved = 0))
   ORDER BY (c.seated = 0) DESC, (c.role = 'feeder') DESC, c.main_index DESC NULLS FIRST, c.created_at DESC LIMIT 1;

  IF NOT EXISTS (SELECT 1 FROM unnest(v_census) c WHERE c.breaking) AND v_candidate.id IS NOT NULL THEN
    SELECT coalesce(sum(c.max_players - c.reserved), 0), count(*) INTO v_remaining_capacity, v_remaining_tables
      FROM unnest(v_census) c WHERE c.id <> v_candidate.id AND c.lifecycle = 'live';
    -- THE FLOOR CLAUSE IS GONE (2026-09-05, 14:50). It read
    -- `seated_total >= floor x remaining_tables`: break only if the
    -- rest would average at or above the maintain floor afterwards. Breaking
    -- a table never makes the rest SHORTER, so the clause could only ever
    -- refuse the breaks that matter most: a game of 1 player on 4 tables
    -- (1 >= 3 x 3, never) kept all four for ever, and a game of 42 on 16
    -- (42 >= 4 x 15, never) never armed. Read live at 14:45: eligible_since
    -- NULL on every table of both. Dan's rule is "fewer tables, more players
    -- at each"; the floor is a target for the fleet to fill to, not a bar
    -- to consolidation. The STRICT fit stays (everyone fits AND the rest
    -- keeps a seat open, so the OPEN rule does not fire on the same board).
    IF v_remaining_tables >= 1
       AND v_seated_total < v_remaining_capacity THEN
      SELECT break_eligible_since INTO r FROM public.tables WHERE id = v_candidate.id;
      IF r.break_eligible_since IS NULL THEN
        UPDATE public.tables SET break_eligible_since = v_now WHERE id = v_candidate.id;
        v_actions := v_actions || jsonb_build_object('break_eligible', v_candidate.id);
      ELSE
        v_orbit := v_candidate.seated;
        v_hands := 0;
        IF v_orbit >= 2 THEN
          SELECT count(*) INTO v_hands FROM public.hand_history h
           WHERE h.table_id = v_candidate.id AND h.created_at >= r.break_eligible_since;
        END IF;
        -- A TABLE WITH NOBODY, OR ONE PLAYER, HAS NOTHING TO INTERRUPT
        -- (2026-09-05): no hand can be dealt there, so the five-minute
        -- window protects nobody. Sixty seconds is enough to let someone who
        -- is sitting down finish sitting down.
        -- (computed first: a CASE ... THEN inside an IF condition ends the
        --  condition early in PL/pgSQL, see the OPEN rule's cap above)
        v_window := CASE WHEN v_orbit <= 1 THEN interval '60 seconds' ELSE interval '5 minutes' END;
        IF r.break_eligible_since <= v_now - v_window
           OR (v_orbit >= 2 AND v_hands >= 2 * v_orbit) THEN
          UPDATE public.tables SET lifecycle = 'breaking', break_started_at = v_now, break_eligible_since = NULL
           WHERE id = v_candidate.id;
          SELECT coalesce(array_agg(
                   (c.id, c.role, c.main_index,
                    CASE WHEN c.id = v_candidate.id THEN 'breaking' ELSE c.lifecycle END,
                    c.status, c.created_at, c.max_players, c.seated, c.reserved, c.open_unreserved,
                    c.breaking OR c.id = v_candidate.id)::public.cash_cluster_census_row
                   ORDER BY c.created_at), '{}'::public.cash_cluster_census_row[])
            INTO v_census FROM unnest(v_census) c;
          INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
          VALUES (g.id, v_candidate.id, 'table_break_started',
                  jsonb_build_object('seated_total', v_seated_total, 'remaining_capacity', v_remaining_capacity,
                                     'eligible_since', r.break_eligible_since, 'hands_since_eligible', v_hands, 'orbit', v_orbit));
          v_actions := v_actions || jsonb_build_object('break_started', v_candidate.id,
                                                       'hands_since_eligible', v_hands, 'orbit', v_orbit);
        END IF;
      END IF;
    ELSE
      UPDATE public.tables SET break_eligible_since = NULL
       WHERE cluster_id = g.id AND break_eligible_since IS NOT NULL;
    END IF;
  ELSE
    UPDATE public.tables SET break_eligible_since = NULL
     WHERE cluster_id = g.id AND break_eligible_since IS NOT NULL;
  END IF;

  -- A breaking table: every seated player is planned onto the shortest live
  -- table with room (must-move already took the mains' open seats above;
  -- this covers what is left, feeder included). When the last chair is
  -- empty it closes.
  FOR t IN SELECT * FROM unnest(v_census) c WHERE c.breaking LOOP
    IF t.seated = 0 THEN
      UPDATE public.tables SET status = 'closed', lifecycle = 'closed', current_players = 0, updated_at = now()
       WHERE id = t.id;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'table_break_completed');
      SELECT coalesce(array_agg(c ORDER BY c.created_at), '{}'::public.cash_cluster_census_row[])
        INTO v_census FROM unnest(v_census) c WHERE c.id <> t.id;
      v_actions := v_actions || jsonb_build_object('closed', t.id);
      CONTINUE;
    END IF;
    -- A CLASSIC TABLE IS NEVER BROKEN UNDER ITS PLAYERS (Dan 2026-10-24).
    IF v_classic THEN
      UPDATE public.tables SET lifecycle = 'live', break_started_at = NULL, break_eligible_since = NULL, updated_at = now()
       WHERE id = t.id AND lifecycle = 'breaking';
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'classic_break_withdrawn');
      v_actions := v_actions || jsonb_build_object('classic_break_withdrawn', t.id);
      v_census := public.fn_cash_cluster_census(g.id, v_now);
      CONTINUE;
    END IF;
    -- Native committed ownership makes duplicate-chair cashout unnecessary.
    FOR r IN SELECT ts.user_id FROM public.table_seats ts
              WHERE ts.table_id = t.id AND ts.left_at IS NULL AND ts.user_id IS NOT NULL
                AND coalesce(ts.stack, 0) > 0
                AND coalesce(ts.leave_pending, false) = false
                AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = ts.user_id AND m.state = 'pending')
                AND NOT EXISTS (SELECT 1 FROM public.cash_seat_moves m WHERE m.player_id = ts.user_id AND m.state = 'cancelled' AND coalesce(m.resolved_at, m.created_at) > v_now - interval '60 seconds')
              ORDER BY coalesce((SELECT r2.joined_at FROM public.cash_game_roster r2
                                  WHERE r2.game_id = g.id AND r2.user_id = ts.user_id AND r2.left_at IS NULL), ts.joined_at),
                       ts.joined_at
    LOOP
      SELECT c.id INTO v_shortest FROM unnest(v_census) c
       WHERE c.id <> t.id AND NOT c.breaking AND c.lifecycle IN ('live', 'opening')
         AND c.open_unreserved - (SELECT count(*) FROM public.cash_seat_moves m WHERE m.to_table_id = c.id AND m.state = 'pending' AND m.swap_move_id IS NULL) > 0
         AND NOT EXISTS (SELECT 1 FROM public.table_seats d WHERE d.table_id = c.id AND d.user_id = r.user_id AND d.left_at IS NULL)
       ORDER BY c.seated ASC, c.main_index ASC NULLS LAST LIMIT 1;
      EXIT WHEN v_shortest IS NULL;
      INSERT INTO public.cash_seat_moves (game_id, player_id, from_table_id, to_table_id, reason)
      VALUES (g.id, r.user_id, t.id, v_shortest, 'break');
      v_moves := v_moves + 1;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (g.id, v_shortest, 'move_planned', jsonb_build_object('player_id', r.user_id, 'from_table_id', t.id, 'reason', 'break'));
    END LOOP;
  END LOOP;

  -- ── 6. ROLES (1.3 s9.2) ──────────────────────────────────────────────────
  -- Oldest live table is Main 1; mains renumber by age; with no feeder left
  -- and two or more tables, the newest becomes the feeder.
  -- A GAME WITH A FEEDER AND NO MAIN (2026-09-05). Found live: Main 1 closed
  -- by status under a disabled game, five players still on its feeder, and
  -- nothing below promoted the feeder because this step only renumbers
  -- mains. Oldest live table is Main 1 (1.3 s9.2); if no main is live, the
  -- oldest live feeder becomes it, so the players on it have a Main to be
  -- on and the R3 repair does not open a second table beside them.
  IF NOT EXISTS (SELECT 1 FROM unnest(v_census) c WHERE c.lifecycle IN ('live', 'opening') AND c.role = 'main')
     AND EXISTS (SELECT 1 FROM unnest(v_census) c WHERE c.lifecycle = 'live' AND c.role = 'feeder')
     -- LIGHTNING 2.0 PHASE 3 (lone_feeder_is_the_cluster): a Lightning-
     -- capable Cluster's ONE table is a feeder, by specification. There is
     -- nothing for a Main to receive movers FROM while it is the only table,
     -- so the promotion loses nothing by waiting; the moment a second table
     -- opens this arm fires and ordinary must-move roles resume.
     AND NOT (coalesce(g.lightning_enabled, false)
              AND (SELECT count(*) FROM unnest(v_census) c WHERE c.lifecycle IN ('live', 'opening')) = 1) THEN
    SELECT * INTO t FROM unnest(v_census) c WHERE c.lifecycle = 'live' AND c.role = 'feeder' ORDER BY c.created_at LIMIT 1;
    UPDATE public.tables SET role = 'main', main_index = 1, promote_pending = false, name = g.name WHERE id = t.id;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
    VALUES (g.id, t.id, 'feeder_promoted_to_main', jsonb_build_object('main_index', 1, 'reason', 'no_live_main'));
    SELECT coalesce(array_agg(
             (c.id, CASE WHEN c.id = t.id THEN 'main' ELSE c.role END, CASE WHEN c.id = t.id THEN 1 ELSE c.main_index END,
              c.lifecycle, c.status, c.created_at, c.max_players, c.seated, c.reserved, c.open_unreserved, c.breaking)::public.cash_cluster_census_row
             ORDER BY c.created_at), '{}'::public.cash_cluster_census_row[])
      INTO v_census FROM unnest(v_census) c;
    v_actions := v_actions || jsonb_build_object('feeder_became_main1', t.id);
  END IF;
  v_idx := 0;
  FOR t IN SELECT * FROM unnest(v_census) c WHERE c.lifecycle IN ('live', 'opening') AND c.role = 'main' ORDER BY c.created_at LOOP
    v_idx := v_idx + 1;
    IF t.main_index IS DISTINCT FROM v_idx THEN
      UPDATE public.tables SET main_index = v_idx,
             name = CASE WHEN v_idx = 1 THEN g.name ELSE left(g.name, 50) || ' Main ' || v_idx END
       WHERE id = t.id;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
      VALUES (g.id, t.id, 'main_renumbered', jsonb_build_object('from', t.main_index, 'to', v_idx));
    END IF;
  END LOOP;
  IF v_idx >= 2 AND NOT EXISTS (SELECT 1 FROM unnest(v_census) c WHERE c.role = 'feeder' AND c.lifecycle IN ('live', 'opening')) THEN
    SELECT * INTO t FROM unnest(v_census) c WHERE c.role = 'main' AND c.lifecycle = 'live' ORDER BY c.created_at DESC LIMIT 1;
    UPDATE public.tables SET role = 'feeder', main_index = NULL, promote_pending = false,
           name = left(g.name, 50) || ' Feeder'
     WHERE id = t.id;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'main_demoted_to_feeder');
    v_actions := v_actions || jsonb_build_object('demoted', t.id);
  END IF;

  -- A BREAKING MAIN KEEPS A NUMBER A SURVIVOR IS RENUMBERED INTO (2026-09-09).
  -- The loop above walks live|opening mains only, so a BREAKING main holds its
  -- old index while the survivors renumber past it. The break candidate is
  -- chosen empty-first, so an empty Main 2 is taken ahead of a populated
  -- feeder and Main 3 is renumbered to 2 in the same pass: two tables carrying
  -- main_index 2, both named "... Main 2", until the break completes and
  -- fn_closed_cluster_main_releases_index nulls the closed one. Nothing
  -- refuses the duplicate - there is no unique index on
  -- (cluster_id, main_index) - and fn_cash_clusters_to_tick reads
  -- `main_index = 1 AND lifecycle <> 'closed'`, which a breaking table
  -- satisfies, so the controller's eligible-horse map can be keyed on a table
  -- that refuses every player it is sent.
  --
  -- So the breaking one moves above the live range, here, in the transaction
  -- that created the collision. After the demote block on purpose: v_idx is
  -- the live main count and a demoted table's main_index is NULL, so these
  -- numbers can collide with nothing. Seats, lifecycle and planned moves are
  -- untouched.
  FOR t IN SELECT * FROM unnest(v_census) c
            WHERE c.breaking AND c.role = 'main'
              AND c.main_index IS NOT NULL AND c.main_index <= v_idx
            ORDER BY c.main_index
  LOOP
    v_idx := v_idx + 1;
    UPDATE public.tables SET main_index = v_idx, name = left(g.name, 50) || ' Main ' || v_idx
     WHERE id = t.id;
    INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload)
    VALUES (g.id, t.id, 'main_renumbered',
            jsonb_build_object('from', t.main_index, 'to', v_idx,
                               'reason', 'breaking_main_released_a_live_index'));
    v_actions := v_actions || jsonb_build_object('breaking_main_renumbered', t.id);
  END LOOP;

  -- ── enabled = false (18.4): no seeding, no opening; empties close ─────────
  IF NOT g.enabled THEN
    FOR t IN SELECT * FROM unnest(v_census) c WHERE c.seated = 0 LOOP
      UPDATE public.tables SET status = 'closed', lifecycle = 'closed', current_players = 0, updated_at = now() WHERE id = t.id;
      INSERT INTO public.cash_cluster_events (game_id, table_id, kind) VALUES (g.id, t.id, 'table_closed_disabled');
      v_actions := v_actions || jsonb_build_object('closed_disabled', t.id);
    END LOOP;
  END IF;

  -- ── 7. WAKE / SLEEP (18.4) ───────────────────────────────────────────────
  v_new_state := CASE WHEN v_seated_total = 0 AND coalesce(p_eligible_horses, 0) = 0 THEN 'dormant' ELSE 'live' END;
  -- NOT gated on g.enabled (2026-09-07). `enabled` says whether this game
  -- may OPEN tables; it has nothing to do with whether `state` is true. Three
  -- games sat at 'live' with no tables and nobody in them for 38 hours
  -- because a disabled game could never be corrected, and once its last table
  -- closed fn_cash_clusters_to_tick stopped admitting it at all.
  IF g.state IS DISTINCT FROM v_new_state THEN
    UPDATE public.cash_games SET state = v_new_state, updated_at = now() WHERE id = g.id;
    INSERT INTO public.cash_cluster_events (game_id, kind, payload)
    VALUES (g.id, CASE WHEN v_new_state = 'live' THEN 'game_woken' ELSE 'game_dormant' END,
            jsonb_build_object('seated_total', v_seated_total, 'eligible_horses', p_eligible_horses));
    v_actions := v_actions || jsonb_build_object('state', v_new_state);
  END IF;

  UPDATE public.cash_games SET last_tick_at = v_now, last_tick_actions = v_actions WHERE id = g.id;

  RETURN jsonb_build_object('ok', true, 'game_id', g.id, 'seated_total', v_seated_total,
                            'tables', v_live_tables, 'buyers', v_buyers, 'actions', v_actions);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ca_horse_roster_refresh(integer,integer,integer,numeric,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_horse_roster_refresh(integer,integer,integer,numeric,integer) TO service_role;
REVOKE ALL ON FUNCTION public.fn_ca_horse_roster_seat_guard() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_horse_roster_seat_guard() TO service_role;
REVOKE ALL ON FUNCTION public.fn_cash_cluster_tick(uuid,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_cash_cluster_tick(uuid,integer) TO service_role;

UPDATE public.ca_declared_money_triggers
SET note='October 26: top-half cash-performance admission; every club/variant, tournaments and existing same-game moves preserved. No chip writes.'
WHERE table_name='table_seats' AND trigger_name='zzzzzz_horse_roster_seat_guard';
-- Preserve the existing daily business schedule; replace its stale fixed-50/90-day arguments.
SELECT cron.alter_job(job_id := jobid, command := 'select public.fn_ca_horse_roster_refresh()')
FROM cron.job WHERE jobname='ca-horse-roster-refresh';
-- Refresh uses the existing daily business refresh as well as this explicit installation.
SELECT public.fn_ca_horse_roster_refresh();
COMMIT;
