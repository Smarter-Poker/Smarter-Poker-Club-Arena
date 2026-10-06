-- 20261003163015_a_busted_chair_taken_by_a_late_entry_is_movement_evidence.sql
--
-- Version reserved by scripts/reserve-migration-version.sh against origin/main
-- and every remote branch. This file changes ONE reader,
-- smarter_private.f06_movement_prior. It schedules nothing, retries nothing,
-- writes no row and moves no chip.
--
-- ===========================================================================
-- WHAT WAS WRONG, READ FROM ROWS AND LOG LINES (2026-10-03)
--
-- 64c9e949 "Morning Free Buy (NLH)" (10 playing, two tables left): table
-- 77b326dc (Table 9) holds 9 players and has dealt nothing since its sealed
-- hand 21599187 (committed 13:50:08.95 UTC). Its park b3677b93
-- (park_requested 14:01:51) cannot take its movement admission; every engine
-- re-admits the table every ~15 s and is refused every time, across the
-- 14:55 and 15:55 restarts (MttPlayStopped from 16:18 once #5924 counted
-- failing-admission tables):
--
--   [Tournament.table_engine_readmission_failed] f06_movement_admission_unproven
--     [55000]: F06_MOVEMENT_SEAT_CHANGED
--
-- The rows: hand 21599187 busted 8b3b6f26 from seat 5 (seat row 439e206f;
-- registration eliminated at 13:50:08.954114 = the commit, 0 chips, this
-- table). Thirty-nine seconds later 47965354 LATE-REGISTERED and the event
-- seated it straight into that same chair row (joined_at = registered_at =
-- 13:50:47.889284); its entry funding receipt 3c3cd07d (13:50:51.71) carries
-- a registration image playing on 77b326dc seat 5 with 3,000 chips = the
-- starting stack, and its add-on receipt (13:51:26) the 13,000 now in the
-- seat.
--
-- 20261002134551 already admits 47965354 itself as an ENTRY. But the busted
-- player's hand item then finds its chair row taken by somebody else, and the
-- reoccupied-chair branch (20260928165716) accepts that only when the chair
-- was taken by a MOVE receipt. A late entry is never moved, so the proof
-- refuses F06_MOVEMENT_SEAT_CHANGED for as long as the table lives: nine
-- players frozen while the last opponent waits alone on the other table.
--
-- ===========================================================================
-- WHAT THIS CHANGES
--
-- One branch. A player busted in the proven hand whose chair row has since
-- been taken is accepted when the taker is EITHER (as before) a committed
-- move receipt into exactly that chair, OR the late entry the arrival loop
-- has already admitted on its own funding receipt into exactly that chair row
-- (same seat id, same user, same joined_at, still open, sat after the proven
-- hand). Every other condition is unchanged: the busted registration is
-- eliminated, 0 chips, on this table, eliminated no earlier than the proven
-- hand and no later than the taker sat, and holds no open chair anywhere in
-- the event. The proof records the taker as 'entry' instead of 'arrival' in
-- receipts.reoccupied. A proof that does not need this is byte-identical to
-- before (jsonb object keys are normalised, so the rebuilt arrival object is
-- the same value).
--
-- Same signature, owner (postgres), ACL {postgres=X/postgres}, SECURITY
-- DEFINER, volatility and search_path. Restoring the two changed passages
-- reproduces the pre-image body digest exactly (asserted below).
--
-- PROVED FIRST (CLAUDE.md 11.5): the pre- and post-image bodies, installed as
-- pg_temp functions (row locks stripped) in a psql transaction switched READ
-- ONLY before either ran and ended in ROLLBACK (2026-10-03 ~16:35 UTC), on
-- 64c9e949 / 77b326dc:
--   pre-image : F06_MOVEMENT_SEAT_CHANGED
--   post-image: roster 9, eliminated 0, receipts.entries = 47965354 via
--               funding receipt 3c3cd07d, receipts.reoccupied = 8b3b6f26's
--               chair taken by that entry, purchases = the two add-ons
--               (00000000-...0029 to 15,847; 47965354 to 13,000).
--
-- NOT TOUCHED: fn_f06_admit_parked_movement, f06_assert_movement,
-- f06_movement_never_dealt_prior.
--
-- Pinned by tests/a-busted-chair-taken-by-a-late-entry-is-movement-evidence.law.test.ts.

