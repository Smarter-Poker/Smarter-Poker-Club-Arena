-- 20261003021958_a_park_over_a_committed_hand_is_withdrawn_when_its_roster_ca.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch. This file REPLACES the body of one function,
-- public.fn_f06_withdraw_unplaceable_park (20261002142740), and changes
-- nothing else: same signature, owner, ACL, configuration, receipt and
-- writes. It moves no chip, seat, registration or money.
--
-- ===========================================================================
-- WHAT WAS WRONG, READ FROM ROWS AND LOG LINES (2026-10-03)
--
-- 79feebfc "Prime Time Free Buy (NLH)" (about 290 playing, 31 nine-max tables
-- open). A Supabase IO stall at 01:07-01:08Z timed out fn_f06_begin_hand on
-- many tables; their dealers' permits stayed unknown, the zombie watchdog
-- rebuilt them at 01:10Z, and stopped-original recovery parked every one for
-- a table break. Fifteen full tables (135 players) have been parked since,
-- each logging `destinations_full:N_of_9_placed_across_16_tables` every sweep:
-- the field needs every table it has, so none of the breaks can ever begin.
--
-- fn_f06_withdraw_unplaceable_park is the door for exactly this, but it has
-- never fired in production (no receipt of kind unplaceable_park_withdrawal
-- exists), and for six of the fifteen it could not: their latest permit is
-- the ACCEPTED, sealed previous hand (a1697be4 20846402, 341e9d11 20846776,
-- 269366b3 20846550, bfa4a914 20846017, 4560471f 20846847, 4d63a4af
-- 20846585). The timed-out begin_hand rolled back, so no never_started row
-- exists to witness the park, and the door refused
-- F06_WITHDRAWAL_POSITIVE_ORIGINAL_REQUIRED. SNG 657e45b2 "PLO4 Heads-Up 5"
-- (table bba21601, the event's only table) is the same shape at the last
-- table: latest permit accepted (20901612), so the last-table continuation
-- refuses too and the heads-up match is frozen.
--
-- ===========================================================================
-- WHAT THIS CHANGES
--
-- The witness may also be the table's latest permit ACCEPTED with its hand
-- sealed (atomic commit with post-commit completed, and its hand_history
-- row). Then the trace checks start at the next hand number, and the
-- dispatch check (a sealed hand was dispatched by definition) applies only
-- to a never_started witness. A park over a sealed hand may be withdrawn on
-- the event's last table as well, because the continuation cannot read that
-- witness. A permit already named by a receipt cannot witness a second one.
-- Every other condition - identity, live-lease prefix, exact pre-manifest
-- park held by the caller, no reserved permit, RUNNING event, open source,
-- whole roster proven by f06_movement_prior, fewer free seats elsewhere than
-- the roster - is unchanged, and the receipt records which witness it took.
-- ===========================================================================

BEGIN;

DO $withdraw_sealed_preimage$
DECLARE r record;
BEGIN
  -- The body this replaces, exactly as installed by 20261002142740.
  IF (SELECT md5(p.prosrc) FROM pg_proc p
       WHERE p.oid = to_regprocedure('public.fn_f06_withdraw_unplaceable_park(uuid,uuid,uuid,bigint,uuid,uuid,bigint)'))
     IS DISTINCT FROM 'bda3af4b7eb6977b9375fce72d731b9f' THEN
    RAISE EXCEPTION 'F06_WITHDRAW_SEALED_PREIMAGE: fn_f06_withdraw_unplaceable_park is not the body inspected';
  END IF;
  FOR r IN SELECT * FROM (VALUES
    ('smarter_private.f06_prefix(uuid,uuid,uuid[],uuid[])', 'd857e9d6270456d122ef385c751bc5f1'),
    ('smarter_private.f06_movement_prior(uuid,uuid)', 'c63825076c08ec077a480a57cc8ae79a'),
    ('smarter_private.f06_immutable_identity()', '31329a1df4bec9c92e0517b38fd42b93')
  ) AS v(sig, body_md5) LOOP
    IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig)) IS DISTINCT FROM r.body_md5 THEN
      RAISE EXCEPTION 'F06_WITHDRAW_SEALED_PREIMAGE: % is not the body inspected', r.sig;
    END IF;
  END LOOP;
END
$withdraw_sealed_preimage$;

