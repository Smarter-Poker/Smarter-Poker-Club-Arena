-- An abort that moves no chips does not need the cards it can no longer read.
--
-- public.cleanup_old_hole_cards() deleted public.table_hole_cards by age alone.
-- On 2026-09-20 00:00 UTC, pg_cron job 9 run 540885 destroyed the hole cards of
-- Noon table 2c621856-e728-4e8b-bf08-4c56746a8649 hand 12942021 while
-- smarter_private.f06_hand_permits still held permit
-- 098c0945-54f9-4c48-a600-3b8845da267b for that hand in state 'reserved'.
-- Migration 20260920232341 stopped that cleanup from doing it again; the cards
-- already destroyed are unrecoverable. Both functions on the retained-original
-- disposition path - smarter_private.f06_retired_origin_snapshot and
-- smarter_private.f06_retained_mtt_abort_snapshot - require the surviving
-- hole-card rows to match the roster exactly and raise
-- F06_RETAINED_CARDS_CHANGED otherwise, so the disposition cannot proceed.
--
-- WHY A RELAXATION IS JUSTIFIED HERE AND NOWHERE ELSE
--
-- Verified live on kuklfnapbkmacvwxktbh on 2026-09-20: that abort moves ZERO
-- chips. For each of the two players, the snapshot's own stack + totalInvested
-- already equals the durable balance in public.tournament_players.chips AND in
-- the live public.table_seats.stack - seat 1 user 23e84589: 0 + 46125 = 46125
-- = 46125 = 46125.00; seat 3 user c1b575fb: 45000 + 43875 = 88875 = 88875 =
-- 88875.00. There is no public.hand_atomic_commits row for that hand and none
-- for any later hand at that table. The 90,000 "pot" therefore exists ONLY
-- inside hand_state_snapshots.state_json: it was never deducted from any
-- durable balance. Aborting the hand as unsettled restores exactly the state
-- that is already durable. It awards nothing, takes nothing, and decides no
-- winner - so no hole card can affect any financial outcome, because no
-- financial outcome is being decided.
--
-- A hole card matters when it decides who wins. Here nothing is decided.
--
-- WHAT THIS CHANGES
--
-- One count test, in both functions, gains one alternative: the count may also
-- be EXACTLY ZERO when the abort is provably financially inert. Inertness is
-- the conjunction of all five conditions below, evaluated by one shared
-- SECURITY DEFINER predicate so the two functions cannot disagree about it:
--
--   1. EXACTLY zero public.table_hole_cards rows for that exact table and
--      hand. A PARTIAL set means some rows survived and some did not - real
--      drift - and still refuses.
--   2. The hand never committed: no public.hand_atomic_commits row for it.
--   3. No later hand committed at that table.
--   4. The snapshot is incomplete and un-acted: is_complete=false,
--      stage='preflop', state_json->>'stage'='preflop' and
--      state_json->'actionHistory' = '[]'.
--   5. FINANCIAL INERTNESS. For EVERY player in the snapshot the durable
--      balance already equals that player's pre-hand total:
--      tournament_players.chips = stack + totalInvested for that
--      tournament+user, AND the live table_seats.stack for that table+user
--      with left_at IS NULL equals the same value.
--
-- Every other assertion in both functions is preserved byte for byte. The
-- orphan-row test that follows the count is untouched, so a card row whose
-- user or seat is not in the roster still refuses - and because any surviving
-- card row fails condition 1, the relaxation is unreachable whenever a card
-- exists at all. No check is deleted, no unknown or missing state is accepted
-- generally, and the relaxation is impossible to trigger where any chip would
-- move.
--
-- WHY THE AGGREGATE GAINS A coalesce
--
-- SELECT jsonb_agg(...) INTO cards over zero rows yields SQL NULL, and
-- jsonb_build_object('cards',cards) would then emit JSON null. Both callers
-- compare the canonical with IS DISTINCT FROM - public.fn_f06_abort_retained_
-- mtt_hands against the submitted expectation, smarter_private.f06_retired_
-- origin_disposition against the stored receipt - and null IS DISTINCT FROM
-- []. The disposition would refuse later, at the canonical comparison, for a
-- reason nobody would recognise. '[]' is what the variable is declared as,
-- what the sibling inbound_requests coalesces to in the same jsonb_build_
-- object, and what the prior_commit_plus_inbound_moves branch already emits
-- when it has no cards. Before this change the aggregate could only run over
-- jsonb_array_length(roster) >= 2 rows, so the coalesce cannot move any
-- existing canonical; it only defines the newly reachable zero-row one.
--
-- The migration edits the LIVE definition by textual substitution and pins the
-- md5 of what it composes, so no other byte of either function can move. Its
-- in-transaction proof is read-only - public.table_hole_cards is writer-guarded
-- by a00_f06_cancelled_preparation and smarter_private.f06_hand_permits is
-- immutability-guarded - and the writing proof, including a partial card set
-- executed end to end against both functions, runs on a disposable cluster in
-- scripts/dev/probe-inert-abort-missing-hole-cards-pg17.sh.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

