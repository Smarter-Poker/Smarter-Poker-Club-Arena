-- ============================================================================
-- DIAMOND PHASE 9 - FUNDED CONSERVATION REHEARSAL, EVERY FORMAT
-- ============================================================================
-- REHEARSAL ONLY. Run by /Users/smarter.poker/Documents/diamond-arena/bin/rehearse.sh
-- (an empty migration file first) against production, once per slice, each
-- run ONE transaction that ends in a deliberate error (RAISE EXCEPTION
-- 'REHEARSAL OK [slice ...]: ...'), so NOTHING persists. No CI runner loads
-- this file; it is evidence, repeatable by hand.
--
-- The line it evidences (docs/POKER-ARENA-DIAMOND-BUILD-PROGRAMME.md, Phase 9):
-- "Test prize-pool conservation, capped exposure, rounding and cancellation
-- recovery" - the FUNDED half the closed-arena CI cases cannot reach: an
-- event's entries in equal to its prizes, bounties and fees out with custody
-- released, banks at zero and the supply identity unchanged; cancellation
-- after launch, after a rebuy and after a paid bounty; replays of every money
-- step. Seven formats: mtt, sng, bounty, progressive_bounty (PKO),
-- mystery_bounty, satellite (into a Diamond target) and spin.
--
-- INSIDE THIS ROLLED-BACK TRANSACTION ONLY, and never committed: synthetic
-- accounts (hydra.bot, no club membership) get sessions and 1000-Diamond
-- wallets by hand; the fixture's staff account is made admin; the house is
-- given the cover a Spin table needs; a Spin reserve source is authorized with
-- the table's OWN worst excess as its cap (derived from the contract, not a
-- number anyone approved); and tournaments_enabled is opened. Every one of
-- those is rolled back with the rest. The supply identity is measured
-- relative to a baseline taken AFTER that scene.
--
-- REHEARSAL SAFETY (the 2026-09-29 rules):
--   * lock_timeout 2s, so the rehearsal - not live play - gives way. The one
--     exception is stage 2's single wait for the finish lane (see there).
--   * Every deferred constraint is forced at each point a real transaction
--     would commit (SET CONSTRAINTS ALL IMMEDIATE, then back to deferred): the
--     seat guards P0810-P0815, the entry-custody guard, the roster, elimination
--     and table-origin guards. A launch is one commit per RPC, as the engine
--     runs it.
--   * The global settlement lane is never requested. Every finish, settlement
--     and cancellation runs last, back to back, inside ONE finish lane (F),
--     which the rehearsal queues for like any live finish; a cancellation runs
--     inside it naming its own event (fn_ca_lock_settlement_lane_global
--     re-enters a held finish lane instead of escalating), which changes
--     which advisory keys are held, never what moves. Each phase records the
--     lane keys it holds, and a phase that finds the global lane taken fails.
--   * SLICES. Seven formats do not fit one transaction under the ten-second
--     target, so this ONE fixture is run once per slice (the line below the
--     SET LOCALs), each run its own rolled-back transaction with its own
--     REHEARSAL OK line: mtt | sng | bounty | pko | mystery | satellite,spin.
--   * The supply identity is read three times per run (baseline, after stage
--     1, at the end), not per case: it costs up to a second a read.
-- Numbers are rehearsal inputs, chosen so fees, ladders, heads and halves do
-- NOT divide evenly; none is an approved price, rate or guarantee.
-- ============================================================================
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '20s';
-- THE SLICE THIS RUN COVERS. The seven formats do not fit one transaction under
-- the ten-second rehearsal target, so this one fixture is run once per slice,
-- each run its own rolled-back transaction ending in its own REHEARSAL OK line:
--   mtt | sng | bounty | pko | mystery | satellite,spin
SELECT set_config('conservation.slice', 'mtt', true);
SELECT set_config('conservation.boundary', 'all', true);
-- The initially-deferred constraints, put back to deferred after each forced commit.
SELECT set_config('conservation.deferred_sql', (SELECT 'SET CONSTRAINTS '||string_agg(DISTINCT quote_ident(n.nspname)||'.'||quote_ident(c.conname), ', ')||' DEFERRED'
  FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE c.condeferrable AND c.condeferred), true);

CREATE TEMP TABLE res(n serial PRIMARY KEY, fmt text, name text, ok boolean, info boolean DEFAULT false, detail text);
CREATE TEMP TABLE formats(ord int PRIMARY KEY, fmt text UNIQUE, cfg jsonb, players uuid[]);
CREATE TEMP TABLE base(k text PRIMARY KEY, v numeric);
CREATE TEMP TABLE state(fmt text, k text, v text, PRIMARY KEY (fmt,k));
CREATE TEMP TABLE timing(n serial PRIMARY KEY, fmt text, phase text, ms numeric);
-- Every event this rehearsal creates, with its format, so the end can account
-- for every Diamond across all of them.
CREATE TEMP TABLE events(tid uuid PRIMARY KEY, fmt text, label text);

CREATE FUNCTION pg_temp.players() RETURNS uuid[] LANGUAGE sql STABLE AS $f$
  SELECT players FROM pg_temp.formats WHERE fmt=current_setting('conservation.fmt');
$f$;
CREATE FUNCTION pg_temp.admin() RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$
  SELECT '00000000-0000-0000-0000-000000000001'::uuid;
$f$;
CREATE FUNCTION pg_temp.put(p_fmt text, p_k text, p_v text) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO pg_temp.state VALUES (p_fmt,p_k,p_v) ON CONFLICT (fmt,k) DO UPDATE SET v=EXCLUDED.v;
$f$;
CREATE FUNCTION pg_temp.get(p_fmt text, p_k text) RETURNS text LANGUAGE sql AS $f$
  SELECT v FROM pg_temp.state WHERE fmt=p_fmt AND k=p_k;
$f$;

-- A real client: its own uid, the authenticated role, a live session, and no
-- engine header.
CREATE FUNCTION pg_temp.as_client(p_uid uuid) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub',p_uid,'role','authenticated',
    'session_id',uuid_in(md5('conservation-session:'||p_uid::text)::cstring))::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.headers', '{}', true);
