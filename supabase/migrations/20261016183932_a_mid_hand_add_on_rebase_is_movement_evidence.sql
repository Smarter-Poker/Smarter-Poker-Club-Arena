-- 20261016183932_a_mid_hand_add_on_rebase_is_movement_evidence.sql
--
-- Version reserved by scripts/reserve-migration-version.sh against origin/main
-- and every remote branch. This file changes ONE reader,
-- smarter_private.f06_movement_prior. It schedules nothing, retries nothing,
-- writes no row and moves no chip.
--
-- ===========================================================================
-- WHAT WAS WRONG, READ FROM ROWS AND LOG LINES (2026-10-16)
--
-- 85313174 "Coffee Break Freeroll (PLO4)" (16 playing): its three live tables
-- 0c6edb9d, cdc8cdcf and 30c09ebd have dealt nothing since 17:03 UTC. Their
-- parks (74fa4319, a3d58b20, c0be0f07; park_requested 17:03:05-17:03:30)
-- cannot take their movement admission, and every engine re-admission is
-- refused:
--
--   f06_movement_admission_unproven [55000]: F06_MOVEMENT_STACK_RECEIPT
--
-- The add-on window opened during each table's last sealed hand. Four
-- players bought the add-on WHILE that hand was being dealt (funding receipts
-- 17:02:14-17:02:50, each 3,000 chips, before the hands sealed at
-- 17:02:58-17:03:22). The engine had read their seats before the chips
-- arrived, so the stack settlement rebased those seats: it wrote the engine's
-- result plus exactly the 3,000 that arrived, recorded one
-- ca_seat_stack_rebases row each (36510, 36511, 36512, 36516) and published
-- them in stack_result.rebased. The seats and registrations now hold those
-- chips (for example 26fc77c4: engine 6,776 -> 6,626, seat found 9,776,
-- written 9,626 = seat and registration today).
--
-- f06_movement_prior refused ANY non-empty rebased, and compared every
-- written stack with the engine's request stack. A paid add-on that landed
-- mid-hand therefore froze the table for as long as the event lived: three
-- tables, 15 players, from 17:03 until this migration.
--
-- Table 30c09ebd had a second gap behind the first. 70a7e704 busted there in
-- hand 36294016 (sealed 17:02:38.28, chair d5200fb2 vacated by that hand),
-- REBOUGHT at 17:02:43.37 (receipt 122a2f38: playing on this table, seat 5,
-- 3,000 = the rebuy grant) and was seated again in the same chair row at
-- 17:02:43.41, while the last hand was already being dealt, so that hand did
-- not deal it. The arrival loop admits an undealt chair only by a move
-- receipt or by an ENTRY/RE-ENTRY receipt recorded no earlier than the chair
-- was taken; a rebuy is neither, and its receipt precedes the re-seat by
-- ~40 ms. That refused F06_MOVEMENT_WHOLE_ROSTER_REQUIRED.
--
-- ===========================================================================
-- WHAT THIS CHANGES
--
-- 1. A rebased player is admitted only by its own rows: exactly one rebase
--    receipt this settlement recorded for this player (same table, hand id,
--    hand number) whose engine_before/engine_after are the request's
--    stack_before/stack, whose db_before is engine_before + the rebase, and
--    whose written is the request stack + the rebase; and the add-on funding
--    receipts that bought it, walked back from db_before to engine_before.
--    Each walked receipt is an add-on, on this table, observed after the
--    previous hand on this table (and after the chair was taken) and no later
--    than this hand was sealed, its registration image exactly the running
--    stack, and their grants sum to exactly the rebase. Written and
--    tournament_player_chips must then equal request stack + rebase, and every
--    rebased key must be a player this hand dealt. The proven stack is
--    request stack + rebase. Those receipts precede the seal, so the purchase
--    loop (receipts AFTER the seal) never counts them twice. The proof records
--    them in receipts.rebased.
-- 2. An undealt chair is also admitted when its player busted on this table
--    in an earlier hand and bought back into exactly that chair row: its
--    latest entry/re-entry/rebuy receipt is the rebuy, recorded no earlier
--    than that bust was sealed and no later than the chair was taken, playing
--    on exactly this table and seat number with exactly the rebuy grant; the
--    last hand here that dealt it is that bust (this chair row, stack 0,
--    written 0, the chair in its vacated zero-stack generations); no move of
--    the player since the bust and no hand on this table dealt it since. It is
--    recorded as an entry with operation 'rebuy' and its bust_hand_id.
-- 3. The busted-chair-reoccupied branch is not taken for a rebased player.
--
-- Every other refusal, and every proof that needs neither, is unchanged: a
-- proof with no rebase is byte-identical to before (rebases is empty, so the
-- receipts object and the no-receipt fast path are what they were).
--
-- Same signature, owner (postgres), ACL {postgres=X/postgres}, SECURITY
-- DEFINER, volatility and search_path. Restoring the eight changed passages
-- reproduces the pre-image body digest exactly (asserted below).
--
-- PROVED FIRST (CLAUDE.md 11.5): the post-image body, installed as a pg_temp
-- function (row locks stripped; temp body md5 b042488b31654dec0f63352645b036ae
-- = the stripped file body) in ONE Supabase MCP call whose transaction was
-- switched READ ONLY before it ran and ended in ROLLBACK (2026-10-16 ~18:46
-- UTC), against the live installed function in the same transaction:
--   installed (862440fc): F06_MOVEMENT_STACK_RECEIPT on all three tables
--   post-image          : 0c6edb9d roster 6 (rebased 26fc77c4, 9dc5344d via
--                         add-on receipts 5aec9d66, 9513b5c0; arrival
--                         878cdf61), eliminated 2
--                         cdc8cdcf roster 4 (rebased 2928e6a1 via 76e6d347),
--                         eliminated 3
--                         30c09ebd rebased 2610f833 via 5e9acf93; entry
--                         70a7e704 as rebuy 122a2f38 after bust hand
--                         0cdbb623; eliminated 2
--
-- NOT TOUCHED: fn_f06_admit_parked_movement, f06_assert_movement (its roster
-- comparison reads live seats and registrations, which already hold these
-- chips), f06_movement_never_dealt_prior, the stack settlement itself.
--
-- Pinned by tests/a-mid-hand-add-on-rebase-is-movement-evidence.law.test.ts.

