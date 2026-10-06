-- 20261001151056_a_table_that_never_dealt_is_moved_from_its_seated_entries.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- CLAUDE.md 10.9 / 10.11 / 10.12: the reasoning is in this header. This file
-- adds ONE reader, smarter_private.f06_movement_never_dealt_prior, and gives
-- two existing readers one branch each for a table that never dealt:
-- smarter_private.f06_movement_prior and smarter_private.f06_assert_movement.
-- It schedules nothing, retries nothing, writes no row and moves no chip.
--
-- ===========================================================================
-- WHAT WAS WRONG, READ FROM ROWS AND LOG LINES (2026-10-01)
--
-- 21ada05e "Early Bird Freeroll (NLH)" is RUNNING and has dealt nothing since
-- 06:29 UTC. Three players remain:
--   nice_waffle  835,000  alone on table b29a51c9 (waiting; last hand
--                          19242290 committed 06:29, post-commit ok)
--   CLTPriya       2,500  table c0b95966 seat 2 } late registrants, 05:08,
--   LuckyRock      2,500  table c0b95966 seat 1 } one 'entry' funding receipt
--                                                  each (starting_chips 2500),
--                                                  no rebuy or add-on
-- c0b95966 has NEVER dealt a hand: no hand_atomic_commits, hand_history,
-- hand_private_state, table_hole_cards, hand_state_snapshots or
-- f06_hand_permits row. It is the source of break e1f15079 (park_requested,
-- manifest NULL, lifecycle 529616, created 05:52). Every resume since:
--
--   [Tournament.table_engine_readmission_failed] Error:
--     f06_movement_admission_unproven [55000]: F06_MOVEMENT_PRIOR_INCOMPLETE
--   Break e1f15079 not begun: source_engine_absent
--
-- fn_f06_admit_parked_movement takes its proof from f06_movement_prior, which
-- loads the source table's LAST hand_atomic_commits row and raises
-- F06_MOVEMENT_PRIOR_INCOMPLETE when there is none. A table that never dealt
-- has none, so a never-dealt table that is not the event's last table can
-- never be moved or consolidated, and the event stalls for ever. The existing
-- never-dealt path (fn_f06_continue_no_start_last_table, 20260926132457)
-- covers only an event's LAST table with every entrant seated on it.
--
-- ===========================================================================
-- WHAT THIS CHANGES
--
-- f06_movement_prior: when the table's one open break is park_requested
-- (manifest NULL, current lifecycle; already checked above it) and the table
-- has no committed hand, the proof is taken by the new
-- f06_movement_never_dealt_prior, which admits ONLY when all of these hold:
--   * no hand of any number was committed, recorded, held privately, dealt,
--     snapshotted or permitted on the table;
--   * every occupied chair holds a 'playing' registration of this event on
--     exactly that table and seat, not eliminated, whose chips equal the
--     chair's stack;
--   * that stack is exactly what the registration's ONE durable funding
--     receipt granted: operation 'entry', its tournament image's
--     starting_chips and its registration image's chips; no other receipt for
--     the registration or user, rebuys 0, no add-on, no rebuy/add-on ledger
--     leg (a purchase cannot be proven exactly here, so it refuses);
--   * the chairs are the whole roster (1..10, equal to the event's
--     playing/registered registrations on the table) and no permit exists.
-- It returns the park proof shape with no hand: 'atomic' and 'history' JSON
-- null, 'eliminated' [], 'permits' [], 'first_hand' true (as
-- fn_f06_continue_no_start_last_table reports a first hand), the roster as
-- {seat, registration} exactly as the park branch writes it, and 'receipts'
-- naming the break and the entry receipts. Anything else refuses. Every table
-- that has a committed hand, and every begun break, takes the old path
-- unchanged.
--
-- f06_assert_movement: a proof whose 'first_hand' is true is held to "atomic
-- and history null, permits [], the table on the admitted lifecycle, and no
-- hand row of any kind on the table". Every other proof is checked by the old
-- boundary statement, byte for byte, nested in the ELSE. The roster, winner,
-- elimination and whole-roster checks after it are unchanged and apply to
-- both.
--
-- The engine needs no change: verifyF06MovementAdmission reads only the
-- admission identity, revision and proof hash, never the proof's hand.
--
-- Same signatures, owner (postgres), ACL {postgres=X/postgres}, SECURITY
-- DEFINER, volatility and search_path. Removing the stated passages from each
-- changed body reproduces its pre-image digest exactly (asserted below). The
-- mixed-custody contract pins for f06_assert_movement (release publisher
-- constant, fixture, shared-hand lane) carry the post-image.
--
-- PROVED FIRST (CLAUDE.md 11.5): this file applied as written to a scratch
-- cluster holding production's schema-only dump of the tables it reads and
-- the three live function bodies (digests equal to production's), and the
-- never-dealt shape, its refusals and an ordinary proof were exercised there.
--
-- NOT TOUCHED: fn_f06_admit_parked_movement, f06_movement_permits, every
-- stored proof, operation, attempt, lease and receipt.
--
-- Pinned by tests/a-table-that-never-dealt-is-moved-from-its-seated-entries.law.test.ts.
--
-- @live-proof: (SELECT md5(prosrc)='c0da72045d9c661631484a4d7c9dc922' AND md5(pg_get_functiondef(oid))='433debf7038257e4c8f0e3dfb9bb4a7d' AND proacl::text='{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_movement_never_dealt_prior(uuid,uuid,uuid)'::regprocedure)
-- @live-proof: (SELECT md5(prosrc)='493026caf75bb03a336db56bac008009' AND md5(pg_get_functiondef(oid))='847ab696563b25d097636b078a54982e' AND proacl::text='{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_movement_prior(uuid,uuid)'::regprocedure)
-- @live-proof: (SELECT md5(prosrc)='df656e0490a6a8f570f409916fc2f643' AND md5(pg_get_functiondef(oid))='6fd0cf3d598211408d165117fd8c32fe' AND proacl::text='{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_assert_movement(uuid)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

DO $never_dealt_preimage$
BEGIN
  IF to_regprocedure('smarter_private.f06_movement_never_dealt_prior(uuid,uuid,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'F06_NEVER_DEALT_PREIMAGE_DRIFT: smarter_private.f06_movement_never_dealt_prior(uuid,uuid,uuid) already exists';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('smarter_private.f06_movement_prior(uuid,uuid)')
       AND md5(p.prosrc) = '17cd448464cd6e297dc8927890d1a8ff'
       AND md5(pg_get_functiondef(p.oid)) = '7131896d73597c72a2e29b802580ef37'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig = ARRAY['search_path=pg_catalog, public, smarter_private']
       AND p.prosecdef AND p.provolatile = 'v'
       AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')) THEN
    RAISE EXCEPTION 'F06_NEVER_DEALT_PREIMAGE_DRIFT: smarter_private.f06_movement_prior(uuid,uuid)';
  END IF;
END
$never_dealt_preimage$;

CREATE FUNCTION smarter_private.f06_movement_never_dealt_prior(p_tournament uuid, p_table uuid, p_break uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $never_dealt_helper$
DECLARE o smarter_private.f06_operations; seat public.table_seats; registration public.tournament_players;
 fund public.tournament_participant_funding_receipts; roster jsonb:='[]'; entries jsonb:='[]'; n integer:=0; permits jsonb;
BEGIN
 -- Called only by f06_movement_prior, for the one open break of this table's
 -- current lifecycle, when the table has no committed hand. A park of a table
 -- that never dealt has no sealed hand to prove its boundary from: the
 -- boundary is its seated entries, each holding exactly what its entry grants.
 SELECT op.* INTO o FROM smarter_private.f06_operations op JOIN public.tables t ON t.id=op.source_table_id AND t.f06_lifecycle=op.lifecycle
 WHERE op.break_id=p_break AND op.tournament_id=p_tournament AND op.source_table_id=p_table AND t.tournament_id=p_tournament;
 IF NOT FOUND OR o.state IS DISTINCT FROM 'park_requested' OR o.manifest IS NOT NULL
 OR (SELECT count(*) FROM smarter_private.f06_operations WHERE tournament_id=p_tournament AND source_table_id=p_table AND state IN ('park_requested','begun'))<>1 THEN
 RAISE EXCEPTION 'F06_MOVEMENT_PRIOR_INCOMPLETE' USING ERRCODE='55000'; END IF;
 -- Never dealt: no hand of any number was committed, recorded, held
 -- privately, dealt, snapshotted or permitted on this table.
 IF EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=p_table)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=p_table)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=p_table)
 OR EXISTS(SELECT 1 FROM public.table_hole_cards WHERE table_id=p_table)
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=p_table)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=p_table) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_PRIOR_INCOMPLETE' USING ERRCODE='55000'; END IF;
 -- Every occupied chair holds a playing registration of this event on exactly
 -- this chair, whose chips are the chair's stack and are exactly what its one
 -- durable funding receipt, an entry, granted: no rebuy, re-entry or add-on
 -- (receipt, registration counter or ledger leg), no elimination.
 FOR seat IN SELECT st.* FROM public.table_seats st WHERE st.table_id=p_table AND st.left_at IS NULL ORDER BY st.user_id,st.id FOR UPDATE LOOP
 SELECT * INTO registration FROM public.tournament_players WHERE tournament_id=p_tournament AND user_id=seat.user_id FOR UPDATE;
 SELECT * INTO fund FROM public.tournament_participant_funding_receipts f WHERE f.tournament_id=p_tournament AND f.registration_id=registration.id;
 IF seat.user_id IS NULL OR seat.occupancy_id IS NULL OR seat.stack IS NULL OR seat.stack<=0
 OR registration.id IS NULL OR registration.status IS DISTINCT FROM 'playing' OR registration.eliminated_at IS NOT NULL
 OR (registration.table_id,registration.seat_number) IS DISTINCT FROM (seat.table_id,seat.seat_number)
 OR registration.chips::numeric IS DISTINCT FROM seat.stack
 OR COALESCE(registration.rebuys,0)<>0 OR COALESCE(registration.add_on,false)
 OR fund.id IS NULL OR fund.operation IS DISTINCT FROM 'entry' OR fund.user_id IS DISTINCT FROM registration.user_id
 OR fund.tournament_snapshot->>'id' IS DISTINCT FROM p_tournament::text
 OR fund.registration_snapshot->>'id' IS DISTINCT FROM registration.id::text
 OR jsonb_typeof(fund.tournament_snapshot->'starting_chips') IS DISTINCT FROM 'number'
 OR jsonb_typeof(fund.registration_snapshot->'chips') IS DISTINCT FROM 'number'
 OR (fund.tournament_snapshot->>'starting_chips')::numeric IS DISTINCT FROM seat.stack
 OR (fund.registration_snapshot->>'chips')::numeric IS DISTINCT FROM seat.stack
 OR (SELECT count(*) FROM public.tournament_participant_funding_receipts f WHERE f.tournament_id=p_tournament
 AND (f.registration_id=registration.id OR f.user_id=registration.user_id))<>1
 OR EXISTS(SELECT 1 FROM public.chip_ledger l WHERE l.tournament_id=p_tournament AND l.category IN ('rebuy','addon')
 AND l.from_entity_id=registration.user_id) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN' USING ERRCODE='55000'; END IF;
 n:=n+1;
 roster:=roster||jsonb_build_array(jsonb_build_object('seat',to_jsonb(seat),'registration',to_jsonb(registration)));
 entries:=entries||jsonb_build_array(jsonb_build_object('receipt_id',fund.id,'registration_id',fund.registration_id,'user_id',fund.user_id,
 'operation',fund.operation,'observed_at',fund.observed_at,'starting_chips',fund.tournament_snapshot->'starting_chips','chips',fund.registration_snapshot->'chips'));
 END LOOP;
 IF n NOT BETWEEN 1 AND 10
 OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=p_tournament AND table_id=p_table AND status IN ('playing','registered'))<>n THEN
 RAISE EXCEPTION 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED' USING ERRCODE='55000'; END IF;
 permits:=smarter_private.f06_movement_permits(p_tournament,p_table,NULL);
 IF permits IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'F06_MOVEMENT_PRIOR_INCOMPLETE' USING ERRCODE='55000'; END IF;
 -- No hand: 'atomic' and 'history' are JSON null and 'first_hand' is true, as
 -- fn_f06_continue_no_start_last_table reports a first hand. The roster entries
 -- have the park shape f06_assert_movement compares.
 RETURN jsonb_build_object('atomic',NULL::jsonb,'history',NULL::jsonb,'roster',roster,'eliminated','[]'::jsonb,'permits',permits,'first_hand',true,
 'receipts',jsonb_build_object('break_id',o.break_id,'state',o.state,'lifecycle',o.lifecycle,'never_dealt',true,'entries',entries));