DO $inert_preimage$
DECLARE snap oid := to_regprocedure('smarter_private.f06_retired_origin_snapshot(jsonb)');
        mixed oid := to_regprocedure('smarter_private.f06_retained_mtt_abort_snapshot(jsonb)');
        helper oid := to_regprocedure('smarter_private.f06_zero_cards_abort_is_inert(uuid,uuid,bigint)');
BEGIN
 -- PRE-IMAGE. The live identity of both functions this repair edits, captured
 -- from kuklfnapbkmacvwxktbh on 2026-09-20: definition md5, body md5, owner,
 -- ACL, proconfig, security mode and volatility. Anything else is refused.
 -- The second md5 pair in each row is this migration's own result, so
 -- re-applying it is a clean no-op rather than a refusal.
 IF current_user <> 'postgres' OR snap IS NULL OR mixed IS NULL THEN
  RAISE EXCEPTION 'F06_INERT_ABORT_CARDS_PREIMAGE_CHANGED' USING ERRCODE='55000';
 END IF;
 IF (md5(pg_get_functiondef(snap)) IS DISTINCT FROM 'e821cf8a38c6718237f1d45110bf7f00'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid=snap)) IS DISTINCT FROM 'eef2b4beccc02dffd5efeffe57081a0e')
 AND (md5(pg_get_functiondef(snap)) IS DISTINCT FROM '83d871d42ecc2e1933035b62bdb5be72'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid=snap)) IS DISTINCT FROM '4feff8f73862b199eed6cc9b034071f8') THEN
  RAISE EXCEPTION 'F06_INERT_ABORT_CARDS_PREIMAGE_CHANGED: f06_retired_origin_snapshot' USING ERRCODE='55000';
 END IF;
 IF (md5(pg_get_functiondef(mixed)) IS DISTINCT FROM '2d40c8218d043e644faa40f7b78ff772'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid=mixed)) IS DISTINCT FROM '45d5e92898dd9fb2fb72f33917cf96d8')
 AND (md5(pg_get_functiondef(mixed)) IS DISTINCT FROM 'e300521f9be4430cc7e86811100e89ea'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid=mixed)) IS DISTINCT FROM 'ea1589334d7e2637600dd3eff32d6c7b') THEN
  RAISE EXCEPTION 'F06_INERT_ABORT_CARDS_PREIMAGE_CHANGED: f06_retained_mtt_abort_snapshot' USING ERRCODE='55000';
 END IF;
 -- Owner, ACL, proconfig, security mode and volatility, for both, preserved
 -- exactly. CREATE OR REPLACE keeps them; this refuses to start if they have
 -- already moved, and the post-image below proves they did not move here.
 IF (SELECT count(*) FROM pg_proc WHERE oid IN (snap,mixed)
      AND proowner='postgres'::regrole AND prosecdef AND provolatile='v'
      AND proacl::text='{postgres=X/postgres}'
      AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']::text[]) <> 2 THEN
  RAISE EXCEPTION 'F06_INERT_ABORT_CARDS_PREIMAGE_CHANGED: definer identity' USING ERRCODE='55000';
 END IF;
 -- A predicate of this name that is not the one written below is somebody
 -- else's object; replacing it blind would change their behaviour.
 IF helper IS NOT NULL
 AND md5(pg_get_functiondef(helper)) IS DISTINCT FROM '5d92c217691518a3a6cf90a9ba328e6a' THEN
  RAISE EXCEPTION 'F06_INERT_ABORT_CARDS_HELPER_CHANGED' USING ERRCODE='55000';
 END IF;

 -- The columns condition 5 compares, in the types it compares them in. If
 -- chips stopped being a whole-chip integer or stack stopped being numeric,
 -- "the durable balance already equals the pre-hand total" would be a
 -- different statement and this relaxation would have to be re-reasoned.
 IF EXISTS (SELECT 1 FROM (VALUES
      ('public.table_hole_cards','table_id','uuid'),
      ('public.table_hole_cards','hand_number','bigint'),
      ('public.hand_atomic_commits','table_id','uuid'),
      ('public.hand_atomic_commits','hand_number','bigint'),
      ('public.hand_state_snapshots','table_id','uuid'),
      ('public.hand_state_snapshots','hand_number','integer'),
      ('public.hand_state_snapshots','is_complete','boolean'),
      ('public.hand_state_snapshots','stage','text'),
      ('public.hand_state_snapshots','state_json','jsonb'),
      ('public.tournament_players','tournament_id','uuid'),
      ('public.tournament_players','user_id','uuid'),
      ('public.tournament_players','chips','integer'),
      ('public.table_seats','table_id','uuid'),
      ('public.table_seats','user_id','uuid'),
      ('public.table_seats','stack','numeric'),
      ('public.table_seats','left_at','timestamp with time zone')
    ) required(rel,col,kind)
    WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid=to_regclass(required.rel) AND a.attname=required.col
                         AND a.atttypid=to_regtype(required.kind) AND NOT a.attisdropped)) THEN
  RAISE EXCEPTION 'F06_INERT_ABORT_CARDS_DEPENDENCY_CHANGED' USING ERRCODE='55000';
 END IF;
 -- One snapshot per hand is what makes conditions 4 and 5 a decidable question
 -- for an exact (table_id, hand_number) rather than a choice between rows.
 IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid=to_regclass('public.hand_state_snapshots')
                   AND contype IN ('p','u')
                   AND pg_get_constraintdef(oid)='UNIQUE (table_id, hand_number)') THEN
  RAISE EXCEPTION 'F06_INERT_ABORT_CARDS_DEPENDENCY_CHANGED: snapshot uniqueness' USING ERRCODE='55000';
 END IF;
