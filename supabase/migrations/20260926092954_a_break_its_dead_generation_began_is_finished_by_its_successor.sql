-- 20260926092954_a_break_its_dead_generation_began_is_finished_by_its_successor
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-26 09:29:54 UTC.
--
-- ===========================================================================
--  A BREAK ITS DEAD GENERATION BEGAN IS FINISHED BY ITS SUCCESSOR
-- ===========================================================================
--
-- What was wrong
-- --------------
-- Event 7c6277e7 (Morning Free Buy (NLH)), incident 34f66b95. Table 244a2997
-- has not dealt since 2026-09-19 14:04 UTC. It is the source of F06 table
-- break dce8ddb0: state 'begun', revision 1, eight members in its manifest,
-- one moved (MiaPoker 3b7caeb9, 13,510 to 26c00afc seat 3 at 14:29:14),
-- seven 'active' attempts never dispatched. Origin and custody generation
-- are both 29afae24, which is dead. The other two open tables hold one
-- player each (124,007 and 114,503) and cannot deal, so the whole event has
-- been stopped since 2026-09-25 16:27. Chips conserve: 338,000 on the felt
-- = 338,000 held by the nine playing registrations.
--
-- The current lease holder does try to take custody. The source table's
-- admission reads `source_excluded` and calls
-- public.fn_f06_admit_parked_movement, the protocol's own door for a
-- successor to take a break's custody and move its players. It refused on
-- every attempt (engine log: "Tournament table 244a2997 ... was never
-- ready"; rolled-back probe 2026-09-26 09:09 UTC):
-- F06_MOVEMENT_ORIGINAL_PROOF_MISSING.
--
-- The door has two ways to obtain the movement proof it binds custody to.
-- It can carry forward a proof a previous generation recorded in
-- smarter_private.f06_movement_admissions, or capture a fresh one when the
-- break is still 'park_requested' with no manifest. This break has neither.
-- Generation 29afae24 began it and dispatched its first move while it held
-- a live dealer for the table, a path that never records a movement
-- admission, so there is nothing to carry forward. It is 'begun' with a
-- manifest, so it may not be recaptured: the table no longer holds the whole
-- original roster. Every break a live generation begins and then dies
-- part-way through has this shape. PR #5035's continueAbandonedNoStartPark
-- covers only a 'park_requested' last-table park with no members, so it
-- does not reach this one.
--
-- What this changes
-- -----------------
-- A third way to obtain the proof, taken only when ALL hold: the break is
-- 'begun' with a manifest; neither its origin nor its custody generation is
-- the caller's (the caller holds the event's lease, so both are dead); and
-- no movement admission was ever recorded for it.
-- smarter_private.f06_movement_abandoned_begun_proof rebuilds the proof the
-- original generation would have captured, at the same boundary (the table's
-- sealed last hand), through every check of f06_movement_prior. It departs
-- from that function in exactly three places, each backed by a durable row:
--   * a member who already left through THIS break's own winning move is
--     witnessed by that winning receipt (same source seat, occupancy,
--     lifecycle and break, moved_at = the chair's left_at, and the carried
--     stack = the chair's stack at the boundary plus what it bought);
--   * chips a member bought after the boundary are admitted, counted from
--     the purchase door's own wallet debits (category rebuy/addon, type
--     debit, the event's id) at the event's own chip rates (the rates
--     fn_ca_tournament_chip_supply uses). Any non-debit purchase row after
--     the boundary refuses;
--   * a member the last hand busted who then rebought is re-seated in the
--     same chair row under a new joined_at; only a rebuy debit after the
--     boundary and before that joined_at renews it.
-- Every manifest member must be accounted for, either moved or still in its
-- manifest chair with its manifest occupancy. The live roster must equal
-- the remaining members exactly. Once installed, the proof is enforced at
-- every move by the unchanged smarter_private.f06_assert_movement, and the
-- successor finishes the break through the protocol's own transitions:
-- fn_f06_claim_custody (inside the door), fn_move_tournament_player,
-- close, cleanup ack. Nothing here writes a chair, a registration or money.
--
-- Measured on 2026-09-19 14:04-14:09, for this break: the last hand
-- (13176489) left MiaPoker 3,510, 559c9e97 2,451, 8ebbb163 7,561, 93e59b77
-- 5,853, ae0bc48d 0, aecab0a3 7,453, b82cb704 6,964, bbca3b33 16,208. Then
-- ae0bc48d rebought (14:04:07, 3,000, re-seated 14:04:27), and at 14:08:44-47
-- six of them took the 10,000 add-on (1.00 each). Every chair now equals its
-- boundary stack plus those purchases, and MiaPoker's move carried
-- 3,510 + 10,000 = 13,510.
--
-- Proved in a transaction rolled back (one DO block ending in RAISE,
-- 2026-09-26 09:28 UTC, this exact body installed in pg_temp), as the current
-- lease holder:
--   * admission ok: reconstructed {moved 1, remaining 7}, custody claimed by
--     generation 4f11ca96 at revision 2;
--   * the next member's own active request (dfb60c85) then moved through
--     fn_move_tournament_player: 559c9e97 with 12,451 to 26c00afc seat 6;
--   * felt 338,000 -> 338,000, registrations 338,000 -> 338,000.
--
-- Law: tests/a-break-its-dead-generation-began-is-finished-by-its-successor.law.test.ts.
-- Changelog: docs/changelog/2026-09-26-a-break-its-dead-generation-began-is-finished-by-its-successor.md.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $pre$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_f06_admit_parked_movement(uuid,uuid,uuid,bigint,uuid,uuid,uuid,bigint)'::regprocedure
       AND md5(p.prosrc) = '9bcb1b3bb38fb6abaca0c663e51ab325'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{"search_path=pg_catalog, public, smarter_private"}'
       AND p.prosecdef) THEN
    RAISE EXCEPTION 'PREIMAGE: fn_f06_admit_parked_movement is not the definition of 20260918095135';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'smarter_private.f06_movement_prior(uuid,uuid)'::regprocedure
       AND md5(p.prosrc) = '97c4a1afeaa41512026d3dca6936364a') THEN
    RAISE EXCEPTION 'PREIMAGE: f06_movement_prior, which the rebuilt proof mirrors, has changed';
  END IF;
  IF to_regprocedure('smarter_private.f06_movement_abandoned_begun_proof(uuid,uuid,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'PREIMAGE: f06_movement_abandoned_begun_proof already exists';
  END IF;
END
$pre$;

CREATE FUNCTION smarter_private.f06_movement_abandoned_begun_proof(p_tournament uuid, p_table uuid, p_break uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'smarter_private' AS $$
DECLARE a public.hand_atomic_commits; h public.hand_history; s jsonb; payload jsonb; submitted jsonb;
 x jsonb; seat public.table_seats; registration public.tournament_players;
 roster jsonb:='[]'; eliminated jsonb:='[]'; permits jsonb; n integer; positive integer:=0;
 o smarter_private.f06_operations; w jsonb; member jsonb; moved integer:=0; seat_found boolean;
 chips_rebuy numeric; chips_addon numeric; bought numeric; expected numeric;
BEGIN
 -- THE PROOF A DEAD GENERATION NEVER RECORDED (2026-09-26). A break that its
 -- original generation BEGAN and started dispatching while it held a live
 -- dealer never needed a movement admission, so none exists. When that
 -- generation dies part-way, the successor may not recapture the table (it
 -- is no longer the whole original roster: some members have moved). This
 -- rebuilds the proof the original would have captured at the same
 -- boundary, from the same sealed last hand, with one difference: a member
 -- who already left through THIS break's own winning move is witnessed by
 -- that winning receipt instead of by the live chair it vacated. Every
 -- other check of f06_movement_prior is unchanged.
 SELECT * INTO o FROM smarter_private.f06_operations WHERE break_id=p_break AND tournament_id=p_tournament AND source_table_id=p_table;
 IF NOT FOUND OR o.state<>'begun' OR jsonb_typeof(o.manifest) IS DISTINCT FROM 'array' OR jsonb_array_length(o.manifest)=0 THEN
 RAISE EXCEPTION 'F06_MOVEMENT_ORIGINAL_PROOF_MISSING' USING ERRCODE='55000'; END IF;
 -- Chips a member bought after the last hand (a rebuy or the add-on, taken
 -- during the break) are the one legitimate change to a chair since the
 -- boundary. They are counted from the purchase door's own wallet debits, at
 -- the event's own chip rates (as fn_ca_tournament_chip_supply counts them).
 SELECT COALESCE(NULLIF(t.rebuy_chips,0),t.starting_chips,0),COALESCE(NULLIF(t.addon_chips,0),t.starting_chips,0)
 INTO chips_rebuy,chips_addon FROM public.tournaments t WHERE t.id=p_tournament;
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
 IF EXISTS(SELECT 1 FROM public.wallet_transactions wt WHERE wt.related_entity_id::text=p_tournament::text
 AND wt.user_id=(x->>'user_id')::uuid AND wt.category IN ('rebuy','addon') AND wt.type<>'debit' AND wt.created_at>a.committed_at) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_PURCHASE_UNPROVEN' USING ERRCODE='55000'; END IF;
 bought:=COALESCE((SELECT sum(CASE wt.category WHEN 'rebuy' THEN chips_rebuy ELSE chips_addon END) FROM public.wallet_transactions wt
 WHERE wt.related_entity_id::text=p_tournament::text AND wt.user_id=(x->>'user_id')::uuid AND wt.category IN ('rebuy','addon')
 AND wt.type='debit' AND wt.created_at>a.committed_at),0);
 expected:=(x->>'stack')::numeric+bought;
 -- A member the last hand busted who rebought after it is re-seated in the
 -- same chair row under a new joined_at; only that rebuy may renew it.
 SELECT * INTO seat FROM public.table_seats WHERE id=(x->>'seat_id')::uuid AND table_id=p_table
 AND user_id=(x->>'user_id')::uuid AND (joined_at=(x->>'seat_joined_at')::timestamptz
 OR ((x->>'stack')::numeric=0 AND joined_at>a.committed_at AND EXISTS(SELECT 1 FROM public.wallet_transactions wt
 WHERE wt.related_entity_id::text=p_tournament::text AND wt.user_id=(x->>'user_id')::uuid AND wt.category='rebuy'
 AND wt.type='debit' AND wt.created_at>a.committed_at AND wt.created_at<=joined_at))) FOR UPDATE;
 seat_found:=FOUND;
 IF seat_found AND expected>0 THEN
 member:=NULL;
 SELECT value INTO member FROM jsonb_array_elements(o.manifest) WHERE value->>'user_id'=seat.user_id::text;
 IF member IS NULL OR (member->>'source_seat_id')::uuid IS DISTINCT FROM seat.id
 OR (member->>'occupancy_id')::uuid IS DISTINCT FROM seat.occupancy_id THEN
 RAISE EXCEPTION 'F06_MOVEMENT_MANIFEST_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT d.receipt INTO w FROM smarter_private.f06_attempts d JOIN public.tournament_seat_move_receipts r USING(request_id)
 WHERE d.break_id=p_break AND d.user_id=seat.user_id AND d.state='winner';
 IF FOUND THEN
 IF seat.left_at IS NULL OR seat.occupancy_id IS NULL
 OR (w->>'source_table_id')::uuid IS DISTINCT FROM p_table OR (w->>'source_seat_id')::uuid IS DISTINCT FROM seat.id
 OR (w->>'source_occupancy_id')::uuid IS DISTINCT FROM seat.occupancy_id
 OR (w->>'stack')::numeric IS DISTINCT FROM expected
 OR (w->>'break_id')::uuid IS DISTINCT FROM p_break OR (w->>'source_lifecycle')::bigint IS DISTINCT FROM o.lifecycle
 OR (w->>'moved_at')::timestamptz IS DISTINCT FROM seat.left_at THEN
 RAISE EXCEPTION 'F06_MOVEMENT_WINNER_CHANGED' USING ERRCODE='55000'; END IF;
 moved:=moved+1;
 roster:=roster||jsonb_build_array(jsonb_build_object('seat',jsonb_build_object('id',seat.id,'user_id',seat.user_id,
 'table_id',seat.table_id,'seat_number',seat.seat_number,'joined_at',seat.joined_at,'occupancy_id',seat.occupancy_id,
 'stack',expected),'witness','winning_receipt','receipt',w,'bought',bought));
 CONTINUE;
 END IF;
 END IF;
 IF NOT seat_found OR seat.stack IS DISTINCT FROM expected OR seat.occupancy_id IS NULL THEN
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
 positive:=positive+1;
 roster:=roster||jsonb_build_array(jsonb_build_object('seat',to_jsonb(seat),'registration',to_jsonb(registration)));
 END IF;
 END LOOP;
 IF positive=0 OR positive+moved<>jsonb_array_length(o.manifest)
 OR (SELECT count(*) FROM public.table_seats WHERE table_id=p_table AND left_at IS NULL)<>positive
 OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id=p_tournament AND table_id=p_table AND status IN ('playing','registered'))<>positive THEN
 RAISE EXCEPTION 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED' USING ERRCODE='55000'; END IF;
 RETURN jsonb_build_object('atomic',to_jsonb(a),'history',to_jsonb(h),'roster',roster,'eliminated',eliminated,'permits',permits,
 'reconstructed',jsonb_build_object('break_id',p_break,'origin_generation',o.origin_generation,
 'custody_generation',o.custody_generation,'moved',moved,'remaining',positive));
END $$;
REVOKE ALL ON FUNCTION smarter_private.f06_movement_abandoned_begun_proof(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.fn_f06_admit_parked_movement(p_tournament_id uuid, p_lease_generation uuid, p_table_id uuid, p_lifecycle bigint, p_break_id uuid, p_admission_id uuid, p_custody_id uuid, p_expected_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog', 'public', 'smarter_private' AS $$
DECLARE o smarter_private.f06_operations; a smarter_private.f06_movement_admissions; prior smarter_private.f06_movement_admissions;
 users uuid[]; proof jsonb; claimed jsonb;
BEGIN
 PERFORM smarter_private.f06_authority(p_tournament_id,p_lease_generation);
 PERFORM public.fn_ca_lock_settlement_lane_for_tournament(p_tournament_id);
 SELECT array_agg(user_id ORDER BY user_id) INTO users FROM public.tournament_players WHERE tournament_id=p_tournament_id AND table_id=p_table_id;
 PERFORM smarter_private.f06_prefix(p_tournament_id,p_lease_generation,COALESCE(users,'{}'),ARRAY[p_table_id]);
 SELECT * INTO o FROM smarter_private.f06_operations WHERE break_id=p_break_id FOR UPDATE;
 IF NOT FOUND OR (o.tournament_id,o.source_table_id,o.lifecycle) IS DISTINCT FROM(p_tournament_id,p_table_id,p_lifecycle)
 OR o.state NOT IN ('park_requested','begun') OR p_admission_id IS NULL OR p_custody_id IS NULL
 OR NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id=p_tournament_id AND upper(status)='RUNNING')
 OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=p_table_id AND tournament_id=p_tournament_id AND f06_lifecycle=p_lifecycle AND lower(status)<>'closed' AND NOT COALESCE(is_deleted,false)) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_OPERATION_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT * INTO a FROM smarter_private.f06_movement_admissions WHERE admission_id=p_admission_id;
 IF FOUND THEN
 IF (a.tournament_id,a.lease_generation,a.table_id,a.lifecycle,a.break_id,a.custody_id) IS DISTINCT FROM
 (p_tournament_id,p_lease_generation,p_table_id,p_lifecycle,p_break_id,p_custody_id) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_CHANGED_REPLAY' USING ERRCODE='22023'; END IF;
 IF a.requested_revision IS DISTINCT FROM p_expected_revision THEN
 RAISE EXCEPTION 'F06_MOVEMENT_CHANGED_REPLAY' USING ERRCODE='22023'; END IF;
 IF (a.custody_id,a.lease_generation,a.revision) IS DISTINCT FROM
 (o.custody_id,o.custody_generation,o.revision) THEN
 RAISE EXCEPTION 'F06_MOVEMENT_CUSTODY_CHANGED' USING ERRCODE='55000'; END IF;
 PERFORM smarter_private.f06_assert_movement(p_break_id);
 ELSE
 IF o.revision IS DISTINCT FROM p_expected_revision THEN RAISE EXCEPTION 'F06_MOVEMENT_CAS_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT * INTO prior FROM smarter_private.f06_movement_admissions WHERE break_id=p_break_id AND custody_id=o.custody_id;
 IF FOUND THEN
 -- A successor may carry the same immutable original proof, not recapture a
 -- partial roster. Current lease authority replaces the old custody by CAS.
 proof:=prior.proof;
 ELSE
 -- A break a now-dead generation BEGAN, with no admission ever recorded (its
 -- live dealer never needed one): rebuild the proof it would have taken,
 -- with its own winning receipts as witnesses for members already moved.
 IF o.state='begun' AND o.manifest IS NOT NULL
 AND o.origin_generation IS DISTINCT FROM p_lease_generation AND o.custody_generation IS DISTINCT FROM p_lease_generation
 AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_movement_admissions WHERE break_id=p_break_id) THEN
 proof:=smarter_private.f06_movement_abandoned_begun_proof(p_tournament_id,p_table_id,p_break_id);
 ELSE
 IF o.state<>'park_requested' OR o.manifest IS NOT NULL THEN RAISE EXCEPTION 'F06_MOVEMENT_ORIGINAL_PROOF_MISSING' USING ERRCODE='55000'; END IF;
 proof:=smarter_private.f06_movement_prior(p_tournament_id,p_table_id);
 END IF;
 END IF;
 claimed:=public.fn_f06_claim_custody(p_tournament_id,p_lease_generation,p_break_id,p_custody_id,p_expected_revision);
 IF claimed->'ok' IS DISTINCT FROM 'true'::jsonb OR claimed->>'custody_id' IS DISTINCT FROM p_custody_id::text
 OR claimed->>'custody_generation' IS DISTINCT FROM p_lease_generation::text THEN
 RAISE EXCEPTION 'F06_MOVEMENT_CAS_CHANGED' USING ERRCODE='55000'; END IF;
 INSERT INTO smarter_private.f06_movement_admissions(admission_id,tournament_id,lease_generation,table_id,lifecycle,break_id,custody_id,revision,requested_revision,proof,proof_hash)
 VALUES(p_admission_id,p_tournament_id,p_lease_generation,p_table_id,p_lifecycle,p_break_id,p_custody_id,(claimed->>'revision')::bigint,p_expected_revision,proof,
 encode(extensions.digest(convert_to(proof::text,'UTF8'),'sha256'),'hex')) RETURNING * INTO a;
 PERFORM smarter_private.f06_assert_movement(p_break_id);
 END IF;
 RETURN jsonb_build_object('ok',true,'mode','movement_only','admission_id',a.admission_id,'tournament_id',a.tournament_id,
 'lease_generation',a.lease_generation,'table_id',a.table_id,'lifecycle',a.lifecycle::text,'break_id',a.break_id,
 'custody_id',a.custody_id,'revision',a.revision::text,'proof_hash',a.proof_hash);
