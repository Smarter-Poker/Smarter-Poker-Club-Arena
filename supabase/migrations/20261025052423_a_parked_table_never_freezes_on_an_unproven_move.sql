-- 20261025052423_a_parked_table_never_freezes_on_an_unproven_move.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch. This file:
--   1. ADDS public.fn_f06_withdraw_unproven_movement_park, a sibling of
--      fn_f06_withdraw_unplaceable_park (20261003021958, live body 8560ec3a);
--   2. PATCHES public.fn_ca_choose_tournament_seat_locked by one anchored
--      ORDER BY key (live body 32ed1ece, installed by 20261024193700).
-- It schedules nothing, retries nothing, and moves no chip, seat or
-- registration. Neither function is a repair job: (1) is the park's own
-- disposition door, asked by the engine from the park's own live path; (2)
-- is a ranking key on the existing chooser.
--
-- ===========================================================================
-- WHAT WAS WRONG, READ FROM ROWS (2026-10-24)
--
-- 12135e5b "Union PKO Afternoon (PLO4)", Table 13 (3e3d1587). TylerRVA
-- (fb825ba4) busted on Table 16 (da33eedb) at 19:53:26 and rebought at
-- 19:53:30.71. process_tournament_rebuy -> fn_ca_choose_tournament_seat_locked
-- seated him on Table 13 at 19:53:30.74 while Table 13's hand 46740543 was in
-- flight (started 19:53:07.16, sealed 19:53:40.14), so that sealed hand did
-- not deal his chair. Balancing parked Table 13 at 19:53:41.56 (break
-- 5135b05b). Every movement admission then refused
--   F06_MOVEMENT_WHOLE_ROSTER_REQUIRED  (smarter_private.f06_movement_prior)
-- and the table dealt nothing for 3h46m, until 20261024211825 taught the
-- proof that one arrival shape. That was the fifth such patch since 09-29.
--
-- The structural gap is in the engine (TournamentManager.ts): after a park
-- fails to begin, the only withdrawal door was fn_f06_withdraw_unplaceable_park,
-- reached only for a `destinations_full:` refusal and admitted only while the
-- other tables lack the seats. A park refused by its movement proof had no
-- exit at all.
--
-- ===========================================================================
-- (1) fn_f06_withdraw_unproven_movement_park
--
-- Derived from the live withdrawal door's body by four stated edits and
-- nothing else:
--   - the capacity block (F06_WITHDRAWAL_CAPACITY_UNKNOWN / _ROSTER_FITS) is
--     removed: this door is not about seats;
--   - f06_movement_prior is asked inside a sub-block. A proof that SUCCEEDS
--     refuses the withdrawal (F06_WITHDRAWAL_MOVEMENT_PROVEN: the break can go
--     on). Only a refusal with SQLSTATE 55000 AND a message starting
--     F06_MOVEMENT_ admits it; every other error is re-raised unchanged;
--   - the receipt kind is 'unproven_movement_park_withdrawal' and carries the
--     proof's refusal (sqlstate and message) instead of the capacity numbers;
--   - the answer's state is 'withdrawn_unproven_movement'.
-- Every other guard is the withdrawal door's, byte for byte: identity, the
-- live lease holder's f06_prefix lane, replay by break_id, platform freeze,
-- the exact pre-manifest park held by the caller (no manifest, members,
-- attempts, close or abort), the positive witness (latest permit
-- never_started by this park's generation, or accepted and sealed), one
-- receipt per witness, no reserved permit, the dispatch try-lock, RUNNING
-- event, open source, last-table rule, the full seat/registration roster
-- check, and no trace of any hand after the witness. The receipt lands in
-- smarter_private.f06_no_start_continuations, whose break_id key makes the
-- door idempotent and whose row f06_immutable_identity requires for the
-- park's one transition to withdrawn_before_manifest. Credit 0.
--
-- ===========================================================================
-- (2) A REBUY IS NOT SEATED UNDER A HAND IN FLIGHT
--
-- The recurring cause, chosen over teaching the proof a sixth arrival shape:
-- a rebuy chooses its chair inside the purchase transaction, and the chooser
-- ranked tables by free chairs only, so it seated rebuys onto tables whose
-- hand was being dealt. That chair is undealt by the next sealed hand, which
-- is exactly the shape each of the five proof patches had to learn. Measured
-- 2026-10-25 over 600 seated rebuys (last 6 hours): 62 were seated onto a
-- table mid-hand, and in every one another table of the event was between
-- hands at that instant.
--
-- The chooser now ranks a table whose hand permit is `reserved` (a hand in
-- flight; f06_one_hand is a partial unique index on exactly that predicate,
-- so this is an index probe) after every table between hands, behind the
-- existing break-in-progress key and before the free-chair count. It is a
-- ranking, never an exclusion: when every table is mid-hand the chooser picks
-- exactly as before, so it can only remove undealt chairs, never refuse a
-- purchase. The late-registration chooser is unchanged.
--
-- Patched by exact anchor with an md5 pre-image guard, as 20261024193700 did.
--
-- ===========================================================================
-- PROVED FIRST
--
-- The chooser was rebuilt md5-identical (32ed1ece) in a throwaway local
-- PostgreSQL 16, this file applied there, and its post-image asserted
-- (body md5 below). The door was exercised there against stub proofs that
-- refuse with F06_MOVEMENT_WHOLE_ROSTER_REQUIRED, prove, or raise a non-
-- movement 55000: it withdrew (one receipt, park withdrawn_before_manifest,
-- replay returns the same receipt) only for the movement refusal.
-- Nothing was written to production; every production read was a SELECT.
--
-- Pinned by tests/a-parked-table-never-freezes-on-an-unproven-move.law.test.ts.
--
-- @live-proof: (SELECT to_regprocedure('public.fn_f06_withdraw_unproven_movement_park(uuid,uuid,uuid,bigint,uuid,uuid,bigint)') IS NOT NULL AND position('A REBUY IS NOT SEATED UNDER A HAND IN FLIGHT' IN pg_get_functiondef('public.fn_ca_choose_tournament_seat_locked(uuid,uuid,uuid,integer)'::regprocedure))>0)

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $unproven_move_preimage$
DECLARE r record;
BEGIN
  -- Every body this file reads or relies on, exactly as inspected on
  -- 2026-10-25 with pg_get_functiondef. The sibling door is derived from the
  -- withdrawal door below; the proof it asks is f06_movement_prior as
  -- installed by 20261024211825.
  FOR r IN SELECT * FROM (VALUES
    ('public.fn_f06_withdraw_unplaceable_park(uuid,uuid,uuid,bigint,uuid,uuid,bigint)', '8560ec3a35f712126248dee38c9afc8f'),
    ('smarter_private.f06_movement_prior(uuid,uuid)', 'd21b415b4754a19147cce0160de59479'),
    ('smarter_private.f06_prefix(uuid,uuid,uuid[],uuid[])', 'd857e9d6270456d122ef385c751bc5f1'),
    ('smarter_private.f06_immutable_identity()', '31329a1df4bec9c92e0517b38fd42b93')
  ) AS v(sig, body_md5) LOOP
    IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig)) IS DISTINCT FROM r.body_md5 THEN
      RAISE EXCEPTION 'F06_UNPROVEN_MOVE_PREIMAGE: % is not the body inspected', r.sig;
    END IF;
  END LOOP;
  -- The chooser is the body 20261024193700 installed, or this file's own
  -- post-image (a replay).
  IF (SELECT md5(p.prosrc) FROM pg_proc p
       WHERE p.oid = 'public.fn_ca_choose_tournament_seat_locked(uuid,uuid,uuid,integer)'::regprocedure)
     NOT IN ('32ed1ece2bd0e0fe5f53fd92e81448e6', '4d112b360dc96cf4a3ef1036d3a89e8f') THEN
    RAISE EXCEPTION 'F06_UNPROVEN_MOVE_PREIMAGE: fn_ca_choose_tournament_seat_locked is not the body inspected';
  END IF;
  -- The sibling door is new, or is exactly this file's body (a replay).
  IF to_regprocedure('public.fn_f06_withdraw_unproven_movement_park(uuid,uuid,uuid,bigint,uuid,uuid,bigint)') IS NOT NULL
     AND (SELECT md5(p.prosrc) FROM pg_proc p
           WHERE p.oid = to_regprocedure('public.fn_f06_withdraw_unproven_movement_park(uuid,uuid,uuid,bigint,uuid,uuid,bigint)'))
         IS DISTINCT FROM '19f50c8d6e70eb2b83f5a808fb886bad' THEN
    RAISE EXCEPTION 'F06_UNPROVEN_MOVE_PREIMAGE: fn_f06_withdraw_unproven_movement_park exists with another body';
  END IF;