END $never_dealt_helper$;

REVOKE ALL ON FUNCTION smarter_private.f06_movement_never_dealt_prior(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION smarter_private.f06_movement_prior(p_tournament uuid, p_table uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $never_dealt_prior$
DECLARE a public.hand_atomic_commits; h public.hand_history; s jsonb; payload jsonb; submitted jsonb;
 x jsonb; seat public.table_seats; registration public.tournament_players;
 roster jsonb:='[]'; eliminated jsonb:='[]'; permits jsonb; n integer; positive integer:=0;
 o smarter_private.f06_operations; ops integer; member smarter_private.f06_members; winner jsonb;
 movement public.tournament_seat_move_receipts; item jsonb; items jsonb:='[]'; p record;
 gained numeric; held numeric; rebought timestamptz; bought integer; since timestamptz; lim timestamptz; remaining integer:=0; users uuid[]:='{}';
 purchases jsonb:='[]'; arrivals jsonb:='[]'; moved jsonb:='[]';
 reoccupied jsonb:='[]'; arrival public.tournament_seat_move_receipts;
BEGIN
 -- The one open break of this table's current lifecycle says what kind of
 -- proof may be taken. A park is proven from its last sealed hand. A begun
 -- break that never took a proof may take one only from durable receipts:
 -- a member already moved is named by its committed winner receipt, every
 -- other member by its live seat and registration. Nothing else qualifies.
 SELECT count(*) INTO ops FROM smarter_private.f06_operations op JOIN public.tables t ON t.id=op.source_table_id AND t.f06_lifecycle=op.lifecycle
 WHERE op.tournament_id=p_tournament AND op.source_table_id=p_table AND op.state IN ('park_requested','begun');
 SELECT op.* INTO o FROM smarter_private.f06_operations op JOIN public.tables t ON t.id=op.source_table_id AND t.f06_lifecycle=op.lifecycle
 WHERE op.tournament_id=p_tournament AND op.source_table_id=p_table AND op.state IN ('park_requested','begun');
 IF ops<>1 OR NOT ((o.state='park_requested' AND o.manifest IS NULL) OR (o.state='begun' AND o.manifest IS NOT NULL)) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_ORIGINAL_PROOF_MISSING' USING ERRCODE='55000'; END IF;
 -- A park of a table that never dealt has no sealed hand to prove from. Its
 -- boundary is its seated entries (f06_movement_never_dealt_prior), and
 -- anything that is not exactly that still refuses there.
 IF o.state='park_requested' AND NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=p_table) THEN
 RETURN smarter_private.f06_movement_never_dealt_prior(p_tournament,p_table,o.break_id); END IF;
 SELECT * INTO a FROM public.hand_atomic_commits WHERE table_id=p_table ORDER BY hand_number DESC LIMIT 1 FOR SHARE;
 IF NOT FOUND OR a.post_commit_completed_at IS NULL OR NOT isfinite(a.post_commit_completed_at)
 OR a.post_commit_completed_at<a.committed_at OR a.post_commit_result->'ok' IS DISTINCT FROM 'true'::jsonb
 OR a.post_commit_result->>'hand_id' IS DISTINCT FROM a.hand_id::text
 OR (a.post_commit_result->>'hand_number')::bigint IS DISTINCT FROM a.hand_number THEN
 RAISE EXCEPTION 'F06_MOVEMENT_PRIOR_INCOMPLETE' USING ERRCODE='55000'; END IF;
 SELECT * INTO h FROM public.hand_history WHERE id=a.hand_id AND table_id=p_table AND hand_number=a.hand_number FOR SHARE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=p_table AND committed_at>a.committed_at)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=p_table AND hand_number>a.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=p_table AND hand_number>a.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=p_table AND NOT is_complete) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_PRIOR_NOT_LAST_BOUNDARY' USING ERRCODE='55000'; END IF;
 permits:=smarter_private.f06_movement_permits(p_tournament,p_table,a.hand_number);
 payload:=a.post_commit_payload;
 IF a.payload_hash IS NULL OR a.payload_hash !~ '^[0-9a-f]{64}$'
 OR jsonb_typeof(payload) IS DISTINCT FROM 'object' OR payload->>'version' IS DISTINCT FROM '1'
 OR jsonb_typeof(payload->'accepted_hand_facts') IS DISTINCT FROM 'object'
 OR encode(extensions.digest(convert_to(payload::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM a.post_commit_payload_hash THEN
 RAISE EXCEPTION 'F06_MOVEMENT_POSTCOMMIT_SEAL' USING ERRCODE='55000'; END IF;
 submitted:=payload-'accepted_hand_facts';
 IF jsonb_typeof(submitted->'pending_addons')='object' THEN
 IF jsonb_typeof(submitted#>'{pending_addons,ids}') IS DISTINCT FROM 'array' THEN
 RAISE EXCEPTION 'F06_MOVEMENT_POSTCOMMIT_SEAL' USING ERRCODE='55000'; END IF;
 submitted:=submitted#-'{pending_addons,ids}'; END IF;
 IF encode(extensions.digest(convert_to(submitted::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM a.post_commit_request_hash THEN
 RAISE EXCEPTION 'F06_MOVEMENT_POSTCOMMIT_SEAL' USING ERRCODE='55000'; END IF;
 s:=a.stack_result;
 IF s->'success' IS DISTINCT FROM 'true'::jsonb OR s->>'mode' IS DISTINCT FROM 'delta'
 OR s->>'table_id' IS DISTINCT FROM p_table::text OR s->>'tournament_id' IS DISTINCT FROM p_tournament::text
 OR (s->>'hand_number')::bigint IS DISTINCT FROM a.hand_number OR NULLIF(s->>'hand_id','') IS NULL
 OR s->'conservation_checked' IS DISTINCT FROM 'true'::jsonb OR s->'tournament_players_synced' IS DISTINCT FROM 'true'::jsonb
 OR s->'rebased' IS DISTINCT FROM '{}'::jsonb OR s->'departed' IS DISTINCT FROM '[]'::jsonb
 OR (s->>'net_deltas')::numeric IS DISTINCT FROM 0 OR (s->>'inflow')::numeric IS DISTINCT FROM 0
 OR (s->>'rake')::numeric IS DISTINCT FROM 0 OR (s->>'bbj')::numeric IS DISTINCT FROM 0
 OR jsonb_typeof(s#>'{request,stacks}') IS DISTINCT FROM 'array'
 OR jsonb_typeof(s->'written') IS DISTINCT FROM 'object'
 OR jsonb_typeof(s->'tournament_player_chips') IS DISTINCT FROM 'array' THEN
 RAISE EXCEPTION 'F06_MOVEMENT_STACK_RECEIPT' USING ERRCODE='55000'; END IF;
 n:=jsonb_array_length(s#>'{request,stacks}');
 IF n NOT BETWEEN 1 AND 10 OR (s->>'players')::integer IS DISTINCT FROM n
 OR (s->>'tournament_player_count')::integer IS DISTINCT FROM n
 OR jsonb_array_length(s->'tournament_player_chips')<>n
 OR (SELECT count(*) FROM jsonb_object_keys(s->'written'))<>n
 OR (SELECT count(DISTINCT v->>'user_id') FROM jsonb_array_elements(s#>'{request,stacks}') v)<>n
 OR (SELECT count(DISTINCT v->>'user_id') FROM jsonb_array_elements(s->'tournament_player_chips') v)<>n THEN
 RAISE EXCEPTION 'F06_MOVEMENT_STACK_RECEIPT' USING ERRCODE='55000'; END IF;
 FOR x IN SELECT value FROM jsonb_array_elements(s#>'{request,stacks}') ORDER BY value->>'user_id' LOOP
 IF x->>'stack' IS NULL OR x->>'stack' !~ '^[0-9]+([.][0-9]+)?$'
 OR (s->'written'->>(x->>'user_id'))::numeric IS DISTINCT FROM (x->>'stack')::numeric
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'tournament_player_chips') v
 WHERE v->>'user_id'=x->>'user_id' AND (v->>'chips')::numeric=(x->>'stack')::numeric) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_STACK_RECEIPT' USING ERRCODE='55000'; END IF;
 items:=items||jsonb_build_array(jsonb_build_object('hand',x));
 END LOOP;
 -- An open seat the last hand did not deal is an arrival. It is admitted only
 -- by a committed move receipt into exactly this seat occupancy (the receipt
 -- time is the seat's joined_at) and only while no committed hand on this
 -- table has dealt it since, so its chips are exactly the receipted stack.
 FOR seat IN SELECT st.* FROM public.table_seats st WHERE st.table_id=p_table AND st.left_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s#>'{request,stacks}') v WHERE v->>'user_id'=st.user_id::text)
 ORDER BY st.user_id,st.id FOR UPDATE LOOP
 SELECT m.* INTO movement FROM public.tournament_seat_move_receipts m WHERE m.tournament_id=p_tournament AND m.user_id=seat.user_id
 AND m.destination_table_id=p_table AND m.destination_seat_id=seat.id AND m.moved_at=seat.joined_at;
 IF NOT FOUND OR seat.user_id IS NULL OR seat.occupancy_id IS NULL OR movement.destination_seat_number IS DISTINCT FROM seat.seat_number
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits c WHERE c.table_id=p_table AND c.committed_at>=seat.joined_at
 AND c.stack_result#>'{request,stacks}' @> jsonb_build_array(jsonb_build_object('user_id',seat.user_id::text))) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED' USING ERRCODE='55000'; END IF;
 items:=items||jsonb_build_array(jsonb_build_object('arrival',to_jsonb(movement)));
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(items) LOOP
 x:=item->'hand'; winner:=NULL; member:=NULL; movement:=NULL;
 IF x IS NOT NULL THEN
 held:=(x->>'stack')::numeric; since:=a.committed_at; lim:='infinity';
 ELSE
 movement:=jsonb_populate_record(NULL::public.tournament_seat_move_receipts,item->'arrival');
 x:=jsonb_build_object('user_id',movement.user_id::text);
 held:=movement.stack; since:=movement.moved_at; lim:='infinity';
 END IF;
 IF o.state='begun' THEN
 SELECT * INTO member FROM smarter_private.f06_members WHERE break_id=o.break_id AND user_id=(x->>'user_id')::uuid;
 IF item ? 'hand' THEN
 SELECT d.receipt INTO winner FROM smarter_private.f06_attempts d WHERE d.break_id=o.break_id AND d.user_id=(x->>'user_id')::uuid AND d.state='winner';
 IF winner IS NOT NULL THEN
 SELECT * INTO movement FROM public.tournament_seat_move_receipts WHERE request_id=(winner->>'request_id')::uuid;
 lim:=COALESCE(movement.moved_at,'-infinity'::timestamptz); END IF;
 END IF;
 END IF;
 -- A committed chip purchase after the proven stack is chip evidence: its
 -- funding receipt (or, before those existed, the add-on's single wallet
 -- key and its posted ledger leg) carries the exact grant, and a receipt's
 -- registration image must show the running stack. Anything else refuses.
 rebought:=NULL; bought:=0;
 FOR p IN SELECT q.* FROM (
 SELECT f.operation op,f.observed_at at,f.purchase_key k,f.tournament_snapshot ts,(f.registration_snapshot->>'chips')::numeric snap
 FROM public.tournament_participant_funding_receipts f
 WHERE f.tournament_id=p_tournament AND f.user_id=(x->>'user_id')::uuid AND f.observed_at>since AND f.observed_at<lim
 UNION ALL
 SELECT 'addon',l.created_at,k.key,to_jsonb(t),NULL::numeric
 FROM public.chip_ledger l
 JOIN public.wallet_credit_idempotency k ON k.key='tourney:'||p_tournament::text||':addon:'||(x->>'user_id')
 AND k.created_at=l.created_at AND k.user_id=l.from_entity_id AND k.amount=l.amount
 JOIN public.tournaments t ON t.id=p_tournament
 WHERE l.from_entity_id=(x->>'user_id')::uuid AND l.tournament_id=p_tournament AND l.category='addon'
 AND l.from_type='player_wallet' AND l.to_type='prize_liability' AND l.status='posted'
 AND l.created_at>since AND l.created_at<lim
 AND NOT EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts f WHERE f.tournament_id=p_tournament AND (f.ledger_id=l.id OR f.purchase_key=k.key))
 ) q ORDER BY q.at,q.k LOOP
 gained:=(CASE WHEN p.op='addon' THEN COALESCE(NULLIF((p.ts->>'addon_chips')::numeric,0),(p.ts->>'starting_chips')::numeric,0)
 WHEN p.op IN ('rebuy','reentry') THEN COALESCE(NULLIF((p.ts->>'rebuy_chips')::numeric,0),(p.ts->>'starting_chips')::numeric,0) END)::integer;
 IF gained IS NULL OR gained<=0 OR (p.op='reentry' AND held<>0) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_SEAT_CHANGED' USING ERRCODE='55000'; END IF;
 bought:=bought+1; IF bought=1 AND p.op IN ('rebuy','reentry') THEN rebought:=p.at; END IF;
 held:=CASE WHEN p.op='reentry' THEN gained ELSE held+gained END;
 IF p.snap IS NOT NULL AND p.snap IS DISTINCT FROM held THEN RAISE EXCEPTION 'F06_MOVEMENT_SEAT_CHANGED' USING ERRCODE='55000'; END IF;
 purchases:=purchases||jsonb_build_array(jsonb_build_object('user_id',x->>'user_id','operation',p.op,'purchase_key',p.k,'at',p.at,'chips',gained,'stack',held));
 END LOOP;
 IF winner IS NOT NULL THEN
 -- Already moved by this break: the winner receipt is the chip evidence.
 IF member.user_id IS NULL OR movement.request_id IS NULL OR held<=0
 OR winner-'source_occupancy_id'-'source_lifecycle'-'break_id' IS DISTINCT FROM to_jsonb(movement)
 OR (winner->>'source_table_id')::uuid IS DISTINCT FROM p_table OR movement.source_table_id IS DISTINCT FROM p_table
 OR (winner->>'source_seat_id')::uuid IS DISTINCT FROM (x->>'seat_id')::uuid OR member.source_seat_id IS DISTINCT FROM (x->>'seat_id')::uuid
 OR (winner->>'source_occupancy_id')::uuid IS DISTINCT FROM member.occupancy_id
 OR (winner->>'source_lifecycle')::bigint IS DISTINCT FROM o.lifecycle OR (winner->>'break_id')::uuid IS DISTINCT FROM o.break_id
 OR movement.tournament_id IS DISTINCT FROM p_tournament OR movement.user_id IS DISTINCT FROM member.user_id
 OR movement.moved_at<=a.committed_at OR movement.stack IS DISTINCT FROM held
 OR EXISTS(SELECT 1 FROM public.table_seats WHERE id=member.source_seat_id AND left_at IS NULL AND occupancy_id=member.occupancy_id) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_ORIGINAL_PROOF_MISSING' USING ERRCODE='55000'; END IF;
 positive:=positive+1; users:=users||member.user_id;
 roster:=roster||jsonb_build_array(jsonb_build_object('seat',jsonb_build_object('id',member.source_seat_id,'table_id',p_table,
 'user_id',member.user_id,'seat_number',member.source_seat_number,'occupancy_id',member.occupancy_id,'stack',movement.stack)));
 moved:=moved||jsonb_build_array(to_jsonb(movement));
 CONTINUE;
 END IF;
 IF item ? 'hand' THEN
 SELECT * INTO seat FROM public.table_seats WHERE id=(x->>'seat_id')::uuid AND table_id=p_table
 AND user_id=(x->>'user_id')::uuid AND (joined_at=(x->>'seat_joined_at')::timestamptz
 -- Busted in this hand and bought back in: the same seat, re-occupied no
 -- earlier than the first purchase, holds only the receipted chips.
 OR ((x->>'stack')::numeric=0 AND held>0 AND left_at IS NULL AND joined_at>=rebought)) FOR UPDATE;
 ELSE
 SELECT * INTO seat FROM public.table_seats WHERE id=movement.destination_seat_id AND table_id=p_table
 AND user_id=movement.user_id AND joined_at=movement.moved_at AND left_at IS NULL FOR UPDATE;
 END IF;
 -- Busted in the proven hand, and the same chair row since taken by a
 -- receipted arrival (the arrival loop above admitted it): the busted
 -- player's seat image is gone, so the bust is proven by its registration
 -- (eliminated, 0 chips, this table, recorded no later than the arrival
 -- sat) and by the arrival's move receipt into exactly this chair. Such a
 -- player holds no chip and no chair, so it is neither roster nor seat.
 IF NOT FOUND AND item ? 'hand' AND (x->>'stack')::numeric=0 AND bought=0 THEN
 arrival:=NULL;
 SELECT m.* INTO arrival FROM public.table_seats st JOIN public.tournament_seat_move_receipts m
 ON m.destination_seat_id=st.id AND m.user_id=st.user_id AND m.moved_at=st.joined_at
 WHERE st.id=(x->>'seat_id')::uuid AND st.table_id=p_table AND st.left_at IS NULL AND st.occupancy_id IS NOT NULL
 AND st.user_id IS DISTINCT FROM (x->>'user_id')::uuid AND st.joined_at>a.committed_at
 AND m.tournament_id=p_tournament AND m.destination_table_id=p_table AND m.destination_seat_number=st.seat_number;
 SELECT * INTO registration FROM public.tournament_players WHERE tournament_id=p_tournament AND user_id=(x->>'user_id')::uuid FOR UPDATE;
 IF arrival.request_id IS NOT NULL AND registration.user_id IS NOT NULL
 AND registration.status='eliminated' AND registration.eliminated_at IS NOT NULL
 AND registration.eliminated_at>=a.committed_at AND registration.eliminated_at<=arrival.moved_at
 AND registration.chips::numeric=0 AND registration.table_id IS NOT DISTINCT FROM p_table
 AND NOT EXISTS(SELECT 1 FROM public.table_seats st JOIN public.tables t ON t.id=st.table_id
 WHERE t.tournament_id=p_tournament AND st.user_id=registration.user_id AND st.left_at IS NULL) THEN
 reoccupied:=reoccupied||jsonb_build_array(jsonb_build_object('accepted',x,'registration',to_jsonb(registration),'arrival',to_jsonb(arrival)));
 CONTINUE;
 END IF;
 RAISE EXCEPTION 'F06_MOVEMENT_SEAT_CHANGED' USING ERRCODE='55000';
 END IF;
 IF NOT FOUND OR seat.stack IS DISTINCT FROM held OR seat.occupancy_id IS NULL THEN
 RAISE EXCEPTION 'F06_MOVEMENT_SEAT_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT * INTO registration FROM public.tournament_players WHERE tournament_id=p_tournament AND user_id=seat.user_id FOR UPDATE;
 IF NOT FOUND OR registration.chips::numeric IS DISTINCT FROM seat.stack THEN
 RAISE EXCEPTION 'F06_MOVEMENT_REGISTRATION_CHANGED' USING ERRCODE='55000'; END IF;
 IF seat.stack=0 THEN
 IF seat.left_at IS NULL OR registration.status<>'eliminated' OR registration.eliminated_at IS NULL THEN
 RAISE EXCEPTION 'F06_MOVEMENT_ELIMINATION_UNPROVEN' USING ERRCODE='55000'; END IF;
 eliminated:=eliminated||jsonb_build_array(jsonb_build_object('seat',to_jsonb(seat),'registration',to_jsonb(registration),'accepted',x));
 ELSE
 IF seat.left_at IS NOT NULL OR registration.status<>'playing' OR registration.eliminated_at IS NOT NULL
 OR (registration.table_id,registration.seat_number) IS DISTINCT FROM(seat.table_id,seat.seat_number) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;
 IF o.state='begun' AND (member.user_id IS NULL OR (member.source_seat_id,member.occupancy_id) IS DISTINCT FROM (seat.id,seat.occupancy_id)) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_ORIGINAL_PROOF_MISSING' USING ERRCODE='55000'; END IF;
 positive:=positive+1; remaining:=remaining+1; users:=users||seat.user_id;
 IF item ? 'arrival' THEN arrivals:=arrivals||jsonb_build_array(item->'arrival'); END IF;
 roster:=roster||jsonb_build_array(jsonb_build_object('seat',to_jsonb(seat),'registration',to_jsonb(registration)));
 END IF;
 END LOOP;
 IF positive=0 OR (SELECT count(*) FROM public.table_seats WHERE table_id=p_table AND left_at IS NULL)<>remaining
 OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=p_tournament AND table_id=p_table AND status IN ('playing','registered'))<>remaining THEN
 RAISE EXCEPTION 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED' USING ERRCODE='55000'; END IF;
 IF o.state='begun' AND ((SELECT count(*) FROM smarter_private.f06_members WHERE break_id=o.break_id)<>positive
 OR EXISTS(SELECT 1 FROM smarter_private.f06_members m WHERE m.break_id=o.break_id AND m.user_id<>ALL(users))) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_ORIGINAL_PROOF_MISSING' USING ERRCODE='55000'; END IF;
 -- A proof that needed no receipt is byte-identical to the one this function
 -- always took, so an expectation captured before this migration still holds.
 RETURN jsonb_build_object('atomic',to_jsonb(a),'history',to_jsonb(h),'roster',roster,'eliminated',eliminated,'permits',permits)
 ||CASE WHEN o.state='park_requested' AND purchases='[]'::jsonb AND arrivals='[]'::jsonb THEN '{}'::jsonb
 ELSE jsonb_build_object('receipts',jsonb_build_object('break_id',o.break_id,'state',o.state,'purchases',purchases,'arrivals',arrivals,'moved',moved)
 ||CASE WHEN reoccupied='[]'::jsonb THEN '{}'::jsonb ELSE jsonb_build_object('reoccupied',reoccupied) END) END;
END $never_dealt_prior$;

REVOKE ALL ON FUNCTION smarter_private.f06_movement_prior(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;

DO $never_dealt_postimage$
DECLARE body text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'smarter_private.f06_movement_never_dealt_prior(uuid,uuid,uuid)'::regprocedure
       AND md5(p.prosrc) = 'c0da72045d9c661631484a4d7c9dc922'
       AND md5(pg_get_functiondef(p.oid)) = '433debf7038257e4c8f0e3dfb9bb4a7d'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig = ARRAY['search_path=pg_catalog, public, smarter_private']
       AND p.prosecdef AND p.provolatile = 'v') THEN
    RAISE EXCEPTION 'F06_NEVER_DEALT_POSTIMAGE_DRIFT: smarter_private.f06_movement_never_dealt_prior(uuid,uuid,uuid)';
  END IF;
  SELECT p.prosrc INTO body FROM pg_proc p
   WHERE p.oid = 'smarter_private.f06_movement_prior(uuid,uuid)'::regprocedure
     AND md5(p.prosrc) = '493026caf75bb03a336db56bac008009'
     AND md5(pg_get_functiondef(p.oid)) = '847ab696563b25d097636b078a54982e'
     AND pg_get_userbyid(p.proowner) = 'postgres'
     AND p.proacl::text = '{postgres=X/postgres}'
     AND p.proconfig = ARRAY['search_path=pg_catalog, public, smarter_private']
     AND p.prosecdef AND p.provolatile = 'v';
  IF body IS NULL THEN
    RAISE EXCEPTION 'F06_NEVER_DEALT_POSTIMAGE_DRIFT: smarter_private.f06_movement_prior(uuid,uuid)';
  END IF;
  -- Only the stated passage changed: removing it reproduces the pre-image.
  IF md5(replace(body, $r$ -- A park of a table that never dealt has no sealed hand to prove from. Its
 -- boundary is its seated entries (f06_movement_never_dealt_prior), and
 -- anything that is not exactly that still refuses there.
 IF o.state='park_requested' AND NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=p_table) THEN
 RETURN smarter_private.f06_movement_never_dealt_prior(p_tournament,p_table,o.break_id); END IF;
$r$, '')) <> '17cd448464cd6e297dc8927890d1a8ff' THEN
    RAISE EXCEPTION 'F06_NEVER_DEALT_POSTIMAGE_DRIFT: more than the stated passage of f06_movement_prior changed';
  END IF;
END
$never_dealt_postimage$;

DO $never_dealt_assert_preimage$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('smarter_private.f06_assert_movement(uuid)')
       AND md5(p.prosrc) = 'bbab37373518b7dcc520ae2bf3e5d1b5'
       AND md5(pg_get_functiondef(p.oid)) = 'ad99e13122447e117d9769d28019cb7f'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig = ARRAY['search_path=pg_catalog, public, smarter_private']
       AND p.prosecdef AND p.provolatile = 'v'
       AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')) THEN
    RAISE EXCEPTION 'F06_NEVER_DEALT_ASSERT_PREIMAGE_DRIFT: smarter_private.f06_assert_movement(uuid)';
  END IF;
END
$never_dealt_assert_preimage$;

CREATE OR REPLACE FUNCTION smarter_private.f06_assert_movement(p_break uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $movement_proof$
DECLARE a smarter_private.f06_movement_admissions; o smarter_private.f06_operations;
 r jsonb; actual jsonb; winner jsonb; movement public.tournament_seat_move_receipts; remaining integer:=0; mixed_generation uuid;
 g uuid:=NULLIF(current_setting('app.smarter_tournament_lease_generation',true),'')::uuid;
BEGIN
 mixed_generation:=smarter_private.f06_mixed_movement_generation(p_break);
 IF NOT EXISTS(SELECT 1 FROM smarter_private.f06_movement_admissions WHERE break_id=p_break) THEN RETURN; END IF;
 SELECT * INTO o FROM smarter_private.f06_operations WHERE break_id=p_break;
 SELECT * INTO a FROM smarter_private.f06_movement_admissions WHERE break_id=p_break AND custody_id=o.custody_id;
 IF NOT FOUND OR o.custody_generation IS DISTINCT FROM a.lease_generation OR o.revision IS DISTINCT FROM a.revision
 OR o.lifecycle IS DISTINCT FROM a.lifecycle OR o.source_table_id IS DISTINCT FROM a.table_id
 OR o.tournament_id IS DISTINCT FROM a.tournament_id OR (g IS DISTINCT FROM a.lease_generation AND g IS DISTINCT FROM mixed_generation)
 OR o.state NOT IN ('park_requested','begun','close_confirmed') THEN
 RAISE EXCEPTION 'F06_MOVEMENT_CUSTODY_CHANGED' USING ERRCODE='55000'; END IF;
 PERFORM smarter_private.f06_authority(a.tournament_id,COALESCE(mixed_generation,a.lease_generation),false);
 -- A never-dealt park's proof (f06_movement_never_dealt_prior) names no hand:
 -- its boundary holds while nothing of any hand exists on the table.
 IF a.proof->'first_hand'='true'::jsonb THEN
 IF a.proof->'atomic' IS DISTINCT FROM 'null'::jsonb OR a.proof->'history' IS DISTINCT FROM 'null'::jsonb
 OR a.proof->'permits' IS DISTINCT FROM '[]'::jsonb
 OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=a.table_id AND tournament_id=a.tournament_id AND f06_lifecycle=a.lifecycle)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=a.table_id)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=a.table_id)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=a.table_id)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=a.table_id)
 OR EXISTS(SELECT 1 FROM public.table_hole_cards WHERE table_id=a.table_id)
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=a.table_id) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_BOUNDARY_CHANGED' USING ERRCODE='55000'; END IF;
 ELSE
 IF NOT EXISTS(SELECT 1 FROM public.tables WHERE id=a.table_id AND tournament_id=a.tournament_id AND f06_lifecycle=a.lifecycle)
 OR smarter_private.f06_movement_permits(a.tournament_id,a.table_id,(a.proof#>>'{atomic,hand_number}')::bigint) IS DISTINCT FROM a.proof->'permits'
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=a.table_id AND NOT is_complete)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=a.table_id AND hand_number>(a.proof#>>'{atomic,hand_number}')::bigint)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=a.table_id AND hand_number>(a.proof#>>'{atomic,hand_number}')::bigint)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=a.table_id AND (hand_number>(a.proof#>>'{atomic,hand_number}')::bigint OR committed_at>(a.proof#>>'{atomic,committed_at}')::timestamptz))
 OR NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits x WHERE hand_id=(a.proof#>>'{atomic,hand_id}')::uuid AND (SELECT jsonb_object_agg(c.key,c.value) FROM jsonb_each(to_jsonb(x)) c WHERE a.proof->'atomic' ? c.key OR c.value<>'null'::jsonb)=a.proof->'atomic')
 OR NOT EXISTS(SELECT 1 FROM public.hand_history x WHERE id=(a.proof#>>'{history,id}')::uuid AND (SELECT jsonb_object_agg(c.key,c.value) FROM jsonb_each(to_jsonb(x)) c WHERE a.proof->'history' ? c.key OR c.value<>'null'::jsonb)=a.proof->'history') THEN
 RAISE EXCEPTION 'F06_MOVEMENT_BOUNDARY_CHANGED' USING ERRCODE='55000'; END IF;
 END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(a.proof->'roster') LOOP
 SELECT d.receipt INTO winner FROM smarter_private.f06_attempts d JOIN public.tournament_seat_move_receipts m ON m.request_id=d.request_id
 WHERE d.break_id=p_break AND d.user_id=(r#>>'{seat,user_id}')::uuid AND d.state='winner';
 IF FOUND THEN
 SELECT * INTO movement FROM public.tournament_seat_move_receipts WHERE request_id=(winner->>'request_id')::uuid;
 IF NOT FOUND OR winner-'source_occupancy_id'-'source_lifecycle'-'break_id' IS DISTINCT FROM to_jsonb(movement)
 OR (winner->>'source_table_id')::uuid IS DISTINCT FROM a.table_id OR (winner->>'source_seat_id')::uuid IS DISTINCT FROM (r#>>'{seat,id}')::uuid
 OR (winner->>'source_occupancy_id')::uuid IS DISTINCT FROM (r#>>'{seat,occupancy_id}')::uuid
 OR (winner->>'stack')::numeric IS DISTINCT FROM (r#>>'{seat,stack}')::numeric OR (winner->>'break_id')::uuid IS DISTINCT FROM p_break
 OR (winner->>'source_lifecycle')::bigint IS DISTINCT FROM a.lifecycle THEN
 RAISE EXCEPTION 'F06_MOVEMENT_WINNER_CHANGED' USING ERRCODE='55000'; END IF;
 ELSE
 remaining:=remaining+1;
 SELECT jsonb_build_object('seat',to_jsonb(s),'registration',to_jsonb(p)) INTO actual
 FROM public.table_seats s JOIN public.tournament_players p ON p.tournament_id=a.tournament_id AND p.user_id=s.user_id
 WHERE s.id=(r#>>'{seat,id}')::uuid AND s.table_id=a.table_id AND s.left_at IS NULL;
 IF jsonb_set(actual,'{registration}',(actual->'registration')-'{current_bounty,bounty_winnings,bounties_collected,mystery_bounty_value}'::text[]) IS DISTINCT FROM jsonb_set(r,'{registration}',(r->'registration')-'{current_bounty,bounty_winnings,bounties_collected,mystery_bounty_value}'::text[]) THEN RAISE EXCEPTION 'F06_MOVEMENT_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;
 END IF;
 END LOOP;
 FOR r IN SELECT value FROM jsonb_array_elements(a.proof->'eliminated') LOOP
 SELECT jsonb_build_object('seat',to_jsonb(s),'registration',to_jsonb(p),'accepted',r->'accepted') INTO actual
 FROM public.table_seats s JOIN public.tournament_players p ON p.tournament_id=a.tournament_id AND p.user_id=s.user_id
 WHERE s.id=(r#>>'{seat,id}')::uuid AND s.table_id=a.table_id;
 IF jsonb_set(actual,'{registration}',(actual->'registration')-'{current_bounty,bounty_winnings,bounties_collected,mystery_bounty_value}'::text[]) IS DISTINCT FROM jsonb_set(r,'{registration}',(r->'registration')-'{current_bounty,bounty_winnings,bounties_collected,mystery_bounty_value}'::text[]) THEN RAISE EXCEPTION 'F06_MOVEMENT_ELIMINATION_CHANGED' USING ERRCODE='55000'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM public.table_seats WHERE table_id=a.table_id AND left_at IS NULL)<>remaining
 OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=a.tournament_id AND table_id=a.table_id AND status IN ('playing','registered'))<>remaining THEN
 RAISE EXCEPTION 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED' USING ERRCODE='55000'; END IF;
END $movement_proof$;

REVOKE ALL ON FUNCTION smarter_private.f06_assert_movement(uuid) FROM PUBLIC, anon, authenticated, service_role;

DO $never_dealt_assert_postimage$
DECLARE body text;
BEGIN
  SELECT p.prosrc INTO body FROM pg_proc p
   WHERE p.oid = 'smarter_private.f06_assert_movement(uuid)'::regprocedure
     AND md5(p.prosrc) = 'df656e0490a6a8f570f409916fc2f643'
     AND md5(pg_get_functiondef(p.oid)) = '6fd0cf3d598211408d165117fd8c32fe'
     AND pg_get_userbyid(p.proowner) = 'postgres'
     AND p.proacl::text = '{postgres=X/postgres}'
     AND p.proconfig = ARRAY['search_path=pg_catalog, public, smarter_private']
     AND p.prosecdef AND p.provolatile = 'v';
  IF body IS NULL THEN
    RAISE EXCEPTION 'F06_NEVER_DEALT_ASSERT_POSTIMAGE_DRIFT: smarter_private.f06_assert_movement(uuid)';
  END IF;
  -- Only the two stated passages changed: removing them reproduces the
  -- pre-image (the old boundary statement, byte for byte, is the ELSE).
  IF md5(replace(replace(body, $r$ -- A never-dealt park's proof (f06_movement_never_dealt_prior) names no hand:
 -- its boundary holds while nothing of any hand exists on the table.
 IF a.proof->'first_hand'='true'::jsonb THEN
 IF a.proof->'atomic' IS DISTINCT FROM 'null'::jsonb OR a.proof->'history' IS DISTINCT FROM 'null'::jsonb
 OR a.proof->'permits' IS DISTINCT FROM '[]'::jsonb
 OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=a.table_id AND tournament_id=a.tournament_id AND f06_lifecycle=a.lifecycle)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=a.table_id)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=a.table_id)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=a.table_id)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=a.table_id)
 OR EXISTS(SELECT 1 FROM public.table_hole_cards WHERE table_id=a.table_id)
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=a.table_id) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_BOUNDARY_CHANGED' USING ERRCODE='55000'; END IF;
 ELSE
$r$, ''), $r$a.proof->'history') THEN
 RAISE EXCEPTION 'F06_MOVEMENT_BOUNDARY_CHANGED' USING ERRCODE='55000'; END IF;
 END IF;
$r$, $r$a.proof->'history') THEN
 RAISE EXCEPTION 'F06_MOVEMENT_BOUNDARY_CHANGED' USING ERRCODE='55000'; END IF;
$r$)) <> 'bbab37373518b7dcc520ae2bf3e5d1b5' THEN
    RAISE EXCEPTION 'F06_NEVER_DEALT_ASSERT_POSTIMAGE_DRIFT: more than the stated passages of f06_assert_movement changed';
  END IF;
END
$never_dealt_assert_postimage$;

COMMIT;