END $inert_preimage$;

CREATE OR REPLACE FUNCTION smarter_private.f06_zero_cards_abort_is_inert(p_tournament_id uuid, p_table_id uuid, p_hand_number bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
  -- TRUE only where aborting this hand as unsettled is PROVABLY financially
  -- inert, so its destroyed hole cards cannot affect any outcome. All five
  -- must hold; any one of them failing leaves F06_RETAINED_CARDS_CHANGED
  -- standing. Never widen this. Reads only; decides nothing else.
  SELECT
    -- 1. EXACTLY zero hole cards for this exact table and hand. A PARTIAL set
    --    means some rows survived and some did not, which is real drift.
    NOT EXISTS (SELECT 1 FROM public.table_hole_cards c
                 WHERE c.table_id = p_table_id AND c.hand_number = p_hand_number)
    -- 2. The hand never committed.
    AND NOT EXISTS (SELECT 1 FROM public.hand_atomic_commits a
                     WHERE a.table_id = p_table_id AND a.hand_number = p_hand_number)
    -- 3. No later hand committed at this table, so nothing was settled on top
    --    of the state this abort restores.
    AND NOT EXISTS (SELECT 1 FROM public.hand_atomic_commits a
                     WHERE a.table_id = p_table_id AND a.hand_number > p_hand_number)
    -- 4. The snapshot is incomplete and un-acted: preflop by column and by
    --    state_json, empty actionHistory, and a non-empty player array (an
    --    empty one would make condition 5 vacuously true).
    AND EXISTS (SELECT 1 FROM public.hand_state_snapshots s
                 WHERE s.table_id = p_table_id AND s.hand_number = p_hand_number
                   AND s.is_complete IS FALSE
                   AND s.stage = 'preflop'
                   AND s.state_json->>'stage' = 'preflop'
                   AND s.state_json->'actionHistory' = '[]'::jsonb
                   AND jsonb_typeof(s.state_json->'players') = 'array'
                   AND jsonb_array_length(s.state_json->'players') > 0)
    -- 5. FINANCIAL INERTNESS, the load-bearing condition. For EVERY player in
    --    the snapshot the durable balance ALREADY equals that player's
    --    pre-hand total (stack + totalInvested), in public.tournament_players
    --    AND in the live public.table_seats row. The pot therefore exists only
    --    inside state_json and was never deducted from anything durable, so
    --    aborting the hand as unsettled restores exactly what is already
    --    durable: it awards nothing, takes nothing and decides no winner.
    --    Every term is an EXISTS or a coalesced boolean, so the row test is
    --    never NULL and an unreadable player can only make this false.
    AND NOT EXISTS (
          SELECT 1
            FROM public.hand_state_snapshots s
            CROSS JOIN LATERAL jsonb_array_elements(s.state_json->'players') x
           WHERE s.table_id = p_table_id AND s.hand_number = p_hand_number
             AND NOT (
                   coalesce(pg_input_is_valid(x->>'user_id','uuid'), false)
               AND coalesce(pg_input_is_valid(x->>'stack','numeric'), false)
               AND coalesce(pg_input_is_valid(x->>'totalInvested','numeric'), false)
               AND EXISTS (SELECT 1 FROM public.tournament_players p
                            WHERE p.tournament_id = p_tournament_id
                              AND p.user_id = (x->>'user_id')::uuid
                              AND p.chips::numeric
                                  = (x->>'stack')::numeric + (x->>'totalInvested')::numeric)
               AND EXISTS (SELECT 1 FROM public.table_seats q
                            WHERE q.table_id = p_table_id
                              AND q.user_id = (x->>'user_id')::uuid
                              AND q.left_at IS NULL
                              AND q.stack::numeric
                                  = (x->>'stack')::numeric + (x->>'totalInvested')::numeric)));
$function$;
ALTER FUNCTION smarter_private.f06_zero_cards_abort_is_inert(uuid, uuid, bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.f06_zero_cards_abort_is_inert(uuid, uuid, bigint)
  FROM PUBLIC, anon, authenticated, service_role;

DO $inert_edit$
DECLARE sig text;
        target oid;
        before_metadata jsonb;
        after_metadata jsonb;
        original text;
        replacement text;
        want text;
        pins jsonb := jsonb_build_object(
          'smarter_private.f06_retired_origin_snapshot(jsonb)',     '83d871d42ecc2e1933035b62bdb5be72',
          'smarter_private.f06_retained_mtt_abort_snapshot(jsonb)', 'e300521f9be4430cc7e86811100e89ea');
BEGIN
 FOREACH sig IN ARRAY ARRAY['smarter_private.f06_retired_origin_snapshot(jsonb)',
                            'smarter_private.f06_retained_mtt_abort_snapshot(jsonb)'] LOOP
  target := to_regprocedure(sig);
  want := pins->>sig;
  IF md5(pg_get_functiondef(target)) = want THEN
   RAISE NOTICE '% already admits a financially inert zero-card abort; body unchanged', sig;
   CONTINUE;
  END IF;
  SELECT to_jsonb(p)-'prosrc' INTO before_metadata FROM pg_proc p WHERE oid=target;
  original := pg_get_functiondef(target);
  -- The ONLY edit: the count test gains one alternative, and the aggregate
  -- gains a coalesce. Every other byte of both functions is carried across
  -- untouched, which is what pinning md5(replacement) proves.
  replacement := replace(original,
$before$ IF (SELECT count(*) FROM public.table_hole_cards WHERE table_id=h.table_id AND hand_number=h.hand_number)<>jsonb_array_length(roster)
 OR EXISTS(SELECT 1 FROM public.table_hole_cards c WHERE c.table_id=h.table_id AND c.hand_number=h.hand_number
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(roster) s WHERE s->>'user_id'=c.user_id::text
 AND (s->>'seat_number')::integer=c.seat_number)) THEN
 RAISE EXCEPTION 'F06_RETAINED_CARDS_CHANGED' USING ERRCODE='55000'; END IF;
 SELECT jsonb_agg(jsonb_build_object('id',c.id,'user_id',c.user_id,'seat_number',c.seat_number,
 'row_hash',md5(to_jsonb(c)::text)) ORDER BY c.id) INTO cards FROM public.table_hole_cards c
 WHERE c.table_id=h.table_id AND c.hand_number=h.hand_number;$before$,
$after$ -- The hole cards of this hand were destroyed by age while the hand was still
 -- unresolved, and they are unrecoverable. Admit that ONE case, and only where
 -- the abort provably moves no chips: exactly zero cards survive, the hand
 -- never committed, nothing committed after it at this table, the snapshot is
 -- an un-acted preflop, and every durable balance ALREADY equals that player's
 -- pre-hand total. Such an abort awards nothing, takes nothing and decides no
 -- winner, so no hole card can affect any financial outcome - there is no
 -- financial outcome to affect. A PARTIAL set is real drift and still refuses.
 -- The orphan-row test below is unchanged: a card row outside the roster still
 -- refuses, and it also keeps the zero-card relaxation unreachable whenever any
 -- card row exists at all.
 IF ((SELECT count(*) FROM public.table_hole_cards WHERE table_id=h.table_id AND hand_number=h.hand_number)<>jsonb_array_length(roster)
 AND NOT smarter_private.f06_zero_cards_abort_is_inert(t,h.table_id,h.hand_number))
 OR EXISTS(SELECT 1 FROM public.table_hole_cards c WHERE c.table_id=h.table_id AND c.hand_number=h.hand_number
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(roster) s WHERE s->>'user_id'=c.user_id::text
 AND (s->>'seat_number')::integer=c.seat_number)) THEN
 RAISE EXCEPTION 'F06_RETAINED_CARDS_CHANGED' USING ERRCODE='55000'; END IF;
 -- coalesce because jsonb_agg over zero rows is SQL NULL, and this canonical is
 -- compared with IS DISTINCT FROM by both callers. '[]' is what this variable is
 -- declared as, what the sibling inbound_requests coalesces to in the same
 -- jsonb_build_object, and what the prior_commit_plus_inbound_moves branch
 -- already emits when it has no cards. Every path reachable before this change
 -- aggregated jsonb_array_length(roster) >= 2 rows, so no existing canonical
 -- moves; this only defines the newly reachable zero-row one.
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',c.id,'user_id',c.user_id,'seat_number',c.seat_number,
 'row_hash',md5(to_jsonb(c)::text)) ORDER BY c.id),'[]'::jsonb) INTO cards FROM public.table_hole_cards c
 WHERE c.table_id=h.table_id AND c.hand_number=h.hand_number;$after$);
  IF replacement = original OR md5(replacement) IS DISTINCT FROM want THEN
   RAISE EXCEPTION 'F06_INERT_ABORT_CARDS_COMPOSITION_CHANGED: %', sig USING ERRCODE='55000';
  END IF;
  EXECUTE replacement;
  SELECT to_jsonb(p)-'prosrc' INTO after_metadata FROM pg_proc p WHERE oid=target;
  -- POST-IMAGE. Owner, ACL, search_path, volatility and security mode must be
  -- byte-identical to the pre-image; only the body may have moved.
  IF after_metadata IS DISTINCT FROM before_metadata
  OR pg_get_functiondef(target) IS DISTINCT FROM replacement THEN
   RAISE EXCEPTION 'F06_INERT_ABORT_CARDS_POSTIMAGE_CHANGED: %', sig USING ERRCODE='55000';
  END IF;
 END LOOP;