END
$unproven_move_preimage$;

CREATE OR REPLACE FUNCTION public.fn_f06_withdraw_unproven_movement_park(
  p_tournament_id uuid,
  p_lease_generation uuid,
  p_table_id uuid,
  p_lifecycle bigint,
  p_break_id uuid,
  p_park_custody_id uuid,
  p_park_revision bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, smarter_private
AS $withdraw_unproven_movement$
DECLARE h smarter_private.f06_hand_permits; o smarter_private.f06_operations;
 receipt smarter_private.f06_no_start_continuations; users uuid[]; roster jsonb; movement jsonb;
 unsealed bigint; refusal_state text; refusal_message text;
BEGIN
 IF p_tournament_id IS NULL OR p_lease_generation IS NULL OR p_table_id IS NULL OR p_lifecycle IS NULL OR p_lifecycle<1
 OR p_break_id IS NULL OR p_park_custody_id IS NULL OR p_park_revision IS NULL OR p_park_revision<1 THEN
 RAISE EXCEPTION 'F06_WITHDRAWAL_IDENTITY' USING ERRCODE='22023'; END IF;
 SELECT array_agg(user_id ORDER BY user_id) INTO users FROM public.table_seats
 WHERE table_id=p_table_id AND left_at IS NULL;
 -- The live lease holder's exclusive tournament lane, exactly as the
 -- last-table continuation takes it.
 PERFORM smarter_private.f06_prefix(p_tournament_id,p_lease_generation,COALESCE(users,'{}'),ARRAY[p_table_id]);
 SELECT * INTO receipt FROM smarter_private.f06_no_start_continuations WHERE break_id=p_break_id;
 IF FOUND THEN
 IF (receipt.tournament_id,receipt.current_generation,receipt.table_id,receipt.lifecycle,
 (receipt.park->>'custody_id')::uuid,(receipt.park->>'revision')::bigint,receipt.prior_committed->>'kind') IS DISTINCT FROM
 (p_tournament_id,p_lease_generation,p_table_id,p_lifecycle,p_park_custody_id,p_park_revision,'unproven_movement_park_withdrawal'::text) THEN
 RAISE EXCEPTION 'F06_WITHDRAWAL_CHANGED_REPLAY' USING ERRCODE='22023'; END IF;
 ELSE
 IF public.fn_platform_frozen() THEN RAISE EXCEPTION 'PLATFORM_FROZEN: withdrawal refused' USING ERRCODE='55000'; END IF;
 SELECT * INTO o FROM smarter_private.f06_operations WHERE break_id=p_break_id FOR UPDATE;
 IF NOT FOUND OR (o.tournament_id,o.source_table_id,o.lifecycle,o.state,o.custody_id,o.revision)
 IS DISTINCT FROM (p_tournament_id,p_table_id,p_lifecycle,'park_requested'::text,p_park_custody_id,p_park_revision)
 -- Only the park's current custodian, which f06_prefix proved is the live
 -- lease holder, withdraws it.
 OR o.custody_generation IS DISTINCT FROM p_lease_generation
 OR o.manifest IS NOT NULL OR o.close_receipt IS NOT NULL OR o.cleanup_kind IS NOT NULL
 OR o.abort_receipt_id IS NOT NULL
 OR EXISTS(SELECT 1 FROM smarter_private.f06_members WHERE break_id=o.break_id)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_attempts WHERE break_id=o.break_id) THEN
 RAISE EXCEPTION 'F06_WITHDRAWAL_EXACT_PREMANIFEST_PARK' USING ERRCODE='55000'; END IF;
 -- The table's latest hand permit is the positive witness that nothing is in
 -- flight. Either it was decided never_started (a terminal, immutable
 -- outcome) by the generation that parked it or the one that holds its
 -- custody now - a successor that re-claimed the park after an engine
 -- restart holds a new custody id, so the witness's evidence is not required
 -- to equal it - or it is accepted and its hand is sealed: committed
 -- atomically, post-commit completed, in hand_history. The second is the park
 -- whose next hand's permit was never written at all (2026-10-03, 79feebfc:
 -- a begin_hand cancelled by a statement timeout left the dealer's permit
 -- unknown, the zombie watchdog parked the table, and the database holds
 -- nothing after the last sealed hand). The park itself excludes the table
 -- from every later permit, so no hand can start behind either witness.
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE table_id=p_table_id
 ORDER BY hand_number DESC LIMIT 1 FOR UPDATE;
 IF NOT FOUND OR (h.tournament_id,h.lifecycle) IS DISTINCT FROM (p_tournament_id,p_lifecycle)
 OR h.evidence_id IS NULL OR h.state NOT IN ('never_started','accepted')
 OR (h.state='never_started' AND h.generation IS DISTINCT FROM o.origin_generation
     AND h.generation IS DISTINCT FROM o.custody_generation)
 OR (h.state='accepted' AND NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits c
     JOIN public.hand_history x ON x.id=c.hand_id AND x.table_id=c.table_id AND x.hand_number=c.hand_number
     WHERE c.table_id=p_table_id AND c.hand_number=h.hand_number AND c.post_commit_completed_at IS NOT NULL))
 -- One witness answers for one withdrawal; the receipt table keys on it.
 OR EXISTS(SELECT 1 FROM smarter_private.f06_no_start_continuations WHERE permit_id=h.permit_id)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=p_table_id AND state='reserved') THEN
 RAISE EXCEPTION 'F06_WITHDRAWAL_POSITIVE_ORIGINAL_REQUIRED' USING ERRCODE='55000'; END IF;
 -- The first hand number that must have left no trace: the witness's own for
 -- a hand that never started, the next one after a sealed hand.
 unsealed:=CASE WHEN h.state='accepted' THEN h.hand_number+1 ELSE h.hand_number END;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('f06:hand:'||h.permit_id::text,0)) THEN
 RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE='55P03'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id=p_tournament_id AND status='RUNNING'
 AND format_contract IN ('mtt-v1','mtt-v2','sng-v1','spin-v1'))
 OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=p_table_id AND tournament_id=p_tournament_id
 AND f06_lifecycle=p_lifecycle AND lower(status) IN ('waiting','running') AND NOT COALESCE(is_deleted,false)) THEN
 RAISE EXCEPTION 'F06_WITHDRAWAL_OPEN_SOURCE_REQUIRED' USING ERRCODE='55000'; END IF;
 -- The last open table has its own exit, the no-start continuation, for a
 -- never_started witness. That door cannot read a sealed-hand witness, so a
 -- last table parked over one is withdrawn here (2026-10-03: SNG 657e45b2,
 -- table bba21601, heads-up, parked with nothing after its sealed hand).
 IF h.state='never_started' AND (SELECT count(*) FROM public.tables WHERE tournament_id=p_tournament_id AND lower(status)<>'closed'
 AND NOT COALESCE(is_deleted,false))<2 THEN
 RAISE EXCEPTION 'F06_WITHDRAWAL_LAST_TABLE' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM public.table_seats s LEFT JOIN public.tournament_players p
 ON p.tournament_id=p_tournament_id AND p.user_id=s.user_id AND p.table_id=s.table_id
 AND p.seat_number=s.seat_number AND p.status='playing'
 WHERE s.table_id=p_table_id AND s.left_at IS NULL AND (p.id IS NULL OR s.occupancy_id IS NULL
 OR s.joined_at IS NULL OR s.terminal_closed_at IS NOT NULL OR s.stack IS DISTINCT FROM p.chips::numeric
 OR s.stack IS NULL OR s.stack<=0 OR s.stack::text IN ('NaN','Infinity','-Infinity')))
 OR EXISTS(SELECT 1 FROM public.tournament_players p WHERE p.tournament_id=p_tournament_id AND p.table_id=p_table_id
 AND p.status IN ('playing','registered') AND NOT EXISTS(SELECT 1 FROM public.table_seats s WHERE s.table_id=p_table_id
 AND s.user_id=p.user_id AND s.seat_number=p.seat_number AND s.left_at IS NULL)) THEN
 RAISE EXCEPTION 'F06_WITHDRAWAL_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT jsonb_agg(jsonb_build_object('seat_id',s.id,'occupancy_id',s.occupancy_id,'registration_id',p.id,
 'user_id',s.user_id,'joined_at',s.joined_at,'table_id',s.table_id,'seat_number',s.seat_number,'stack',s.stack,'chips',p.chips) ORDER BY s.user_id)
 INTO roster FROM public.table_seats s JOIN public.tournament_players p
 ON p.tournament_id=p_tournament_id AND p.user_id=s.user_id AND p.table_id=s.table_id AND p.seat_number=s.seat_number AND p.status='playing'
 WHERE s.table_id=p_table_id AND s.left_at IS NULL;
 IF roster IS NULL OR jsonb_array_length(roster) NOT BETWEEN 2 AND 10
 OR (SELECT count(DISTINCT x->>'user_id') FROM jsonb_array_elements(roster) x)<>jsonb_array_length(roster)
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=p_table_id AND hand_number>=unsealed)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=p_table_id AND hand_number>=unsealed)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=p_table_id AND hand_number>=unsealed)
 OR EXISTS(SELECT 1 FROM public.table_hole_cards WHERE table_id=p_table_id AND hand_number>=unsealed)
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=p_table_id AND NOT is_complete)
 OR (h.state='never_started' AND EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch WHERE permit_id=h.permit_id)) THEN
 RAISE EXCEPTION 'F06_WITHDRAWAL_STARTED_OR_ROSTER_CHANGED' USING ERRCODE='55000'; END IF;
 -- A PARKED TABLE NEVER FREEZES ON AN UNPROVEN MOVE (2026-10-25). The park
 -- exists to move this roster, and the movement proof is what refuses it. Ask
 -- that proof exactly as fn_f06_admit_parked_movement asks it. If it proves
 -- the roster, the break can go on and nothing is withdrawn. If it refuses
 -- with one of its own named F06_MOVEMENT_* refusals (55000), that refusal is
 -- written into the receipt, and the park, which never began and moves
 -- nothing, is withdrawn so the table deals. Any other error propagates.
 BEGIN
 movement:=smarter_private.f06_movement_prior(p_tournament_id,p_table_id);
 EXCEPTION WHEN SQLSTATE '55000' THEN
 GET STACKED DIAGNOSTICS refusal_state=RETURNED_SQLSTATE, refusal_message=MESSAGE_TEXT;
 IF refusal_message NOT LIKE 'F06\_MOVEMENT\_%' THEN RAISE; END IF;
 END;
 IF refusal_message IS NULL THEN
 RAISE EXCEPTION 'F06_WITHDRAWAL_MOVEMENT_PROVEN' USING ERRCODE='55000'; END IF;
 INSERT INTO smarter_private.f06_no_start_continuations
 (break_id,permit_id,tournament_id,table_id,lifecycle,hand_number,original_generation,current_generation,park,permit,roster,prior_committed)
 VALUES(o.break_id,h.permit_id,p_tournament_id,p_table_id,p_lifecycle,h.hand_number,o.origin_generation,p_lease_generation,to_jsonb(o),to_jsonb(h),roster,
 jsonb_build_object('kind','unproven_movement_park_withdrawal','roster_size',jsonb_array_length(roster),
 'witness',h.state,'movement_refusal',jsonb_build_object('sqlstate',refusal_state,'message',refusal_message)))
 RETURNING * INTO receipt;
 -- The receipt names the park's exact pre-image; f06_immutable_identity
 -- admits this one transition and makes it permanent.
 UPDATE smarter_private.f06_operations SET state='withdrawn_before_manifest',abort_receipt_id=receipt.receipt_id WHERE break_id=o.break_id;
 END IF;
 RETURN jsonb_build_object('ok',true,'state','withdrawn_unproven_movement','receipt_id',receipt.receipt_id,
 'tournament_id',receipt.tournament_id,'table_id',receipt.table_id,'lifecycle',receipt.lifecycle::text,
 'break_id',receipt.break_id,'park_custody_id',receipt.park->>'custody_id','park_revision',receipt.park->>'revision',
 'lease_generation',receipt.current_generation,'original_generation',receipt.original_generation,
 'permit_id',receipt.permit_id,'hand_number',receipt.hand_number::text,
 'roster_size',(receipt.prior_committed->>'roster_size')::integer,
 'movement_refusal',receipt.prior_committed#>>'{movement_refusal,message}','credit',0);
END
$withdraw_unproven_movement$;

ALTER FUNCTION public.fn_f06_withdraw_unproven_movement_park(uuid,uuid,uuid,bigint,uuid,uuid,bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_f06_withdraw_unproven_movement_park(uuid,uuid,uuid,bigint,uuid,uuid,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_withdraw_unproven_movement_park(uuid,uuid,uuid,bigint,uuid,uuid,bigint) TO service_role;

DO $a_rebuy_is_not_seated_under_a_hand_in_flight$
DECLARE
  v_sig constant regprocedure :=
    'public.fn_ca_choose_tournament_seat_locked(uuid,uuid,uuid,integer)'::regprocedure;
  v_marker constant text := 'A REBUY IS NOT SEATED UNDER A HAND IN FLIGHT';
  v_def text;
  v_old constant text := E'          AND o.state NOT IN (\'acknowledged\',\'withdrawn_before_manifest\')),\n     (\n       SELECT count(*)\n';
  v_new constant text := E'          AND o.state NOT IN (\'acknowledged\',\'withdrawn_before_manifest\')),\n     -- A REBUY IS NOT SEATED UNDER A HAND IN FLIGHT (2026-10-25): a table\n     -- whose hand permit is still reserved is dealing a hand that cannot deal\n     -- this chair, so it sorts after every table between hands.\n     EXISTS (\n       SELECT 1 FROM smarter_private.f06_hand_permits hp\n        WHERE hp.table_id=tb.id AND hp.state=\'reserved\'),\n     (\n       SELECT count(*)\n';
BEGIN
  IF position(v_marker IN (SELECT prosrc FROM pg_proc WHERE oid = v_sig)) > 0 THEN
    RETURN; -- already installed
  END IF;
  v_def := pg_get_functiondef(v_sig);
  IF (length(v_def) - length(replace(v_def, v_old, ''))) <> length(v_old) THEN
    RAISE EXCEPTION 'chooser in-flight anchor is not present exactly once';
  END IF;
  EXECUTE replace(v_def, v_old, v_new);
END
$a_rebuy_is_not_seated_under_a_hand_in_flight$;

DO $unproven_move_postimage$
DECLARE p pg_proc;
BEGIN
  SELECT * INTO p FROM pg_proc
   WHERE oid = to_regprocedure('public.fn_f06_withdraw_unproven_movement_park(uuid,uuid,uuid,bigint,uuid,uuid,bigint)');
  IF NOT FOUND
     OR md5(p.prosrc) IS DISTINCT FROM '19f50c8d6e70eb2b83f5a808fb886bad'
     OR pg_get_userbyid(p.proowner) IS DISTINCT FROM 'postgres'
     OR NOT p.prosecdef OR p.provolatile IS DISTINCT FROM 'v'
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, smarter_private']
     OR p.prorettype IS DISTINCT FROM 'jsonb'::regtype
     OR (SELECT array_agg(a::text ORDER BY a::text) FROM unnest(p.proacl) a)
        IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres'] THEN
    RAISE EXCEPTION 'F06_UNPROVEN_MOVE_POSTIMAGE: the door is not the body, owner, ACL or configuration stated';
  END IF;
  -- The withdrawal door it was derived from is untouched.
  IF (SELECT md5(prosrc) FROM pg_proc
       WHERE oid = 'public.fn_f06_withdraw_unplaceable_park(uuid,uuid,uuid,bigint,uuid,uuid,bigint)'::regprocedure)
     IS DISTINCT FROM '8560ec3a35f712126248dee38c9afc8f' THEN
    RAISE EXCEPTION 'F06_UNPROVEN_MOVE_POSTIMAGE: fn_f06_withdraw_unplaceable_park changed';
  END IF;
  SELECT * INTO p FROM pg_proc
   WHERE oid = 'public.fn_ca_choose_tournament_seat_locked(uuid,uuid,uuid,integer)'::regprocedure;
  IF md5(p.prosrc) IS DISTINCT FROM '4d112b360dc96cf4a3ef1036d3a89e8f'
     OR NOT p.prosecdef
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp','statement_timeout=30s']::text[]
     OR has_function_privilege('service_role', p.oid, 'EXECUTE')
     OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
     OR has_function_privilege('anon', p.oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'F06_UNPROVEN_MOVE_POSTIMAGE: the chooser is not the body, settings or private grant stated';
  END IF;
END
$unproven_move_postimage$;

COMMIT;