END $f$;
CREATE FUNCTION pg_temp.as_engine() RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM set_config('request.jwt.claim.sub','',true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  PERFORM set_config('request.headers','{"x-smarter-data-actor":"service","x-smarter-data-protocol":"1"}',true);
  PERFORM set_config('request.method','POST',true);
END $f$;
-- Where a real transaction would commit: EVERY deferred constraint fires now
-- (the seat guards P0810-P0815, the entry-custody guard, the roster and
-- elimination guards), then the deferral is restored for the next "transaction".
-- (conservation.boundary = 'all' is the evidence run. Any other value is an
-- exploratory run that forces a named subset, and can never print REHEARSAL OK.)
CREATE FUNCTION pg_temp.commit_boundary() RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  IF current_setting('conservation.boundary', true) = 'all' THEN
    SET CONSTRAINTS ALL IMMEDIATE;
  ELSE
    EXECUTE current_setting('conservation.boundary_sql');
  END IF;
  EXECUTE current_setting('conservation.deferred_sql');
END $f$;

CREATE FUNCTION pg_temp.chk(p_fmt text, p_name text, p_ok boolean, p_detail text DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO pg_temp.res(fmt,name,ok,detail) VALUES (p_fmt,p_name,COALESCE(p_ok,false),left(p_detail,700));
  RETURN COALESCE(p_ok,false);
END $f$;
CREATE FUNCTION pg_temp.note(p_fmt text, p_name text, p_detail text) RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO pg_temp.res(fmt,name,ok,info,detail) VALUES (p_fmt,p_name,true,true,left(p_detail,700));
END $f$;
-- A refusal probe: runs the statement, ALWAYS rolls it back, and passes only
-- when it raised an error whose text matches the expected pattern (a regex).
CREATE FUNCTION pg_temp.refuses(p_fmt text, p_name text, p_sql text, p_expect text) RETURNS boolean
LANGUAGE plpgsql AS $f$
DECLARE v_msg text;
BEGIN
  BEGIN
    EXECUTE p_sql;
    RAISE EXCEPTION 'PROBE_SUCCEEDED_AND_WAS_ROLLED_BACK';
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM;
  END;
  RETURN pg_temp.chk(p_fmt, p_name, v_msg ~ p_expect AND v_msg <> 'PROBE_SUCCEEDED_AND_WAS_ROLLED_BACK',
    'raised: '||v_msg);
END $f$;

-- Everything a refusal must leave untouched, for one event and its players.
CREATE FUNCTION pg_temp.money(p_tid uuid) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object(
    'wallets',(SELECT jsonb_object_agg(id::text, diamonds) FROM public.profiles WHERE id = ANY(pg_temp.players())),
    'house',(SELECT balance FROM public.ca_diamond_house WHERE id=1),
    'custody',public.fn_poker_diamond_tournament_custody(p_tid),
    'custody_rows',(SELECT jsonb_agg(jsonb_build_array(c.id,c.state,c.balance) ORDER BY c.id) FROM public.poker_diamond_custody c WHERE c.target_id=p_tid),
    'ledger',(SELECT count(*) FROM public.poker_diamond_tournament_ledger WHERE tournament_id=p_tid),
    'movements',(SELECT count(*) FROM public.poker_diamond_movements m JOIN public.poker_diamond_custody c ON c.id=m.custody_id WHERE c.target_id=p_tid),
    'journal',(SELECT count(*) FROM public.diamond_transactions WHERE user_id = ANY(pg_temp.players())),
    'credit_keys',(SELECT count(*) FROM public.wallet_credit_idempotency WHERE user_id = ANY(pg_temp.players())),
    'escrow',(SELECT to_jsonb(e) FROM public.fn_poker_diamond_tournament_escrow(p_tid) e),
    'caches',(SELECT jsonb_build_array(prize_pool,bounty_pool,total_rake,bounty_pool_paid,status) FROM public.tournaments WHERE id=p_tid));
$f$;

CREATE FUNCTION pg_temp.identity() RETURNS numeric LANGUAGE sql AS $f$
  SELECT difference FROM public.fn_ca_diamond_register_vs_supply();
$f$;

-- The configuration the classic formats share; each format's row adds its own.
CREATE FUNCTION pg_temp.cfg(p_fmt text) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('name','Conservation Rehearsal '||p_fmt,'gameVariant','NLH','maxPlayers',9,'minPlayers',2,
    'startingStack',10000,
    'blindStructure','[{"level":1,"smallBlind":25,"bigBlind":50,"ante":0,"duration":600},{"level":2,"smallBlind":50,"bigBlind":100,"ante":0,"duration":600}]'::jsonb,
    'payoutStructure','[{"place":1,"percentage":50},{"place":2,"percentage":30},{"place":3,"percentage":20}]'::jsonb,
    'startTime',(now()+interval '1 hour')::text)
  || (SELECT cfg FROM pg_temp.formats WHERE fmt=p_fmt);
$f$;

CREATE FUNCTION pg_temp.create_event(p_fmt text, p_label text, p_cfg jsonb) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v jsonb;
BEGIN
  PERFORM pg_temp.as_client(pg_temp.admin());
  v := public.fn_poker_diamond_create_tournament(p_cfg);
  IF (v->>'tournamentId') IS NULL THEN RAISE EXCEPTION 'the create door refused %: %', p_label, v; END IF;
  INSERT INTO pg_temp.events VALUES ((v->>'tournamentId')::uuid, p_fmt, p_label);
  RETURN v;
END $f$;
CREATE FUNCTION pg_temp.register(p_tid uuid, p_user uuid, p_req uuid) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v jsonb;
BEGIN
  PERFORM pg_temp.as_client(p_user);
  v := public.fn_register_for_tournament_request(p_tid, p_req);
  PERFORM pg_temp.commit_boundary();
  RETURN v;
END $f$;
CREATE FUNCTION pg_temp.unregister(p_tid uuid, p_user uuid, p_req uuid) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v jsonb;
BEGIN
  PERFORM pg_temp.as_client(p_user);
  v := public.fn_unregister_from_tournament(p_tid, p_req);
  PERFORM pg_temp.commit_boundary();
  RETURN v;
END $f$;
-- The rebuy money core, exactly as process_tournament_rebuy calls it once the
-- engine's accepted-hand bust evidence is proved (that evidence cannot be
-- forged in a rehearsal; the public door replays its stored receipt first).
CREATE FUNCTION pg_temp.rebuy(p_tid uuid, p_user uuid, p_token text) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v jsonb;
BEGIN
  PERFORM pg_temp.as_engine();
  v := public.fn_ca_process_tournament_chip_purchase_money_v1(p_tid, p_user, 'rebuy', NULL, NULL, 1, p_token);
  PERFORM pg_temp.commit_boundary();
  RETURN v;
END $f$;
-- The engine's cancel door. It asks for the global settlement lane first; a
-- rehearsal on a live platform never takes that lane, so the cancel runs
-- inside the finish lane this transaction already holds, named for the event
-- being cancelled (fn_ca_lock_settlement_lane_global re-enters a held finish
-- lane instead of escalating). Which advisory keys are held changes; what
-- moves does not.
CREATE FUNCTION pg_temp.cancel(p_tid uuid) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v jsonb;
BEGIN
  PERFORM pg_temp.as_engine();
  PERFORM set_config('ca.finish_lane_tournament', p_tid::text, true);
  v := public.fn_poker_diamond_tournament_cancel(p_tid, pg_temp.admin());
  PERFORM pg_temp.commit_boundary();
  RETURN v;
END $f$;
-- A bust as the engine writes one (fn_eliminate_player_legacy_candidate_20260907):
-- the roster row eliminated at its place, its chair vacated, the table's count
-- recounted, the seat-first count synced. A bust inside a rebuy window
-- (conservation.rebuy_window names the player) is what the accepted hand leaves
-- before the rebuy decision: no chips, still playing, the chair kept at zero.
CREATE FUNCTION pg_temp.bust(p_tid uuid, p_user uuid, p_position int) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_tables uuid[];
BEGIN
  IF current_setting('conservation.rebuy_window', true) = p_user::text THEN
    UPDATE public.tournament_players SET chips=0 WHERE tournament_id=p_tid AND user_id=p_user;
  ELSE
    UPDATE public.tournament_players SET chips=0, status='eliminated', position=p_position,
           eliminated_at=now() + make_interval(secs => 100 - p_position)
     WHERE tournament_id=p_tid AND user_id=p_user;
  END IF;
  -- The chair the hand busted is vacated as the hand settlement vacates a
  -- zero-stack seat (fn_ca_settle_hand_stacks_absolute): at the wall clock,
  -- status left, every sit-out flag cleared.
  WITH released AS (
    UPDATE public.table_seats s SET stack=0, left_at=clock_timestamp(), status='left', leave_pending=false,
           is_sitting_out=false, is_away=false, sit_out_at=NULL, scheduled_leave_hands=NULL
      FROM public.tables tb
     WHERE tb.id=s.table_id AND tb.tournament_id=p_tid AND s.user_id=p_user AND s.left_at IS NULL
    RETURNING s.table_id)
  SELECT COALESCE(array_agg(DISTINCT table_id), ARRAY[]::uuid[]) INTO v_tables FROM released;
  UPDATE public.tables tb SET current_players=(
    SELECT count(*) FROM public.table_seats s WHERE s.table_id=tb.id AND s.left_at IS NULL)
   WHERE tb.id = ANY(v_tables);
  PERFORM public.fn_sync_seat_first_player_count(p_tid);
END $f$;

-- Timing inside a phase: milliseconds since the previous tick.
CREATE FUNCTION pg_temp.tick(p_label text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_prev timestamptz := COALESCE(NULLIF(current_setting('conservation.tick', true),'')::timestamptz, clock_timestamp());
BEGIN
  INSERT INTO pg_temp.timing(fmt, phase, ms) VALUES (current_setting('conservation.fmt', true), '  '||p_label,
    round(extract(epoch FROM clock_timestamp() - v_prev)*1000));
  PERFORM set_config('conservation.tick', clock_timestamp()::text, true);
END $f$;

-- The estate's launch protocol, one RPC (one commit) at a time: begin, the
-- table (born inside the open launch), each chair, then completion.
CREATE FUNCTION pg_temp.launch(p_tid uuid, p_players uuid[], p_complete boolean) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v_gen uuid := gen_random_uuid(); v_launch uuid := gen_random_uuid(); v_res jsonb; v_table uuid;
        v_arena uuid; v_fmt text; v_size int; i int;
BEGIN
  SELECT club_id, table_size INTO v_arena, v_size FROM public.tournaments WHERE id=p_tid;
  v_fmt := public.fn_ca_tournament_recorded_format(p_tid);
  PERFORM pg_temp.as_engine();
  PERFORM set_config('request.path','rpc/claim_tournament_lease_v2',true);
  SET LOCAL ROLE service_role;
  PERFORM smarter_private.fn_smarter_data_api_pre_request();
  PERFORM public.claim_tournament_lease_v2(p_tid,'conservation-rehearsal','conservation-proof',v_gen,30);
  v_res := public.fn_begin_tournament_launch_atomic(p_tid, v_launch, now(), v_gen, v_fmt);
  RESET ROLE;
  IF (v_res->>'ok') IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'begin launch refused: %', v_res; END IF;
  PERFORM pg_temp.commit_boundary();
  SET LOCAL ROLE service_role;
  INSERT INTO public.tables (club_id, tournament_id, name, game_type, game_variant, stakes, small_blind, big_blind, ante,
                             min_buy_in, max_buy_in, max_players, current_players, status, action_time_seconds)
  VALUES (v_arena, p_tid, 'Conservation Rehearsal - Table 1', 'tournament', 'nlh', '25/50', 25, 50, 0, 0, 0,
          COALESCE(v_size,9), 0, 'running', 15) RETURNING id INTO v_table;
  RESET ROLE;
  PERFORM pg_temp.commit_boundary();
  FOR i IN 1..array_length(p_players,1) LOOP
    SET LOCAL ROLE service_role;
    v_res := public.fn_assign_tournament_player_seat_atomic(p_tid, p_players[i], v_table, i);
    RESET ROLE;
    IF COALESCE((v_res->>'ok')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'seat % refused: %', i, v_res; END IF;
    PERFORM pg_temp.commit_boundary();
  END LOOP;
  IF p_complete THEN
    SET LOCAL ROLE service_role;
    v_res := public.fn_complete_tournament_launch_atomic(p_tid, v_launch, v_gen, v_fmt);
    RESET ROLE;
    IF (v_res->>'status') IS DISTINCT FROM 'RUNNING' THEN RAISE EXCEPTION 'complete launch refused: %', v_res; END IF;
    PERFORM pg_temp.commit_boundary();
  END IF;
  RETURN v_table;
END $f$;

-- The engine's one terminal door, each finish its own "transaction": the lane
-- marker a real commit clears is cleared first, so the terminal takes the
-- finish lane for its own event in the ordinary way.
CREATE FUNCTION pg_temp.terminal(p_tid uuid, p_winner uuid) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v jsonb;
BEGIN
  PERFORM set_config('ca.finish_lane_tournament', '', true);
  PERFORM pg_temp.as_engine();
  PERFORM set_config('request.path','rpc/fn_complete_tournament_terminal',true);
  SET LOCAL ROLE service_role;
  v := public.fn_complete_tournament_terminal(p_tid, p_winner, 'places');
  RESET ROLE;
  PERFORM pg_temp.commit_boundary();
  RETURN v;
END $f$;
-- ============================================================================
-- KNOCKOUTS, as the engine's claim writes them (from the 2026-09-21 fixture).
-- ============================================================================
-- A knockout the way the engine's claim writes it (the obligation row, then the
-- estate's own collector). Expected shares are computed HERE, independently:
-- each claimant but the last takes floor(head / n) floored to the unit, the
-- last takes the remainder; a PKO share pays its cash half floored to the unit
-- and the rest rides onto the claimant's head.
CREATE FUNCTION pg_temp.ko(p_fmt text, p_tid uuid, p_table uuid, p_victim uuid, p_claimants uuid[], p_position int,
                            p_hand bigint, p_joined timestamptz) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE
  v_t record; v_mode text; v_head numeric; v_ob uuid; v_res jsonb; v_e0 record; v_e1 record;
  v_w0 jsonb; v_h0 jsonb; v_n int := array_length(p_claimants,1); v_cents bigint; v_assigned bigint := 0;
  v_share bigint; v_cash bigint; v_exp_cash jsonb := '{}'; v_exp_head jsonb := '{}'; v_total_cash bigint := 0;
  v_ok boolean := true; v_u uuid; i int := 0; v_detail text := '';
BEGIN
  PERFORM pg_temp.as_engine();
  SELECT is_bounty, is_pko, is_mystery_bounty, bounty_amount INTO v_t FROM public.tournaments WHERE id=p_tid;
  IF NOT (COALESCE(v_t.is_bounty,false) OR COALESCE(v_t.is_pko,false) OR COALESCE(v_t.is_mystery_bounty,false)) THEN
    PERFORM pg_temp.bust(p_tid, p_victim, p_position);
    RETURN jsonb_build_object('ok',true,'mode','none');
  END IF;
  v_mode := CASE WHEN v_t.is_pko THEN 'pko' WHEN v_t.is_mystery_bounty THEN 'mystery_pre' ELSE 'regular' END;
  SELECT COALESCE(NULLIF(current_bounty,0), v_t.bounty_amount) INTO v_head
    FROM public.tournament_players WHERE tournament_id=p_tid AND user_id=p_victim;
  -- A PKO knockout is now proved from the engine's accepted-hand evidence (a
  -- knockout candidate bound to hand_atomic_commits, a succeeded settlement
  -- key and hand_history). A rehearsal cannot forge that evidence, so the
  -- collector is probed (and rolled back) and the player simply busts; the
  -- PKO bounty bank is then settled whole at the terminal.
  IF v_mode='pko' THEN
    BEGIN
      INSERT INTO public.tournament_bounty_obligations
        (tournament_id, eliminated_user_id, table_id, hand_id, hand_number, settlement_completed_at, seat_joined_at, position, prize, bubble_refund,
         mode, activation_generation, head_amount, knocker_user_id, claimants, state, attempt_count, next_attempt_at)
      VALUES (p_tid, p_victim, p_table, gen_random_uuid(), p_hand, now(), p_joined, p_position, 0, 0,
         'pko', 0, v_head, p_claimants[1], jsonb_build_array(jsonb_build_object('user_id',p_claimants[1],'weight',1)), 'pending', 0, now())
      RETURNING id INTO v_ob;
      PERFORM set_config('app.bounty_obligation_id', v_ob::text, true);
      v_res := public.fn_collect_bounty(p_tid, p_victim, p_claimants[1], NULL);
      RAISE EXCEPTION 'PKO_PROBE %', v_res;
    EXCEPTION WHEN OTHERS THEN
      v_detail := SQLERRM;
    END;
    IF p_hand = 1000001 THEN
      PERFORM pg_temp.note(p_fmt,'PKO knockouts are not driven: the collector refuses a knockout without the engine''s accepted-hand evidence, which a rehearsal cannot forge; every PKO bust here settles at the terminal instead',
        v_detail);
    END IF;
    PERFORM pg_temp.bust(p_tid, p_victim, p_position);
    RETURN jsonb_build_object('ok',true,'mode','pko_not_driven','probe',v_detail);
  END IF;
  SELECT jsonb_object_agg(id::text, diamonds) INTO v_w0 FROM public.profiles WHERE id = ANY(p_claimants);
  SELECT jsonb_object_agg(user_id::text, COALESCE(current_bounty,0)) INTO v_h0 FROM public.tournament_players
   WHERE tournament_id=p_tid AND user_id = ANY(p_claimants);
  SELECT * INTO v_e0 FROM public.fn_poker_diamond_tournament_escrow(p_tid);
  v_cents := round(v_head*100)::bigint;
  FOR v_u IN SELECT u FROM unnest(p_claimants) u ORDER BY u::text LOOP
    i := i + 1;
    IF i < v_n THEN
      v_share := (floor(floor(v_cents::numeric / v_n) / 100) * 100)::bigint;
    ELSE
      v_share := v_cents - v_assigned;
    END IF;
    v_assigned := v_assigned + v_share;
    v_cash := CASE WHEN v_mode='pko' THEN (floor(trunc(v_share::numeric/2) / 100) * 100)::bigint ELSE v_share END;
    v_total_cash := v_total_cash + v_cash;
    v_exp_cash := v_exp_cash || jsonb_build_object(v_u::text, v_cash/100);
    v_exp_head := v_exp_head || jsonb_build_object(v_u::text, (v_share - v_cash)/100);
  END LOOP;
  PERFORM pg_temp.bust(p_tid, p_victim, p_position);
  INSERT INTO public.tournament_bounty_obligations
    (tournament_id, eliminated_user_id, table_id, hand_id, hand_number, settlement_completed_at, seat_joined_at, position, prize, bubble_refund,
     mode, activation_generation, head_amount, knocker_user_id, claimants, state, attempt_count, next_attempt_at)
  VALUES (p_tid, p_victim, p_table, gen_random_uuid(), p_hand, now(), p_joined, p_position, 0, 0,
     v_mode, 0, v_head, p_claimants[1],
     (SELECT jsonb_agg(jsonb_build_object('user_id',u,'weight',1)) FROM unnest(p_claimants) u), 'pending', 0, now())
  RETURNING id INTO v_ob;
  PERFORM set_config('app.bounty_obligation_id', v_ob::text, true);
  v_res := public.fn_collect_bounty(p_tid, p_victim, p_claimants[1], NULL);
  PERFORM set_config('app.bounty_obligation_id', '', true);
  PERFORM pg_temp.commit_boundary();
  SELECT * INTO v_e1 FROM public.fn_poker_diamond_tournament_escrow(p_tid);
  FOREACH v_u IN ARRAY p_claimants LOOP
    IF (SELECT diamonds FROM public.profiles WHERE id=v_u) <> (v_w0->>v_u::text)::numeric + (v_exp_cash->>v_u::text)::numeric
       OR (SELECT COALESCE(current_bounty,0) FROM public.tournament_players WHERE tournament_id=p_tid AND user_id=v_u)
          <> (v_h0->>v_u::text)::numeric + (v_exp_head->>v_u::text)::numeric THEN
      v_ok := false;
    END IF;
    v_detail := v_detail || format(' %s: wallet %s->%s head %s->%s;', right(v_u::text,2),
      (v_w0->>v_u::text), (SELECT diamonds FROM public.profiles WHERE id=v_u),
      (v_h0->>v_u::text), (SELECT current_bounty FROM public.tournament_players WHERE tournament_id=p_tid AND user_id=v_u));
  END LOOP;
  PERFORM pg_temp.chk(p_fmt, format('knockout (%s, head %s, %s claimant(s)): each claimant is paid its exact whole-Diamond share from the bounty bank and nothing else moves', v_mode, v_head, v_n),
    COALESCE((v_res->>'ok')::boolean,false) AND v_ok AND (v_res->>'paid_cash')::numeric = v_total_cash/100.0
    AND v_e1.bounty_out - v_e0.bounty_out = v_total_cash/100.0
    AND v_e1.prize_balance = v_e0.prize_balance AND v_e1.fee_balance = v_e0.fee_balance,
    format('%s | expected cash %s head %s |%s', v_res, v_exp_cash, v_exp_head, v_detail));
  IF v_n > 1 OR v_mode='pko' THEN
    PERFORM pg_temp.chk(p_fmt, format('rounding (%s): a head that does not divide is spent exactly, its residue on a named claimant or head, whole', v_mode),
      v_ok AND v_assigned = v_cents
      AND (SELECT sum(x.value::numeric) FROM jsonb_each_text(v_exp_cash) x)
        + (SELECT sum(x.value::numeric) FROM jsonb_each_text(v_exp_head) x) = v_head
      AND NOT EXISTS (SELECT 1 FROM jsonb_each_text(v_exp_cash) x WHERE x.value::numeric <> trunc(x.value::numeric))
      AND NOT EXISTS (SELECT 1 FROM jsonb_each_text(v_exp_head) x WHERE x.value::numeric <> trunc(x.value::numeric)),
      format('head %s -> cash %s, onto heads %s', v_head, v_exp_cash, v_exp_head));
  END IF;
  SELECT jsonb_object_agg(id::text, diamonds) INTO v_w0 FROM public.profiles WHERE id = ANY(p_claimants);
  BEGIN
    PERFORM set_config('app.bounty_obligation_id', v_ob::text, true);
    v_res := public.fn_collect_bounty(p_tid, p_victim, p_claimants[1], NULL);
    PERFORM set_config('app.bounty_obligation_id', '', true);
  EXCEPTION WHEN OTHERS THEN
    v_res := jsonb_build_object('raised', SQLERRM);
  END;
  PERFORM pg_temp.chk(p_fmt, 'idempotency: collecting a settled knockout again answers with what it paid and pays nothing',
    COALESCE((v_res->>'already')::boolean,false)
    AND (SELECT jsonb_object_agg(id::text, diamonds) FROM public.profiles WHERE id = ANY(p_claimants)) = v_w0
    AND (SELECT bounty_out FROM public.fn_poker_diamond_tournament_escrow(p_tid)) = v_e1.bounty_out, v_res::text);
  RETURN v_res || jsonb_build_object('obligation_id', v_ob);
END $f$;

-- A mystery chest knockout, as m9b drove it: the claim's obligation, the
-- reserve that draws a sealed chest, the reveal, the payment.
CREATE FUNCTION pg_temp.chest_ko(p_fmt text, p_tid uuid, p_table uuid, p_victim uuid, p_knocker uuid, p_position int, p_hand bigint)
RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v_hand uuid := gen_random_uuid(); v_ob uuid; v_res jsonb; v_pay jsonb; v_award uuid; v_amt bigint; v_w numeric;
        v_e0 record; v_e1 record; v_head numeric;
BEGIN
  PERFORM pg_temp.as_engine();
  SELECT bounty_amount INTO v_head FROM public.tournaments WHERE id=p_tid;
  SELECT diamonds INTO v_w FROM public.profiles WHERE id=p_knocker;
  SELECT * INTO v_e0 FROM public.fn_poker_diamond_tournament_escrow(p_tid);
  PERFORM pg_temp.bust(p_tid, p_victim, p_position);
  INSERT INTO public.tournament_bounty_obligations
    (tournament_id, eliminated_user_id, table_id, hand_id, hand_number, settlement_completed_at, seat_joined_at, position, prize, bubble_refund,
     mode, activation_generation, head_amount, knocker_user_id, claimants, state, attempt_count, next_attempt_at)
  VALUES (p_tid, p_victim, p_table, v_hand, p_hand, now(), now(), p_position, 0, 0,
     'mystery_chest', 1, v_head, p_knocker, jsonb_build_array(jsonb_build_object('user_id',p_knocker,'weight',1)), 'pending', 0, now())
  RETURNING id INTO v_ob;
  v_res := public.fn_mystery_bounty_reserve(p_tid, p_victim, NULL, p_table, v_hand::text, gen_random_uuid());
  IF COALESCE((v_res->>'ok')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'mystery reserve refused: %', v_res; END IF;
  v_award := (v_res->>'award_id')::uuid;
  SELECT amount_cents INTO v_amt FROM public.tournament_bounty_awards WHERE id=v_award;
  PERFORM public.fn_mystery_bounty_reveal(v_award, p_knocker, false);
  v_pay := public.fn_mystery_bounty_pay(v_award);
  PERFORM pg_temp.commit_boundary();
  SELECT * INTO v_e1 FROM public.fn_poker_diamond_tournament_escrow(p_tid);
  PERFORM pg_temp.chk(p_fmt, 'knockout (mystery chest): the knocker is paid its whole-Diamond chest from the bounty bank',
    COALESCE((v_pay->>'ok')::boolean,false) AND v_amt % 100 = 0 AND v_amt > 0
    AND (SELECT diamonds FROM public.profiles WHERE id=p_knocker) = v_w + v_amt/100
    AND v_e1.bounty_out - v_e0.bounty_out = v_amt/100
    AND v_e1.prize_balance = v_e0.prize_balance AND v_e1.fee_balance = v_e0.fee_balance
    AND (SELECT status FROM public.tournament_bounty_awards WHERE id=v_award)='completed'
    AND EXISTS (SELECT 1 FROM public.tournament_bounty_obligations WHERE id=v_ob AND state='settled')
    AND public.fn_bounty_obligation_has_complete_marker(v_ob),
    format('reserve %s | pay %s | chest %s cents', v_res, v_pay, v_amt));
  v_w := (SELECT diamonds FROM public.profiles WHERE id=p_knocker);
  BEGIN
    v_pay := public.fn_mystery_bounty_pay(v_award);
  EXCEPTION WHEN OTHERS THEN
    v_pay := jsonb_build_object('raised', SQLERRM);
  END;
  PERFORM pg_temp.chk(p_fmt, 'idempotency: paying a paid chest again pays nothing',
    (SELECT diamonds FROM public.profiles WHERE id=p_knocker) = v_w
    AND (SELECT bounty_out FROM public.fn_poker_diamond_tournament_escrow(p_tid)) = v_e1.bounty_out, v_pay::text);
  RETURN jsonb_build_object('award_id',v_award,'amount_cents',v_amt);
END $f$;

-- ============================================================================
-- EVERY CONSERVATION FACT ONE EVENT MUST END WITH, whether it completed or was
-- cancelled. Per event, from its own ledger, custody, movements and journal.
-- (Wallets and the house are accounted per format and for the whole
-- rehearsal at the end, where the events that share them are all closed.)
-- ============================================================================
CREATE FUNCTION pg_temp.conserved(p_fmt text, p_case text, p_tid uuid)
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_e record; v_in numeric; v_out numeric; v_status text; v_label text := p_case||': ';
BEGIN
  SELECT status INTO v_status FROM public.tournaments WHERE id=p_tid;
  SELECT * INTO v_e FROM public.fn_poker_diamond_tournament_escrow(p_tid);
  PERFORM pg_temp.chk(p_fmt, v_label||'every bank (prize, bounty, fee) is at exact zero',
    v_e.prize_balance=0 AND v_e.bounty_balance=0 AND v_e.fee_balance=0, row_to_json(v_e)::text);
  SELECT COALESCE(sum(amount) FILTER (WHERE kind IN ('entry','rebuy','reentry','addon','spin_underwrite')),0),
         COALESCE(sum(amount) FILTER (WHERE kind IN ('prize','bounty','fee','refund','spin_surplus')),0)
    INTO v_in, v_out FROM public.poker_diamond_tournament_ledger WHERE tournament_id=p_tid;
  PERFORM pg_temp.chk(p_fmt, v_label||'what came in (entries, rebuys, any reserve underwrite) equals what went out (prizes, bounties, fees, refunds, any reserve surplus)',
    v_in = v_out AND v_in > 0,
    format('in %s = prize %s + bounty %s + fee %s + refund %s (+ surplus/underwrite legs)', v_in, v_e.prize_out, v_e.bounty_out, v_e.fee_out, v_e.refund_out));
  PERFORM pg_temp.chk(p_fmt, v_label||'every ledger row decomposes exactly into its prize, bounty and fee parts, in whole Diamonds',
    NOT EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger
                 WHERE tournament_id=p_tid AND (prize_part+bounty_part+fee_part<>amount OR amount<>trunc(amount))));
  PERFORM pg_temp.chk(p_fmt, v_label||'every custody row is released at exact zero',
    EXISTS (SELECT 1 FROM public.poker_diamond_custody WHERE target_id=p_tid)
    AND NOT EXISTS (SELECT 1 FROM public.poker_diamond_custody WHERE target_id=p_tid AND (state<>'released' OR balance<>0))
    AND public.fn_poker_diamond_tournament_custody(p_tid) = 0,
    (SELECT jsonb_agg(jsonb_build_array(state,balance))::text FROM public.poker_diamond_custody WHERE target_id=p_tid));
  PERFORM pg_temp.chk(p_fmt, v_label||'every custody row''s movements net to zero (reserved in = released out)',
    NOT EXISTS (SELECT 1 FROM public.poker_diamond_custody c WHERE c.target_id=p_tid AND
      (SELECT COALESCE(sum(CASE WHEN m.action='reserve' THEN m.amount ELSE -m.amount END),0)
         FROM public.poker_diamond_movements m WHERE m.custody_id=c.id) <> 0));
  PERFORM pg_temp.chk(p_fmt, v_label||'no ledger row is orphaned: every custody reference is one of this event''s entries',
    NOT EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger l
                 WHERE l.tournament_id=p_tid AND l.custody_id IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM public.poker_diamond_custody c
                                    WHERE c.id=l.custody_id AND c.target_id=p_tid AND c.purpose='tournament_entry')));
  PERFORM pg_temp.chk(p_fmt, v_label||'no custody row is orphaned: each carries exactly one entry line',
    NOT EXISTS (SELECT 1 FROM public.poker_diamond_custody c WHERE c.target_id=p_tid
                 AND (SELECT count(*) FROM public.poker_diamond_tournament_ledger l WHERE l.custody_id=c.id AND l.kind='entry')<>1));
  PERFORM pg_temp.chk(p_fmt, v_label||'every refund line names a settled refund obligation',
    NOT EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger l WHERE l.tournament_id=p_tid AND l.kind='refund'
                 AND (l.obligation_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.tournament_obligations o
                        WHERE o.id=l.obligation_id AND o.kind='refund' AND o.amount_paid=o.amount_owed AND o.settled_at IS NOT NULL))));
  PERFORM pg_temp.chk(p_fmt, v_label||'every prize and bounty line names the wallet journal row that credited it',
    NOT EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger l WHERE l.tournament_id=p_tid AND l.kind IN ('prize','bounty')
                 AND (l.wallet_journal_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.diamond_transactions d WHERE d.id=l.wallet_journal_id))));
  PERFORM pg_temp.chk(p_fmt, v_label||'every custody movement that moved a Diamond names its journal row',
    NOT EXISTS (SELECT 1 FROM public.poker_diamond_movements m JOIN public.poker_diamond_custody c ON c.id=m.custody_id
                 WHERE c.target_id=p_tid AND m.amount>0
                   AND (m.wallet_journal_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.diamond_transactions d WHERE d.id=m.wallet_journal_id))));
  PERFORM pg_temp.chk(p_fmt, v_label||'every obligation the event wrote is settled in full',
    NOT EXISTS (SELECT 1 FROM public.tournament_obligations o WHERE o.tournament_id=p_tid
                 AND (o.amount_paid IS DISTINCT FROM o.amount_owed OR o.settled_at IS NULL)),
    (SELECT jsonb_agg(jsonb_build_array(kind,place,amount_owed,amount_paid,settled_at IS NOT NULL))::text
       FROM public.tournament_obligations WHERE tournament_id=p_tid));
  PERFORM pg_temp.chk(p_fmt, v_label||'no fractional Diamond anywhere: caches, payouts and heads are whole',
    (SELECT prize_pool=trunc(prize_pool) AND bounty_pool=trunc(bounty_pool) AND COALESCE(bounty_pool_paid,0)=trunc(COALESCE(bounty_pool_paid,0))
            AND total_rake=trunc(total_rake) FROM public.tournaments WHERE id=p_tid)
    AND NOT EXISTS (SELECT 1 FROM public.tournament_payouts WHERE tournament_id=p_tid AND amount<>trunc(amount))
    AND NOT EXISTS (SELECT 1 FROM public.tournament_players WHERE tournament_id=p_tid
                     AND (COALESCE(current_bounty,0)<>trunc(COALESCE(current_bounty,0)) OR COALESCE(bounty_winnings,0)<>trunc(COALESCE(bounty_winnings,0)))),
    (SELECT format('pools %s/%s/%s/%s', prize_pool, bounty_pool, bounty_pool_paid, total_rake) FROM public.tournaments WHERE id=p_tid));
  IF v_status='COMPLETED' THEN
    PERFORM pg_temp.chk(p_fmt, v_label||'the escrow shadow is closed at exact zero',
      EXISTS (SELECT 1 FROM public.tournament_escrow x WHERE x.tournament_id=p_tid AND x.closed_at IS NOT NULL
                 AND x.prize_balance=0 AND x.bounty_balance=0 AND x.fee_balance=0),
      (SELECT to_jsonb(x)::text FROM public.tournament_escrow x WHERE x.tournament_id=p_tid));
  ELSIF v_status='CANCELLED' THEN
    PERFORM pg_temp.chk(p_fmt, v_label||'the escrow is closed by an immutable cancellation receipt at exact zero',
      EXISTS (SELECT 1 FROM public.tournament_cancellation_receipts r WHERE r.tournament_id=p_tid AND r.escrow_closed_at IS NOT NULL),
      (SELECT to_jsonb(r)::text FROM public.tournament_cancellation_receipts r WHERE r.tournament_id=p_tid));
  ELSE
    PERFORM pg_temp.chk(p_fmt, v_label||'the event reached a terminal status', false, v_status);
  END IF;