END $inert_edit$;

DO $inert_postimage$
DECLARE snap oid := to_regprocedure('smarter_private.f06_retired_origin_snapshot(jsonb)');
        mixed oid := to_regprocedure('smarter_private.f06_retained_mtt_abort_snapshot(jsonb)');
        helper oid := to_regprocedure('smarter_private.f06_zero_cards_abort_is_inert(uuid,uuid,bigint)');
BEGIN
 -- POST-IMAGE, all three objects, read back from the catalog.
 IF md5(pg_get_functiondef(snap)) IS DISTINCT FROM '83d871d42ecc2e1933035b62bdb5be72'
 OR md5((SELECT prosrc FROM pg_proc WHERE oid=snap)) IS DISTINCT FROM '4feff8f73862b199eed6cc9b034071f8'
 OR md5(pg_get_functiondef(mixed)) IS DISTINCT FROM 'e300521f9be4430cc7e86811100e89ea'
 OR md5((SELECT prosrc FROM pg_proc WHERE oid=mixed)) IS DISTINCT FROM 'ea1589334d7e2637600dd3eff32d6c7b'
 OR (SELECT count(*) FROM pg_proc WHERE oid IN (snap,mixed)
      AND proowner='postgres'::regrole AND prosecdef AND provolatile='v'
      AND proacl::text='{postgres=X/postgres}'
      AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']::text[]) <> 2 THEN
  RAISE EXCEPTION 'F06_INERT_ABORT_CARDS_POSTIMAGE_CHANGED' USING ERRCODE='55000';
 END IF;
 IF helper IS NULL
 OR md5(pg_get_functiondef(helper)) IS DISTINCT FROM '5d92c217691518a3a6cf90a9ba328e6a'
 OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=helper AND proowner='postgres'::regrole
      AND prosecdef AND provolatile='s'
      AND proacl::text='{postgres=X/postgres}'
      AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']::text[]) THEN
  RAISE EXCEPTION 'F06_INERT_ABORT_CARDS_HELPER_CHANGED' USING ERRCODE='55000';
 END IF;
 -- Every other assertion is preserved: the two functions still carry exactly
 -- one F06_RETAINED_CARDS_CHANGED each, and the refusal count for the branch
 -- this edit touches is unchanged. Nothing was deleted to make room.
 IF (SELECT count(*) FROM pg_proc WHERE oid IN (snap,mixed)
      AND (length(prosrc)-length(replace(prosrc,'F06_RETAINED_CARDS_CHANGED','')))/26 = 1
      AND (length(prosrc)-length(replace(prosrc,'RAISE EXCEPTION','')))/15 = 23) <> 2 THEN
  RAISE EXCEPTION 'F06_INERT_ABORT_CARDS_POSTIMAGE_CHANGED: assertion count' USING ERRCODE='55000';
 END IF;
END $inert_postimage$;

DO $inert_proof$
DECLARE n bigint; m bigint; hands bigint; inert bigint; r record;
BEGIN
 -- EXECUTABLE PROOF, read-only, in this same transaction. public.table_hole_
 -- cards is writer-guarded and smarter_private.f06_hand_permits is
 -- immutability-guarded, so these proofs run over real rows rather than
 -- inserted ones; the writing proofs are in the PG17 probe.

 -- (1) A PARTIAL SET STILL REFUSES, executed over every hand that actually has
 --     cards. Condition 1 is "exactly zero", which draws no distinction
 --     between a partial set and a full one: ANY surviving card row makes the
 --     predicate false, which leaves the original count test - and therefore
 --     the original refusal - in charge of every non-empty set. This is the
 --     direction that must never regress into accepting drift.
 SELECT count(*), count(*) FILTER (
          WHERE smarter_private.f06_zero_cards_abort_is_inert(
                  (SELECT tb.tournament_id FROM public.tables tb WHERE tb.id=c.table_id),
                  c.table_id, c.hand_number))
   INTO hands, n
   FROM (SELECT DISTINCT table_id, hand_number FROM public.table_hole_cards) c;
 IF n <> 0 THEN
  RAISE EXCEPTION 'F06_INERT_ABORT_CARDS_PROOF_NONEMPTY_SET_ADMITTED: % of % hand(s)', n, hands
   USING ERRCODE='55000';
 END IF;
 RAISE NOTICE 'inert-abort proof: % hand(s) still hold cards and every one of them is refused', hands;

 -- (2) THE PREDICATE IS EXACTLY ITS FIVE CONDITIONS, re-derived inline from
 --     the same tables and compared over every hand that has a snapshot. If
 --     the predicate is ever edited into something wider or narrower than the
 --     five conditions it claims, this disagrees and the migration refuses.
 SELECT count(*), count(*) FILTER (WHERE agree) INTO n, m FROM (
   SELECT smarter_private.f06_zero_cards_abort_is_inert(tb.tournament_id, s.table_id, s.hand_number)
          IS NOT DISTINCT FROM (
            NOT EXISTS (SELECT 1 FROM public.table_hole_cards c
                         WHERE c.table_id=s.table_id AND c.hand_number=s.hand_number)
        AND NOT EXISTS (SELECT 1 FROM public.hand_atomic_commits a
                         WHERE a.table_id=s.table_id AND a.hand_number>=s.hand_number)
        AND s.is_complete IS FALSE AND s.stage='preflop'
        AND s.state_json->>'stage'='preflop'
        AND s.state_json->'actionHistory'='[]'::jsonb
        AND jsonb_typeof(s.state_json->'players')='array'
        AND jsonb_array_length(s.state_json->'players')>0
        AND NOT EXISTS (
              SELECT 1 FROM jsonb_array_elements(s.state_json->'players') x
               WHERE NOT (coalesce(pg_input_is_valid(x->>'user_id','uuid'),false)
                      AND coalesce(pg_input_is_valid(x->>'stack','numeric'),false)
                      AND coalesce(pg_input_is_valid(x->>'totalInvested','numeric'),false)
                      AND EXISTS (SELECT 1 FROM public.tournament_players p
                                   WHERE p.tournament_id=tb.tournament_id
                                     AND p.user_id=(x->>'user_id')::uuid
                                     AND p.chips::numeric=(x->>'stack')::numeric+(x->>'totalInvested')::numeric)
                      AND EXISTS (SELECT 1 FROM public.table_seats q
                                   WHERE q.table_id=s.table_id AND q.user_id=(x->>'user_id')::uuid
                                     AND q.left_at IS NULL
                                     AND q.stack::numeric=(x->>'stack')::numeric+(x->>'totalInvested')::numeric)))
          ) AS agree
     FROM public.hand_state_snapshots s JOIN public.tables tb ON tb.id=s.table_id) q;
 IF n <> m THEN
  RAISE EXCEPTION 'F06_INERT_ABORT_CARDS_PROOF_CONTRACT_DIVERGED: % of % snapshot(s)', n-m, n
   USING ERRCODE='55000';
 END IF;
 RAISE NOTICE 'inert-abort proof: the predicate equals its five stated conditions on all % snapshot(s)', n;

 -- (3) THE REFUSAL ALGEBRA, exactly as the edited functions now spell it:
 --     ((count <> roster) AND NOT inert) OR orphan. The combination that is
 --     newly accepted is the only one that changed; a partial set, a partial
 --     set with an orphan, a full set with an orphan, a zero set that is not
 --     inert, and an over-large set all still refuse. Condition 1 is what
 --     makes "inert" unreachable for every row with count > 0, and proof (1)
 --     above establishes that over real data.
 FOR r IN SELECT * FROM (VALUES
     (0, 2, true,  false, false, 'zero cards, provably inert - THE RELAXATION'),
     (1, 2, false, false, true,  'PARTIAL SET - still refuses'),
     (2, 2, false, false, false, 'full matching set - unchanged'),
     (2, 2, false, true,  true,  'full set with an orphan row - still refuses'),
     (1, 2, false, true,  true,  'partial set with an orphan row - still refuses'),
     (0, 2, false, false, true,  'zero cards but NOT inert - still refuses'),
     (3, 2, false, false, true,  'more cards than seats - still refuses')
   ) AS t(cards_count, roster_len, inert, orphan, must_refuse)
 LOOP
  IF (((r.cards_count <> r.roster_len) AND NOT r.inert) OR r.orphan) IS DISTINCT FROM r.must_refuse THEN
   RAISE EXCEPTION 'F06_INERT_ABORT_CARDS_PROOF_ALGEBRA_CHANGED: %', r.must_refuse USING ERRCODE='55000';
  END IF;
  IF r.inert AND r.cards_count <> 0 THEN
   RAISE EXCEPTION 'F06_INERT_ABORT_CARDS_PROOF_ALGEBRA_CHANGED: inert with cards' USING ERRCODE='55000';
  END IF;
 END LOOP;
 RAISE NOTICE 'inert-abort proof: the refusal algebra holds for all 7 reviewed card shapes';

 -- (4) THE BLAST RADIUS, named. Every hand the predicate admits, with the
 --     independent aggregate restatement of condition 5: the pot lives only in
 --     state_json, so the durable chips of those players already equal the sum
 --     of their pre-hand totals. Printed so the operator installing this can
 --     see exactly which hands it unblocks.
 inert := 0;
 FOR r IN SELECT s.table_id, s.hand_number, tb.tournament_id,
                 jsonb_array_length(s.state_json->'players') AS players,
                 (s.state_json->>'pot')::numeric AS snapshot_pot,
                 (SELECT sum((x->>'stack')::numeric+(x->>'totalInvested')::numeric)
                    FROM jsonb_array_elements(s.state_json->'players') x) AS pre_hand_total,
                 (SELECT sum(p.chips::numeric) FROM public.tournament_players p
                   WHERE p.tournament_id=tb.tournament_id
                     AND p.user_id IN (SELECT (x->>'user_id')::uuid
                                         FROM jsonb_array_elements(s.state_json->'players') x)) AS durable_total
            FROM public.hand_state_snapshots s JOIN public.tables tb ON tb.id=s.table_id
           WHERE smarter_private.f06_zero_cards_abort_is_inert(tb.tournament_id, s.table_id, s.hand_number)
           ORDER BY s.table_id, s.hand_number
 LOOP
  inert := inert + 1;
  IF r.durable_total IS DISTINCT FROM r.pre_hand_total THEN
   RAISE EXCEPTION 'F06_INERT_ABORT_CARDS_PROOF_NOT_INERT: table % hand % durable % <> pre-hand %',
    r.table_id, r.hand_number, r.durable_total, r.pre_hand_total USING ERRCODE='55000';
  END IF;
  RAISE NOTICE 'inert-abort admits table % hand % (tournament %): % players, snapshot pot %, pre-hand total % = durable total %',
   r.table_id, r.hand_number, r.tournament_id, r.players, r.snapshot_pot, r.pre_hand_total, r.durable_total;
 END LOOP;
 RAISE NOTICE 'inert-abort proof: % hand(s) admitted in total', inert;
END $inert_proof$;

COMMENT ON FUNCTION smarter_private.f06_zero_cards_abort_is_inert(uuid, uuid, bigint) IS
 'True only where aborting an exact tournament/table/hand as unsettled is provably financially inert: exactly zero surviving hole cards, no atomic commit for that hand or any later hand at that table, an incomplete un-acted preflop snapshot, and every snapshot player''s durable chips (tournament_players.chips and the live table_seats.stack) already equal stack + totalInvested. Such an abort awards nothing and takes nothing, so its destroyed hole cards cannot affect any outcome. A partial card set is drift and is never admitted. Read-only; never widen.';
COMMIT;
