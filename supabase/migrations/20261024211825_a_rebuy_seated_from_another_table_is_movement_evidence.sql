-- 20261024211825_a_rebuy_seated_from_another_table_is_movement_evidence.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch. This file changes ONE reader,
-- smarter_private.f06_movement_prior. It schedules nothing, retries nothing,
-- writes no row and moves no chip.
--
-- ===========================================================================
-- WHAT WAS WRONG, READ FROM ROWS (2026-10-24)
--
-- 12135e5b "Union PKO Afternoon (PLO4)" (Diamonds, 27 players live): Table 13
-- (3e3d1587) has dealt nothing since 19:53:39 UTC with 5 players seated,
-- while Tables 3, 5, 6 and 9 kept dealing. The engine's every re-admission of
-- its park (break 5135b05b, park_requested 19:53:41.56) is refused, and an
-- engine restart (21:00 UTC) did not clear it:
--
--   f06_movement_admission_unproven [55000]: F06_MOVEMENT_WHOLE_ROSTER_REQUIRED
--
-- TylerRVA (fb825ba4) busted on Table 16 (da33eedb) at 19:53:26 and rebought
-- at 19:53:30.71. The purchase records its funding receipt (75852135) BEFORE
-- it chooses a chair, so that receipt's registration image still names Table
-- 16; fn_ca_choose_tournament_seat_locked then seated him on Table 13, seat 5
-- (5f98a004, 6,000 chips, joined 19:53:30.74) while Table 13's hand 46740543
-- was being dealt, so that sealed hand (19:53:40.14) did not deal him. His
-- purchase's immutable result (entry_purchase_idempotency_receipts, knockout
-- candidate e41ad793 rebought) names exactly that chair. Balancing parked the
-- table 1.4 s later.
--
-- f06_movement_prior admits an undealt chair by a move receipt, by a rebuy
-- whose receipt AND bust are on THIS table, or by an entry recorded no earlier
-- than the chair was taken. A rebuy seated from another table matches none,
-- so the event can never finish: those 5 players can neither play, move nor
-- bust. f06_movement_never_dealt_prior already admits exactly this purchase
-- (20261021172832, rebuy_proven); the dealt-table proof never got the rule.
--
-- WHAT CHANGES
--
-- One passage is added to the arrival loop, after the same-table rebuy rule
-- and before the entry rule: the rebuy_proven predicate of
-- f06_movement_never_dealt_prior (purchase result names this chair, seat
-- number and stack; candidate rebought from 0 in a sealed bust hand on any
-- table of this event; paid by its chip ledger and wallet debit or its diamond
-- custody; registration playing on exactly this chair with exactly these
-- chips; no later receipt; no stack exit), plus what a DEALT table must also
-- show: no move of the player since the bust, no committed hand on this table
-- has dealt the chair since it was taken, and it was taken before this park.
-- It is recorded as an entry with its atomic_purchase key, so the purchase
-- loop, the seat, registration and roster checks below still apply unchanged.
--
-- Every other refusal, and every proof that needs no such rebuy, is unchanged:
-- removing the one passage reproduces the pre-image body byte for byte
-- (asserted below), and a proof with no such entry is byte-identical.
--
-- Same signature, owner (postgres), ACL {postgres=X/postgres}, SECURITY
-- DEFINER, volatility and search_path.
--
-- PROVED FIRST (CLAUDE.md 11.5): in ONE Supabase MCP call (2026-10-24 ~21:30
-- UTC) the live pre-image body (d2ead738) was read, the passage spliced in
-- (post-image body d21b415b, asserted), both installed as pg_temp functions
-- with row locks stripped, the transaction switched READ ONLY, and both run on
-- Table 13, ending in RAISE (rolled back):
--   installed (d2ead738): F06_MOVEMENT_WHOLE_ROSTER_REQUIRED
--   post-image          : roster 5, eliminated 1 (busted in hand 46740543),
--                         entry fb825ba4 as rebuy 75852135 (6,000 chips,
--                         atomic_purchase ...:candidate:e41ad793), no
--                         purchases, no arrivals
--
-- Release: no row is touched. The engine's existing park re-admission
-- (startParkedMovementEngine -> fn_f06_admit_parked_movement) takes the proof
-- on its next pass and the break proceeds through fn_f06_begin_break and the
-- normal move receipts. No repair job, no abort, no seat write.
--
-- NOT TOUCHED: fn_f06_admit_parked_movement, f06_assert_movement,
-- f06_movement_never_dealt_prior, process_tournament_rebuy.
--
-- Pinned by tests/a-rebuy-seated-from-another-table-is-movement-evidence.law.test.ts.