CREATE OR REPLACE FUNCTION public.fn_f06_withdraw_unplaceable_park(
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
AS $withdraw_unplaceable$
DECLARE h smarter_private.f06_hand_permits; o smarter_private.f06_operations;
 receipt smarter_private.f06_no_start_continuations; users uuid[]; roster jsonb; movement jsonb;
 free_seats bigint; destinations integer; unknown_capacity integer; unsealed bigint;
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
 (p_tournament_id,p_lease_generation,p_table_id,p_lifecycle,p_park_custody_id,p_park_revision,'unplaceable_park_withdrawal'::text) THEN
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
 RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE='40001'; END IF;
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
 -- The break cannot place this roster: the other open tables that hold
 -- players and are not themselves break sources have fewer free seats.
 SELECT count(*)::integer, COALESCE(sum(GREATEST(0,t.max_players-c.seated)),0),
 (count(*) FILTER (WHERE t.max_players IS NULL OR t.max_players<2))::integer
 INTO destinations, free_seats, unknown_capacity
 FROM public.tables t
 CROSS JOIN LATERAL (SELECT count(*)::integer AS seated FROM public.table_seats s
 WHERE s.table_id=t.id AND s.left_at IS NULL) c
 WHERE t.tournament_id=p_tournament_id AND t.id<>p_table_id
 AND lower(t.status) IN ('running','waiting','active') AND NOT COALESCE(t.is_deleted,false) AND c.seated>0
 AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_operations x WHERE x.source_table_id=t.id
 AND x.state NOT IN ('acknowledged','withdrawn_before_manifest'));
 IF unknown_capacity>0 THEN RAISE EXCEPTION 'F06_WITHDRAWAL_CAPACITY_UNKNOWN' USING ERRCODE='55000'; END IF;
 IF free_seats>=jsonb_array_length(roster) THEN
 RAISE EXCEPTION 'F06_WITHDRAWAL_ROSTER_FITS' USING ERRCODE='55000'; END IF;
 -- The whole roster, proven exactly as any movement admission of this park
 -- proves it. Anything it cannot prove refuses here.
 movement:=smarter_private.f06_movement_prior(p_tournament_id,p_table_id);
 INSERT INTO smarter_private.f06_no_start_continuations
 (break_id,permit_id,tournament_id,table_id,lifecycle,hand_number,original_generation,current_generation,park,permit,roster,prior_committed)
 VALUES(o.break_id,h.permit_id,p_tournament_id,p_table_id,p_lifecycle,h.hand_number,o.origin_generation,p_lease_generation,to_jsonb(o),to_jsonb(h),roster,
 jsonb_build_object('kind','unplaceable_park_withdrawal','roster_size',jsonb_array_length(roster),
 'free_seats',free_seats,'destination_tables',destinations,'witness',h.state,'movement_prior',movement))
 RETURNING * INTO receipt;
 -- The receipt names the park's exact pre-image; f06_immutable_identity
 -- admits this one transition and makes it permanent.
 UPDATE smarter_private.f06_operations SET state='withdrawn_before_manifest',abort_receipt_id=receipt.receipt_id WHERE break_id=o.break_id;
 END IF;
 RETURN jsonb_build_object('ok',true,'state','withdrawn_unplaceable','receipt_id',receipt.receipt_id,
 'tournament_id',receipt.tournament_id,'table_id',receipt.table_id,'lifecycle',receipt.lifecycle::text,
 'break_id',receipt.break_id,'park_custody_id',receipt.park->>'custody_id','park_revision',receipt.park->>'revision',
 'lease_generation',receipt.current_generation,'original_generation',receipt.original_generation,
 'permit_id',receipt.permit_id,'hand_number',receipt.hand_number::text,
 'roster_size',(receipt.prior_committed->>'roster_size')::integer,'free_seats',(receipt.prior_committed->>'free_seats')::bigint,'credit',0);
END
$withdraw_unplaceable$;

ALTER FUNCTION public.fn_f06_withdraw_unplaceable_park(uuid,uuid,uuid,bigint,uuid,uuid,bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_f06_withdraw_unplaceable_park(uuid,uuid,uuid,bigint,uuid,uuid,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_withdraw_unplaceable_park(uuid,uuid,uuid,bigint,uuid,uuid,bigint) TO service_role;

DO $withdraw_sealed_postimage$
DECLARE p pg_proc;
BEGIN
  SELECT * INTO p FROM pg_proc
   WHERE oid = to_regprocedure('public.fn_f06_withdraw_unplaceable_park(uuid,uuid,uuid,bigint,uuid,uuid,bigint)');
  IF NOT FOUND
     OR md5(p.prosrc) IS DISTINCT FROM '1f5ce9675af70bc16b69157ca122ce06'
     OR pg_get_userbyid(p.proowner) IS DISTINCT FROM 'postgres'
     OR NOT p.prosecdef OR p.provolatile IS DISTINCT FROM 'v'
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, smarter_private']
     OR p.prorettype IS DISTINCT FROM 'jsonb'::regtype
     OR (SELECT array_agg(a::text ORDER BY a::text) FROM unnest(p.proacl) a)
        IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres'] THEN
    RAISE EXCEPTION 'F06_WITHDRAW_SEALED_POSTIMAGE: the function is not the body, owner, ACL or configuration stated';
  END IF;
END
$withdraw_sealed_postimage$;

COMMIT;
