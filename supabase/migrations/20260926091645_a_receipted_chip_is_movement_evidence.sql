-- 20260926091645_a_receipted_chip_is_movement_evidence
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
-- CLAUDE.md 10.12: this file changes three readers. It schedules nothing,
-- retries nothing, writes no row and moves no chip.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- A parked tournament table (a table break's source) is re-admitted after an
-- engine restart through fn_f06_admit_parked_movement. With no stored proof it
-- takes one with smarter_private.f06_movement_prior, which reads the table's
-- last sealed hand and requires every seat and registration to still hold
-- exactly that hand's stack. Four durable, committed facts it could not read
-- refused tables whose every chip is accounted for, and a fifth refusal came
-- from the source guard, not the proof:
--
--   F06_MOVEMENT_SEAT_CHANGED        a player bought chips after the last hand
--                                    (the add-on, and after a bust, a rebuy):
--                                    seat = registration = proven stack plus
--                                    exactly the receipted purchase.
--   F06_MOVEMENT_WHOLE_ROSTER_REQUIRED
--                                    a player was moved INTO the table after
--                                    (or during) its last hand, by a committed
--                                    tournament_seat_move_receipts row at the
--                                    seat's stack, and has not been dealt since.
--   F06_MOVEMENT_ORIGINAL_PROOF_MISSING
--                                    a break was BEGUN by its original manager
--                                    (manifest, members, attempts) without a
--                                    movement admission, and some members had
--                                    already moved. The admission refused to
--                                    take any proof for a begun break.
--   F06_MOVEMENT_ELIMINATION_UNPROVEN
--                                    a player busted in the last hand (seat
--                                    closed at 0) and the bust was never
--                                    recorded: fn_eliminate_tournament_player_
--                                    atomic was refused F06_SOURCE_EXCLUDED
--                                    because smarter_private.f06_source_guard
--                                    admits a validated elimination on a park
--                                    only while its custody was never claimed
--                                    (revision 0), and these parks' custody had
--                                    been claimed. The proof waits for the bust
--                                    and the bust waits for the proof.
--
-- MEASURED 2026-09-26 09:00-09:35 UTC, read-only against production (every
-- entrant of every event below is profiles.is_horse):
--
--   SEAT_CHANGED (3 tables)
--     98d247a3/1d0dd46e  b956dcdf  975 + add-on 3,000 = 3,975, funding receipt
--                        15:40:43 after hand 12747907 (09-18 15:40:39)
--     a565d424/611bfe25  7f554d21 3,249 + 10,000 = 13,249 and 87b95987
--                        2,917 + 10,000 = 12,917, receipts 13:29:05-06 after
--                        hand 12644175 (09-18 13:08:23)
--     99271c16/80891794  3faa1e32 37,000 + 10,000 = 47,000; the add-on
--                        predates funding receipts (first 09-18 00:33): its
--                        single wallet key tourney:99271c16:addon:3faa1e32 and
--                        its posted ledger leg, both 09-17 21:42:27, after
--                        hand 12177952 (21:23:39)
--   WHOLE_ROSTER_REQUIRED (4 tables, 5 arrivals, each by a move receipt whose
--   moved_at is the seat's joined_at, at the seat's stack, never dealt since)
--     cb6f3704/148d56b2  1c1c12c2 154,000 (after the hand)
--     65a4a06e/e6c7c42d  d708c5d2  27,000 (after the hand)
--     a565d424/bcb26b00  acbf88b1 180,065 (moved during the last hand)
--     65a4a06e/b4351e28  8ecf28ab 6,008 and bafc4741 4,087 (during the hand)
--   ORIGINAL_PROOF_MISSING (13 begun breaks, no admission ever taken)
--     0bb488ef 17233321 3efd972d 46fc3d3a 494355f1 5745831b 65a4a06e
--     7c6277e7 99271c16 b008f31b c79a520f dedacd85 f6e561ed: 57 members,
--     11 already moved by winner receipts at their proven stack (plus any
--     receipted add-on before the move), every other member still seated
--     at its proven stack plus receipted purchases; 7c6277e7's ae0bc48d
--     busted in the last hand, rebought (0 + 3,000) and took the add-on
--     (+10,000) on the same re-occupied seat: 13,000.
--   ELIMINATION_UNPROVEN (2 parks, revision 1, no admission, no manifest)
--     bfcfaf17/0cfc4303  ed9ff9e2, hand 12381491 (09-18 05:17:48), place 2
--     494355f1/84ca6a55  4aa0d45c, hand 14684385 (09-26 06:35:14), place 53
--     engine: "atomic elimination FAILED ... F06_SOURCE_EXCLUDED" 148 times
--     in nine minutes.
--
-- Read-only rehearsal: the replacement prior and admission, installed as
-- temporary functions in a rolled-back transaction, admit all 20 SEAT /
-- ROSTER / ORIGINAL tables above, and return a byte-identical proof for all
-- 33 parks the installed function already proves.
--
-- ===========================================================================
-- WHAT THIS CHANGES
--
-- 1. smarter_private.f06_movement_prior (same signature, owner, ACL, SECURITY
--    DEFINER, volatility, search_path). Every existing check is kept. Added:
--    a) Purchases. After the proven hand (and, for a moved player, before its
--       move), each committed purchase adds exactly its grant: its
--       tournament_participant_funding_receipts row (addon, rebuy, reentry;
--       grant from that receipt's own tournament image, ::integer as the
--       purchase function grants it; its registration image must show the
--       running stack), or, for an add-on older than funding receipts, the
--       single wallet key tourney:<t>:addon:<u> together with its posted
--       player_wallet -> prize_liability 'addon' ledger leg of the same time
--       and amount. Seat = registration = proven + grants, or it refuses as
--       before. A re-entry must start from 0. Any other receipt refuses.
--    b) A busted player who bought back in: the same seat row, re-occupied no
--       earlier than the first purchase (a rebuy or re-entry), holding
--       exactly the receipted chips.
--    c) Arrivals. An open seat the last hand did not deal is admitted only by
--       a committed move receipt into that seat (destination seat id and
--       number, moved_at = joined_at, same user and event) at the stack it
--       holds (plus receipted purchases since), and only if no committed
--       hand on this table has dealt that user since it sat.
--    d) A BEGUN break with no proof. Its members must be exactly the proven
--       roster. A member already moved must have its committed winner
--       receipt (the identical checks f06_assert_movement makes, plus: the
--       receipt stack is the proven stack plus receipted purchases before
--       the move, and the original occupancy is closed); its roster entry
--       is that receipt's source seat image, which is all the assert reads
--       for a winner. Every other member is its live seat and registration
--       under the existing checks, with the member's seat and occupancy.
--    The proof gains a 'receipts' object (break, state, purchases, arrivals,
--    moved) only when one of these was used. A proof that needed none is
--    byte-identical to before, so an expectation already captured (drained
--    manager custody compares its parks' priors) still holds.
-- 2. fn_f06_admit_parked_movement: the fresh-proof branch accepts a begun
--    break (state begun, manifest present) as well as an untouched park, and
--    requires the proof's receipts to name this break. Nothing else changes.
-- 3. smarter_private.f06_source_guard: a validated elimination (the
--    transaction-local f06_elimination_dispatch image, 0 chips to 0 chips)
--    on a park is admitted while NO MOVEMENT PROOF exists for that break,
--    instead of while its custody revision is 0. A custody claim moves no
--    chip and takes no proof; the proof is the thing the recorded bust must
--    not change. Every other condition is unchanged: no manifest, no member,
--    no attempt, no close, no cleanup, no abort. The busts then complete
--    through the normal door (fn_eliminate_tournament_player_atomic, place
--    from the engine's bust order, eliminated_at from the committed hand
--    exactly as fn_ca_tournament_bust_at / fn_settle_tournament_places rank
--    it); places and prizes are paid only by the normal terminal path.
--
-- STILL REFUSED: any unreceipted chip change; a purchase whose receipt image
-- disagrees with the running stack; a re-entry over a live stack; an arrival
-- with no receipt, a different stack, or a hand since it sat; a moved member
-- whose receipt stack is not proven + purchases, or whose original occupancy
-- is still open; a begun roster that is not exactly its members; a bust on a
-- park that already has a movement proof; every other existing check.
--
-- NOT TOUCHED: f06_assert_movement (and so the mixed-custody contract),
-- f06_movement_permits, every stored proof, operation, lease and receipt.
--
-- ACL. The two private helpers stay {postgres=X/postgres}: the REVOKE names
-- service_role explicitly so no default privilege can widen them. The public
-- admission keeps exactly {postgres=X/postgres,service_role=X/postgres}, and
-- its service_role grant is stated explicitly.
--
-- @live-proof: (SELECT md5(prosrc)='b69098029169b71482e827e9a59ed55b' AND proacl::text='{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_movement_prior(uuid,uuid)'::regprocedure)
-- @live-proof: (SELECT md5(prosrc)='b77d5c53decccf1b0579ce08ef492a63' AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='public.fn_f06_admit_parked_movement(uuid,uuid,uuid,bigint,uuid,uuid,uuid,bigint)'::regprocedure)
-- @live-proof: (SELECT md5(prosrc)='be484837a5103b3c0ac78a1d6d5d0bf2' AND proacl::text='{postgres=X/postgres}' FROM pg_proc WHERE oid='smarter_private.f06_source_guard()'::regprocedure)

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

DO $movement_receipt_preimage$
DECLARE f record;
BEGIN
  FOR f IN SELECT * FROM (VALUES
    ('smarter_private.f06_movement_prior(uuid,uuid)','97c4a1afeaa41512026d3dca6936364a','438d2cbaad05751066393aeadf710228','{postgres=X/postgres}'),
    ('public.fn_f06_admit_parked_movement(uuid,uuid,uuid,bigint,uuid,uuid,uuid,bigint)','9bcb1b3bb38fb6abaca0c663e51ab325','fbf0f3c4b8e004411fa1261890e547fa','{postgres=X/postgres,service_role=X/postgres}'),
    ('smarter_private.f06_source_guard()','97d26bf7859cc41d42752311d0b40d2f','de1b25f96d2c08bf20213c0e194ae261','{postgres=X/postgres}')) v(sig,body,def,acl) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(f.sig)
      AND md5(p.prosrc)=f.body AND md5(pg_get_functiondef(p.oid))=f.def
      AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text=f.acl
      AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']
      AND p.prosecdef AND p.provolatile='v' AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql')) THEN
      RAISE EXCEPTION 'F06_MOVEMENT_RECEIPT_PREIMAGE_DRIFT: %',f.sig;
    END IF;
  END LOOP;
END
$movement_receipt_preimage$;

CREATE OR REPLACE FUNCTION smarter_private.f06_movement_prior(p_tournament uuid, p_table uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $movement_prior$
DECLARE a public.hand_atomic_commits; h public.hand_history; s jsonb; payload jsonb; submitted jsonb;
 x jsonb; seat public.table_seats; registration public.tournament_players;
 roster jsonb:='[]'; eliminated jsonb:='[]'; permits jsonb; n integer; positive integer:=0;
 o smarter_private.f06_operations; ops integer; member smarter_private.f06_members; winner jsonb;
 movement public.tournament_seat_move_receipts; item jsonb; items jsonb:='[]'; p record;
 gained numeric; held numeric; rebought timestamptz; bought integer; since timestamptz; lim timestamptz; remaining integer:=0; users uuid[]:='{}';
 purchases jsonb:='[]'; arrivals jsonb:='[]'; moved jsonb:='[]';
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
 ELSE jsonb_build_object('receipts',jsonb_build_object('break_id',o.break_id,'state',o.state,'purchases',purchases,'arrivals',arrivals,'moved',moved)) END;
END $movement_prior$;

CREATE OR REPLACE FUNCTION public.fn_f06_admit_parked_movement(p_tournament_id uuid, p_lease_generation uuid, p_table_id uuid, p_lifecycle bigint, p_break_id uuid, p_admission_id uuid, p_custody_id uuid, p_expected_revision bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $movement_admit$
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
 IF NOT ((o.state='park_requested' AND o.manifest IS NULL) OR (o.state='begun' AND o.manifest IS NOT NULL)) THEN RAISE EXCEPTION 'F06_MOVEMENT_ORIGINAL_PROOF_MISSING' USING ERRCODE='55000'; END IF;
 -- A begun break that never took a proof takes one from durable receipts
 -- only (f06_movement_prior): moved members by their winner receipts, the
 -- rest by their live seats and registrations, bound to this break.
 proof:=smarter_private.f06_movement_prior(p_tournament_id,p_table_id);
 IF o.state='begun' AND proof#>>'{receipts,break_id}' IS DISTINCT FROM p_break_id::text THEN RAISE EXCEPTION 'F06_MOVEMENT_ORIGINAL_PROOF_MISSING' USING ERRCODE='55000'; END IF;
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
END $movement_admit$;

CREATE OR REPLACE FUNCTION smarter_private.f06_source_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,smarter_private AS $movement_guard$
DECLARE src uuid;dst uuid;u uuid;t uuid;oldj jsonb;newj jsonb;bound boolean;moving boolean;
BEGIN
 oldj:=CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
 newj:=CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) ELSE '{}'::jsonb END;
 src:=(oldj->>'table_id')::uuid;dst:=(newj->>'table_id')::uuid;u:=COALESCE((newj->>'user_id')::uuid,(oldj->>'user_id')::uuid);
 SELECT tournament_id INTO t FROM public.tables WHERE id=COALESCE(src,dst);
 IF t IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
 -- Payload-only writes preserve source custody. They need to exclude a
 -- canonical move/begin, not other accepted hands in this tournament. The
 -- outer hand RPC already holds T shared; promoting it to exclusive here
 -- makes ordinary concurrent hands refuse each other even with no F06 move.
 IF TG_OP='UPDATE' AND (
  (TG_TABLE_NAME='table_seats'
   AND (oldj->>'left_at') IS NOT DISTINCT FROM (newj->>'left_at')
   AND (src,oldj->>'user_id',oldj->>'seat_number') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number'))
  OR (TG_TABLE_NAME='tournament_players'
   AND (src,oldj->>'user_id',oldj->>'seat_number',oldj->>'status') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number',newj->>'status'))
 ) THEN
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0))
   OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:'||t::text,0)) THEN
   RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
 END IF;
 -- Canonical admission authorities already hold T exclusive. A direct row
 -- writer may try it, but cannot wait while holding a row needed by begin.
 -- Closing the exact already-zero generation cannot move funded custody.
 -- Share G/T with other tables' hands, while still excluding every canonical
 -- begin/move/terminal authority, which owns T or G exclusively. Do not
 -- return here: PARK_REQUESTED still needs the original hand receipt and
 -- BEGUN still needs the original move receipt below.
 IF TG_OP='UPDATE' AND TG_TABLE_NAME='table_seats'
  AND oldj->>'left_at' IS NULL AND newj->>'left_at' IS NOT NULL
  AND newj->>'status'='left'
  AND oldj->'stack'='0'::jsonb AND newj->'stack'='0'::jsonb
  AND oldj->>'user_id' IS NOT NULL
  AND (src,oldj->>'id',oldj->>'user_id',oldj->>'seat_number',oldj->>'joined_at',oldj->>'club_id')
      IS NOT DISTINCT FROM
      (dst,newj->>'id',newj->>'user_id',newj->>'seat_number',newj->>'joined_at',newj->>'club_id') THEN
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1',0))
   OR NOT pg_try_advisory_xact_lock_shared(hashtextextended('ca:tournament-terminal-settlement:v1:'||t::text,0)) THEN
   RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001';
  END IF;
 ELSE
  PERFORM smarter_private.f06_try_lane(t);
 END IF;
 bound:=EXISTS(SELECT 1 FROM smarter_private.f06_operations WHERE source_table_id IN(src,dst) AND state NOT IN ('acknowledged','withdrawn_before_manifest'));
 IF NOT bound THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;

 -- A validated elimination is neither a hand dispatch nor a seat move. The
 -- private core authorizes exactly one row image immediately before its CAS;
 -- this BEFORE trigger consumes it, so later writes cannot reuse it. Existing
 -- lane acquisition above still serializes the source/manifest transition.
 IF TG_OP='UPDATE' AND src=dst AND oldj->>'user_id'=newj->>'user_id'
 AND ((TG_TABLE_NAME='tournament_players' AND oldj->>'status'='playing'
       AND newj->>'status'='eliminated' AND oldj->'chips'='0'::jsonb
       AND newj->'chips'='0'::jsonb)
   OR (TG_TABLE_NAME='table_seats' AND oldj->>'left_at' IS NULL
       AND newj->>'left_at' IS NOT NULL AND oldj->'stack'='0'::jsonb
       AND newj->'stack'='0'::jsonb))
 AND NOT EXISTS(SELECT 1 FROM smarter_private.f06_operations o
   WHERE o.source_table_id=src
     AND o.state NOT IN ('acknowledged','withdrawn_before_manifest')
     AND (o.state<>'park_requested' OR o.manifest IS NOT NULL
       OR EXISTS(SELECT 1 FROM smarter_private.f06_movement_admissions ma WHERE ma.break_id=o.break_id)
       OR o.close_receipt IS NOT NULL OR o.cleanup_kind IS NOT NULL
       OR to_jsonb(o)->>'abort_receipt_id' IS NOT NULL
       OR EXISTS(SELECT 1 FROM smarter_private.f06_members m WHERE m.break_id=o.break_id)
       OR EXISTS(SELECT 1 FROM smarter_private.f06_attempts a WHERE a.break_id=o.break_id))) THEN
   DELETE FROM smarter_private.f06_elimination_dispatch d
   USING public.tournament_knockout_candidates c
   WHERE d.xid=txid_current() AND d.relation_name=TG_TABLE_NAME
     AND d.row_id=(oldj->>'id')::uuid AND d.candidate_id=c.id
     AND d.old_record=oldj AND d.new_record=newj
     AND c.tournament_id=t AND c.table_id=src AND c.eliminated_user_id=u
     AND c.state='pending' AND c.stack_after=0
     AND (TG_TABLE_NAME='tournament_players' AND oldj->>'tournament_id'=t::text
       OR TG_TABLE_NAME='table_seats' AND c.seat_id=(oldj->>'id')::uuid
         AND c.seat_joined_at=(oldj->>'joined_at')::timestamptz);
   IF FOUND THEN RETURN NEW; END IF;
 END IF;
 IF TG_TABLE_NAME='table_seats' THEN
 -- Existing accepted final-hand stack updates can drain PARK_REQUESTED. Once
 -- BEGUN, only the one guarded move may vacate/change original custody.
 IF TG_OP='UPDATE' AND (oldj->>'left_at') IS NOT DISTINCT FROM (newj->>'left_at')
 AND (src,oldj->>'user_id',oldj->>'seat_number') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number') THEN
 RETURN NEW; END IF;
 ELSE
 IF TG_OP='UPDATE' AND (src,oldj->>'user_id',oldj->>'seat_number',oldj->>'status') IS NOT DISTINCT FROM(dst,newj->>'user_id',newj->>'seat_number',newj->>'status') THEN RETURN NEW; END IF;
 END IF;
 moving:=EXISTS(SELECT 1 FROM smarter_private.f06_dispatch d JOIN smarter_private.f06_attempts a USING(request_id)
 JOIN smarter_private.f06_operations o ON o.break_id=a.break_id WHERE d.xid=txid_current() AND a.user_id=u AND o.source_table_id=src
 AND (TG_TABLE_NAME='table_seats' AND TG_OP='UPDATE' AND src=dst AND newj->>'left_at' IS NOT NULL
 OR TG_TABLE_NAME='tournament_players' AND TG_OP='UPDATE' AND dst=a.destination_table_id AND (newj->>'seat_number')::integer=a.destination_seat_number));
 IF NOT moving AND EXISTS(SELECT 1 FROM smarter_private.f06_hand_dispatch d JOIN smarter_private.f06_hand_permits h USING(permit_id) JOIN smarter_private.f06_operations o ON o.source_table_id=h.table_id WHERE d.xid=txid_current() AND h.table_id=src AND o.state='park_requested') THEN moving:=true; END IF;
 IF NOT moving THEN RAISE EXCEPTION 'F06_SOURCE_EXCLUDED' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $movement_guard$;

REVOKE ALL ON FUNCTION smarter_private.f06_movement_prior(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION smarter_private.f06_source_guard() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_f06_admit_parked_movement(uuid,uuid,uuid,bigint,uuid,uuid,uuid,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_f06_admit_parked_movement(uuid,uuid,uuid,bigint,uuid,uuid,uuid,bigint) TO service_role;

DO $movement_receipt_postimage$
DECLARE f record; body text;
BEGIN
  FOR f IN SELECT * FROM (VALUES
    ('smarter_private.f06_movement_prior(uuid,uuid)','b69098029169b71482e827e9a59ed55b','7c847db4d5ed391dc6b2f48a70612402','{postgres=X/postgres}'),
    ('public.fn_f06_admit_parked_movement(uuid,uuid,uuid,bigint,uuid,uuid,uuid,bigint)','b77d5c53decccf1b0579ce08ef492a63','58c444ab4d2828511758e5400976c601','{postgres=X/postgres,service_role=X/postgres}'),
    ('smarter_private.f06_source_guard()','be484837a5103b3c0ac78a1d6d5d0bf2','17bf5b2ba1901ba4a3f55f7ff3426f6c','{postgres=X/postgres}')) v(sig,body,def,acl) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure(f.sig)
      AND md5(p.prosrc)=f.body AND md5(pg_get_functiondef(p.oid))=f.def
      AND pg_get_userbyid(p.proowner)='postgres' AND p.proacl::text=f.acl
      AND p.proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']
      AND p.prosecdef AND p.provolatile='v') THEN
      RAISE EXCEPTION 'F06_MOVEMENT_RECEIPT_POSTIMAGE_DRIFT: %',f.sig;
    END IF;
  END LOOP;
  -- The admission and the guard changed only where stated: restoring the one
  -- replaced passage reproduces each pre-image body exactly.
  SELECT prosrc INTO body FROM pg_proc WHERE oid='smarter_private.f06_source_guard()'::regprocedure;
  IF md5(replace(body,
       $r$       OR EXISTS(SELECT 1 FROM smarter_private.f06_movement_admissions ma WHERE ma.break_id=o.break_id)$r$,
       $r$       OR o.revision<>0 OR o.custody_id IS NOT NULL OR o.custody_generation IS NOT NULL$r$))
     <> '97d26bf7859cc41d42752311d0b40d2f' THEN
    RAISE EXCEPTION 'F06_MOVEMENT_RECEIPT_POSTIMAGE_DRIFT: guard changed beyond its one condition';
  END IF;
  SELECT prosrc INTO body FROM pg_proc WHERE oid='public.fn_f06_admit_parked_movement(uuid,uuid,uuid,bigint,uuid,uuid,uuid,bigint)'::regprocedure;
  IF md5(replace(body,
       $r$ IF NOT ((o.state='park_requested' AND o.manifest IS NULL) OR (o.state='begun' AND o.manifest IS NOT NULL)) THEN RAISE EXCEPTION 'F06_MOVEMENT_ORIGINAL_PROOF_MISSING' USING ERRCODE='55000'; END IF;
 -- A begun break that never took a proof takes one from durable receipts
 -- only (f06_movement_prior): moved members by their winner receipts, the
 -- rest by their live seats and registrations, bound to this break.
 proof:=smarter_private.f06_movement_prior(p_tournament_id,p_table_id);
 IF o.state='begun' AND proof#>>'{receipts,break_id}' IS DISTINCT FROM p_break_id::text THEN RAISE EXCEPTION 'F06_MOVEMENT_ORIGINAL_PROOF_MISSING' USING ERRCODE='55000'; END IF;
$r$,
       $r$ IF o.state<>'park_requested' OR o.manifest IS NOT NULL THEN RAISE EXCEPTION 'F06_MOVEMENT_ORIGINAL_PROOF_MISSING' USING ERRCODE='55000'; END IF;
 proof:=smarter_private.f06_movement_prior(p_tournament_id,p_table_id);
$r$))
     <> '9bcb1b3bb38fb6abaca0c663e51ab325' THEN
    RAISE EXCEPTION 'F06_MOVEMENT_RECEIPT_POSTIMAGE_DRIFT: admission changed beyond its fresh-proof branch';
  END IF;
  -- Both triggers still run the guard.
  IF (SELECT count(*) FROM pg_trigger WHERE tgfoid='smarter_private.f06_source_guard()'::regprocedure
      AND tgname IN ('a00_f06_source_seat','a00_f06_source_roster') AND tgenabled='O') <> 2 THEN
    RAISE EXCEPTION 'F06_MOVEMENT_RECEIPT_POSTIMAGE_DRIFT: source guard triggers';
  END IF;
END
$movement_receipt_postimage$;

COMMIT;