-- @live-proof: (SELECT md5(prosrc)='d21b415b4754a19147cce0160de59479' AND md5(pg_get_functiondef(oid))='ddbca56b65a99f017fb86e791b2fb971' AND proacl::text='{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_movement_prior(uuid,uuid)'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

DO $cross_table_rebuy_preimage$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = to_regprocedure('smarter_private.f06_movement_prior(uuid,uuid)')
       AND md5(p.prosrc) = 'd2ead73888242bf1d29bf7635bb0fa90'
       AND md5(pg_get_functiondef(p.oid)) = 'cd75d4888abb11fbb33daba617e7d589'
       AND pg_get_userbyid(p.proowner) = 'postgres'
       AND p.proacl::text = '{postgres=X/postgres}'
       AND p.proconfig = ARRAY['search_path=pg_catalog, public, smarter_private']
       AND p.prosecdef AND p.provolatile = 'v'
       AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')) THEN
    RAISE EXCEPTION 'F06_MOVEMENT_CROSS_TABLE_REBUY_PREIMAGE_DRIFT: smarter_private.f06_movement_prior(uuid,uuid)';
  END IF;
END
$cross_table_rebuy_preimage$;

CREATE OR REPLACE FUNCTION smarter_private.f06_movement_prior(p_tournament uuid, p_table uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $cross_table_rebuy_prior$
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
 -- Or a rebuy (or re-entry) the event seated straight into this chair after
 -- the player busted on ANY table of this event, while (or after) the proven
 -- hand was dealt, so that hand did not deal it (2026-10-24). The purchase
 -- records its funding receipt before it chooses a chair, so that receipt's
 -- registration image still names the bust table; only the purchase's own
 -- immutable whole-transaction result names this chair. It is admitted only
 -- by its rows, exactly as f06_movement_never_dealt_prior admits it: the
 -- player's latest funding receipt is that purchase, paid (chip ledger and
 -- wallet debit, or diamond custody), granting exactly this chair's stack;
 -- its purchase result seated it in exactly this chair row, seat number and
 -- stack, from its knockout candidate, rebought from 0 in a sealed hand; the
 -- registration plays on exactly this chair with exactly those chips; no
 -- later receipt, no stack exit from this chair, no move of the player since
 -- that bust, and no committed hand on this table has dealt it since it sat;
 -- and it sat before this park. Its chips are that grant plus any receipted
 -- purchase after it.
 fund:=NULL; registration:=NULL;
 SELECT f.* INTO fund FROM public.tournament_participant_funding_receipts f
 WHERE f.tournament_id=p_tournament AND f.user_id=seat.user_id
 ORDER BY f.observed_at DESC,f.id DESC LIMIT 1;
 SELECT r.* INTO registration FROM public.tournament_players r WHERE r.tournament_id=p_tournament AND r.user_id=seat.user_id;
 IF fund.id IS NOT NULL AND fund.operation IN ('rebuy','reentry') AND registration.id IS NOT NULL AND EXISTS(
  SELECT 1 FROM public.entry_purchase_idempotency_receipts pr
  JOIN public.tournament_knockout_candidates c ON c.id=(pr.request->>'candidate_id')::uuid
  JOIN public.hand_atomic_commits bc ON bc.table_id=c.table_id AND bc.hand_number=c.hand_number AND bc.hand_id=c.hand_id
  LEFT JOIN public.chip_ledger l ON l.id=fund.ledger_id
  LEFT JOIN public.wallet_transactions w ON w.id=fund.wallet_transaction_id
  WHERE pr.key_domain='tournament_chip_purchase' AND pr.idempotency_key=fund.purchase_key
  AND fund.amount>0 AND fund.user_id=seat.user_id AND fund.registration_id=registration.id
  AND seat.user_id IS NOT NULL AND seat.occupancy_id IS NOT NULL AND seat.joined_at IS NOT NULL
  AND seat.stack>0 AND seat.stack=trunc(seat.stack)
  AND registration.status='playing' AND registration.eliminated_at IS NULL
  AND (registration.table_id,registration.seat_number) IS NOT DISTINCT FROM (seat.table_id,seat.seat_number)
  AND registration.chips::numeric=seat.stack
  AND fund.registration_snapshot->>'id'=registration.id::text
  AND fund.registration_snapshot->>'user_id'=seat.user_id::text
  AND fund.tournament_snapshot->>'id'=p_tournament::text
  AND jsonb_typeof(fund.registration_snapshot->'chips')='number'
  AND (fund.registration_snapshot->>'chips')::numeric=seat.stack
  AND COALESCE(NULLIF((fund.tournament_snapshot->>'rebuy_chips')::numeric,0),(fund.tournament_snapshot->>'starting_chips')::numeric)=seat.stack
  AND pr.request->>'version'='v1' AND pr.request->>'user_id'=seat.user_id::text
  AND pr.request->>'tournament_id'=p_tournament::text AND pr.request->>'rebuy_type'=fund.operation
  AND pr.request->>'idempotency_key'=fund.purchase_key
  AND pr.response->'success'='true'::jsonb AND pr.response->'seated'='true'::jsonb
  AND pr.response->>'atomic_tournament_chip_purchase'='v1'
  AND pr.response->>'rebuy_type'=fund.operation AND pr.response->>'candidate_id'=c.id::text
  AND pr.response->>'candidate_state'='rebought'
  AND pr.response->>'table_id'=p_table::text AND pr.response->>'seat_id'=seat.id::text
  AND (pr.response->>'seat_number')::integer=seat.seat_number AND (pr.response->>'stack')::numeric=seat.stack
  AND (pr.response->>'new_stack')::numeric=seat.stack AND (pr.response->>'chips_added')::numeric=seat.stack
  AND (pr.response->>'cost')::numeric=fund.amount
  AND pr.claimed_at IS NOT NULL AND pr.completed_at IS NOT NULL AND pr.completed_at>=pr.claimed_at
  AND c.tournament_id=p_tournament AND c.eliminated_user_id=seat.user_id AND c.state='rebought'
  AND c.stack_after=0 AND c.resolved_at IS NOT NULL
  AND c.resolved_at>=fund.observed_at AND seat.joined_at>=c.resolved_at AND seat.joined_at<o.created_at
  AND bc.post_commit_completed_at IS NOT NULL AND bc.post_commit_result->'ok'='true'::jsonb
  AND bc.post_commit_completed_at<=fund.observed_at
  AND bc.stack_result->'conservation_checked'='true'::jsonb
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(bc.stack_result->'request'->'stacks') xs
   WHERE xs->>'user_id'=seat.user_id::text AND xs->>'seat_id'=c.seat_id::text
   AND (xs->>'seat_joined_at')::timestamptz=c.seat_joined_at AND (xs->>'stack')::numeric=0)
  AND ((fund.asset='chips' AND to_jsonb(l)=fund.ledger_snapshot AND l.status='posted' AND l.category=fund.operation
  AND l.from_entity_id=seat.user_id AND l.tournament_id=p_tournament
  AND l.amount=fund.amount AND l.to_entity_id=p_tournament AND l.club_id=fund.funding_club_id
  AND to_jsonb(w)=fund.wallet_snapshot AND w.user_id=seat.user_id AND w.type='debit'
  AND w.category=fund.operation AND w.related_entity_id=p_tournament AND w.amount=fund.amount)
  OR (fund.asset='diamonds' AND EXISTS(SELECT 1 FROM public.poker_diamond_tournament_ledger d
   JOIN public.poker_diamond_movements m ON m.request_id=(d.request->>'request_id')::uuid
   JOIN public.poker_diamond_custody dc ON dc.id=d.custody_id
   WHERE d.idempotency_key=fund.purchase_key AND d.id::text=fund.custody_result->>'ledger_id'
   AND d.tournament_id=p_tournament AND d.registration_id=registration.id AND d.user_id=seat.user_id
   AND d.kind=fund.operation AND d.amount=fund.amount AND d.amount=d.prize_part+d.bounty_part+d.fee_part
   AND d.arena_id=(fund.tournament_snapshot->>'club_id')::uuid
   AND dc.user_id=seat.user_id AND dc.target_id=p_tournament AND dc.purpose='tournament_entry'
   AND dc.arena_id=d.arena_id AND dc.state='active'
   AND fund.entitlement_id IS NULL AND fund.ledger_id IS NULL AND fund.wallet_transaction_id IS NULL
   AND fund.custody_result->'success'='true'::jsonb
   AND (fund.custody_result->>'amount')::numeric=fund.amount
   AND fund.custody_result->>'custody_id'=d.custody_id::text
   AND fund.custody_result->>'journal_id'=d.wallet_journal_id::text
   AND fund.custody_result->>'request_id'=m.request_id::text
   AND m.custody_id=d.custody_id AND m.user_id=seat.user_id AND m.action='reserve' AND m.amount=fund.amount
   AND m.source_account='player:'||seat.user_id::text AND m.destination_account='arena_custody:'||d.custody_id::text
   AND m.wallet_journal_id=d.wallet_journal_id
   AND m.request=jsonb_build_object('user_id',seat.user_id,'custody_id',d.custody_id,'amount',fund.amount,'action','tournament_add')
   AND m.receipt->'success'='true'::jsonb AND (m.receipt->>'amount')::numeric=fund.amount
   AND m.receipt->>'custody_id'=d.custody_id::text AND m.receipt->>'request_id'=m.request_id::text
   AND m.receipt->>'journal_id'=d.wallet_journal_id::text
   AND m.created_at<=fund.observed_at AND d.created_at<=fund.observed_at)))
  AND NOT EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts later
   WHERE later.tournament_id=p_tournament AND later.user_id=seat.user_id AND later.observed_at>fund.observed_at)
  AND NOT EXISTS(SELECT 1 FROM public.ca_seat_stack_exits ex WHERE ex.table_id=p_table AND ex.user_id=seat.user_id AND ex.occurred_at>=pr.claimed_at)
  AND NOT EXISTS(SELECT 1 FROM public.tournament_seat_move_receipts mv WHERE mv.tournament_id=p_tournament AND mv.user_id=seat.user_id AND mv.moved_at>=c.resolved_at)
  AND NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits hc WHERE hc.table_id=p_table AND hc.committed_at>=seat.joined_at
   AND hc.stack_result#>'{request,stacks}' @> jsonb_build_array(jsonb_build_object('user_id',seat.user_id::text)))
 ) THEN
 items:=items||jsonb_build_array(jsonb_build_object('entry',jsonb_build_object('receipt_id',fund.id,'registration_id',fund.registration_id,
 'user_id',fund.user_id,'operation',fund.operation,'observed_at',fund.observed_at,'chips',fund.registration_snapshot->'chips',
 'seat_id',seat.id,'seat_number',seat.seat_number,'joined_at',seat.joined_at,'atomic_purchase',fund.purchase_key)));
 CONTINUE;
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
END $cross_table_rebuy_prior$;