-- @live-proof: (SELECT md5(prosrc)='d2ead73888242bf1d29bf7635bb0fa90' AND md5(pg_get_functiondef(oid))='cd75d4888abb11fbb33daba617e7d589' AND proacl::text='{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_movement_prior(uuid,uuid)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

DO $mid_hand_addon_preimage$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('smarter_private.f06_movement_prior(uuid,uuid)')
       AND md5(p.prosrc) = '862440fc437b25c7c10b96f9ed603283'
       AND md5(pg_get_functiondef(p.oid)) = '458a9e5135824e03d4188e43bc7c9c84'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig = ARRAY['search_path=pg_catalog, public, smarter_private']
       AND p.prosecdef AND p.provolatile = 'v'
       AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')) THEN
    RAISE EXCEPTION 'F06_MOVEMENT_MID_HAND_ADDON_PREIMAGE_DRIFT: smarter_private.f06_movement_prior(uuid,uuid)';
  END IF;
END
$mid_hand_addon_preimage$;

CREATE OR REPLACE FUNCTION smarter_private.f06_movement_prior(p_tournament uuid, p_table uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $mid_hand_addon_prior$
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
 -- An add-on bought while the proven hand was being dealt (2026-10-16).
 credit numeric; credited integer:=0; rebases jsonb:='[]'; chain jsonb; cur numeric; opened timestamptz;
 rb public.ca_seat_stack_rebases; rf public.tournament_participant_funding_receipts;
 -- A chair bought back after a bust and taken while the proven hand was dealt (2026-10-16).
 bust public.hand_atomic_commits;
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
 OR jsonb_typeof(s->'rebased') IS DISTINCT FROM 'object' OR s->'departed' IS DISTINCT FROM '[]'::jsonb
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
 IF x->>'stack' IS NULL OR x->>'stack' !~ '^[0-9]+([.][0-9]+)?$' THEN
 RAISE EXCEPTION 'F06_MOVEMENT_STACK_RECEIPT' USING ERRCODE='55000'; END IF;
 -- An add-on bought while this hand was being dealt reached the seat after
 -- the engine read it, so the settlement rebased the seat: it wrote the
 -- engine's result plus exactly the chips that arrived meanwhile (rebased).
 -- That credit is admitted only by its own rows: the one rebase receipt this
 -- settlement recorded for this player (engine before and after, the seat it
 -- found, what it wrote), and the add-on funding receipts that bought it,
 -- walked back from the seat the settlement found to the stack the engine
 -- dealt. Each receipt's registration image is the running stack on this
 -- table, sat after the previous hand and before this one was sealed, and
 -- their grants are exactly the rebase. Anything else still refuses.
 credit:=0;
 IF s->'rebased' ? (x->>'user_id') THEN
 IF jsonb_typeof(s->'rebased'->(x->>'user_id')) IS DISTINCT FROM 'number'
 OR (SELECT count(*) FROM public.ca_seat_stack_rebases r WHERE r.table_id=p_table
 AND r.hand_id=(s->>'hand_id')::uuid AND r.user_id=(x->>'user_id')::uuid)<>1 THEN
 RAISE EXCEPTION 'F06_MOVEMENT_STACK_RECEIPT' USING ERRCODE='55000'; END IF;
 SELECT r.* INTO rb FROM public.ca_seat_stack_rebases r WHERE r.table_id=p_table
 AND r.hand_id=(s->>'hand_id')::uuid AND r.user_id=(x->>'user_id')::uuid;
 credit:=(s->'rebased'->>(x->>'user_id'))::numeric;
 IF credit<=0 OR rb.amount IS DISTINCT FROM credit OR rb.hand_number IS DISTINCT FROM a.hand_number
 OR rb.engine_after IS DISTINCT FROM (x->>'stack')::numeric
 OR rb.engine_before IS DISTINCT FROM (x->>'stack_before')::numeric
 OR rb.db_before IS DISTINCT FROM rb.engine_before+credit
 OR rb.written IS DISTINCT FROM (x->>'stack')::numeric+credit THEN
 RAISE EXCEPTION 'F06_MOVEMENT_STACK_RECEIPT' USING ERRCODE='55000'; END IF;
 SELECT max(c.committed_at) INTO opened FROM public.hand_atomic_commits c WHERE c.table_id=p_table AND c.hand_number<a.hand_number;
 opened:=GREATEST(COALESCE(opened,'-infinity'::timestamptz),(x->>'seat_joined_at')::timestamptz);
 cur:=rb.db_before; chain:='[]';
 FOR rf IN SELECT f.* FROM public.tournament_participant_funding_receipts f
 WHERE f.tournament_id=p_tournament AND f.user_id=(x->>'user_id')::uuid
 AND f.observed_at>opened AND f.observed_at<=a.committed_at ORDER BY f.observed_at DESC,f.id DESC LOOP
 EXIT WHEN cur=rb.engine_before;
 gained:=COALESCE(NULLIF((rf.tournament_snapshot->>'addon_chips')::numeric,0),(rf.tournament_snapshot->>'starting_chips')::numeric,0);
 IF rf.operation IS DISTINCT FROM 'addon' OR gained IS NULL OR gained<=0
 OR rf.registration_snapshot->>'table_id' IS DISTINCT FROM p_table::text
 OR jsonb_typeof(rf.registration_snapshot->'chips') IS DISTINCT FROM 'number'
 OR (rf.registration_snapshot->>'chips')::numeric IS DISTINCT FROM cur THEN
 RAISE EXCEPTION 'F06_MOVEMENT_STACK_RECEIPT' USING ERRCODE='55000'; END IF;
 chain:=chain||jsonb_build_array(jsonb_build_object('receipt_id',rf.id,'purchase_key',rf.purchase_key,
 'observed_at',rf.observed_at,'chips',gained,'stack',cur));
 cur:=cur-gained;
 END LOOP;
 IF cur IS DISTINCT FROM rb.engine_before OR chain='[]'::jsonb THEN
 RAISE EXCEPTION 'F06_MOVEMENT_STACK_RECEIPT' USING ERRCODE='55000'; END IF;
 credited:=credited+1;
 rebases:=rebases||jsonb_build_array(jsonb_build_object('user_id',x->>'user_id','rebase_id',rb.id,
 'settlement_id',rb.settlement_id,'chips',credit,'engine_before',rb.engine_before,'engine_after',rb.engine_after,
 'seat_before',rb.db_before,'written',rb.written,'receipts',chain));
 END IF;
 IF (s->'written'->>(x->>'user_id'))::numeric IS DISTINCT FROM (x->>'stack')::numeric+credit
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'tournament_player_chips') v
 WHERE v->>'user_id'=x->>'user_id' AND (v->>'chips')::numeric=(x->>'stack')::numeric+credit) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_STACK_RECEIPT' USING ERRCODE='55000'; END IF;
 items:=items||jsonb_build_array(jsonb_build_object('hand',x)
 ||CASE WHEN credit=0 THEN '{}'::jsonb ELSE jsonb_build_object('credit',credit) END);
 END LOOP;
 -- Every rebased player is a player this hand dealt, each proven above.
 IF (SELECT count(*) FROM jsonb_object_keys(s->'rebased'))<>credited THEN
 RAISE EXCEPTION 'F06_MOVEMENT_STACK_RECEIPT' USING ERRCODE='55000'; END IF;
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
 -- Or the player busted on this table in an earlier hand, bought back in,
 -- and was seated again in exactly that chair row while the proven hand
 -- was being dealt, so that hand did not deal it. It is admitted only by
 -- its rows: its latest entry, re-entry or rebuy receipt is the rebuy,
 -- recorded no earlier than that bust was sealed and no later than the
 -- chair was taken, whose registration image is playing on exactly this
 -- table and seat number with exactly the rebuy grant; the last hand here
 -- that dealt it is that bust, on this chair row, written 0, its zero-stack
 -- chair vacated by that hand; no move of the player since the bust; and
 -- no committed hand on this table has dealt it since the bust. Its chips
 -- are that grant plus any receipted purchase after it.
 rf:=NULL; bust:=NULL;
 SELECT f.* INTO rf FROM public.tournament_participant_funding_receipts f
 WHERE f.tournament_id=p_tournament AND f.user_id=seat.user_id AND f.operation IN ('entry','reentry','rebuy')
 ORDER BY f.observed_at DESC,f.id DESC LIMIT 1;
 IF rf.id IS NOT NULL AND rf.operation='rebuy' AND seat.user_id IS NOT NULL AND seat.occupancy_id IS NOT NULL
 AND seat.joined_at IS NOT NULL AND rf.observed_at<=seat.joined_at
 AND rf.registration_snapshot->>'table_id'=p_table::text
 AND rf.registration_snapshot->>'seat_number'=seat.seat_number::text
 AND rf.registration_snapshot->>'status'='playing' AND rf.registration_snapshot->>'eliminated_at' IS NULL
 AND jsonb_typeof(rf.registration_snapshot->'chips')='number' AND (rf.registration_snapshot->>'chips')::numeric>0
 AND (rf.registration_snapshot->>'chips')::numeric=COALESCE(NULLIF((rf.tournament_snapshot->>'rebuy_chips')::numeric,0),(rf.tournament_snapshot->>'starting_chips')::numeric) THEN
 SELECT c.* INTO bust FROM public.hand_atomic_commits c WHERE c.table_id=p_table AND c.committed_at<=rf.observed_at
 AND c.stack_result#>'{request,stacks}' @> jsonb_build_array(jsonb_build_object('user_id',seat.user_id::text))
 ORDER BY c.hand_number DESC LIMIT 1;
 IF bust.hand_id IS NOT NULL
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(bust.stack_result#>'{request,stacks}') v WHERE v->>'user_id'=seat.user_id::text
 AND v->>'seat_id'=seat.id::text AND (v->>'stack')::numeric=0)
 AND (bust.stack_result->'written'->>seat.user_id::text)::numeric=0
 AND bust.stack_result->'tournament_zero_stack_seat_generations' @> jsonb_build_array(jsonb_build_object('seat_id',seat.id::text,'user_id',seat.user_id::text))
 AND NOT EXISTS(SELECT 1 FROM public.tournament_seat_move_receipts m WHERE m.tournament_id=p_tournament AND m.user_id=seat.user_id AND m.moved_at>bust.committed_at)
 AND NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits c WHERE c.table_id=p_table AND c.committed_at>bust.committed_at
 AND c.stack_result#>'{request,stacks}' @> jsonb_build_array(jsonb_build_object('user_id',seat.user_id::text))) THEN
 items:=items||jsonb_build_array(jsonb_build_object('entry',jsonb_build_object('receipt_id',rf.id,'registration_id',rf.registration_id,
 'user_id',rf.user_id,'operation',rf.operation,'observed_at',rf.observed_at,'chips',rf.registration_snapshot->'chips',
 'seat_id',seat.id,'seat_number',seat.seat_number,'joined_at',seat.joined_at,'bust_hand_id',bust.hand_id)));
 CONTINUE;
 END IF;
 END IF;
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
 held:=(x->>'stack')::numeric+COALESCE((item->>'credit')::numeric,0); since:=a.committed_at; lim:='infinity';
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
 IF NOT FOUND AND item ? 'hand' AND (x->>'stack')::numeric=0 AND bought=0 AND NOT item ? 'credit' THEN
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
 ||CASE WHEN o.state='park_requested' AND purchases='[]'::jsonb AND arrivals='[]'::jsonb AND entries='[]'::jsonb AND rebases='[]'::jsonb THEN '{}'::jsonb
 ELSE jsonb_build_object('receipts',jsonb_build_object('break_id',o.break_id,'state',o.state,'purchases',purchases,'arrivals',arrivals,'moved',moved)
 ||CASE WHEN reoccupied='[]'::jsonb THEN '{}'::jsonb ELSE jsonb_build_object('reoccupied',reoccupied) END
 ||CASE WHEN entries='[]'::jsonb THEN '{}'::jsonb ELSE jsonb_build_object('entries',entries) END
 ||CASE WHEN rebases='[]'::jsonb THEN '{}'::jsonb ELSE jsonb_build_object('rebased',rebases) END) END;