END $f$;

-- A cancelled event: the receipt, every entrant whole within the event (what
-- each paid in came back to them), the per-event facts, and the replay.
CREATE FUNCTION pg_temp.whole_again(p_fmt text, p_case text, p_tid uuid, p_rec jsonb,
                                     p_entrants int, p_refunded numeric, p_fees numeric) RETURNS void
LANGUAGE plpgsql AS $f$
DECLARE v_again jsonb; v_lines bigint;
BEGIN
  PERFORM pg_temp.chk(p_fmt, p_case||': the cancellation receipt is complete, owes nobody and names every Diamond it returned',
    COALESCE((p_rec->>'ok')::boolean,false) AND COALESCE((p_rec->>'fully_settled')::boolean,false)
    AND p_rec->>'status' = 'CANCELLED' AND p_rec->>'asset' = 'diamonds'
    AND (p_rec->>'refunded_count')::int = p_entrants AND (p_rec->>'total_refunded')::numeric = p_refunded
    AND (p_rec->>'fees_reversed')::numeric = p_fees, left(p_rec::text,600));
  PERFORM pg_temp.chk(p_fmt, p_case||': every entrant got back exactly what it paid in, entry by entry, and no fee was kept',
    NOT EXISTS (SELECT 1 FROM (SELECT user_id,
                   sum(amount) FILTER (WHERE kind IN ('entry','rebuy','reentry','addon')) AS paid,
                   COALESCE(sum(amount) FILTER (WHERE kind='refund'),0) AS back
                 FROM public.poker_diamond_tournament_ledger WHERE tournament_id=p_tid AND user_id IS NOT NULL
                 GROUP BY user_id) x WHERE x.paid IS DISTINCT FROM x.back)
    AND NOT EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger WHERE tournament_id=p_tid AND kind IN ('fee','prize','bounty')),
    (SELECT jsonb_agg(jsonb_build_array(right(user_id::text,2),kind,amount))::text FROM public.poker_diamond_tournament_ledger WHERE tournament_id=p_tid));
  PERFORM pg_temp.conserved(p_fmt, p_case, p_tid);
  v_lines := (SELECT count(*) FROM public.poker_diamond_tournament_ledger WHERE tournament_id=p_tid);
  v_again := pg_temp.cancel(p_tid);
  PERFORM pg_temp.chk(p_fmt, p_case||': the same cancellation again returns the stored receipt byte for byte and writes nothing',
    v_again = p_rec AND (SELECT count(*) FROM public.tournament_cancellation_receipts WHERE tournament_id=p_tid) = 1
    AND (SELECT count(*) FROM public.poker_diamond_tournament_ledger WHERE tournament_id=p_tid) = v_lines,
    left(v_again::text,300));
END $f$;
-- ============================================================================
-- STAGE 1 (classic formats): everything before a finish. No finish lane and no
-- global lane is taken here; a withdrawal, a knockout and a chest take their
-- own event's tournament lane, as they do live.
-- ============================================================================
-- The expected parts of one charge, computed here from the configuration.
CREATE FUNCTION pg_temp.parts(p_fmt text) RETURNS TABLE(total numeric, fee numeric, bounty numeric, prize numeric,
  is_bounty boolean, pko boolean, mystery boolean, flat boolean, rebuy boolean, n int) LANGUAGE sql AS $f$
  SELECT (c->>'buyIn')::numeric, trunc((c->>'buyIn')::numeric*0.10),
         CASE WHEN c->>'type' IN ('bounty','progressive_bounty','mystery_bounty') THEN (c->>'bountyAmount')::numeric ELSE 0 END,
         (c->>'buyIn')::numeric - trunc((c->>'buyIn')::numeric*0.10)
           - CASE WHEN c->>'type' IN ('bounty','progressive_bounty','mystery_bounty') THEN (c->>'bountyAmount')::numeric ELSE 0 END,
         c->>'type' IN ('bounty','progressive_bounty','mystery_bounty'), c->>'type'='progressive_bounty',
         c->>'type'='mystery_bounty', c->>'type'='bounty', COALESCE((c->>'rebuy')::boolean,false),
         (SELECT array_length(players,1) FROM pg_temp.formats WHERE fmt=p_fmt)
    FROM (SELECT pg_temp.cfg(p_fmt) c) x;
$f$;