-- @live-proof: (SELECT md5(prosrc)='862440fc437b25c7c10b96f9ed603283' AND md5(pg_get_functiondef(oid))='458a9e5135824e03d4188e43bc7c9c84' AND proacl::text='{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_movement_prior(uuid,uuid)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

DO $busted_entry_preimage$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('smarter_private.f06_movement_prior(uuid,uuid)')
       AND md5(p.prosrc) = 'c63825076c08ec077a480a57cc8ae79a'
       AND md5(pg_get_functiondef(p.oid)) = 'c2d61153a39a8ccac8f923205124daa7'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig = ARRAY['search_path=pg_catalog, public, smarter_private']
       AND p.prosecdef AND p.provolatile = 'v'
       AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')) THEN
    RAISE EXCEPTION 'F06_MOVEMENT_BUSTED_ENTRY_PREIMAGE_DRIFT: smarter_private.f06_movement_prior(uuid,uuid)';
  END IF;
END
$busted_entry_preimage$;

CREATE OR REPLACE FUNCTION smarter_private.f06_movement_prior(p_tournament uuid, p_table uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $busted_entry_prior$
DECLARE a public.hand_atomic_commits; h public.hand_history; s jsonb; payload jsonb; submitted jsonb;
 x jsonb; seat public.table_seats; registration public.tournament_players;
 roster jsonb:='[]'; eliminated jsonb:='[]'; permits jsonb; n integer; positive integer:=0;
 o smarter_private.f06_operations; ops integer; member smarter_private.f06_members; winner jsonb;
 movement public.tournament_seat_move_receipts; item jsonb; items jsonb:='[]'; p record;
 gained numeric; held numeric; rebought timestamptz; bought integer; since timestamptz; lim timestamptz; remaining integer:=0; users uuid[]:='{}';
 purchases jsonb:='[]'; arrivals jsonb:='[]'; moved jsonb:='[]';
 reoccupied jsonb:='[]'; arrival public.tournament_seat_move_receipts;
 -- A late entry seated after the proven hand was dealt (2026-10-02).
 fund public.tournament_participant_funding_receipts; entries jsonb:='[]';
 -- A busted chair taken by a late entry after the proven hand (2026-10-03).
 taken jsonb;
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
 -- No move receipt: a late entry (or re-entry) the event seated straight
 -- into this chair while, or after, the proven hand was dealt. It is
 -- admitted only by its own funding receipt: the player's latest entry,
 -- recorded no earlier than the chair was taken, whose registration image
 -- is playing on exactly this table and seat number with exactly the chips
 -- the entry grants; no move of the player since it sat; and no committed
 -- hand on this table has dealt it since. Its chips are that grant plus
 -- any receipted purchase after it (the purchase loop below).
 IF NOT FOUND THEN
 fund:=NULL;
 SELECT f.* INTO fund FROM public.tournament_participant_funding_receipts f
 WHERE f.tournament_id=p_tournament AND f.user_id=seat.user_id AND f.operation IN ('entry','reentry')
 ORDER BY f.observed_at DESC,f.id DESC LIMIT 1;
 IF fund.id IS NULL OR seat.user_id IS NULL OR seat.occupancy_id IS NULL OR seat.joined_at IS NULL
 OR fund.observed_at<seat.joined_at
 OR fund.registration_snapshot->>'table_id' IS DISTINCT FROM p_table::text
 OR fund.registration_snapshot->>'seat_number' IS DISTINCT FROM seat.seat_number::text
 OR fund.registration_snapshot->>'status' IS DISTINCT FROM 'playing'
 OR fund.registration_snapshot->>'eliminated_at' IS NOT NULL
 OR jsonb_typeof(fund.registration_snapshot->'chips') IS DISTINCT FROM 'number'
 OR (fund.registration_snapshot->>'chips')::numeric<=0
 OR (fund.registration_snapshot->>'chips')::numeric IS DISTINCT FROM (CASE WHEN fund.operation='entry' THEN (fund.tournament_snapshot->>'starting_chips')::numeric
 ELSE COALESCE(NULLIF((fund.tournament_snapshot->>'rebuy_chips')::numeric,0),(fund.tournament_snapshot->>'starting_chips')::numeric) END)
 OR EXISTS(SELECT 1 FROM public.tournament_seat_move_receipts m WHERE m.tournament_id=p_tournament AND m.user_id=seat.user_id AND m.moved_at>=seat.joined_at)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits c WHERE c.table_id=p_table AND c.committed_at>=seat.joined_at
 AND c.stack_result#>'{request,stacks}' @> jsonb_build_array(jsonb_build_object('user_id',seat.user_id::text))) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED' USING ERRCODE='55000'; END IF;
 items:=items||jsonb_build_array(jsonb_build_object('entry',jsonb_build_object('receipt_id',fund.id,'registration_id',fund.registration_id,
 'user_id',fund.user_id,'operation',fund.operation,'observed_at',fund.observed_at,'chips',fund.registration_snapshot->'chips',
 'seat_id',seat.id,'seat_number',seat.seat_number,'joined_at',seat.joined_at)));
 CONTINUE;
 END IF;
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
 ELSIF item ? 'entry' THEN
 x:=jsonb_build_object('user_id',item#>>'{entry,user_id}');
 held:=(item#>>'{entry,chips}')::numeric; since:=(item#>>'{entry,observed_at}')::timestamptz; lim:='infinity';
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
 ELSIF item ? 'entry' THEN
 SELECT * INTO seat FROM public.table_seats WHERE id=(item#>>'{entry,seat_id}')::uuid AND table_id=p_table
 AND user_id=(x->>'user_id')::uuid AND joined_at=(item#>>'{entry,joined_at}')::timestamptz AND left_at IS NULL FOR UPDATE;
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
 arrival:=NULL; taken:=NULL;
 SELECT m.* INTO arrival FROM public.table_seats st JOIN public.tournament_seat_move_receipts m
 ON m.destination_seat_id=st.id AND m.user_id=st.user_id AND m.moved_at=st.joined_at
 WHERE st.id=(x->>'seat_id')::uuid AND st.table_id=p_table AND st.left_at IS NULL AND st.occupancy_id IS NOT NULL
 AND st.user_id IS DISTINCT FROM (x->>'user_id')::uuid AND st.joined_at>a.committed_at
 AND m.tournament_id=p_tournament AND m.destination_table_id=p_table AND m.destination_seat_number=st.seat_number;
 -- Or the chair was taken by a late entry the arrival loop above already
 -- admitted on its own funding receipt: exactly this chair row, occupied
 -- by that entry since it sat, after the proven hand.
 IF arrival.request_id IS NULL THEN
 SELECT e.value->'entry' INTO taken FROM jsonb_array_elements(items) e JOIN public.table_seats st ON st.id=(e.value#>>'{entry,seat_id}')::uuid
 WHERE e.value ? 'entry' AND st.id=(x->>'seat_id')::uuid AND st.table_id=p_table AND st.left_at IS NULL AND st.occupancy_id IS NOT NULL
 AND st.user_id=(e.value#>>'{entry,user_id}')::uuid AND st.user_id IS DISTINCT FROM (x->>'user_id')::uuid
 AND st.joined_at=(e.value#>>'{entry,joined_at}')::timestamptz AND st.joined_at>a.committed_at;
 END IF;
 SELECT * INTO registration FROM public.tournament_players WHERE tournament_id=p_tournament AND user_id=(x->>'user_id')::uuid FOR UPDATE;
 IF (arrival.request_id IS NOT NULL OR taken IS NOT NULL) AND registration.user_id IS NOT NULL
 AND registration.status='eliminated' AND registration.eliminated_at IS NOT NULL
 AND registration.eliminated_at>=a.committed_at AND registration.eliminated_at<=COALESCE(arrival.moved_at,(taken->>'joined_at')::timestamptz)
 AND registration.chips::numeric=0 AND registration.table_id IS NOT DISTINCT FROM p_table
 AND NOT EXISTS(SELECT 1 FROM public.table_seats st JOIN public.tables t ON t.id=st.table_id
 WHERE t.tournament_id=p_tournament AND st.user_id=registration.user_id AND st.left_at IS NULL) THEN
 reoccupied:=reoccupied||jsonb_build_array(jsonb_build_object('accepted',x,'registration',to_jsonb(registration))
 ||CASE WHEN taken IS NULL THEN jsonb_build_object('arrival',to_jsonb(arrival)) ELSE jsonb_build_object('entry',taken) END);
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
 IF item ? 'entry' THEN entries:=entries||jsonb_build_array(item->'entry'); END IF;
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
 ||CASE WHEN o.state='park_requested' AND purchases='[]'::jsonb AND arrivals='[]'::jsonb AND entries='[]'::jsonb THEN '{}'::jsonb
 ELSE jsonb_build_object('receipts',jsonb_build_object('break_id',o.break_id,'state',o.state,'purchases',purchases,'arrivals',arrivals,'moved',moved)
 ||CASE WHEN reoccupied='[]'::jsonb THEN '{}'::jsonb ELSE jsonb_build_object('reoccupied',reoccupied) END
 ||CASE WHEN entries='[]'::jsonb THEN '{}'::jsonb ELSE jsonb_build_object('entries',entries) END) END;
END $busted_entry_prior$;

REVOKE ALL ON FUNCTION smarter_private.f06_movement_prior(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;

DO $busted_entry_postimage$
DECLARE body text;
BEGIN
  SELECT p.prosrc INTO body FROM pg_proc p
   WHERE p.oid = 'smarter_private.f06_movement_prior(uuid,uuid)'::regprocedure
     AND md5(p.prosrc) = '862440fc437b25c7c10b96f9ed603283'
     AND md5(pg_get_functiondef(p.oid)) = '458a9e5135824e03d4188e43bc7c9c84'
     AND pg_get_userbyid(p.proowner) = 'postgres'
     AND p.proacl::text = '{postgres=X/postgres}'
     AND p.proconfig = ARRAY['search_path=pg_catalog, public, smarter_private']
     AND p.prosecdef AND p.provolatile = 'v';
  IF body IS NULL THEN
    RAISE EXCEPTION 'F06_MOVEMENT_BUSTED_ENTRY_POSTIMAGE_DRIFT: smarter_private.f06_movement_prior(uuid,uuid)';
  END IF;
  -- Only the two stated passages changed: restoring them reproduces the
  -- pre-image byte for byte.
  IF md5(replace(replace(body,
       $r$ fund public.tournament_participant_funding_receipts; entries jsonb:='[]';
 -- A busted chair taken by a late entry after the proven hand (2026-10-03).
 taken jsonb;
$r$, $r$ fund public.tournament_participant_funding_receipts; entries jsonb:='[]';
$r$),
       $r$ arrival:=NULL; taken:=NULL;
 SELECT m.* INTO arrival FROM public.table_seats st JOIN public.tournament_seat_move_receipts m
 ON m.destination_seat_id=st.id AND m.user_id=st.user_id AND m.moved_at=st.joined_at
 WHERE st.id=(x->>'seat_id')::uuid AND st.table_id=p_table AND st.left_at IS NULL AND st.occupancy_id IS NOT NULL
 AND st.user_id IS DISTINCT FROM (x->>'user_id')::uuid AND st.joined_at>a.committed_at
 AND m.tournament_id=p_tournament AND m.destination_table_id=p_table AND m.destination_seat_number=st.seat_number;
 -- Or the chair was taken by a late entry the arrival loop above already
 -- admitted on its own funding receipt: exactly this chair row, occupied
 -- by that entry since it sat, after the proven hand.
 IF arrival.request_id IS NULL THEN
 SELECT e.value->'entry' INTO taken FROM jsonb_array_elements(items) e JOIN public.table_seats st ON st.id=(e.value#>>'{entry,seat_id}')::uuid
 WHERE e.value ? 'entry' AND st.id=(x->>'seat_id')::uuid AND st.table_id=p_table AND st.left_at IS NULL AND st.occupancy_id IS NOT NULL
 AND st.user_id=(e.value#>>'{entry,user_id}')::uuid AND st.user_id IS DISTINCT FROM (x->>'user_id')::uuid
 AND st.joined_at=(e.value#>>'{entry,joined_at}')::timestamptz AND st.joined_at>a.committed_at;
 END IF;
 SELECT * INTO registration FROM public.tournament_players WHERE tournament_id=p_tournament AND user_id=(x->>'user_id')::uuid FOR UPDATE;
 IF (arrival.request_id IS NOT NULL OR taken IS NOT NULL) AND registration.user_id IS NOT NULL
 AND registration.status='eliminated' AND registration.eliminated_at IS NOT NULL
 AND registration.eliminated_at>=a.committed_at AND registration.eliminated_at<=COALESCE(arrival.moved_at,(taken->>'joined_at')::timestamptz)
 AND registration.chips::numeric=0 AND registration.table_id IS NOT DISTINCT FROM p_table
 AND NOT EXISTS(SELECT 1 FROM public.table_seats st JOIN public.tables t ON t.id=st.table_id
 WHERE t.tournament_id=p_tournament AND st.user_id=registration.user_id AND st.left_at IS NULL) THEN
 reoccupied:=reoccupied||jsonb_build_array(jsonb_build_object('accepted',x,'registration',to_jsonb(registration))
 ||CASE WHEN taken IS NULL THEN jsonb_build_object('arrival',to_jsonb(arrival)) ELSE jsonb_build_object('entry',taken) END);
 CONTINUE;
 END IF;$r$, $r$ arrival:=NULL;
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
 END IF;$r$)) <> 'c63825076c08ec077a480a57cc8ae79a' THEN
    RAISE EXCEPTION 'F06_MOVEMENT_BUSTED_ENTRY_POSTIMAGE_DRIFT: more than the stated passages of f06_movement_prior changed';
  END IF;
END
$busted_entry_postimage$;

COMMIT;