END $mid_hand_addon_prior$;

REVOKE ALL ON FUNCTION smarter_private.f06_movement_prior(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;

DO $mid_hand_addon_postimage$
DECLARE body text;
BEGIN
  SELECT p.prosrc INTO body FROM pg_proc p
   WHERE p.oid = 'smarter_private.f06_movement_prior(uuid,uuid)'::regprocedure
     AND md5(p.prosrc) = 'd2ead73888242bf1d29bf7635bb0fa90'
     AND md5(pg_get_functiondef(p.oid)) = 'cd75d4888abb11fbb33daba617e7d589'
     AND pg_get_userbyid(p.proowner) = 'postgres'
     AND p.proacl::text = '{postgres=X/postgres}'
     AND p.proconfig = ARRAY['search_path=pg_catalog, public, smarter_private']
     AND p.prosecdef AND p.provolatile = 'v';
  IF body IS NULL THEN
    RAISE EXCEPTION 'F06_MOVEMENT_MID_HAND_ADDON_POSTIMAGE_DRIFT: smarter_private.f06_movement_prior(uuid,uuid)';
  END IF;
  -- Only the eight stated passages changed: restoring them reproduces the
  -- pre-image byte for byte.
  IF md5(replace(replace(replace(replace(replace(replace(replace(replace(body,
       $r$ IF NOT FOUND THEN
 -- Or the player busted on this table in an earlier hand, bought back in,
 -- and was seated again in exactly that chair row while the proven hand
 -- was being dealt, so that hand did not deal it. It is admitted only by
 -- its rows: its latest entry, re-entry or rebuy receipt is the rebuy,
 -- recorded no earlier than that bust was sealed and no later than the
 -- chair was taken, whose registration image is playing on exactly this
 -- table and seat number with exactly the rebuy grant; the last hand here
 -- that dealt it is that bust, on this chair row, written 0, its zero-stack
 -- chair vacated by that hand; no move of the player since the bust; and
 -- no committed hand on this table has dealt it since the bust. Its chips
 -- are that grant plus any receipted purchase after it.
 rf:=NULL; bust:=NULL;
 SELECT f.* INTO rf FROM public.tournament_participant_funding_receipts f
 WHERE f.tournament_id=p_tournament AND f.user_id=seat.user_id AND f.operation IN ('entry','reentry','rebuy')
 ORDER BY f.observed_at DESC,f.id DESC LIMIT 1;
 IF rf.id IS NOT NULL AND rf.operation='rebuy' AND seat.user_id IS NOT NULL AND seat.occupancy_id IS NOT NULL
 AND seat.joined_at IS NOT NULL AND rf.observed_at<=seat.joined_at
 AND rf.registration_snapshot->>'table_id'=p_table::text
 AND rf.registration_snapshot->>'seat_number'=seat.seat_number::text
 AND rf.registration_snapshot->>'status'='playing' AND rf.registration_snapshot->>'eliminated_at' IS NULL
 AND jsonb_typeof(rf.registration_snapshot->'chips')='number' AND (rf.registration_snapshot->>'chips')::numeric>0
 AND (rf.registration_snapshot->>'chips')::numeric=COALESCE(NULLIF((rf.tournament_snapshot->>'rebuy_chips')::numeric,0),(rf.tournament_snapshot->>'starting_chips')::numeric) THEN
 SELECT c.* INTO bust FROM public.hand_atomic_commits c WHERE c.table_id=p_table AND c.committed_at<=rf.observed_at
 AND c.stack_result#>'{request,stacks}' @> jsonb_build_array(jsonb_build_object('user_id',seat.user_id::text))
 ORDER BY c.hand_number DESC LIMIT 1;
 IF bust.hand_id IS NOT NULL
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(bust.stack_result#>'{request,stacks}') v WHERE v->>'user_id'=seat.user_id::text
 AND v->>'seat_id'=seat.id::text AND (v->>'stack')::numeric=0)
 AND (bust.stack_result->'written'->>seat.user_id::text)::numeric=0
 AND bust.stack_result->'tournament_zero_stack_seat_generations' @> jsonb_build_array(jsonb_build_object('seat_id',seat.id::text,'user_id',seat.user_id::text))
 AND NOT EXISTS(SELECT 1 FROM public.tournament_seat_move_receipts m WHERE m.tournament_id=p_tournament AND m.user_id=seat.user_id AND m.moved_at>bust.committed_at)
 AND NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits c WHERE c.table_id=p_table AND c.committed_at>bust.committed_at
 AND c.stack_result#>'{request,stacks}' @> jsonb_build_array(jsonb_build_object('user_id',seat.user_id::text))) THEN
 items:=items||jsonb_build_array(jsonb_build_object('entry',jsonb_build_object('receipt_id',rf.id,'registration_id',rf.registration_id,
 'user_id',rf.user_id,'operation',rf.operation,'observed_at',rf.observed_at,'chips',rf.registration_snapshot->'chips',
 'seat_id',seat.id,'seat_number',seat.seat_number,'joined_at',seat.joined_at,'bust_hand_id',bust.hand_id)));
 CONTINUE;
 END IF;
 END IF;
 fund:=NULL;
$r$, $r$ IF NOT FOUND THEN
 fund:=NULL;
$r$),
       $r$ ||CASE WHEN entries='[]'::jsonb THEN '{}'::jsonb ELSE jsonb_build_object('entries',entries) END
 ||CASE WHEN rebases='[]'::jsonb THEN '{}'::jsonb ELSE jsonb_build_object('rebased',rebases) END) END;
$r$, $r$ ||CASE WHEN entries='[]'::jsonb THEN '{}'::jsonb ELSE jsonb_build_object('entries',entries) END) END;
$r$),
       $r$ ||CASE WHEN o.state='park_requested' AND purchases='[]'::jsonb AND arrivals='[]'::jsonb AND entries='[]'::jsonb AND rebases='[]'::jsonb THEN '{}'::jsonb
$r$, $r$ ||CASE WHEN o.state='park_requested' AND purchases='[]'::jsonb AND arrivals='[]'::jsonb AND entries='[]'::jsonb THEN '{}'::jsonb
$r$),
       $r$ IF NOT FOUND AND item ? 'hand' AND (x->>'stack')::numeric=0 AND bought=0 AND NOT item ? 'credit' THEN
$r$, $r$ IF NOT FOUND AND item ? 'hand' AND (x->>'stack')::numeric=0 AND bought=0 THEN
$r$),
       $r$ held:=(x->>'stack')::numeric+COALESCE((item->>'credit')::numeric,0); since:=a.committed_at; lim:='infinity';
$r$, $r$ held:=(x->>'stack')::numeric; since:=a.committed_at; lim:='infinity';
$r$),
       $r$ FOR x IN SELECT value FROM jsonb_array_elements(s#>'{request,stacks}') ORDER BY value->>'user_id' LOOP
 IF x->>'stack' IS NULL OR x->>'stack' !~ '^[0-9]+([.][0-9]+)?$' THEN
 RAISE EXCEPTION 'F06_MOVEMENT_STACK_RECEIPT' USING ERRCODE='55000'; END IF;
 -- An add-on bought while this hand was being dealt reached the seat after
 -- the engine read it, so the settlement rebased the seat: it wrote the
 -- engine's result plus exactly the chips that arrived meanwhile (rebased).
 -- That credit is admitted only by its own rows: the one rebase receipt this
 -- settlement recorded for this player (engine before and after, the seat it
 -- found, what it wrote), and the add-on funding receipts that bought it,
 -- walked back from the seat the settlement found to the stack the engine
 -- dealt. Each receipt's registration image is the running stack on this
 -- table, sat after the previous hand and before this one was sealed, and
 -- their grants are exactly the rebase. Anything else still refuses.
 credit:=0;
 IF s->'rebased' ? (x->>'user_id') THEN
 IF jsonb_typeof(s->'rebased'->(x->>'user_id')) IS DISTINCT FROM 'number'
 OR (SELECT count(*) FROM public.ca_seat_stack_rebases r WHERE r.table_id=p_table
 AND r.hand_id=(s->>'hand_id')::uuid AND r.user_id=(x->>'user_id')::uuid)<>1 THEN
 RAISE EXCEPTION 'F06_MOVEMENT_STACK_RECEIPT' USING ERRCODE='55000'; END IF;
 SELECT r.* INTO rb FROM public.ca_seat_stack_rebases r WHERE r.table_id=p_table
 AND r.hand_id=(s->>'hand_id')::uuid AND r.user_id=(x->>'user_id')::uuid;
 credit:=(s->'rebased'->>(x->>'user_id'))::numeric;
 IF credit<=0 OR rb.amount IS DISTINCT FROM credit OR rb.hand_number IS DISTINCT FROM a.hand_number
 OR rb.engine_after IS DISTINCT FROM (x->>'stack')::numeric
 OR rb.engine_before IS DISTINCT FROM (x->>'stack_before')::numeric
 OR rb.db_before IS DISTINCT FROM rb.engine_before+credit
 OR rb.written IS DISTINCT FROM (x->>'stack')::numeric+credit THEN
 RAISE EXCEPTION 'F06_MOVEMENT_STACK_RECEIPT' USING ERRCODE='55000'; END IF;
 SELECT max(c.committed_at) INTO opened FROM public.hand_atomic_commits c WHERE c.table_id=p_table AND c.hand_number<a.hand_number;
 opened:=GREATEST(COALESCE(opened,'-infinity'::timestamptz),(x->>'seat_joined_at')::timestamptz);
 cur:=rb.db_before; chain:='[]';
 FOR rf IN SELECT f.* FROM public.tournament_participant_funding_receipts f
 WHERE f.tournament_id=p_tournament AND f.user_id=(x->>'user_id')::uuid
 AND f.observed_at>opened AND f.observed_at<=a.committed_at ORDER BY f.observed_at DESC,f.id DESC LOOP
 EXIT WHEN cur=rb.engine_before;
 gained:=COALESCE(NULLIF((rf.tournament_snapshot->>'addon_chips')::numeric,0),(rf.tournament_snapshot->>'starting_chips')::numeric,0);
 IF rf.operation IS DISTINCT FROM 'addon' OR gained IS NULL OR gained<=0
 OR rf.registration_snapshot->>'table_id' IS DISTINCT FROM p_table::text
 OR jsonb_typeof(rf.registration_snapshot->'chips') IS DISTINCT FROM 'number'
 OR (rf.registration_snapshot->>'chips')::numeric IS DISTINCT FROM cur THEN
 RAISE EXCEPTION 'F06_MOVEMENT_STACK_RECEIPT' USING ERRCODE='55000'; END IF;
 chain:=chain||jsonb_build_array(jsonb_build_object('receipt_id',rf.id,'purchase_key',rf.purchase_key,
 'observed_at',rf.observed_at,'chips',gained,'stack',cur));
 cur:=cur-gained;
 END LOOP;
 IF cur IS DISTINCT FROM rb.engine_before OR chain='[]'::jsonb THEN
 RAISE EXCEPTION 'F06_MOVEMENT_STACK_RECEIPT' USING ERRCODE='55000'; END IF;
 credited:=credited+1;
 rebases:=rebases||jsonb_build_array(jsonb_build_object('user_id',x->>'user_id','rebase_id',rb.id,
 'settlement_id',rb.settlement_id,'chips',credit,'engine_before',rb.engine_before,'engine_after',rb.engine_after,
 'seat_before',rb.db_before,'written',rb.written,'receipts',chain));
 END IF;
 IF (s->'written'->>(x->>'user_id'))::numeric IS DISTINCT FROM (x->>'stack')::numeric+credit
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'tournament_player_chips') v
 WHERE v->>'user_id'=x->>'user_id' AND (v->>'chips')::numeric=(x->>'stack')::numeric+credit) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_STACK_RECEIPT' USING ERRCODE='55000'; END IF;
 items:=items||jsonb_build_array(jsonb_build_object('hand',x)
 ||CASE WHEN credit=0 THEN '{}'::jsonb ELSE jsonb_build_object('credit',credit) END);
 END LOOP;
 -- Every rebased player is a player this hand dealt, each proven above.
 IF (SELECT count(*) FROM jsonb_object_keys(s->'rebased'))<>credited THEN
 RAISE EXCEPTION 'F06_MOVEMENT_STACK_RECEIPT' USING ERRCODE='55000'; END IF;
$r$, $r$ FOR x IN SELECT value FROM jsonb_array_elements(s#>'{request,stacks}') ORDER BY value->>'user_id' LOOP
 IF x->>'stack' IS NULL OR x->>'stack' !~ '^[0-9]+([.][0-9]+)?$'
 OR (s->'written'->>(x->>'user_id'))::numeric IS DISTINCT FROM (x->>'stack')::numeric
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s->'tournament_player_chips') v
 WHERE v->>'user_id'=x->>'user_id' AND (v->>'chips')::numeric=(x->>'stack')::numeric) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_STACK_RECEIPT' USING ERRCODE='55000'; END IF;
 items:=items||jsonb_build_array(jsonb_build_object('hand',x));
 END LOOP;
$r$),
       $r$ OR jsonb_typeof(s->'rebased') IS DISTINCT FROM 'object' OR s->'departed' IS DISTINCT FROM '[]'::jsonb
 OR (s->>'net_deltas')::numeric IS DISTINCT FROM 0 OR (s->>'inflow')::numeric IS DISTINCT FROM 0
 OR (s->>'rake')::numeric IS DISTINCT FROM 0 OR (s->>'bbj')::numeric IS DISTINCT FROM 0
 OR jsonb_typeof(s#>'{request,stacks}') IS DISTINCT FROM 'array'
$r$, $r$ OR s->'rebased' IS DISTINCT FROM '{}'::jsonb OR s->'departed' IS DISTINCT FROM '[]'::jsonb
 OR (s->>'net_deltas')::numeric IS DISTINCT FROM 0 OR (s->>'inflow')::numeric IS DISTINCT FROM 0
 OR (s->>'rake')::numeric IS DISTINCT FROM 0 OR (s->>'bbj')::numeric IS DISTINCT FROM 0
 OR jsonb_typeof(s#>'{request,stacks}') IS DISTINCT FROM 'array'
$r$),
       $r$ -- A busted chair taken by a late entry after the proven hand (2026-10-03).
 taken jsonb;
 -- An add-on bought while the proven hand was being dealt (2026-10-16).
 credit numeric; credited integer:=0; rebases jsonb:='[]'; chain jsonb; cur numeric; opened timestamptz;
 rb public.ca_seat_stack_rebases; rf public.tournament_participant_funding_receipts;
 -- A chair bought back after a bust and taken while the proven hand was dealt (2026-10-16).
 bust public.hand_atomic_commits;
$r$, $r$ -- A busted chair taken by a late entry after the proven hand (2026-10-03).
 taken jsonb;
$r$)) <> '862440fc437b25c7c10b96f9ed603283' THEN
    RAISE EXCEPTION 'F06_MOVEMENT_MID_HAND_ADDON_POSTIMAGE_DRIFT: more than the stated passages of f06_movement_prior changed';
  END IF;
END
$mid_hand_addon_postimage$;

COMMIT;
