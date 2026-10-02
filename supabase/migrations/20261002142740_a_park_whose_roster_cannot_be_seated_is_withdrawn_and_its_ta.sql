-- 20261002142740_a_park_whose_roster_cannot_be_seated_is_withdrawn_and_its_ta.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch. This file ADDS one function,
-- public.fn_f06_withdraw_unplaceable_park, and changes nothing else. The
-- function writes exactly what fn_f06_continue_no_start_last_table writes for
-- a park that never began: one immutable receipt row and the park's own state.
-- It moves no chip, seat, registration or money.
--
-- ===========================================================================
-- WHAT WAS WRONG, READ FROM ROWS AND LOG LINES (2026-10-02)
--
-- 4d2afa41 "Morning Free Buy (NLH)" (286 playing on 32 nine-max tables at
-- 14:18Z). Seven full tables (62 players) have been parked since 13:28Z by
-- park_requested table breaks whose manifests were never written. Every park's
-- latest hand permit is never_started with the park's own custody as evidence,
-- so nothing is in flight; the engine re-reads each park every sweep and logs
--
--   [Tournament:4d2afa41] Break 4f208f2b not begun:
--     destinations_full:7_of_9_placed_across_25_tables
--
-- The 25 tables that still deal held SIX free seats between them. 286 players
-- need 32 nine-max tables, so no table of this field can be broken at all;
-- a park waits until enough players bust elsewhere, one table at a time, and
-- for that whole wait its nine players are dealt nothing. Industry standard is
-- the opposite: a table is broken only when its players can be seated now, and
-- otherwise it keeps playing.
--
-- The only door that withdraws an unbegun park is
-- fn_f06_continue_no_start_last_table, and it refuses anything but the
-- event's LAST open table.
--
-- ===========================================================================
-- WHAT THIS ADDS
--
-- fn_f06_withdraw_unplaceable_park, the same door for a table that is NOT the
-- last one, admitted only when its roster cannot be seated:
--   * the same identity, live-lease prefix (f06_prefix) and replay receipt as
--     the last-table continuation; a replay must name the same withdrawal;
--   * the park is exactly the one named, park_requested, never manifested,
--     closed, cleaned or aborted, with no member and no attempt, and its
--     custody is held by the caller, the live lease holder;
--   * the table's latest hand permit is never_started (terminal) by the
--     generation that parked it or the one holding its custody, no permit of
--     the table is reserved, and no hand at or after it has any commit,
--     history, private state, hole cards, dispatch or open snapshot. After an
--     engine restart the successor re-claims the park under a new custody id
--     (4d2afa41 at 14:34Z: d8185c67 and 157ca851 now name 787428f3), so the
--     permit's evidence need not equal the park's current custody;
--   * the event is RUNNING, the table is open in this lifecycle and is NOT the
--     last open table (that one takes the continuation);
--   * every seated chair is a playing registration with the same chips, and
--     the whole roster is proven by smarter_private.f06_movement_prior, the
--     proof every movement admission of a park takes;
--   * the free seats of every other open table that holds players and is not
--     itself a break source are FEWER than the roster: the break cannot place
--     it. Otherwise the function refuses F06_WITHDRAWAL_ROSTER_FITS.
-- The receipt goes into smarter_private.f06_no_start_continuations, the
-- receipt table f06_immutable_identity already requires for a
-- withdrawn_before_manifest park (receipt park = the park's exact pre-image),
-- with prior_committed naming kind 'unplaceable_park_withdrawal', the roster
-- size, the free seats counted and the movement proof. The park becomes
-- withdrawn_before_manifest; nothing else is written. The engine then
-- readmits the table, which deals again, and the balancer parks it again only
-- when the field has room for it.
--
-- New function: owner postgres, SECURITY DEFINER, search_path
-- pg_catalog, public, smarter_private, EXECUTE for postgres and service_role
-- only (stated explicitly: service_role's default privilege is restated, and
-- PUBLIC, anon and authenticated are revoked).
-- ===========================================================================

BEGIN;

DO $withdraw_unplaceable_preimage$
DECLARE r record;
BEGIN
  IF to_regprocedure('public.fn_f06_withdraw_unplaceable_park(uuid,uuid,uuid,bigint,uuid,uuid,bigint)') IS NOT NULL THEN
    RAISE EXCEPTION 'F06_WITHDRAW_UNPLACEABLE_PREIMAGE: fn_f06_withdraw_unplaceable_park already exists';
  END IF;
  -- Every body this function relies on, exactly as read on production.
  FOR r IN SELECT * FROM (VALUES
    ('smarter_private.f06_prefix(uuid,uuid,uuid[],uuid[])', 'd857e9d6270456d122ef385c751bc5f1'),
    ('smarter_private.f06_movement_prior(uuid,uuid)', 'c63825076c08ec077a480a57cc8ae79a'),
    ('smarter_private.f06_immutable_identity()', '31329a1df4bec9c92e0517b38fd42b93')
  ) AS v(sig, body_md5) LOOP
    IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig)) IS DISTINCT FROM r.body_md5
       OR NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig)
                         AND pg_get_userbyid(p.proowner) = 'postgres' AND p.prosecdef AND p.provolatile = 'v') THEN
      RAISE EXCEPTION 'F06_WITHDRAW_UNPLACEABLE_PREIMAGE: % is not the body, owner or volatility inspected', r.sig;
    END IF;
  END LOOP;
  -- The withdrawal door this receipt satisfies is the enabled immutability trigger.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'smarter_private.f06_operations'::regclass
                    AND tgname = 'f06_operations_immutable'
                    AND tgfoid = 'smarter_private.f06_immutable_identity()'::regprocedure
                    AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'F06_WITHDRAW_UNPLACEABLE_PREIMAGE: f06_operations_immutable is not the enabled withdrawal door';
  END IF;
  IF (SELECT string_agg(column_name || ':' || data_type, ',' ORDER BY ordinal_position)
        FROM information_schema.columns
       WHERE table_schema = 'smarter_private' AND table_name = 'f06_no_start_continuations')
     IS DISTINCT FROM 'receipt_id:uuid,break_id:uuid,permit_id:uuid,tournament_id:uuid,table_id:uuid,lifecycle:bigint,hand_number:bigint,original_generation:uuid,current_generation:uuid,park:jsonb,permit:jsonb,roster:jsonb,prior_committed:jsonb,created_at:timestamp with time zone' THEN
    RAISE EXCEPTION 'F06_WITHDRAW_UNPLACEABLE_PREIMAGE: f06_no_start_continuations is not the receipt shape inspected';
  END IF;