REVOKE ALL ON FUNCTION smarter_private.f06_movement_prior(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;

DO $cross_table_rebuy_postimage$
DECLARE body text;
BEGIN
  SELECT p.prosrc INTO body FROM pg_proc p
   WHERE p.oid = 'smarter_private.f06_movement_prior(uuid,uuid)'::regprocedure
     AND md5(p.prosrc) = 'd21b415b4754a19147cce0160de59479'
     AND md5(pg_get_functiondef(p.oid)) = 'ddbca56b65a99f017fb86e791b2fb971'
     AND pg_get_userbyid(p.proowner) = 'postgres'
     AND p.proacl::text = '{postgres=X/postgres}'
     AND p.proconfig = ARRAY['search_path=pg_catalog, public, smarter_private']
     AND p.prosecdef AND p.provolatile = 'v';
  IF body IS NULL THEN
    RAISE EXCEPTION 'F06_MOVEMENT_CROSS_TABLE_REBUY_POSTIMAGE_DRIFT: smarter_private.f06_movement_prior(uuid,uuid)';
  END IF;
  -- Only the one stated passage was added: removing it reproduces the
  -- pre-image byte for byte.
  IF md5(replace(body, $r$
 -- Or a rebuy (or re-entry) the event seated straight into this chair after
 -- the player busted on ANY table of this event, while (or after) the proven
 -- hand was dealt, so that hand did not deal it (2026-10-24). The purchase
 -- records its funding receipt before it chooses a chair, so that receipt's
 -- registration image still names the bust table; only the purchase's own
 -- immutable whole-transaction result names this chair. It is admitted only
 -- by its rows, exactly as f06_movement_never_dealt_prior admits it: the
 -- player's latest funding receipt is that purchase, paid (chip ledger and
 -- wallet debit, or diamond custody), granting exactly this chair's stack;
 -- its purchase result seated it in exactly this chair row, seat number and
 -- stack, from its knockout candidate, rebought from 0 in a sealed hand; the
 -- registration plays on exactly this chair with exactly those chips; no
 -- later receipt, no stack exit from this chair, no move of the player since
 -- that bust, and no committed hand on this table has dealt it since it sat;
 -- and it sat before this park. Its chips are that grant plus any receipted
 -- purchase after it.
 fund:=NULL; registration:=NULL;
 SELECT f.* INTO fund FROM public.tournament_participant_funding_receipts f
 WHERE f.tournament_id=p_tournament AND f.user_id=seat.user_id
 ORDER BY f.observed_at DESC,f.id DESC LIMIT 1;
 SELECT r.* INTO registration FROM public.tournament_players r WHERE r.tournament_id=p_tournament AND r.user_id=seat.user_id;
 IF fund.id IS NOT NULL AND fund.operation IN ('rebuy','reentry') AND registration.id IS NOT NULL AND EXISTS(
  SELECT 1 FROM public.entry_purchase_idempotency_receipts pr
  JOIN public.tournament_knockout_candidates c ON c.id=(pr.request->>'candidate_id')::uuid
  JOIN public.hand_atomic_commits bc ON bc.table_id=c.table_id AND bc.hand_number=c.hand_number AND bc.hand_id=c.hand_id
  LEFT JOIN public.chip_ledger l ON l.id=fund.ledger_id
  LEFT JOIN public.wallet_transactions w ON w.id=fund.wallet_transaction_id
  WHERE pr.key_domain='tournament_chip_purchase' AND pr.idempotency_key=fund.purchase_key
  AND fund.amount>0 AND fund.user_id=seat.user_id AND fund.registration_id=registration.id
  AND seat.user_id IS NOT NULL AND seat.occupancy_id IS NOT NULL AND seat.joined_at IS NOT NULL
  AND seat.stack>0 AND seat.stack=trunc(seat.stack)
  AND registration.status='playing' AND registration.eliminated_at IS NULL
  AND (registration.table_id,registration.seat_number) IS NOT DISTINCT FROM (seat.table_id,seat.seat_number)
  AND registration.chips::numeric=seat.stack
  AND fund.registration_snapshot->>'id'=registration.id::text
  AND fund.registration_snapshot->>'user_id'=seat.user_id::text
  AND fund.tournament_snapshot->>'id'=p_tournament::text
  AND jsonb_typeof(fund.registration_snapshot->'chips')='number'
  AND (fund.registration_snapshot->>'chips')::numeric=seat.stack
  AND COALESCE(NULLIF((fund.tournament_snapshot->>'rebuy_chips')::numeric,0),(fund.tournament_snapshot->>'starting_chips')::numeric)=seat.stack
  AND pr.request->>'version'='v1' AND pr.request->>'user_id'=seat.user_id::text
  AND pr.request->>'tournament_id'=p_tournament::text AND pr.request->>'rebuy_type'=fund.operation
  AND pr.request->>'idempotency_key'=fund.purchase_key
  AND pr.response->'success'='true'::jsonb AND pr.response->'seated'='true'::jsonb
  AND pr.response->>'atomic_tournament_chip_purchase'='v1'
  AND pr.response->>'rebuy_type'=fund.operation AND pr.response->>'candidate_id'=c.id::text
  AND pr.response->>'candidate_state'='rebought'
  AND pr.response->>'table_id'=p_table::text AND pr.response->>'seat_id'=seat.id::text
  AND (pr.response->>'seat_number')::integer=seat.seat_number AND (pr.response->>'stack')::numeric=seat.stack
  AND (pr.response->>'new_stack')::numeric=seat.stack AND (pr.response->>'chips_added')::numeric=seat.stack
  AND (pr.response->>'cost')::numeric=fund.amount
  AND pr.claimed_at IS NOT NULL AND pr.completed_at IS NOT NULL AND pr.completed_at>=pr.claimed_at
  AND c.tournament_id=p_tournament AND c.eliminated_user_id=seat.user_id AND c.state='rebought'
  AND c.stack_after=0 AND c.resolved_at IS NOT NULL
  AND c.resolved_at>=fund.observed_at AND seat.joined_at>=c.resolved_at AND seat.joined_at<o.created_at
  AND bc.post_commit_completed_at IS NOT NULL AND bc.post_commit_result->'ok'='true'::jsonb
  AND bc.post_commit_completed_at<=fund.observed_at
  AND bc.stack_result->'conservation_checked'='true'::jsonb
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(bc.stack_result->'request'->'stacks') xs
   WHERE xs->>'user_id'=seat.user_id::text AND xs->>'seat_id'=c.seat_id::text
   AND (xs->>'seat_joined_at')::timestamptz=c.seat_joined_at AND (xs->>'stack')::numeric=0)
  AND ((fund.asset='chips' AND to_jsonb(l)=fund.ledger_snapshot AND l.status='posted' AND l.category=fund.operation
  AND l.from_entity_id=seat.user_id AND l.tournament_id=p_tournament
  AND l.amount=fund.amount AND l.to_entity_id=p_tournament AND l.club_id=fund.funding_club_id
  AND to_jsonb(w)=fund.wallet_snapshot AND w.user_id=seat.user_id AND w.type='debit'
  AND w.category=fund.operation AND w.related_entity_id=p_tournament AND w.amount=fund.amount)
  OR (fund.asset='diamonds' AND EXISTS(SELECT 1 FROM public.poker_diamond_tournament_ledger d
   JOIN public.poker_diamond_movements m ON m.request_id=(d.request->>'request_id')::uuid
   JOIN public.poker_diamond_custody dc ON dc.id=d.custody_id
   WHERE d.idempotency_key=fund.purchase_key AND d.id::text=fund.custody_result->>'ledger_id'
   AND d.tournament_id=p_tournament AND d.registration_id=registration.id AND d.user_id=seat.user_id
   AND d.kind=fund.operation AND d.amount=fund.amount AND d.amount=d.prize_part+d.bounty_part+d.fee_part
   AND d.arena_id=(fund.tournament_snapshot->>'club_id')::uuid
   AND dc.user_id=seat.user_id AND dc.target_id=p_tournament AND dc.purpose='tournament_entry'
   AND dc.arena_id=d.arena_id AND dc.state='active'
   AND fund.entitlement_id IS NULL AND fund.ledger_id IS NULL AND fund.wallet_transaction_id IS NULL
   AND fund.custody_result->'success'='true'::jsonb
   AND (fund.custody_result->>'amount')::numeric=fund.amount
   AND fund.custody_result->>'custody_id'=d.custody_id::text
   AND fund.custody_result->>'journal_id'=d.wallet_journal_id::text
   AND fund.custody_result->>'request_id'=m.request_id::text
   AND m.custody_id=d.custody_id AND m.user_id=seat.user_id AND m.action='reserve' AND m.amount=fund.amount
   AND m.source_account='player:'||seat.user_id::text AND m.destination_account='arena_custody:'||d.custody_id::text
   AND m.wallet_journal_id=d.wallet_journal_id
   AND m.request=jsonb_build_object('user_id',seat.user_id,'custody_id',d.custody_id,'amount',fund.amount,'action','tournament_add')
   AND m.receipt->'success'='true'::jsonb AND (m.receipt->>'amount')::numeric=fund.amount
   AND m.receipt->>'custody_id'=d.custody_id::text AND m.receipt->>'request_id'=m.request_id::text
   AND m.receipt->>'journal_id'=d.wallet_journal_id::text
   AND m.created_at<=fund.observed_at AND d.created_at<=fund.observed_at)))
  AND NOT EXISTS(SELECT 1 FROM public.tournament_participant_funding_receipts later
   WHERE later.tournament_id=p_tournament AND later.user_id=seat.user_id AND later.observed_at>fund.observed_at)
  AND NOT EXISTS(SELECT 1 FROM public.ca_seat_stack_exits ex WHERE ex.table_id=p_table AND ex.user_id=seat.user_id AND ex.occurred_at>=pr.claimed_at)
  AND NOT EXISTS(SELECT 1 FROM public.tournament_seat_move_receipts mv WHERE mv.tournament_id=p_tournament AND mv.user_id=seat.user_id AND mv.moved_at>=c.resolved_at)
  AND NOT EXISTS(SELECT 1 FROM public.hand_atomic_commits hc WHERE hc.table_id=p_table AND hc.committed_at>=seat.joined_at
   AND hc.stack_result#>'{request,stacks}' @> jsonb_build_array(jsonb_build_object('user_id',seat.user_id::text)))
 ) THEN
 items:=items||jsonb_build_array(jsonb_build_object('entry',jsonb_build_object('receipt_id',fund.id,'registration_id',fund.registration_id,
 'user_id',fund.user_id,'operation',fund.operation,'observed_at',fund.observed_at,'chips',fund.registration_snapshot->'chips',
 'seat_id',seat.id,'seat_number',seat.seat_number,'joined_at',seat.joined_at,'atomic_purchase',fund.purchase_key)));
 CONTINUE;
 END IF;$r$, '')) <> 'd2ead73888242bf1d29bf7635bb0fa90' THEN
    RAISE EXCEPTION 'F06_MOVEMENT_CROSS_TABLE_REBUY_POSTIMAGE_DRIFT: more than the stated passage of f06_movement_prior changed';
  END IF;
END
$cross_table_rebuy_postimage$;

COMMIT;