END $$;
REVOKE ALL ON FUNCTION public.fn_f06_admit_parked_movement(uuid,uuid,uuid,bigint,uuid,uuid,uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_admit_parked_movement(uuid,uuid,uuid,bigint,uuid,uuid,uuid,bigint) TO service_role;

DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.fn_f06_admit_parked_movement(uuid,uuid,uuid,bigint,uuid,uuid,uuid,bigint)'::regprocedure
       AND md5(p.prosrc) = 'ed6ff9c0c9efdb9dca5d78966dda1097'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'
       AND p.proconfig::text = '{"search_path=pg_catalog, public, smarter_private"}'
       AND p.prosecdef) THEN
    RAISE EXCEPTION 'POSTIMAGE: fn_f06_admit_parked_movement is not the abandoned-begun definition';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'smarter_private.f06_movement_abandoned_begun_proof(uuid,uuid,uuid)'::regprocedure
       AND md5(p.prosrc) = 'ac84d9bef04a24340cb676d0ed7a2e8c'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig::text = '{"search_path=pg_catalog, public, smarter_private"}'
       AND p.prosecdef) THEN
    RAISE EXCEPTION 'POSTIMAGE: f06_movement_abandoned_begun_proof is not installed as private';
  END IF;
END
$post$;

COMMIT;