-- PHASE entries: create, register, replay, withdraw, replay, re-enter, fill.
CREATE FUNCTION pg_temp.phase_entries(p_fmt text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE
  c jsonb := pg_temp.cfg(p_fmt); x record; p uuid[] := pg_temp.players();
  v_tid uuid; v_res jsonb; v_first jsonb; v_unreg jsonb; v_e record; v_snap jsonb; v_w0 jsonb;
  v_rq uuid[] := ARRAY[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()];
  v_uq uuid := gen_random_uuid(); v_rq4b uuid := gen_random_uuid(); i int;
BEGIN
  SELECT * INTO x FROM pg_temp.parts(p_fmt);
  SELECT jsonb_object_agg(id::text, diamonds) INTO v_w0 FROM public.profiles WHERE id = ANY(p);
  v_res := pg_temp.create_event(p_fmt, 'main', c);
  v_tid := (v_res->>'tournamentId')::uuid;
  PERFORM pg_temp.put(p_fmt,'tid',v_tid::text);
  PERFORM pg_temp.chk(p_fmt,'creation: the event is priced in whole Diamonds, the fee floored at the Diamond unit, the bounty whole',
    (v_res->>'buy_in_fee')::numeric = x.fee AND (v_res->>'buy_in_amount')::numeric = x.total - x.fee
    AND (v_res->>'bounty_amount')::numeric = x.bounty AND (v_res->>'asset') = 'diamonds', v_res::text);
  PERFORM pg_temp.chk(p_fmt,'rounding: the fee fraction a chip event would keep lands in the prize part at the Diamond unit',
    public.fn_ca_unit_floor_cents(round(x.total*100*0.10)::bigint,1) = round(x.total*100*0.10)
    AND public.fn_ca_unit_floor_cents(round(x.total*100*0.10)::bigint,100) = x.fee*100
    AND x.fee + x.bounty + x.prize = x.total,
    format('fee at unit 1: %s cents; at the Diamond unit: %s cents; %s cents move to the prize part',
      public.fn_ca_unit_floor_cents(round(x.total*100*0.10)::bigint,1),
      public.fn_ca_unit_floor_cents(round(x.total*100*0.10)::bigint,100), round(x.total*100*0.10) - x.fee*100));
  PERFORM pg_temp.note(p_fmt,'the event row',
    (SELECT format('format %s, payout_math_version %s, payout_unit_cents %s, table_size %s, max %s, payout_percent %s, structure at creation %s',
       public.fn_ca_tournament_recorded_format(v_tid), payout_math_version, payout_unit_cents, table_size, max_players, payout_percent, payout_structure)
       FROM public.tournaments WHERE id=v_tid));

  FOR i IN 1..4 LOOP
    v_res := pg_temp.register(v_tid, p[i], v_rq[i]);
    PERFORM pg_temp.chk(p_fmt, format('registration: player %s pays exactly the entry into an active custody row, split into named whole parts', i),
      COALESCE((v_res->>'ok')::boolean,false)
      AND (v_res->>'diamonds_after')::numeric = (v_w0->>p[i]::text)::numeric - x.total
      AND (v_res->>'cost')::numeric = x.total AND (v_res->>'prize_contribution')::numeric = x.prize
      AND COALESCE((v_res->>'bounty_contribution')::numeric,0) = x.bounty AND (v_res->>'rake')::numeric = x.fee
      AND EXISTS (SELECT 1 FROM public.poker_diamond_custody cu WHERE cu.user_id=p[i] AND cu.target_id=v_tid
                   AND cu.state='active' AND cu.balance=x.total AND cu.seat_id IS NULL),
      v_res::text);
    IF i = 1 THEN v_first := v_res; END IF;
  END LOOP;

  v_snap := pg_temp.money(v_tid);
  v_res := pg_temp.register(v_tid, p[1], v_rq[1]);
  PERFORM pg_temp.chk(p_fmt,'idempotency: replaying a registration with the same request id returns the same receipt',
    v_res = v_first, format('first %s | replay %s', v_first, v_res));
  PERFORM pg_temp.chk(p_fmt,'idempotency: the replayed registration moved no Diamond and opened no second entry',
    pg_temp.money(v_tid) = v_snap
    AND (SELECT count(*) FROM public.poker_diamond_custody WHERE target_id=v_tid AND user_id=p[1]) = 1
    AND (SELECT count(*) FROM public.tournament_players WHERE tournament_id=v_tid AND user_id=p[1]) = 1);
  PERFORM pg_temp.put(p_fmt,'rq4',v_rq[4]::text);
END $f$;

-- PHASE withdraw (stage 1b - the withdrawal takes its event's tournament lane):
-- withdraw, replay, replay the old registration, re-enter, fill the field.
CREATE FUNCTION pg_temp.phase_withdraw(p_fmt text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE
  x record; p uuid[] := pg_temp.players(); v_tid uuid := pg_temp.get(p_fmt,'tid')::uuid;
  v_res jsonb; v_unreg jsonb; v_e record; v_snap jsonb; v_w0 jsonb;
  v_uq uuid := gen_random_uuid(); v_rq4b uuid := gen_random_uuid(); i int;
BEGIN
  SELECT * INTO x FROM pg_temp.parts(p_fmt);
  SELECT jsonb_object_agg(id::text, diamonds + CASE WHEN id = ANY(p[1:4]) THEN x.total ELSE 0 END) INTO v_w0
    FROM public.profiles WHERE id = ANY(p);

  v_unreg := pg_temp.unregister(v_tid, p[4], v_uq);
  PERFORM pg_temp.chk(p_fmt,'unregistration: the withdrawn entry goes home whole to the Diamond, every part named',
    COALESCE((v_unreg->>'ok')::boolean,false) AND (v_unreg->>'refunded_diamonds')::numeric = x.total
    AND (v_unreg->>'refund_prize')::numeric = x.prize AND (v_unreg->>'refund_bounty')::numeric = x.bounty
    AND (v_unreg->>'refund_fee')::numeric = x.fee
    AND (SELECT diamonds FROM public.profiles WHERE id=p[4]) = (v_w0->>p[4]::text)::numeric
    AND NOT EXISTS (SELECT 1 FROM public.poker_diamond_custody WHERE target_id=v_tid AND user_id=p[4] AND state<>'released'),
    v_unreg::text);
  v_snap := pg_temp.money(v_tid);
  v_res := pg_temp.unregister(v_tid, p[4], v_uq);
  PERFORM pg_temp.chk(p_fmt,'idempotency: replaying an unregistration returns the same refund and pays nothing twice',
    COALESCE((v_res->>'ok')::boolean,false)
    AND (v_res->'refunded_diamonds') = (v_unreg->'refunded_diamonds') AND (v_res->'refund_prize') = (v_unreg->'refund_prize')
    AND (v_res->'refund_bounty') = (v_unreg->'refund_bounty') AND (v_res->'refund_fee') = (v_unreg->'refund_fee')
    AND (v_res->>'registration_id') = (v_unreg->>'registration_id') AND (v_res->>'custody_id') = (v_unreg->>'custody_id')
    AND (v_res->>'obligation_id') = (v_unreg->>'obligation_id')
    AND pg_temp.money(v_tid) = v_snap, format('first %s | replay %s', v_unreg, v_res));
  v_res := pg_temp.register(v_tid, p[4], pg_temp.get(p_fmt,'rq4')::uuid);
  PERFORM pg_temp.chk(p_fmt,'idempotency: replaying a registration that was since withdrawn charges nothing and enters nobody',
    pg_temp.money(v_tid) = v_snap
    AND NOT EXISTS (SELECT 1 FROM public.tournament_players WHERE tournament_id=v_tid AND user_id=p[4]), v_res::text);

  v_res := pg_temp.register(v_tid, p[4], v_rq4b);
  PERFORM pg_temp.chk(p_fmt,'registration: a withdrawn player enters again with a new request, into a new custody row',
    COALESCE((v_res->>'ok')::boolean,false)
    AND (SELECT count(*) FROM public.poker_diamond_custody WHERE target_id=v_tid AND user_id=p[4]) = 2, v_res::text);
  FOR i IN 5..x.n LOOP
    v_res := pg_temp.register(v_tid, p[i], gen_random_uuid());
    PERFORM pg_temp.chk(p_fmt,format('registration: player %s enters', i), COALESCE((v_res->>'ok')::boolean,false), v_res::text);
  END LOOP;
  PERFORM pg_temp.put(p_fmt,'charges',x.n::text);
  SELECT * INTO v_e FROM public.fn_poker_diamond_tournament_escrow(v_tid);
  PERFORM pg_temp.chk(p_fmt,format('escrow: the three banks hold exactly the parts of the %s live entries, the refund named', x.n),
    v_e.prize_balance = x.n*x.prize AND v_e.bounty_balance = x.n*x.bounty AND v_e.fee_balance = x.n*x.fee AND v_e.refund_out = x.total,
    row_to_json(v_e)::text);
  PERFORM pg_temp.chk(p_fmt,'escrow: the cached pools equal the banks',
    (SELECT prize_pool = v_e.prize_balance AND bounty_pool = v_e.bounty_balance AND total_rake = v_e.fee_balance
       FROM public.tournaments WHERE id=v_tid),
    (SELECT format('prize_pool %s bounty_pool %s total_rake %s', prize_pool, bounty_pool, total_rake) FROM public.tournaments WHERE id=v_tid));
END $f$;

-- PHASE launch: the estate's launch, every deferred seat guard forced; a
-- withdrawal after launch is refused by the refund door itself.
CREATE FUNCTION pg_temp.phase_launch(p_fmt text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_tid uuid := pg_temp.get(p_fmt,'tid')::uuid; p uuid[] := pg_temp.players(); v_table uuid; v_snap jsonb; x record;
BEGIN
  SELECT * INTO x FROM pg_temp.parts(p_fmt);
  v_table := pg_temp.launch(v_tid, p, true);
  PERFORM pg_temp.put(p_fmt,'table',v_table::text);
  PERFORM pg_temp.chk(p_fmt,format('launch: the event runs with %s seated entrants, every seat guard satisfied at the commit, and every entry still in custody', x.n),
    (SELECT status FROM public.tournaments WHERE id=v_tid) = 'RUNNING'
    AND (SELECT count(*) FROM public.table_seats s WHERE s.table_id=v_table AND s.left_at IS NULL) = x.n
    AND public.fn_poker_diamond_tournament_custody(v_tid) = x.n*x.total);
  v_snap := pg_temp.money(v_tid);
  PERFORM pg_temp.refuses(p_fmt,'a withdrawal after launch is refused by the refund door by name',
    format('SELECT public.fn_poker_diamond_tournament_refund(%L::uuid,%L::uuid,''unregister'',''conservation'',gen_random_uuid())', v_tid, p[2]),
    'diamond_tournament_entry_in_play');
  PERFORM pg_temp.chk(p_fmt,'a withdrawal after launch: the refusal moved nothing', pg_temp.money(v_tid) = v_snap);
END $f$;

-- PHASE first_knockout: the last player busts (the flat bounty is a three-way
-- split pot); after a paid bounty the refund door refuses a cancellation refund.
CREATE FUNCTION pg_temp.phase_first_knockout(p_fmt text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_tid uuid := pg_temp.get(p_fmt,'tid')::uuid; v_table uuid := pg_temp.get(p_fmt,'table')::uuid;
        p uuid[] := pg_temp.players(); x record; v_snap jsonb;
BEGIN
  SELECT * INTO x FROM pg_temp.parts(p_fmt);
  -- The first bust is inside the rebuy window: the player keeps a chair at zero
  -- and is still playing until the rebuy decision.
  IF x.rebuy THEN PERFORM set_config('conservation.rebuy_window', p[x.n]::text, true); END IF;
  PERFORM pg_temp.ko(p_fmt, v_tid, v_table, p[x.n], CASE WHEN x.flat THEN ARRAY[p[1],p[2],p[3]] ELSE ARRAY[p[1]] END,
                     x.n, 1000001, now());
  PERFORM set_config('conservation.rebuy_window', '', true);
  IF x.is_bounty AND (SELECT bounty_out FROM public.fn_poker_diamond_tournament_escrow(v_tid)) > 0 THEN
    v_snap := pg_temp.money(v_tid);
    PERFORM pg_temp.refuses(p_fmt,'a cancellation refund after a bounty is paid is refused by the refund door itself',
      format('SELECT public.fn_poker_diamond_tournament_refund(%L::uuid,%L::uuid,''cancel'',''conservation'',gen_random_uuid())', v_tid, p[2]),
      'diamond_tournament_already_paid');
    PERFORM pg_temp.chk(p_fmt,'after a paid bounty: the refusal moved nothing', pg_temp.money(v_tid) = v_snap);
  END IF;
END $f$;

-- PHASE rebuy: the busted player buys back in; the same token replayed.
CREATE FUNCTION pg_temp.phase_rebuy(p_fmt text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_tid uuid := pg_temp.get(p_fmt,'tid')::uuid; p uuid[] := pg_temp.players(); x record;
        v_snap jsonb; v_res jsonb; v_res2 jsonb; v_bal0 bigint; r uuid;
BEGIN
  SELECT * INTO x FROM pg_temp.parts(p_fmt);
  r := p[x.n];
  v_snap := pg_temp.money(v_tid);
  -- The custody row is a pooled bank's row: a knockout already paid may have
  -- drained its bounty part, so the rebuy is measured as what it ADDS.
  v_bal0 := (SELECT balance FROM public.poker_diamond_custody WHERE target_id=v_tid AND user_id=r AND state<>'released');
  v_res := pg_temp.rebuy(v_tid, r, 'conservation-rebuy-'||p_fmt);
  PERFORM pg_temp.put(p_fmt,'charges',(x.n+1)::text);
  PERFORM pg_temp.chk(p_fmt,'rebuy: the busted player buys back in whole Diamonds, into the same custody row, the parts named',
    COALESCE((v_res->>'success')::boolean,false) AND NOT COALESCE((v_res->>'idempotent')::boolean,false)
    AND (v_res->>'cost')::numeric = x.total AND (v_res->>'fee')::numeric = x.fee
    AND COALESCE((v_res->>'bounty_head_funded')::numeric,0) = x.bounty
    AND (SELECT count(*) FROM public.poker_diamond_tournament_ledger WHERE tournament_id=v_tid AND user_id=r AND kind='rebuy'
           AND amount=x.total AND prize_part=x.prize AND bounty_part=x.bounty AND fee_part=x.fee) = 1
    AND (SELECT diamonds FROM public.profiles WHERE id=r) = (v_snap->'wallets'->>r::text)::numeric - x.total
    AND (SELECT balance FROM public.poker_diamond_custody WHERE target_id=v_tid AND user_id=r AND state<>'released') = v_bal0 + x.total,
    format('%s | wallet %s -> %s', v_res, v_snap->'wallets'->>r::text, (SELECT diamonds FROM public.profiles WHERE id=r)));
  v_snap := pg_temp.money(v_tid);
  BEGIN
    v_res2 := pg_temp.rebuy(v_tid, r, 'conservation-rebuy-'||p_fmt);
  EXCEPTION WHEN OTHERS THEN
    v_res2 := jsonb_build_object('raised', SQLERRM);
  END;
  PERFORM pg_temp.chk(p_fmt,'idempotency: replaying a rebuy with the same token charges nothing twice',
    COALESCE((v_res2->>'idempotent')::boolean,false) AND pg_temp.money(v_tid) = v_snap
    AND (SELECT count(*) FROM public.poker_diamond_tournament_ledger WHERE tournament_id=v_tid AND kind='rebuy') = 1, v_res2::text);
END $f$;

-- PHASE capped_exposure: nothing pays past its own bank.
CREATE FUNCTION pg_temp.phase_capped_exposure(p_fmt text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_tid uuid := pg_temp.get(p_fmt,'tid')::uuid; p uuid[] := pg_temp.players(); v_e record; v_snap jsonb;
BEGIN
  PERFORM pg_temp.tick('start');
  SELECT * INTO v_e FROM public.fn_poker_diamond_tournament_escrow(v_tid);
  v_snap := pg_temp.money(v_tid);
  PERFORM pg_temp.tick('escrow+snapshot');
  PERFORM pg_temp.refuses(p_fmt,'capped exposure: a prize one Diamond above the prize bank is refused by name',
    format('SELECT public.fn_poker_diamond_tournament_pay(%L::uuid,%s,%L,''prize'',%L::uuid,''probe'')', p[1], v_e.prize_balance+1, 'probe-prize-'||p_fmt, v_tid),
    'diamond_tournament_bank_short');
  PERFORM pg_temp.refuses(p_fmt,'capped exposure: a bounty one Diamond above the bounty bank is refused by name',
    format('SELECT public.fn_poker_diamond_tournament_pay(%L::uuid,%s,%L,''bounty'',%L::uuid,''probe'')', p[1], v_e.bounty_balance+1, 'probe-bounty-'||p_fmt, v_tid),
    'diamond_tournament_bank_short');
  PERFORM pg_temp.tick('two pay probes');
  PERFORM pg_temp.refuses(p_fmt,'capped exposure: draining the fee bank one Diamond past what it holds is refused by name',
    format('SELECT public.fn_poker_diamond_tournament_drain(%L::uuid,''fee'',%s,%L,''house'',NULL)', v_tid, v_e.fee_balance+1, 'probe-fee-'||p_fmt),
    'diamond_tournament_custody_short');
  PERFORM pg_temp.refuses(p_fmt,'capped exposure: draining more than the whole custody is refused by name',
    format('SELECT public.fn_poker_diamond_tournament_drain(%L::uuid,''prize'',%s,%L,''house'',NULL)', v_tid,
      public.fn_poker_diamond_tournament_custody(v_tid)+1, 'probe-all-'||p_fmt),
    'diamond_tournament_custody_short');
  PERFORM pg_temp.refuses(p_fmt,'capped exposure: the pay door has no fee category to overdraw through',
    format('SELECT public.fn_poker_diamond_tournament_pay(%L::uuid,1,%L,''fee'',%L::uuid,''probe'')', p[1], 'probe-fee-pay-'||p_fmt, v_tid),
    'diamond_tournament_pay_unknown_category');
  PERFORM pg_temp.tick('two drain probes + fee pay probe');
  PERFORM pg_temp.chk(p_fmt,'capped exposure: every refused over-payment left the banks, custody, wallets and credit keys exactly as they were',
    pg_temp.money(v_tid) = v_snap);
END $f$;
-- PHASE field_busts: the rest of the field busts; a mystery event seals its
-- chests when four remain, while the mystery half of its bounty bank is odd.
CREATE FUNCTION pg_temp.phase_field_busts(p_fmt text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_tid uuid := pg_temp.get(p_fmt,'tid')::uuid; v_table uuid := pg_temp.get(p_fmt,'table')::uuid;
        p uuid[] := pg_temp.players(); x record; v_res jsonb; v_bp bigint; v_paid bigint; v_half bigint; v_mpool bigint;
        v_c bigint; v_chests jsonb; v_bad jsonb;
BEGIN
  SELECT * INTO x FROM pg_temp.parts(p_fmt);
  IF x.rebuy THEN
    PERFORM pg_temp.ko(p_fmt, v_tid, v_table, p[x.n], ARRAY[p[2]], x.n, 1000002, now() + interval '1 second');
  END IF;
  IF x.n = 6 THEN
    PERFORM pg_temp.ko(p_fmt, v_tid, v_table, p[5], ARRAY[p[1]], 5, 1000003, now());
  END IF;
  IF x.mystery THEN
    PERFORM pg_temp.as_engine();
    UPDATE public.tournaments SET prize_pool_finalized=true WHERE id=v_tid;
    SELECT round(bounty_pool*100)::bigint, round(COALESCE(bounty_pool_paid,0)*100)::bigint INTO v_bp, v_paid
      FROM public.tournaments WHERE id=v_tid;
    v_half := floor(v_bp * 50 / 100.0)::bigint;
    v_mpool := LEAST(v_half, v_bp - v_paid);
    v_mpool := (floor(v_mpool / 100.0) * 100)::bigint;
    v_c := (floor(v_mpool / 300.0) * 100)::bigint;
    v_chests := jsonb_build_array(
      jsonb_build_object('seq',1,'tier','small','amount_cents',v_c),
      jsonb_build_object('seq',2,'tier','major','amount_cents',v_c),
      jsonb_build_object('seq',3,'tier','jackpot','amount_cents',v_mpool - 2*v_c));
    v_bad := jsonb_build_array(
      jsonb_build_object('seq',1,'tier','small','amount_cents',v_c + 50),
      jsonb_build_object('seq',2,'tier','major','amount_cents',v_c - 50),
      jsonb_build_object('seq',3,'tier','jackpot','amount_cents',v_mpool - 2*v_c));
    PERFORM pg_temp.put(p_fmt,'mystery_pool_cents',v_mpool::text);
    v_res := public.fn_mystery_bounty_seed(v_tid, 4, v_bad);
    PERFORM pg_temp.chk(p_fmt,'rounding (mystery): a chest that is not a whole Diamond is refused by name',
      (v_res->>'ok')::boolean IS FALSE AND v_res->>'reason' = 'chest_not_on_unit', v_res::text);
    v_res := public.fn_mystery_bounty_seed(v_tid, 4, v_chests);
    PERFORM pg_temp.chk(p_fmt,'rounding (mystery): the mystery half of an odd bounty bank is floored to whole Diamonds, the residue kept in the regular half',
      COALESCE((v_res->>'ok')::boolean,false) AND (v_res->>'pool_cents')::bigint = v_mpool AND v_half - v_mpool > 0,
      format('%s | half of %s cents is %s, sealed %s', v_res, v_bp, v_half, v_mpool));
    PERFORM pg_temp.commit_boundary();
    PERFORM pg_temp.chest_ko(p_fmt, v_tid, v_table, p[4], p[1], 4, 1000004);
    PERFORM pg_temp.chest_ko(p_fmt, v_tid, v_table, p[3], p[2], 3, 1000005);
    PERFORM pg_temp.chest_ko(p_fmt, v_tid, v_table, p[2], p[1], 2, 1000006);
  ELSE
    PERFORM pg_temp.ko(p_fmt, v_tid, v_table, p[4], ARRAY[p[1]], 4, 1000004, now());
    PERFORM pg_temp.ko(p_fmt, v_tid, v_table, p[3], ARRAY[p[2]], 3, 1000005, now());
    PERFORM pg_temp.ko(p_fmt, v_tid, v_table, p[2], ARRAY[p[1]], 2, 1000006, now());
  END IF;
  UPDATE public.tournament_players SET chips = 10000 * pg_temp.get(p_fmt,'charges')::int
   WHERE tournament_id=v_tid AND user_id=p[1];
  PERFORM pg_temp.commit_boundary();
END $f$;

-- ============================================================================
-- CANCELLATION RECOVERY, per format, each on an event of its own. Set up here
-- (stage 1); cancelled at the end, inside the finish lane (stage 2).
-- ============================================================================
CREATE FUNCTION pg_temp.fresh_event(p_fmt text, p_label text) RETURNS uuid LANGUAGE plpgsql AS $f$
BEGIN
  RETURN (pg_temp.create_event(p_fmt, p_label,
    pg_temp.cfg(p_fmt) || jsonb_build_object('name','Conservation '||p_fmt||' '||p_label))->>'tournamentId')::uuid;
END $f$;

-- Before launch: three entrants, one of whom withdrew and came back.
CREATE FUNCTION pg_temp.phase_setup_cancel_before_launch(p_fmt text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE p uuid[] := pg_temp.players(); x record; v_tid uuid; v_res jsonb;
BEGIN
  SELECT * INTO x FROM pg_temp.parts(p_fmt);
  v_tid := pg_temp.fresh_event(p_fmt,'cancel before launch');
  PERFORM pg_temp.put(p_fmt,'tid_cbl',v_tid::text);
  PERFORM pg_temp.register(v_tid, p[1], gen_random_uuid());
  PERFORM pg_temp.register(v_tid, p[2], gen_random_uuid());
  PERFORM pg_temp.register(v_tid, p[3], gen_random_uuid());
  v_res := pg_temp.unregister(v_tid, p[3], gen_random_uuid());
  v_res := pg_temp.register(v_tid, p[3], gen_random_uuid());
  PERFORM pg_temp.chk(p_fmt,'cancel before launch: three entrants hold their entries, one of them in a second custody row',
    COALESCE((v_res->>'ok')::boolean,false) AND public.fn_poker_diamond_tournament_custody(v_tid) = 3*x.total, v_res::text);
END $f$;

-- After a launch that began, seated its players and never completed.
CREATE FUNCTION pg_temp.phase_setup_cancel_after_begun_launch(p_fmt text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE p uuid[] := pg_temp.players(); x record; v_tid uuid; v_table uuid;
BEGIN
  SELECT * INTO x FROM pg_temp.parts(p_fmt);
  v_tid := pg_temp.fresh_event(p_fmt,'cancel after a begun launch');
  PERFORM pg_temp.put(p_fmt,'tid_cabl',v_tid::text);
  PERFORM pg_temp.register(v_tid, p[3], gen_random_uuid());
  PERFORM pg_temp.register(v_tid, p[4], gen_random_uuid());
  PERFORM pg_temp.register(v_tid, p[5], gen_random_uuid());
  v_table := pg_temp.launch(v_tid, ARRAY[p[3],p[4],p[5]], false);
  PERFORM pg_temp.put(p_fmt,'table_cabl',v_table::text);
  PERFORM pg_temp.chk(p_fmt,'cancel after a begun launch: the launch is open, the table seated, the event not started',
    EXISTS (SELECT 1 FROM public.tournament_launch_receipts r WHERE r.tournament_id=v_tid AND r.completed_at IS NULL)
    AND (SELECT count(*) FROM public.table_seats s WHERE s.table_id=v_table AND s.left_at IS NULL) = 3
    AND (SELECT started_at IS NULL FROM public.tournaments WHERE id=v_tid),
    (SELECT format('status %s started_at %s seats %s', status, started_at,
       (SELECT count(*) FROM public.table_seats s WHERE s.table_id=v_table AND s.left_at IS NULL)) FROM public.tournaments WHERE id=v_tid));
END $f$;

-- A rebuy charged into an entry before launch, through the money core the
-- public rebuy door calls: a naive refund would return only the buy-in.
CREATE FUNCTION pg_temp.phase_setup_cancel_after_prelaunch_rebuy(p_fmt text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE p uuid[] := pg_temp.players(); x record; v_tid uuid; v_res jsonb; v_msg text;
BEGIN
  SELECT * INTO x FROM pg_temp.parts(p_fmt);
  v_tid := pg_temp.fresh_event(p_fmt,'cancel after a rebuy');
  PERFORM pg_temp.put(p_fmt,'tid_car',v_tid::text);
  PERFORM pg_temp.register(v_tid, p[4], gen_random_uuid());
  PERFORM pg_temp.register(v_tid, p[5], gen_random_uuid());
  BEGIN
    v_res := pg_temp.rebuy(v_tid, p[4], 'conservation-prelaunch-rebuy-'||p_fmt);
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM;
  END;
  IF v_msg IS NOT NULL OR COALESCE((v_res->>'success')::boolean,false) IS NOT TRUE THEN
    PERFORM pg_temp.put(p_fmt,'car_rebuy','refused');
    PERFORM pg_temp.note(p_fmt,'cancel after a rebuy: a rebuy cannot be charged before launch, so the only rebuy a cancellation can meet is refused with the started event',
      COALESCE(v_msg, v_res::text));
    RETURN;
  END IF;
  PERFORM pg_temp.put(p_fmt,'car_rebuy','charged');
  PERFORM pg_temp.chk(p_fmt,'cancel after a rebuy: the entry''s custody row holds the entry and the rebuy',
    (SELECT balance FROM public.poker_diamond_custody WHERE target_id=v_tid AND user_id=p[4] AND state<>'released') = 2*x.total, v_res::text);
END $f$;
-- ============================================================================
-- STAGE 2 (classic formats): inside the finish lane, back to back.
-- ============================================================================
-- PHASE finish: a started event with a rebuy and a paid bounty is never voided;
-- the terminal cannot be priced past its banks (probed with an inflated cache
-- inside a rolled-back block); then the engine's one terminal door closes it.
CREATE FUNCTION pg_temp.phase_finish(p_fmt text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_tid uuid := pg_temp.get(p_fmt,'tid')::uuid; p uuid[] := pg_temp.players(); x record; v_e record;
        v_res jsonb; v_house1 numeric; v_maxid bigint; v_pool numeric; v_ver int; v_l numeric[]; v_got numeric[];
        v_head numeric; v_struct jsonb; v_field int; v_pcts numeric[]; v_rem numeric; v_share numeric; i int; v_snap jsonb;
BEGIN
  SELECT * INTO x FROM pg_temp.parts(p_fmt);
  PERFORM pg_temp.tick('start');
  v_snap := pg_temp.money(v_tid);
  PERFORM pg_temp.refuses(p_fmt,
    CASE WHEN x.is_bounty THEN 'cancellation after launch, after a rebuy and after a paid bounty is refused by name: a started event is resumed or settled, never voided'
         ELSE 'cancellation after launch and after a rebuy is refused by name: a started event is resumed or settled, never voided' END,
    format('SELECT pg_temp.cancel(%L::uuid)', v_tid), 'Tournament has started or committed awards');
  PERFORM pg_temp.chk(p_fmt,'the refused cancellation moved nothing', pg_temp.money(v_tid) = v_snap);
  PERFORM pg_temp.tick('cancel probe');
  PERFORM pg_temp.refuses(p_fmt,'capped exposure: a place ladder priced one Diamond above the prize bank is refused by name at the terminal, never overdrawn',
    format($q$DO $x$ DECLARE v jsonb; BEGIN
             UPDATE public.tournaments SET prize_pool=prize_pool+1 WHERE id=%L;
             v := pg_temp.terminal(%L::uuid,%L::uuid);
             RAISE EXCEPTION 'terminal answered %%', v; END $x$$q$, v_tid, v_tid, p[1]),
    '(diamond_tournament_bank_short|does not exactly fund|do not equal|disagree|contradictory|remain open|not exactly funded|overpaid)');
  IF x.is_bounty THEN
    PERFORM pg_temp.refuses(p_fmt,'capped exposure: a bounty residual priced one Diamond above the bounty bank is refused by name at the terminal, never overdrawn',
      format($q$DO $x$ DECLARE v jsonb; BEGIN
               UPDATE public.tournaments SET bounty_pool=bounty_pool+1 WHERE id=%L;
               v := pg_temp.terminal(%L::uuid,%L::uuid);
               RAISE EXCEPTION 'terminal answered %%', v; END $x$$q$, v_tid, v_tid, p[1]),
      '(diamond_tournament_bank_short|does not exactly fund|do not equal|disagree|contradictory|remain open|not exactly funded|overpaid)');
  END IF;

  PERFORM pg_temp.tick('terminal overpricing probes');
  SELECT * INTO v_e FROM public.fn_poker_diamond_tournament_escrow(v_tid);
  v_house1 := (SELECT balance FROM public.ca_diamond_house WHERE id=1);
  v_maxid := (SELECT COALESCE(max(id),0) FROM public.poker_diamond_tournament_ledger WHERE tournament_id=v_tid);
  v_head := (SELECT COALESCE(current_bounty,0) FROM public.tournament_players WHERE tournament_id=v_tid AND user_id=p[1]);
  PERFORM pg_temp.chk(p_fmt,'terminal: the banks hold exactly what came in less what was paid and refunded',
    v_e.prize_balance = pg_temp.get(p_fmt,'charges')::int * x.prize
    AND v_e.fee_balance = pg_temp.get(p_fmt,'charges')::int * x.fee
    AND v_e.bounty_balance = pg_temp.get(p_fmt,'charges')::int * x.bounty - v_e.bounty_out, row_to_json(v_e)::text);

  v_res := pg_temp.terminal(v_tid, p[1]);
  PERFORM pg_temp.tick('the terminal');
  PERFORM pg_temp.put(p_fmt,'terminal_receipt',v_res::text);
  PERFORM pg_temp.chk(p_fmt,'terminal: the engine''s one terminal door completes the event',
    COALESCE((v_res->>'ok')::boolean,false) AND (SELECT status FROM public.tournaments WHERE id=v_tid) = 'COMPLETED',
    left(v_res::text,500));

  -- The ladder the event committed to, trimmed to its field and priced HERE by
  -- the version-1 rule (each place rounded to the whole Diamond in place order,
  -- the last paid place taking what remains).
  v_pool := v_e.prize_balance;
  SELECT payout_math_version, payout_structure::jsonb INTO v_ver, v_struct FROM public.tournaments WHERE id=v_tid;
  PERFORM pg_temp.note(p_fmt,'the committed ladder at the terminal', v_struct::text);
  SELECT count(*) INTO v_field FROM public.tournament_players WHERE tournament_id=v_tid;
  SELECT array_agg((e->>'percentage')::numeric ORDER BY (e->>'place')::int) INTO v_pcts
    FROM jsonb_array_elements(v_struct) e WHERE (e->>'place')::int <= v_field;
  v_l := ARRAY[]::numeric[]; v_rem := v_pool;
  FOR i IN 1..array_length(v_pcts,1) LOOP
    IF i < array_length(v_pcts,1) THEN
      v_share := LEAST(v_rem, round(v_pool * v_pcts[i] / (SELECT sum(y) FROM unnest(v_pcts) y)));
    ELSE
      v_share := v_rem;
    END IF;
    v_l := v_l || v_share; v_rem := v_rem - v_share;
  END LOOP;
  v_got := ARRAY(SELECT (SELECT COALESCE(sum(amount),0) FROM public.poker_diamond_tournament_ledger
                          WHERE tournament_id=v_tid AND kind='prize' AND user_id=p[g])
                   FROM generate_series(1, array_length(v_l,1)) g ORDER BY g);
  PERFORM pg_temp.chk(p_fmt, format('rounding: a %s-Diamond prize bank over the committed ladder %s pays %s, the residue on the last paid place, spent exactly',
      v_pool, v_pcts, v_l),
    v_ver = 1 AND v_got = v_l AND (SELECT sum(y) FROM unnest(v_l) y) = v_pool
    AND NOT EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger WHERE tournament_id=v_tid AND kind='prize'
                     AND NOT (user_id = ANY(p[1:array_length(v_l,1)]))),
    format('paid %s (payout math version %s, field %s, structure %s)', v_got, v_ver, v_field, v_struct));
  IF x.is_bounty THEN
    PERFORM pg_temp.chk(p_fmt,
      CASE WHEN x.mystery THEN 'terminal: the regular half left in the bounty bank (the mystery rounding residue included) is paid to the champion'
           WHEN x.pko THEN 'terminal: with no knockout collected, the whole PKO bounty bank is paid to the champion as the unclaimed pool, exactly'
           ELSE 'terminal: the champion''s own head is paid from the bounty bank, exactly what the bank still held' END,
      (SELECT COALESCE(sum(amount),0) FROM public.poker_diamond_tournament_ledger
        WHERE tournament_id=v_tid AND kind='bounty' AND user_id=p[1] AND id > v_maxid) = v_e.bounty_balance
      AND v_e.bounty_balance > 0 AND (x.mystery OR x.pko OR v_e.bounty_balance = v_head),
      format('bank held %s, champion head %s, paid %s', v_e.bounty_balance, v_head,
        (SELECT COALESCE(sum(amount),0) FROM public.poker_diamond_tournament_ledger
          WHERE tournament_id=v_tid AND kind='bounty' AND user_id=p[1] AND id > v_maxid)));
  END IF;
  PERFORM pg_temp.chk(p_fmt,'terminal: the fee bank goes to the house, exactly, as one fee line',
    (SELECT balance FROM public.ca_diamond_house WHERE id=1) - v_house1 = v_e.fee_balance
    AND (SELECT count(*) FROM public.poker_diamond_tournament_ledger WHERE tournament_id=v_tid AND kind='fee' AND amount=v_e.fee_balance) = 1,
    format('fee bank %s, house moved %s', v_e.fee_balance, (SELECT balance FROM public.ca_diamond_house WHERE id=1) - v_house1));
  PERFORM pg_temp.conserved(p_fmt, 'conservation', v_tid);
  PERFORM pg_temp.tick('checks');
END $f$;

-- PHASE replays: a terminal, a place payment and a fee settlement replayed.
CREATE FUNCTION pg_temp.phase_replays(p_fmt text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_tid uuid := pg_temp.get(p_fmt,'tid')::uuid; v_snap jsonb; v_res jsonb; p uuid[] := pg_temp.players();
        v_key text; v_amt numeric; v_user uuid; v_ok boolean; v_msg text;
BEGIN
  v_snap := pg_temp.money(v_tid);
  BEGIN
    v_res := pg_temp.terminal(v_tid, p[1]);
  EXCEPTION WHEN OTHERS THEN
    v_res := jsonb_build_object('raised', SQLERRM);
  END;
  PERFORM pg_temp.chk(p_fmt,'idempotency: replaying the terminal answers with a receipt and pays nothing twice',
    COALESCE((v_res->>'ok')::boolean,false) AND pg_temp.money(v_tid) = v_snap, left(v_res::text,500));
  SELECT l.request->>'credit_key', l.amount, l.user_id INTO v_key, v_amt, v_user
    FROM public.poker_diamond_tournament_ledger l WHERE l.tournament_id=v_tid AND l.kind='prize' ORDER BY l.id LIMIT 1;
  BEGIN
    v_ok := public.fn_poker_diamond_tournament_pay(v_user, v_amt, v_key, 'prize', v_tid, 'replay');
  EXCEPTION WHEN OTHERS THEN
    v_ok := NULL; v_msg := SQLERRM;
  END;
  PERFORM pg_temp.chk(p_fmt,'idempotency: replaying a place payment with its own credit key pays nothing (answered false, or refused as immutable terminal evidence)',
    (v_ok IS FALSE OR v_msg LIKE '%credit key evidence is immutable%') AND pg_temp.money(v_tid) = v_snap,
    COALESCE(v_msg, v_ok::text)||' | key '||COALESCE(v_key,'none'));
  BEGIN
    v_res := public.fn_poker_diamond_tournament_settle_fee(v_tid,'replay');
  EXCEPTION WHEN OTHERS THEN
    v_res := jsonb_build_object('raised', SQLERRM);
  END;
  PERFORM pg_temp.chk(p_fmt,'idempotency: replaying the fee settlement banks nothing twice',
    COALESCE((v_res->>'already_settled')::boolean,false) AND pg_temp.money(v_tid) = v_snap, v_res::text);
END $f$;

CREATE FUNCTION pg_temp.phase_cancel_before_launch(p_fmt text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE x record; v_tid uuid := pg_temp.get(p_fmt,'tid_cbl')::uuid; v_rec jsonb;
BEGIN
  SELECT * INTO x FROM pg_temp.parts(p_fmt);
  v_rec := pg_temp.cancel(v_tid);
  PERFORM pg_temp.whole_again(p_fmt,'cancel before launch', v_tid, v_rec, 3, 3*x.total, 3*x.fee);
END $f$;

CREATE FUNCTION pg_temp.phase_cancel_after_begun_launch(p_fmt text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE x record; v_tid uuid := pg_temp.get(p_fmt,'tid_cabl')::uuid; v_table uuid := pg_temp.get(p_fmt,'table_cabl')::uuid; v_rec jsonb;
BEGIN
  SELECT * INTO x FROM pg_temp.parts(p_fmt);
  v_rec := pg_temp.cancel(v_tid);
  PERFORM pg_temp.whole_again(p_fmt,'cancel after a begun launch', v_tid, v_rec, 3, 3*x.total, 3*x.fee);
  PERFORM pg_temp.chk(p_fmt,'cancel after a begun launch: every seat is released and the table closed',
    NOT EXISTS (SELECT 1 FROM public.table_seats s WHERE s.table_id=v_table AND s.left_at IS NULL)
    AND (SELECT status='closed' FROM public.tables WHERE id=v_table), NULL);
END $f$;

CREATE FUNCTION pg_temp.phase_cancel_after_prelaunch_rebuy(p_fmt text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE x record; p uuid[] := pg_temp.players(); v_tid uuid := pg_temp.get(p_fmt,'tid_car')::uuid; v_rec jsonb;
BEGIN
  SELECT * INTO x FROM pg_temp.parts(p_fmt);
  v_rec := pg_temp.cancel(v_tid);
  IF pg_temp.get(p_fmt,'car_rebuy') = 'charged' THEN
    PERFORM pg_temp.whole_again(p_fmt,'cancel after a rebuy', v_tid, v_rec, 2, 3*x.total, 3*x.fee);
    PERFORM pg_temp.chk(p_fmt,'cancel after a rebuy: the rebuyer''s refund is the whole custody row, entry and rebuy, every part named',
      EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger WHERE tournament_id=v_tid AND user_id=p[4] AND kind='refund'
               AND amount=2*x.total AND prize_part=2*x.prize AND bounty_part=2*x.bounty AND fee_part=2*x.fee),
      (SELECT jsonb_agg(jsonb_build_array(kind,amount,prize_part,bounty_part,fee_part))::text
         FROM public.poker_diamond_tournament_ledger WHERE tournament_id=v_tid AND user_id=p[4]));
  ELSE
    PERFORM pg_temp.whole_again(p_fmt,'cancel with the rebuy refused', v_tid, v_rec, 2, 2*x.total, 2*x.fee);
  END IF;
END $f$;

-- PHASE accounting: every event of this format is closed; the format's players
-- (nobody else's) lost exactly the fees the house kept from those events.
CREATE FUNCTION pg_temp.phase_accounting(p_fmt text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v_dw numeric; v_fee numeric; v_legs numeric; v_open int;
BEGIN
  SELECT COALESCE(sum(pr.diamonds - 1000),0) INTO v_dw FROM public.profiles pr WHERE pr.id = ANY(pg_temp.players());
  SELECT COALESCE(sum(l.amount) FILTER (WHERE l.kind='fee'),0),
         COALESCE(sum(l.amount) FILTER (WHERE l.kind='spin_surplus'),0) - COALESCE(sum(l.amount) FILTER (WHERE l.kind='spin_underwrite'),0)
    INTO v_fee, v_legs
    FROM public.poker_diamond_tournament_ledger l JOIN pg_temp.events e ON e.tid=l.tournament_id WHERE e.fmt=p_fmt;
  SELECT count(*) INTO v_open FROM pg_temp.events e JOIN public.tournaments t ON t.id=e.tid
   WHERE e.fmt=p_fmt AND t.status NOT IN ('COMPLETED','CANCELLED');
  PERFORM pg_temp.chk(p_fmt, 'accounting: every event of this format is closed, and its players lost exactly what the house kept from those events - no Diamond created or destroyed',
    v_open = 0 AND v_dw = -(v_fee + v_legs),
    format('players %s, fees kept %s, reserve legs to the house %s, open events %s', v_dw, v_fee, v_legs, v_open));
END $f$;
-- ============================================================================
-- SATELLITES: a Diamond satellite seats its winner in a Diamond target. The
-- satellite's prize bank buys whole tickets (the target's entry) custody to
-- custody; what is left over is paid in whole Diamonds; the target then plays
-- out (T1) or is cancelled holding the satellite seat (T2).
--   a, b, c, d  the satellite format's four players
--   S1 -> T1  a wins the seat; b and d buy T1 outright; T1 plays out, a wins it
--   S2 -> T2  b wins the seat; c buys T2 outright; T2 is cancelled
--   S3        cancelled before launch with a and d entered
-- ============================================================================
CREATE FUNCTION pg_temp.sat_blinds() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $f$
  SELECT '[{"level":1,"smallBlind":25,"bigBlind":50,"ante":0,"duration":600},{"level":2,"smallBlind":50,"bigBlind":100,"ante":0,"duration":600}]'::jsonb;
$f$;
CREATE FUNCTION pg_temp.sat_target_cfg(p_name text) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('name',p_name,'type','mtt','gameVariant','NLH','buyIn',100,'minPlayers',2,'maxPlayers',9,
    'startingStack',10000,'blindStructure',pg_temp.sat_blinds(),'payoutStructure','[{"place":1,"percentage":100}]'::jsonb,
    'startTime',(now()+interval '3 hours')::text);
$f$;
CREATE FUNCTION pg_temp.sat_cfg(p_name text, p_target uuid) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('name',p_name,'type','satellite','gameVariant','NLH','buyIn',40,'satelliteTargetId',p_target,
    'minPlayers',2,'startingStack',10000,'blindStructure',pg_temp.sat_blinds(),
    'payoutStructure','[{"place":1,"percentage":100}]'::jsonb,'startTime',(now()+interval '1 hour')::text);
$f$;

-- STAGE 1a: the targets, the satellites and every entry.
CREATE FUNCTION pg_temp.phase_sat_create(p_fmt text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE p uuid[] := pg_temp.players(); v_res jsonb; v_t1 uuid; v_t2 uuid; v_s1 uuid; v_s2 uuid; v_s3 uuid; v_e record;
        v_w0 jsonb;
BEGIN
  SELECT jsonb_object_agg(id::text, diamonds) INTO v_w0 FROM public.profiles WHERE id = ANY(p);
  v_res := pg_temp.create_event(p_fmt, 'target 1', pg_temp.sat_target_cfg('Conservation Satellite Target 1'));
  v_t1 := (v_res->>'tournamentId')::uuid;
  v_res := pg_temp.create_event(p_fmt, 'target 2', pg_temp.sat_target_cfg('Conservation Satellite Target 2'));
  v_t2 := (v_res->>'tournamentId')::uuid;
  v_res := pg_temp.create_event(p_fmt, 'satellite 1', pg_temp.sat_cfg('Conservation Satellite 1', v_t1));
  v_s1 := (v_res->>'tournamentId')::uuid;
  PERFORM pg_temp.chk(p_fmt,'creation: a 40-Diamond satellite is 36 + a fee of 4 floored at the Diamond unit, and its ticket is the target''s whole 100-Diamond entry',
    (v_res->>'buy_in_amount')::numeric = 36 AND (v_res->>'buy_in_fee')::numeric = 4
    AND (v_res->>'satellite_ticket')::numeric = 100 AND (v_res->>'satellite_target_id')::uuid = v_t1
    AND EXISTS (SELECT 1 FROM public.tournaments WHERE id=v_s1 AND variant='satellite' AND tournament_type='SATELLITE'
                 AND satellite_target_id=v_t1 AND NOT is_rebuy AND NOT is_reentry AND NOT add_on_available),
    v_res::text);
  v_res := pg_temp.create_event(p_fmt, 'satellite 2', pg_temp.sat_cfg('Conservation Satellite 2', v_t2));
  v_s2 := (v_res->>'tournamentId')::uuid;
  v_res := pg_temp.create_event(p_fmt, 'satellite 3 (cancel before launch)', pg_temp.sat_cfg('Conservation Satellite 3', v_t2));
  v_s3 := (v_res->>'tournamentId')::uuid;
  PERFORM pg_temp.refuses(p_fmt,'creation: a satellite is a freezeout; a rebuy is refused by name',
    format('SELECT pg_temp.create_event(%L,''x'',%L::jsonb)', p_fmt, pg_temp.sat_cfg('x', v_t1) || '{"rebuy":true}'::jsonb),
    'diamond_satellite_is_a_freezeout');
  PERFORM pg_temp.put(p_fmt,'t1',v_t1::text); PERFORM pg_temp.put(p_fmt,'t2',v_t2::text);
  PERFORM pg_temp.put(p_fmt,'s1',v_s1::text); PERFORM pg_temp.put(p_fmt,'s2',v_s2::text); PERFORM pg_temp.put(p_fmt,'s3',v_s3::text);

  -- Entries, as clients: b and d buy T1, c buys T2; a, b and c enter S1 and S2; a and d enter S3.
  v_res := pg_temp.register(v_t1, p[2], gen_random_uuid());
  PERFORM pg_temp.chk(p_fmt,'registration: b buys the first target outright, 100 Diamonds into custody',
    COALESCE((v_res->>'ok')::boolean,false) AND (v_res->>'cost')::numeric = 100, v_res::text);
  v_res := pg_temp.register(v_t1, p[4], gen_random_uuid());
  PERFORM pg_temp.chk(p_fmt,'registration: d buys the first target outright', COALESCE((v_res->>'ok')::boolean,false), v_res::text);
  v_res := pg_temp.register(v_t2, p[3], gen_random_uuid());
  PERFORM pg_temp.chk(p_fmt,'registration: c buys the second target outright', COALESCE((v_res->>'ok')::boolean,false), v_res::text);
  FOR i IN 1..3 LOOP
    v_res := pg_temp.register(v_s1, p[i], gen_random_uuid());
    PERFORM pg_temp.chk(p_fmt,format('registration: player %s enters satellite 1 for 40 Diamonds, 36 prize and 4 fee', i),
      COALESCE((v_res->>'ok')::boolean,false) AND (v_res->>'cost')::numeric = 40 AND (v_res->>'rake')::numeric = 4, v_res::text);
    v_res := pg_temp.register(v_s2, p[i], gen_random_uuid());
    PERFORM pg_temp.chk(p_fmt,format('registration: player %s enters satellite 2', i), COALESCE((v_res->>'ok')::boolean,false), v_res::text);
  END LOOP;
  PERFORM pg_temp.register(v_s3, p[1], gen_random_uuid());
  PERFORM pg_temp.register(v_s3, p[4], gen_random_uuid());
  SELECT * INTO v_e FROM public.fn_poker_diamond_tournament_escrow(v_s1);
  PERFORM pg_temp.chk(p_fmt,'escrow: satellite 1 holds 3 x 36 in its prize bank and 3 x 4 in its fee bank',
    v_e.prize_balance = 108 AND v_e.fee_balance = 12 AND v_e.bounty_balance = 0, row_to_json(v_e)::text);

END $f$;

-- STAGE 1b: both satellites launch, their pools final at the start (no late
-- entry), and play down to their winners.
CREATE FUNCTION pg_temp.phase_sat_launch(p_fmt text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE p uuid[] := pg_temp.players(); v_res jsonb; v_s1 uuid := pg_temp.get(p_fmt,'s1')::uuid; v_s2 uuid := pg_temp.get(p_fmt,'s2')::uuid;
BEGIN
  PERFORM pg_temp.put(p_fmt,'s1_table', pg_temp.launch(v_s1, p[1:3], true)::text);
  PERFORM pg_temp.put(p_fmt,'s2_table', pg_temp.launch(v_s2, p[1:3], true)::text);
  PERFORM pg_temp.as_engine();
  v_res := public.fn_close_tournament_entry_window(v_s1, 'conservation.entry_window_close');
  PERFORM pg_temp.chk(p_fmt,'launch: satellite 1 runs and its pool is final', COALESCE((v_res->>'finalized')::boolean,false), v_res::text);
  v_res := public.fn_close_tournament_entry_window(v_s2, 'conservation.entry_window_close');
  PERFORM pg_temp.chk(p_fmt,'launch: satellite 2 runs and its pool is final', COALESCE((v_res->>'finalized')::boolean,false), v_res::text);
  PERFORM pg_temp.commit_boundary();
  -- S1 plays down to a (b second); S2 plays down to b (a second).
  PERFORM pg_temp.bust(v_s1, p[3], 3); PERFORM pg_temp.bust(v_s1, p[2], 2);
  PERFORM pg_temp.bust(v_s2, p[3], 3); PERFORM pg_temp.bust(v_s2, p[1], 2);
  PERFORM pg_temp.commit_boundary();
END $f$;

-- STAGE 2: inside the finish lane.
CREATE FUNCTION pg_temp.phase_sat_finish(p_fmt text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE p uuid[] := pg_temp.players(); v_t1 uuid := pg_temp.get(p_fmt,'t1')::uuid; v_t2 uuid := pg_temp.get(p_fmt,'t2')::uuid;
        v_s1 uuid := pg_temp.get(p_fmt,'s1')::uuid; v_s2 uuid := pg_temp.get(p_fmt,'s2')::uuid; v_s3 uuid := pg_temp.get(p_fmt,'s3')::uuid;
        v_snap jsonb; v_rcpt jsonb; v_rcpt2 jsonb; v_reg uuid; v_e record; v_wa numeric; v_wb numeric; v_res jsonb; v_house1 numeric; v_rec jsonb;
BEGIN
  -- A started satellite is never voided (no rebuy, no bounty: the launch alone refuses).
  PERFORM set_config('conservation.fmt', p_fmt, true);
  v_snap := pg_temp.money(v_s1);
  PERFORM pg_temp.refuses(p_fmt,'cancellation after launch (no rebuy, no bounty) is refused by name',
    format('SELECT pg_temp.cancel(%L::uuid)', v_s1), 'Tournament has started or committed awards');
  PERFORM pg_temp.chk(p_fmt,'the refused cancellation moved nothing', pg_temp.money(v_s1) = v_snap);

  -- S3, cancelled before launch: a and d made whole.
  v_rec := pg_temp.cancel(v_s3);
  PERFORM pg_temp.whole_again(p_fmt,'satellite cancelled before launch', v_s3, v_rec, 2, 80, 8);

  -- S1 settles: 108 = one 100-Diamond ticket for a + 8 to b, whole; fee 12.
  SELECT diamonds INTO v_wa FROM public.profiles WHERE id=p[1];
  SELECT diamonds INTO v_wb FROM public.profiles WHERE id=p[2];
  PERFORM set_config('ca.finish_lane_tournament', '', true);
  PERFORM pg_temp.as_engine();
  v_rcpt := public.fn_settle_satellite_tournament(v_s1, p[1]);
  PERFORM pg_temp.commit_boundary();
  SELECT tp.id INTO v_reg FROM public.tournament_players tp
   WHERE tp.tournament_id=v_t1 AND tp.user_id=p[1] AND tp.is_satellite_qualifier AND tp.source_satellite_id=v_s1;
  PERFORM pg_temp.chk(p_fmt,'satellite settlement: 108 Diamonds buy one whole 100-Diamond ticket and pay the 8 left over to second place, in whole Diamonds',
    COALESCE((v_rcpt->>'ok')::boolean,false) AND (v_rcpt->>'seat_count')::int = 1
    AND (v_rcpt->'remainder'->>'amount')::numeric = 8 AND (v_rcpt->'remainder'->>'user_id')::uuid = p[2]
    AND (SELECT diamonds FROM public.profiles WHERE id=p[2]) = v_wb + 8
    AND (SELECT diamonds FROM public.profiles WHERE id=p[1]) = v_wa, left(v_rcpt::text,600));
  PERFORM pg_temp.chk(p_fmt,'satellite settlement: the seat moved custody to custody - the winner holds a target registration with an active 100-Diamond entry, its wallet untouched',
    v_reg IS NOT NULL AND EXISTS (SELECT 1 FROM public.poker_diamond_custody c
                    WHERE c.user_id=p[1] AND c.target_id=v_t1 AND c.purpose='tournament_entry' AND c.state='active'
                      AND c.balance=100 AND c.entry_key='entry:'||v_reg::text)
    AND EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger l WHERE l.tournament_id=v_t1 AND l.user_id=p[1]
                 AND l.kind='entry' AND l.amount=100 AND l.prize_part=90 AND l.fee_part=10 AND l.registration_id=v_reg)
    AND EXISTS (SELECT 1 FROM public.poker_diamond_tournament_ledger l WHERE l.tournament_id=v_s1 AND l.user_id=p[1]
                 AND l.kind='prize' AND l.amount=100),
    (SELECT jsonb_agg(jsonb_build_array(right(tournament_id::text,4),right(user_id::text,2),kind,amount))::text
       FROM public.poker_diamond_tournament_ledger WHERE tournament_id IN (v_s1,v_t1)));
  v_rcpt2 := public.fn_settle_satellite_tournament(v_s1, p[1]);
  PERFORM pg_temp.chk(p_fmt,'idempotency: settling the satellite again returns the same receipt and moves nothing',
    v_rcpt2 = v_rcpt AND (SELECT diamonds FROM public.profiles WHERE id=p[2]) = v_wb + 8
    AND (SELECT count(*) FROM public.tournament_players WHERE tournament_id=v_t1 AND user_id=p[1]) = 1, left(v_rcpt2::text,300));
  PERFORM pg_temp.conserved(p_fmt,'satellite 1 settled', v_s1);

  -- S2 settles into T2: b's ticket; a second.
  PERFORM set_config('ca.finish_lane_tournament', '', true);
  v_rcpt := public.fn_settle_satellite_tournament(v_s2, p[2]);
  PERFORM pg_temp.commit_boundary();
  PERFORM pg_temp.chk(p_fmt,'satellite settlement: the second satellite seats b in the second target and pays a the 8 left over',
    COALESCE((v_rcpt->>'ok')::boolean,false) AND (v_rcpt->>'seat_count')::int = 1
    AND (v_rcpt->'remainder'->>'user_id')::uuid = p[1], left(v_rcpt::text,400));
  PERFORM pg_temp.conserved(p_fmt,'satellite 2 settled', v_s2);

  -- T1 launches with the satellite seat and the two bought entries, and plays out.
  PERFORM pg_temp.launch(v_t1, ARRAY[p[1],p[2],p[4]], true);
  PERFORM pg_temp.bust(v_t1, p[4], 3);
  PERFORM pg_temp.bust(v_t1, p[2], 2);
  UPDATE public.tournament_players SET chips=30000 WHERE tournament_id=v_t1 AND user_id=p[1];
  PERFORM pg_temp.commit_boundary();
  SELECT * INTO v_e FROM public.fn_poker_diamond_tournament_escrow(v_t1);
  SELECT diamonds INTO v_wa FROM public.profiles WHERE id=p[1];
  v_house1 := (SELECT balance FROM public.ca_diamond_house WHERE id=1);
  v_res := pg_temp.terminal(v_t1, p[1]);
  PERFORM pg_temp.chk(p_fmt,'target terminal: the satellite-funded entry settles like any paid entry - 270 prize to the champion, 30 fee to the house',
    COALESCE((v_res->>'ok')::boolean,false) AND v_e.prize_balance = 270 AND v_e.fee_balance = 30
    AND (SELECT diamonds FROM public.profiles WHERE id=p[1]) = v_wa + 270
    AND (SELECT balance FROM public.ca_diamond_house WHERE id=1) = v_house1 + 30, left(v_res::text,400));
  PERFORM pg_temp.conserved(p_fmt,'target 1 played out', v_t1);

  -- T2 is cancelled while it holds the satellite seat: the seat comes home to
  -- its holder in whole Diamonds, the bought entry to its buyer.
  v_rec := pg_temp.cancel(v_t2);
  PERFORM pg_temp.whole_again(p_fmt,'target cancelled holding a satellite seat', v_t2, v_rec, 2, 200, 20);
END $f$;
-- ============================================================================
-- SPINS: three seats, no fee, a multiplier drawn from the table pinned at
-- creation. The pool above the entries is underwritten by the authorized
-- source (the house) into custody; a pool below them releases the surplus to
-- it. d, e and f are the Spin format's three players.
--   Spin 1  published table, filled, drawn, launched, played out (f wins)
--   Spin 2  published table, two seats taken, cancelled before it fills
-- ============================================================================
CREATE FUNCTION pg_temp.spin_blinds() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $f$
  SELECT '[
    {"level":1,"smallBlind":10,"bigBlind":20,"ante":0,"duration":180},
    {"level":2,"smallBlind":15,"bigBlind":30,"ante":0,"duration":180},
    {"level":3,"smallBlind":20,"bigBlind":40,"ante":0,"duration":180},
    {"level":4,"smallBlind":30,"bigBlind":60,"ante":0,"duration":180},
    {"level":5,"smallBlind":40,"bigBlind":80,"ante":0,"duration":180},
    {"level":6,"smallBlind":50,"bigBlind":100,"ante":0,"duration":180},
    {"level":7,"smallBlind":60,"bigBlind":120,"ante":0,"duration":180},
    {"level":8,"smallBlind":75,"bigBlind":150,"ante":0,"duration":180},
    {"level":9,"smallBlind":90,"bigBlind":180,"ante":0,"duration":180},
    {"level":10,"smallBlind":105,"bigBlind":210,"ante":0,"duration":180},
    {"level":11,"smallBlind":145,"bigBlind":290,"ante":0,"duration":180},
    {"level":12,"smallBlind":205,"bigBlind":410,"ante":0,"duration":180,
     "spinContinuation":{"version":1,"anchorLevel":10,"anchorBigBlind":210,"growth":1.4,"roundBigTo":10}}]'::jsonb;
$f$;
CREATE FUNCTION pg_temp.spin_cfg(p_name text) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('name',p_name,'type','spin','gameVariant','NLH','buyIn',10,'startingStack',1000,
                            'blindStructure',pg_temp.spin_blinds());
$f$;
-- The engine's own compiled manifest; a Diamond draw ignores it (the pinned
-- contract is the only table it rolls over).
CREATE FUNCTION pg_temp.spin_engine_manifest() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $f$
  SELECT jsonb_build_object('version',1,'buy_in',10,'seats',3,'rake_rate',0.08,
    'starting_chips',1000,'tiers',jsonb_build_array(jsonb_build_object('multiplier',2,'freq',1,'reserveThresholdX',0)));
$f$;
CREATE FUNCTION pg_temp.take_seat(p_table uuid, p_user uuid, p_seat int) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v jsonb;
BEGIN
  PERFORM pg_temp.as_client(p_user);
  v := public.fn_take_seat_and_buy_in(p_table, p_seat);
  PERFORM pg_temp.commit_boundary();
  RETURN v;
END $f$;

-- STAGE 1a: both Spins created while the source covers them.
CREATE FUNCTION pg_temp.phase_spin_create(p_fmt text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE p uuid[] := pg_temp.players(); v_res jsonb; v_tid uuid; v_table uuid; v_tid2 uuid; v_table2 uuid; v_i numeric;
        v_gen uuid := gen_random_uuid(); v_launch uuid := gen_random_uuid(); v_seat int; v_rows bigint; v_house numeric;
        v_m numeric; v_pool bigint; v_ok boolean := true;
BEGIN
  v_res := pg_temp.create_event(p_fmt, 'spin 1', pg_temp.spin_cfg('Conservation Spin 1'));
  v_tid := (v_res->>'tournamentId')::uuid; v_table := (v_res->>'table_id')::uuid;
  PERFORM pg_temp.put(p_fmt,'tid',v_tid::text); PERFORM pg_temp.put(p_fmt,'table',v_table::text);
  PERFORM pg_temp.chk(p_fmt,'creation: a Spin is priced by its whole buy-in alone - no fee rides on top, no bounty, three seats',
    (v_res->>'buy_in_fee')::numeric = 0 AND (v_res->>'total')::numeric = 10 AND (v_res->>'buy_in_amount')::numeric = 10
    AND EXISTS (SELECT 1 FROM public.tournaments t WHERE t.id=v_tid AND t.variant='spin' AND t.tournament_type='SPIN'
                 AND t.max_players=3 AND t.buy_in_fee=0 AND COALESCE(t.prize_pool,0)=0 AND t.status='REGISTERING'),
    left(v_res::text,500));
  PERFORM pg_temp.chk(p_fmt,'rounding: every tier of the pinned table pays a whole Diamond pool and whole places at this buy-in',
    NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_res->'multiplier_table') x
                 WHERE ((x->>'multiplier')::numeric * 10) <> trunc((x->>'multiplier')::numeric * 10)), left((v_res->'multiplier_table')::text,400));
  PERFORM pg_temp.refuses(p_fmt,'rounding: a table whose 2.5x pool is not a whole Diamond at a buy-in of 3 is refused by name',
    format('SELECT pg_temp.create_event(%L,''x'',%L::jsonb)', p_fmt, pg_temp.spin_cfg('x') || jsonb_build_object('buyIn',3,'spinTiers',
      '[{"multiplier":2.5,"freq":37,"payoutStructure":[{"place":1,"percentage":100}]},{"multiplier":3.5,"freq":13,"payoutStructure":[{"place":1,"percentage":100}]}]'::jsonb)),
    'diamond_spin_tier_not_whole_at_the_buy_in');
  v_res := pg_temp.create_event(p_fmt, 'spin 2 (cancel before it fills)', pg_temp.spin_cfg('Conservation Spin 2'));
  v_tid2 := (v_res->>'tournamentId')::uuid; v_table2 := (v_res->>'table_id')::uuid;
  PERFORM pg_temp.put(p_fmt,'tid2',v_tid2::text); PERFORM pg_temp.put(p_fmt,'table2',v_table2::text);

END $f$;

-- STAGE 1b: the seats, and Spin 1 drawn and launched.
CREATE FUNCTION pg_temp.phase_spin_launch(p_fmt text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE p uuid[] := pg_temp.players(); v_res jsonb; v_tid uuid := pg_temp.get(p_fmt,'tid')::uuid; v_table uuid := pg_temp.get(p_fmt,'table')::uuid;
        v_table2 uuid := pg_temp.get(p_fmt,'table2')::uuid; v_i numeric;
        v_gen uuid := gen_random_uuid(); v_launch uuid := gen_random_uuid(); v_seat int; v_rows bigint; v_house numeric;
        v_m numeric; v_pool bigint; v_ok boolean := true;
BEGIN
  FOR v_seat IN 1..3 LOOP
    v_i := (SELECT diamonds FROM public.profiles WHERE id=p[v_seat]);
    v_res := pg_temp.take_seat(v_table, p[v_seat], v_seat);
    v_ok := v_ok AND COALESCE((v_res->>'ok')::boolean,false) AND (v_res->>'asset') = 'diamonds'
            AND (v_res->>'cost')::numeric = 10 AND (v_res->>'diamonds_after')::numeric = v_i - 10;
  END LOOP;
  PERFORM pg_temp.chk(p_fmt,'registration: three seats bought for 10 Diamonds each; the full Spin holds three whole entries in custody, nothing booked chip-side',
    v_ok AND public.fn_poker_diamond_tournament_custody(v_tid) = 30
    AND (SELECT count(*) FROM public.poker_diamond_tournament_ledger WHERE tournament_id=v_tid AND kind='entry'
           AND amount=10 AND prize_part=10 AND fee_part=0 AND bounty_part=0) = 3
    AND NOT EXISTS (SELECT 1 FROM public.spin_reserve_ledger WHERE tournament_id=v_tid)
    AND NOT EXISTS (SELECT 1 FROM public.rake_records WHERE tournament_id=v_tid), v_res::text);
  FOR v_seat IN 1..2 LOOP
    v_res := pg_temp.take_seat(v_table2, p[v_seat], v_seat);
    PERFORM pg_temp.chk(p_fmt,format('registration: seat %s of Spin 2 bought', v_seat), COALESCE((v_res->>'ok')::boolean,false), v_res::text);
  END LOOP;

  -- The launch protocol with the Diamond draw, as the engine runs it.
  PERFORM pg_temp.as_engine();
  PERFORM set_config('request.path','rpc/claim_tournament_lease_v2',true);
  SET LOCAL ROLE service_role;
  PERFORM smarter_private.fn_smarter_data_api_pre_request();
  PERFORM public.claim_tournament_lease_v2(v_tid,'conservation-rehearsal','conservation-proof',v_gen,30);
  v_res := public.fn_begin_tournament_launch_atomic(v_tid, v_launch, now(), v_gen, 'spin-v1');
  IF (v_res->>'ok') IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'begin launch refused: %', v_res; END IF;
  RESET ROLE;
  v_house := (SELECT balance FROM public.ca_diamond_house WHERE id=1);
  SET LOCAL ROLE service_role;
  v_res := public.fn_spin_draw_and_settle_atomic(v_tid, v_launch, v_gen, pg_temp.spin_engine_manifest());
  RESET ROLE;
  v_m := (v_res->>'multiplier')::numeric; v_pool := (v_res->>'prize_pool')::bigint;
  PERFORM pg_temp.put(p_fmt,'multiplier',v_m::text); PERFORM pg_temp.put(p_fmt,'pool',v_pool::text);
  PERFORM pg_temp.chk(p_fmt,format('draw: %sx of a 10-Diamond buy-in is a whole %s-Diamond pool; the source moved exactly the difference from the three entries, the right way', v_m, v_pool),
    COALESCE((v_res->>'ok')::boolean,false) AND (v_res->>'asset') = 'diamonds' AND (v_res->>'residue')::numeric = 0
    AND v_pool = v_m * 10
    AND (v_res->>'underwrite')::numeric = GREATEST(v_pool - 30, 0) AND (v_res->>'surplus')::numeric = GREATEST(30 - v_pool, 0)
    AND (SELECT balance FROM public.ca_diamond_house WHERE id=1) = v_house + 30 - v_pool
    AND public.fn_poker_diamond_tournament_custody(v_tid) = v_pool
    AND (SELECT prize_balance FROM public.fn_poker_diamond_tournament_escrow(v_tid)) = v_pool,
    left(v_res::text,600));
  SELECT count(*) INTO v_rows FROM public.poker_diamond_tournament_ledger WHERE tournament_id=v_tid;
  v_house := (SELECT balance FROM public.ca_diamond_house WHERE id=1);
  SET LOCAL ROLE service_role;
  v_res := public.fn_spin_draw_and_settle_atomic(v_tid, v_launch, v_gen, pg_temp.spin_engine_manifest());
  RESET ROLE;
  PERFORM pg_temp.chk(p_fmt,'idempotency: replaying the draw returns the same multiplier and moves nothing twice',
    (v_res->>'replay')::boolean IS TRUE AND (v_res->>'multiplier')::numeric = v_m
    AND (SELECT count(*) FROM public.poker_diamond_tournament_ledger WHERE tournament_id=v_tid) = v_rows
    AND (SELECT balance FROM public.ca_diamond_house WHERE id=1) = v_house, left(v_res::text,300));
  SET LOCAL ROLE service_role;
  PERFORM public.claim_tournament_lease_v2(v_tid,'conservation-rehearsal','conservation-proof',v_gen,30);
  v_res := public.fn_poker_diamond_spin_draw_proof(v_tid, v_launch);
  IF COALESCE((v_res->>'ok')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'draw proof %', v_res; END IF;
  v_res := public.fn_complete_tournament_launch_atomic(v_tid, v_launch, v_gen, 'spin-v1');
  RESET ROLE;
  PERFORM pg_temp.commit_boundary();
  PERFORM pg_temp.chk(p_fmt,'launch: the drawn Spin runs, its whole pool in custody',
    (v_res->>'status') = 'RUNNING' AND public.fn_poker_diamond_tournament_custody(v_tid) = v_pool, left(v_res::text,300));
END $f$;

-- STAGE 2: inside the finish lane.
CREATE FUNCTION pg_temp.phase_spin_finish(p_fmt text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE p uuid[] := pg_temp.players(); v_tid uuid := pg_temp.get(p_fmt,'tid')::uuid; v_tid2 uuid := pg_temp.get(p_fmt,'tid2')::uuid;
        v_table2 uuid := pg_temp.get(p_fmt,'table2')::uuid; v_pool bigint := pg_temp.get(p_fmt,'pool')::bigint;
        v_snap jsonb; v_res jsonb; v_w numeric[]; v_pay numeric[] := ARRAY[0,0,0]::numeric[]; v_place record; v_house1 numeric;
        v_rec jsonb; v_ok boolean := true; i int;
BEGIN
  v_snap := pg_temp.money(v_tid);
  PERFORM pg_temp.refuses(p_fmt,'cancellation after the draw and the launch is refused by name: a drawn Spin is played out, never voided',
    format('SELECT pg_temp.cancel(%L::uuid)', v_tid), 'Tournament has started or committed awards');
  PERFORM pg_temp.chk(p_fmt,'the refused cancellation moved nothing', pg_temp.money(v_tid) = v_snap);
  -- d busts first, e next, f wins.
  PERFORM pg_temp.as_engine();
  PERFORM pg_temp.bust(v_tid, p[1], 3); PERFORM pg_temp.bust(v_tid, p[2], 2);
  UPDATE public.tournament_players SET chips=3000 WHERE tournament_id=v_tid AND user_id=p[3];
  PERFORM pg_temp.commit_boundary();
  SELECT array_agg(pr.diamonds ORDER BY x.ord) INTO v_w FROM unnest(p) WITH ORDINALITY x(uid, ord) JOIN public.profiles pr ON pr.id=x.uid;
  v_house1 := (SELECT balance FROM public.ca_diamond_house WHERE id=1);
  v_res := pg_temp.terminal(v_tid, p[3]);
  FOR v_place IN SELECT (e->>'place')::int AS place, (e->>'percentage')::numeric AS pct
                   FROM jsonb_array_elements((SELECT payout_structure::jsonb FROM public.tournaments WHERE id=v_tid)) e LOOP
    v_pay[4 - v_place.place] := v_pool * v_place.pct / 100;
  END LOOP;
  FOR i IN 1..3 LOOP
    v_ok := v_ok AND (SELECT diamonds FROM public.profiles WHERE id=p[i]) = v_w[i] + v_pay[i] AND v_pay[i] = trunc(v_pay[i]);
  END LOOP;
  PERFORM pg_temp.chk(p_fmt,format('terminal: the %s-Diamond pool is paid down the drawn ladder in whole Diamonds (%s), nothing to the house at the finish', v_pool, v_pay),
    COALESCE((v_res->>'ok')::boolean,false) AND v_ok AND (SELECT status FROM public.tournaments WHERE id=v_tid) = 'COMPLETED'
    AND (SELECT balance FROM public.ca_diamond_house WHERE id=1) = v_house1
    AND EXISTS (SELECT 1 FROM public.tournament_escrow x WHERE x.tournament_id=v_tid AND x.prize_out=v_pool
                 AND x.reserve_in = GREATEST(v_pool - 30, 0) AND x.reserve_out = GREATEST(30 - v_pool, 0)),
    left(v_res::text,400));
  PERFORM pg_temp.conserved(p_fmt,'conservation', v_tid);
  v_snap := pg_temp.money(v_tid);
  BEGIN
    v_res := pg_temp.terminal(v_tid, p[3]);
  EXCEPTION WHEN OTHERS THEN
    v_res := jsonb_build_object('raised', SQLERRM);
  END;
  PERFORM pg_temp.chk(p_fmt,'idempotency: replaying the Spin''s terminal answers with a receipt and pays nothing twice',
    COALESCE((v_res->>'ok')::boolean,false) AND pg_temp.money(v_tid) = v_snap, left(v_res::text,300));
  -- Spin 2: two seats bought, never filled, cancelled: both made whole.
  v_rec := pg_temp.cancel(v_tid2);
  PERFORM pg_temp.whole_again(p_fmt,'Spin cancelled before it fills', v_tid2, v_rec, 2, 20, 0);
  PERFORM pg_temp.chk(p_fmt,'Spin cancelled before it fills: both seats released and the table closed',
    NOT EXISTS (SELECT 1 FROM public.table_seats s WHERE s.table_id=v_table2 AND s.left_at IS NULL)
    AND (SELECT status='closed' FROM public.tables WHERE id=v_table2), NULL);
END $f$;
-- ============================================================================
-- ROUNDING AT BOTH UNITS, on the installed arithmetic itself.
-- ============================================================================
CREATE FUNCTION pg_temp.rounding() RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v1 bigint[]; v100 bigint[]; w1 bigint[]; w100 bigint[]; s1 bigint[]; s100 bigint[];
        c_ladder constant jsonb := '[{"place":1,"bp":5000},{"place":2,"bp":3000},{"place":3,"bp":2000}]';
BEGIN
  SELECT array_agg(cents ORDER BY place) INTO v1 FROM public.fn_ca_prize_ladder(9600::bigint, c_ladder, 1);
  SELECT array_agg(cents ORDER BY place) INTO v100 FROM public.fn_ca_prize_ladder(9600::bigint, c_ladder, 100);
  PERFORM pg_temp.chk('arithmetic','rounding (ladder v1): 96 split 50/30/20 is 48.00/28.80/19.20 at unit 1 and 48/29/19 at the Diamond unit; both spend the pool exactly, the Diamond residue on the last paid place',
    v1 = ARRAY[4800,2880,1920]::bigint[] AND v100 = ARRAY[4800,2900,1900]::bigint[], format('unit 1 %s, unit 100 %s', v1, v100));
  SELECT array_agg(cents ORDER BY place) INTO w1 FROM public.fn_ca_prize_ladder_v2(9600::bigint, c_ladder, 1);
  SELECT array_agg(cents ORDER BY place) INTO w100 FROM public.fn_ca_prize_ladder_v2(9600::bigint, c_ladder, 100);
  PERFORM pg_temp.chk('arithmetic','rounding (ladder v2): the largest remainder takes the residual whole Diamond; both units spend the pool exactly',
    w1 = ARRAY[4800,2880,1920]::bigint[] AND w100 = ARRAY[4800,2900,1900]::bigint[], format('unit 1 %s, unit 100 %s', w1, w100));
  SELECT array_agg(cents ORDER BY place) INTO s1 FROM public.fn_ca_prize_ladder(200::bigint, c_ladder, 1);
  SELECT array_agg(cents ORDER BY place) INTO s100 FROM public.fn_ca_prize_ladder(200::bigint, c_ladder, 100);
  PERFORM pg_temp.chk('arithmetic','rounding (short field): 2 Diamonds over 3 places pay one whole Diamond each from the top at the Diamond unit, and split by percentage at unit 1',
    s1 = ARRAY[100,60,40]::bigint[] AND s100 = ARRAY[100,100,0]::bigint[], format('unit 1 %s, unit 100 %s', s1, s100));
  PERFORM pg_temp.chk('arithmetic','rounding (fee): a 25 entry takes 2.50 at unit 1 and 2 at the Diamond unit',
    public.fn_ca_recovery_fee_cents(2500::bigint, 0.10, 1) = 250 AND public.fn_ca_recovery_fee_cents(2500::bigint, 0.10, 100) = 200,
    format('%s / %s', public.fn_ca_recovery_fee_cents(2500::bigint, 0.10, 1), public.fn_ca_recovery_fee_cents(2500::bigint, 0.10, 100)));
  PERFORM pg_temp.chk('arithmetic','rounding (PKO half, mystery half): 3.50 and 17.50 at unit 1 are 3 and 17 at the Diamond unit',
    public.fn_ca_unit_floor_cents(350::bigint,1) = 350 AND public.fn_ca_unit_floor_cents(350::bigint,100) = 300
    AND public.fn_ca_unit_floor_cents(1750::bigint,1) = 1750 AND public.fn_ca_unit_floor_cents(1750::bigint,100) = 1700, NULL);
END $f$;

-- ============================================================================
-- THE FORMATS. Adding a format is adding a row. Players are disjoint per
-- format (synthetic hydra.bot accounts with no club membership), so each
-- format's wallets can be accounted on their own at the end.
-- ============================================================================
INSERT INTO pg_temp.formats VALUES
 (1,'mtt',     '{"type":"mtt","buyIn":25,"payoutPercent":20,"rebuy":true}', ARRAY['00000000-0000-0000-0000-000000000056','00000000-0000-0000-0000-000000000057','00000000-0000-0000-0000-000000000058','00000000-0000-0000-0000-000000000059','00000000-0000-0000-0000-000000000065','00000000-0000-0000-0000-000000000067']::uuid[]),
 (2,'sng',     '{"type":"sng","buyIn":25,"maxPlayers":6,"payoutPercent":20,"rebuy":true}', ARRAY['00000000-0000-0000-0000-000000000069','00000000-0000-0000-0000-000000000070','00000000-0000-0000-0000-000000000071','00000000-0000-0000-0000-000000000072','00000000-0000-0000-0000-000000000073','00000000-0000-0000-0000-000000000074']::uuid[]),
 (3,'bounty',  '{"type":"bounty","buyIn":25,"bountyAmount":7,"payoutPercent":20,"rebuy":true}', ARRAY['00000000-0000-0000-0000-000000000075','00000000-0000-0000-0000-000000000076','00000000-0000-0000-0000-000000000078','00000000-0000-0000-0000-000000000079','00000000-0000-0000-0000-000000000080','00000000-0000-0000-0000-000000000081']::uuid[]),
 (4,'pko',     '{"type":"progressive_bounty","buyIn":25,"bountyAmount":7,"payoutPercent":20,"rebuy":true}', ARRAY['00000000-0000-0000-0000-000000000082','00000000-0000-0000-0000-000000000083','00000000-0000-0000-0000-000000000084','00000000-0000-0000-0000-000000000085','00000000-0000-0000-0000-000000000086','00000000-0000-0000-0000-000000000089']::uuid[]),
 (5,'mystery', '{"type":"mystery_bounty","buyIn":25,"bountyAmount":7,"payoutPercent":20,"rebuy":true,"mysteryBounty":{"activation":"player_count","activationValue":4,"profile":"classic","topPercent":20,"poolPercent":50}}', ARRAY['00000000-0000-0000-0000-000000000090','00000000-0000-0000-0000-000000000091','00000000-0000-0000-0000-000000000092','00000000-0000-0000-0000-000000000093','00000000-0000-0000-0000-000000000094','00000000-0000-0000-0000-000000000095']::uuid[]),
 (6,'satellite','{"type":"satellite"}', ARRAY['00000000-0000-0000-0000-000000000096','00000000-0000-0000-0000-000000000098','00000000-0000-0000-0000-000000000056','00000000-0000-0000-0000-000000000065']::uuid[]),
 (7,'spin',    '{"type":"spin"}', ARRAY['00000000-0000-0000-0000-000000000057','00000000-0000-0000-0000-000000000058','00000000-0000-0000-0000-000000000059']::uuid[]);
-- Players are disjoint within a slice (a slice never shares a transaction with
-- another); the satellite and Spin slice reuses accounts the mtt slice uses.

CREATE TEMP TABLE plan(fmt text, stage text, ord int, phase text, chain text, PRIMARY KEY (fmt, phase));
INSERT INTO pg_temp.plan
SELECT f.fmt, s.stage, s.ord, s.phase, s.chain FROM pg_temp.formats f
 CROSS JOIN (VALUES
   ('a',1,'entries','main'),('a',2,'setup_cancel_after_prelaunch_rebuy','car'),
   ('b',1,'withdraw','main'),('b',2,'launch','main'),('b',3,'first_knockout','main'),('b',4,'rebuy','main'),
   ('b',5,'capped_exposure','main'),('b',6,'field_busts','main'),
   ('b',7,'setup_cancel_before_launch','cbl'),('b',8,'setup_cancel_after_begun_launch','cabl'),
   ('c',1,'finish','main'),('c',2,'replays','main'),
   ('d',1,'cancel_before_launch','cbl'),('d',2,'cancel_after_begun_launch','cabl'),('d',3,'cancel_after_prelaunch_rebuy','car'),
   ('e',1,'accounting','final')) s(stage, ord, phase, chain)
 WHERE f.fmt NOT IN ('satellite','spin')
UNION ALL SELECT * FROM (VALUES
 ('satellite','a',1,'sat_create','main'),('satellite','b',1,'sat_launch','main'),('satellite','c',1,'sat_finish','main'),
 ('satellite','e',1,'accounting','final'),
 ('spin','a',1,'spin_create','main'),('spin','b',1,'spin_launch','main'),('spin','c',1,'spin_finish','main'),
 ('spin','e',1,'accounting','final')) v(fmt, stage, ord, phase, chain);
DELETE FROM pg_temp.plan WHERE NOT (fmt = ANY(string_to_array(current_setting('conservation.slice'), ',')));
DELETE FROM pg_temp.formats WHERE NOT (fmt = ANY(string_to_array(current_setting('conservation.slice'), ',')));
CREATE TEMP TABLE done(fmt text, phase text, ok boolean, PRIMARY KEY (fmt, phase));

-- Runs one planned phase: timed, its lane locks recorded, and recorded as done
-- or failed.
CREATE FUNCTION pg_temp.run_phase(p_fmt text, p_phase text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE t0 timestamptz := clock_timestamp(); v_ok boolean; r record; v_g text; v_f text;
BEGIN
  SELECT * INTO r FROM pg_temp.plan WHERE fmt=p_fmt AND phase=p_phase;
  PERFORM set_config('conservation.fmt', p_fmt, true);
  IF r.chain = 'final' THEN
    v_ok := NOT EXISTS (SELECT 1 FROM pg_temp.plan pl WHERE pl.fmt=p_fmt AND pl.chain<>'final'
                         AND NOT EXISTS (SELECT 1 FROM pg_temp.done d WHERE d.fmt=p_fmt AND d.phase=pl.phase AND d.ok));
  ELSE
    v_ok := NOT EXISTS (SELECT 1 FROM pg_temp.plan pl WHERE pl.fmt=p_fmt AND pl.chain=r.chain
                         AND (pl.stage < r.stage OR (pl.stage = r.stage AND pl.ord < r.ord))
                         AND NOT EXISTS (SELECT 1 FROM pg_temp.done d WHERE d.fmt=p_fmt AND d.phase=pl.phase AND d.ok));
  END IF;
  IF NOT v_ok THEN
    INSERT INTO pg_temp.res(fmt,name,ok,detail) VALUES (p_fmt, 'phase skipped: '||p_phase, false, 'an earlier phase of its chain failed');
    INSERT INTO pg_temp.done VALUES (p_fmt, p_phase, false);
    RETURN;
  END IF;
  BEGIN
    EXECUTE format('SELECT pg_temp.phase_%s(%L)', p_phase, p_fmt);
    INSERT INTO pg_temp.done VALUES (p_fmt, p_phase, true);
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO pg_temp.res(fmt,name,ok,detail) VALUES (p_fmt, 'phase aborted: '||p_phase, false, SQLERRM);
    INSERT INTO pg_temp.done VALUES (p_fmt, p_phase, false);
  END;
  -- Which settlement-lane keys this backend now holds, and how.
  SELECT string_agg(DISTINCT l.mode, '+') INTO v_g FROM pg_locks l
   WHERE l.pid=pg_backend_pid() AND l.locktype='advisory' AND l.objsubid=1
     AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended('ca:tournament-terminal-settlement:v1', 0);
  SELECT string_agg(DISTINCT l.mode, '+') INTO v_f FROM pg_locks l
   WHERE l.pid=pg_backend_pid() AND l.locktype='advisory' AND l.objsubid=1
     AND ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended('ca:tournament-finish-lane:v1', 0);
  INSERT INTO pg_temp.timing(fmt, phase, ms) VALUES (p_fmt, p_phase||CASE WHEN v_g IS NOT NULL THEN ' G:'||v_g ELSE '' END
      ||CASE WHEN v_f IS NOT NULL THEN ' F:'||v_f ELSE '' END,
    round(extract(epoch FROM clock_timestamp() - t0)*1000));
  IF EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid=pg_backend_pid() AND l.locktype='advisory' AND l.objsubid=1
               AND l.mode='ExclusiveLock'
               AND ((l.classid::bigint << 32) | l.objid::bigint) IN (hashtextextended('ca:tournament-terminal-settlement:v1', 0),
                                                                   hashtextextended('ca:hand-settlement-barrier:v1', 0))) THEN
    INSERT INTO pg_temp.res(fmt,name,ok,detail) VALUES (p_fmt, 'safety: the global settlement lane was taken', false, 'after phase '||p_phase);
  END IF;
END $f$;

-- ============================================================================
-- THE SCENE (inside this rolled-back transaction only).
-- ============================================================================
INSERT INTO auth.sessions (id, user_id, created_at, updated_at)
SELECT uuid_in(md5('conservation-session:'||u::text)::cstring), u, now(), now()
  FROM (SELECT unnest(players) u FROM pg_temp.formats UNION SELECT pg_temp.admin()) s;

DO $scene$
DECLARE v_arena uuid; v_tiers jsonb; v_c jsonb; t0 timestamptz := clock_timestamp();
BEGIN
  SELECT id INTO v_arena FROM public.clubs WHERE asset='diamonds' AND is_platform IS TRUE AND union_id IS NULL;
  PERFORM pg_temp.as_engine();
  UPDATE public.profiles SET diamonds=1000, diamond_balance=1000 WHERE id IN (SELECT unnest(players) FROM pg_temp.formats);
  UPDATE public.profiles SET role='admin' WHERE id=pg_temp.admin();
  INSERT INTO public.ca_diamond_house (id, balance) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
  IF EXISTS (SELECT 1 FROM pg_temp.formats WHERE fmt='spin') THEN
  -- Production's state first: no reserve source, so a Diamond Spin is refused by name.
  PERFORM pg_temp.as_client(pg_temp.admin());
  PERFORM pg_temp.refuses('spin','creation: with no reserve source authorized (production today) a Diamond Spin is refused by name',
    format('SELECT public.fn_poker_diamond_create_tournament(%L::jsonb)', pg_temp.spin_cfg('x')), 'diamond_spin_reserve_source_not_authorized');
  -- The source is authorized for exactly the published table's own worst
  -- excess at this buy-in, and the house given exactly the cover the table
  -- requires - both read from the contract the create door applies.
  SELECT jsonb_agg(jsonb_build_object('multiplier', s.multiplier, 'freq', s.freq,
                                      'reserveThresholdX', s.reserve_threshold_x) ORDER BY s.multiplier)
    INTO v_tiers FROM public.spin_tier_spec s;
  v_c := public.fn_poker_diamond_spin_contract(10::bigint, 1000, v_tiers, pg_temp.spin_blinds());
  INSERT INTO public.poker_diamond_spin_reserve_source (id, source_account, max_underwrite_per_spin, authorized_by, ruling)
  VALUES (1, 'diamond_house', (v_c->>'worst_excess')::bigint, 'conservation rehearsal',
          'REHEARSAL ONLY - rolled back; the cap is the table''s own worst excess, not a number anyone approved');
  UPDATE public.ca_diamond_house SET balance = balance + (v_c->>'required_cover')::bigint WHERE id = 1;
  PERFORM pg_temp.note('spin','the reserve the rehearsal authorized, read from the contract',
    format('worst excess %s, required cover %s at a buy-in of 10', v_c->>'worst_excess', v_c->>'required_cover'));
  END IF;
  PERFORM pg_temp.as_engine();
  UPDATE public.ca_arena_settings SET tournaments_enabled=true WHERE id=1 AND club_id=v_arena;
  IF (SELECT count(*) FROM (SELECT unnest(players) FROM pg_temp.formats) x) <>
     (SELECT count(DISTINCT u) FROM (SELECT unnest(players) u FROM pg_temp.formats) x) THEN
    RAISE EXCEPTION 'a slice may not give one account to two formats';
  END IF;
  INSERT INTO pg_temp.base VALUES ('identity', pg_temp.identity()),
    ('house', (SELECT balance FROM public.ca_diamond_house WHERE id=1)),
    ('wallets', (SELECT sum(diamonds) FROM public.profiles WHERE id IN (SELECT unnest(players) FROM pg_temp.formats)));
  INSERT INTO pg_temp.timing(fmt, phase, ms) VALUES ('all','scene', round(extract(epoch FROM clock_timestamp() - t0)*1000));
END $scene$;

-- STAGE 1a then 1b: every format, up to (never into) a finish.
DO $stage1$
DECLARE r record;
BEGIN
  BEGIN
    PERFORM pg_temp.rounding();
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO pg_temp.res(fmt,name,ok,detail) VALUES ('arithmetic','rounding aborted',false,SQLERRM);
  END;
  FOR r IN SELECT pl.* FROM pg_temp.plan pl JOIN pg_temp.formats f USING (fmt)
            WHERE pl.stage IN ('a','b') ORDER BY pl.stage, f.ord, pl.ord LOOP
    PERFORM pg_temp.run_phase(r.fmt, r.phase);
  END LOOP;
END $stage1$;

DO $mid$
BEGIN
  INSERT INTO pg_temp.res(fmt,name,ok,detail)
  SELECT 'all','after every entry, withdrawal, launch, knockout, rebuy and draw, the supply identity has not moved',
         pg_temp.identity() = (SELECT v FROM pg_temp.base WHERE k='identity'),
         format('baseline %s now %s', (SELECT v FROM pg_temp.base WHERE k='identity'), pg_temp.identity());
END $mid$;

-- STAGE 2: every finish, settlement and cancellation, back to back, inside
-- one finish lane; then the accounting.
--
-- The finish lane (F) is exclusive platform-wide, and live terminals queue for
-- it back to back (they hold it about three seconds each). The rehearsal joins
-- that queue like any other finish - FIFO, so it never jumps a live one - and
-- once it holds F, everything below runs inside it and the transaction ends.
-- Only this one wait may take longer than two seconds.
SET LOCAL statement_timeout = '40s';
DO $stage2$
DECLARE r record; t0 timestamptz := clock_timestamp();
BEGIN
  SET LOCAL lock_timeout = '20s';
  PERFORM pg_advisory_xact_lock(hashtextextended('ca:tournament-finish-lane:v1', 0));
  SET LOCAL lock_timeout = '2s';
  INSERT INTO pg_temp.timing(fmt, phase, ms) VALUES ('all', 'waited in the finish-lane queue', round(extract(epoch FROM clock_timestamp() - t0)*1000));
  t0 := clock_timestamp();
  FOR r IN SELECT pl.* FROM pg_temp.plan pl JOIN pg_temp.formats f USING (fmt)
            WHERE pl.stage IN ('c','d') ORDER BY f.ord, pl.stage, pl.ord LOOP
    PERFORM pg_temp.run_phase(r.fmt, r.phase);
  END LOOP;
  FOR r IN SELECT pl.* FROM pg_temp.plan pl JOIN pg_temp.formats f USING (fmt) WHERE pl.stage='e' ORDER BY f.ord LOOP
    PERFORM pg_temp.run_phase(r.fmt, r.phase);
  END LOOP;
  INSERT INTO pg_temp.timing(fmt, phase, ms) VALUES ('all','stage 2 (the finish lane held)', round(extract(epoch FROM clock_timestamp() - t0)*1000));
END $stage2$;

DO $final$
DECLARE v_fail text; v_n int; v_ok int; v_info text; v_per text; v_time text; v_fee numeric; v_legs numeric;
BEGIN
  SELECT COALESCE(sum(l.amount) FILTER (WHERE l.kind='fee'),0),
         COALESCE(sum(l.amount) FILTER (WHERE l.kind='spin_surplus'),0) - COALESCE(sum(l.amount) FILTER (WHERE l.kind='spin_underwrite'),0)
    INTO v_fee, v_legs FROM public.poker_diamond_tournament_ledger l JOIN pg_temp.events e ON e.tid=l.tournament_id;
  INSERT INTO pg_temp.res(fmt,name,ok,detail)
  SELECT 'all','across every event of every format: the house gained exactly the fees kept and the reserve legs, the players lost exactly that, and every event is closed',
         (SELECT balance FROM public.ca_diamond_house WHERE id=1) - (SELECT v FROM pg_temp.base WHERE k='house') = v_fee + v_legs
         AND (SELECT sum(diamonds) FROM public.profiles WHERE id IN (SELECT unnest(players) FROM pg_temp.formats))
             - (SELECT v FROM pg_temp.base WHERE k='wallets') = -(v_fee + v_legs)
         AND NOT EXISTS (SELECT 1 FROM pg_temp.events e JOIN public.tournaments t ON t.id=e.tid WHERE t.status NOT IN ('COMPLETED','CANCELLED')),
         format('events %s, fees %s, legs to the house %s, house moved %s, players moved %s', (SELECT count(*) FROM pg_temp.events), v_fee, v_legs,
           (SELECT balance FROM public.ca_diamond_house WHERE id=1) - (SELECT v FROM pg_temp.base WHERE k='house'),
           (SELECT sum(diamonds) FROM public.profiles WHERE id IN (SELECT unnest(players) FROM pg_temp.formats)) - (SELECT v FROM pg_temp.base WHERE k='wallets'));
  INSERT INTO pg_temp.res(fmt,name,ok,detail)
  SELECT 'all','the Diamond supply identity is exactly where the rehearsal found it, after every format and every case',
         pg_temp.identity() = (SELECT v FROM pg_temp.base WHERE k='identity'),
         format('baseline %s now %s', (SELECT v FROM pg_temp.base WHERE k='identity'), pg_temp.identity());
  SELECT count(*), count(*) FILTER (WHERE ok) INTO v_n, v_ok FROM pg_temp.res WHERE NOT info;
  SELECT string_agg(format('%s %s/%s', fmt, count_ok, count_all), ', ' ORDER BY first_n) INTO v_per FROM (
    SELECT fmt, count(*) FILTER (WHERE ok) count_ok, count(*) count_all, min(n) first_n
      FROM pg_temp.res WHERE NOT info GROUP BY fmt) s;
  SELECT string_agg(format('%s/%s %sms', fmt, phase, ms), ', ' ORDER BY n) INTO v_time FROM pg_temp.timing;
  SELECT string_agg(format('  [%s] %s :: %s', fmt, name, COALESCE(detail,'')), E'\n' ORDER BY n) INTO v_fail FROM pg_temp.res WHERE NOT ok;
  SELECT string_agg(format('  [%s] %s :: %s', fmt, name, COALESCE(detail,'')), E'\n' ORDER BY n) INTO v_info FROM pg_temp.res WHERE info;
  IF v_fail IS NULL AND current_setting('conservation.boundary', true) IS DISTINCT FROM 'all' THEN
    RAISE EXCEPTION E'REHEARSAL EXPLORE (not evidence: boundary %): % of % assertions passed (%).\nTIMING: %', current_setting('conservation.boundary', true), v_ok, v_n, v_per, v_time;
  ELSIF v_fail IS NULL THEN
    RAISE EXCEPTION E'REHEARSAL OK [slice %]: % of % assertions passed (%).\nTIMING: %\nNOTES:\n%\nEVIDENCE:\n%', current_setting('conservation.slice'), v_ok, v_n, v_per, v_time, COALESCE(v_info,'  none'),
      (SELECT string_agg(format('  [%s] %s%s', fmt, name,
         CASE WHEN name ~ '^(rounding|knockout|terminal|draw|satellite settlement|target terminal|conservation: what came in|accounting|across|capped exposure: a place)'
              THEN ' :: '||left(COALESCE(detail,''),240) ELSE '' END), E'\n' ORDER BY n) FROM pg_temp.res WHERE NOT info);
  ELSE
    RAISE EXCEPTION E'REHEARSAL FAIL [slice %]: % of % assertions passed (%).\nTIMING: %\nFAILURES:\n%\nNOTES:\n%', current_setting('conservation.slice'), v_ok, v_n, v_per, v_time, v_fail, COALESCE(v_info,'  none');
  END IF;
END $final$;