END
$withdraw_unplaceable_preimage$;

CREATE FUNCTION public.fn_f06_withdraw_unplaceable_park(
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
 free_seats bigint; destinations integer; unknown_capacity integer;
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
 -- The table's latest hand permit, decided never_started (a terminal,
 -- immutable outcome) by the generation that parked it or the one that holds
 -- its custody now, is the positive witness that nothing is in flight. A
 -- successor that re-claimed the park after an engine restart holds a new
 -- custody id, so the witness's evidence is not required to equal it.
 SELECT * INTO h FROM smarter_private.f06_hand_permits WHERE table_id=p_table_id
 ORDER BY hand_number DESC LIMIT 1 FOR UPDATE;
 IF NOT FOUND OR (h.tournament_id,h.lifecycle,h.state) IS DISTINCT FROM
 (p_tournament_id,p_lifecycle,'never_started'::text) OR h.evidence_id IS NULL
 OR (h.generation IS DISTINCT FROM o.origin_generation AND h.generation IS DISTINCT FROM o.custody_generation)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_permits WHERE table_id=p_table_id AND state='reserved') THEN
 RAISE EXCEPTION 'F06_WITHDRAWAL_POSITIVE_ORIGINAL_REQUIRED' USING ERRCODE='55000'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('f06:hand:'||h.permit_id::text,0)) THEN
 RAISE EXCEPTION 'F06_HAND_DISPATCH_BUSY' USING ERRCODE='40001'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.tournaments WHERE id=p_tournament_id AND status='RUNNING'
 AND format_contract IN ('mtt-v1','mtt-v2','sng-v1','spin-v1'))
 OR NOT EXISTS(SELECT 1 FROM public.tables WHERE id=p_table_id AND tournament_id=p_tournament_id
 AND f06_lifecycle=p_lifecycle AND lower(status) IN ('waiting','running') AND NOT COALESCE(is_deleted,false)) THEN
 RAISE EXCEPTION 'F06_WITHDRAWAL_OPEN_SOURCE_REQUIRED' USING ERRCODE='55000'; END IF;
 -- The last open table has its own exit, the no-start continuation.
 IF (SELECT count(*) FROM public.tables WHERE tournament_id=p_tournament_id AND lower(status)<>'closed'
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
 OR EXISTS(SELECT 1 FROM public.hand_atomic_commits WHERE table_id=p_table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_history WHERE table_id=p_table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_private_state WHERE table_id=p_table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.table_hole_cards WHERE table_id=p_table_id AND hand_number>=h.hand_number)
 OR EXISTS(SELECT 1 FROM public.hand_state_snapshots WHERE table_id=p_table_id AND NOT is_complete)
 OR EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch WHERE permit_id=h.permit_id) THEN
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
 'free_seats',free_seats,'destination_tables',destinations,'movement_prior',movement))
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

DO $withdraw_unplaceable_postimage$
DECLARE p pg_proc;
BEGIN
  SELECT * INTO p FROM pg_proc
   WHERE oid = to_regprocedure('public.fn_f06_withdraw_unplaceable_park(uuid,uuid,uuid,bigint,uuid,uuid,bigint)');
  IF NOT FOUND
     OR md5(p.prosrc) IS DISTINCT FROM 'bda3af4b7eb6977b9375fce72d731b9f'
     OR pg_get_userbyid(p.proowner) IS DISTINCT FROM 'postgres'
     OR NOT p.prosecdef OR p.provolatile IS DISTINCT FROM 'v'
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, smarter_private']
     OR p.prorettype IS DISTINCT FROM 'jsonb'::regtype
     OR (SELECT array_agg(a::text ORDER BY a::text) FROM unnest(p.proacl) a)
        IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres'] THEN
    RAISE EXCEPTION 'F06_WITHDRAW_UNPLACEABLE_POSTIMAGE: the function is not the body, owner, ACL or configuration stated';
  END IF;
  -- Nothing this file relies on moved underneath it.
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'smarter_private.f06_movement_prior(uuid,uuid)'::regprocedure)
       IS DISTINCT FROM 'c63825076c08ec077a480a57cc8ae79a'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'smarter_private.f06_immutable_identity()'::regprocedure)
       IS DISTINCT FROM '31329a1df4bec9c92e0517b38fd42b93' THEN
    RAISE EXCEPTION 'F06_WITHDRAW_UNPLACEABLE_POSTIMAGE: a relied-on body changed';
  END IF;
END
$withdraw_unplaceable_postimage$;

COMMIT;
