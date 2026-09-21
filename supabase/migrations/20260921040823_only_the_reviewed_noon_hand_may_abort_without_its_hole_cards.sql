-- ONE reviewed hand may be aborted without the hole cards that were destroyed
-- underneath it. Exactly one. Named in full, by tournament, table and hand.
--
-- WHAT HAPPENED
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
-- WHY THE PREVIOUS ATTEMPT WAS WRONG, IN ITS OWN WORDS
--
-- 20260921023053 proposed to admit ANY hand meeting five conditions: zero
-- surviving hole cards, no atomic commit for the hand, no later commit at the
-- table, an un-acted preflop snapshot, and every durable balance already equal
-- to stack + totalInvested. It was applied to kuklfnapbkmacvwxktbh and REFUSED
-- by its own dependency guard before it changed anything. Two faults were then
-- found, and this migration exists because of the second one.
--
--   The guard was wrong about production. It demanded a pg_constraint of type
--   p or u on public.hand_state_snapshots whose definition was exactly
--   'UNIQUE (table_id, hand_number)'. Production has no such constraint - only
--   hand_state_snapshots_pkey PRIMARY KEY (id), a NON-unique index
--   idx_hand_state_snapshots_table_hand on (table_id, hand_number), and the
--   PARTIAL unique index idx_hand_snapshots_one_active_per_table on
--   (table_id) WHERE is_complete = false. The probe fixture declared the
--   missing constraint, so the probe never noticed. That fixture is corrected
--   in this commit; see the dependency section below for what replaces it.
--
--   THE SCOPE WAS 468 HANDS, NOT ONE. Re-run read-only on
--   kuklfnapbkmacvwxktbh on 2026-09-20, the five conditions admit 468 hands
--   across 322 tournaments, every one holding a reserved permit, with snapshot
--   pots totalling 506,949 chips. The reasoning failed twice over:
--
--     Condition 1, "exactly zero hole cards", is not a fingerprint of the cron
--     destruction at all. A preflop hand on which nobody has acted simply has
--     no table_hole_cards rows yet, and 468 hands are in that state.
--
--     Condition 5, "financial inertness", is NEAR-VACUOUS for an un-acted
--     preflop. With actionHistory = [], stack + totalInvested IS the player's
--     starting stack, and the starting stack equals the durable balance BY
--     CONSTRUCTION - the chips have not been written down yet because nothing
--     has happened. The condition that was carrying the safety argument was
--     restating the definition of "the hand has not started".
--
--   Installing that would have lifted F06_RETAINED_CARDS_CHANGED for 468
--   reserved permits across 322 tournaments. That is not a repair.
--
-- WHAT THIS MIGRATION DOES INSTEAD
--
-- The relaxation is pinned to ONE hardcoded, reviewed (tournament, table,
-- hand):
--
--   tournament 5a387a75-754a-416e-8fee-b85b15fc2702  (Noon)
--   table      2c621856-e728-4e8b-bf08-4c56746a8649
--   hand       12942021
--
-- and the five conditions are KEPT, AND-ed on top. Nothing is deleted. The
-- identity pin is what makes the scope reviewable - a reader can see the whole
-- blast radius in three literals - and the five conditions are what make that
-- one hand safe to admit. With the pin, the same census that returned 468
-- returns exactly 1, and the in-transaction proof below refuses to commit
-- unless it returns exactly 1 AND that 1 is this triple.
--
-- WHY HARDCODED AND NOT DERIVED FROM THE COHORT
--
-- The house pattern for "an exact reviewed set of events" is
-- smarter_private.f06_retired_origin_cohort(uuid), an IMMUTABLE function
-- returning frozen JSON. Deriving the pin from it was considered and
-- REJECTED, because that cohort names TWO tournaments, each with its own
-- interrupted permit:
--
--   5a387a75-754a-416e-8fee-b85b15fc2702 -> table 2c621856..., hand 12942021
--   615783bf-15e3-40b7-9368-75f21b6ac53b -> table 9f30d335..., hand 12943630
--
-- A cohort-derived pin would therefore admit TWO triples. The second one,
-- Afternoon, does not need this relaxation and must not receive it: verified
-- live, it has NO public.hand_state_snapshots row at all, so its disposition
-- takes the prior_commit_plus_inbound_moves branch, which already REQUIRES
-- zero hole cards and never reaches the count test this migration edits.
-- Admitting it would widen the scope by one reviewed-but-unnecessary hand and
-- would leave the relaxation live on a table whose snapshot could appear
-- later. Three literals are narrower than a function call, and a reader does
-- not have to go and read the cohort to know what they authorise. The cohort
-- is still used - as a CROSS-CHECK in the pre-image below, which refuses to
-- install unless these three literals are exactly the Noon cohort's own
-- reserved permit - so the pin has provenance without having the cohort's
-- width.
--
-- WHY THIS ONE HAND IS SAFE
--
-- Verified live on kuklfnapbkmacvwxktbh on 2026-09-20: that abort moves ZERO
-- chips. For each of the two players the snapshot's own stack + totalInvested
-- already equals the durable balance in public.tournament_players.chips AND
-- the live public.table_seats.stack - user 23e84589: 0 + 46125 = 46125 =
-- 46125.00; user c1b575fb: 45000 + 43875 = 88875 = 88875.00. There is no
-- public.hand_atomic_commits row for that hand and none for any later hand at
-- that table. The 90,000 "pot" exists ONLY inside
-- hand_state_snapshots.state_json; it was never deducted from any durable
-- balance. Aborting the hand as unsettled restores exactly the state that is
-- already durable: it awards nothing, takes nothing and decides no winner, so
-- no hole card can affect any financial outcome, because no financial outcome
-- is being decided.
--
-- THE CONDITIONS, IN FULL
--
-- The shared SECURITY DEFINER predicate below is the conjunction of all of
-- these, so the two functions cannot disagree about any of them:
--
--   0. IDENTITY. The tournament, table and hand are the three literals above.
--      This alone reduces 468 to 1.
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
--   6. EXACTLY ONE public.hand_state_snapshots row exists for that exact
--      (table_id, hand_number). See the dependency section.
--
-- Conditions 1 to 5 are carried over unchanged from 20260921023053, where they
-- were reviewed. They are still correct; they were never sufficient. Condition
-- 6 is new and is discussed next. Condition 0 is the pin.
--
-- THE DEPENDENCY GUARD, HONESTLY
--
-- The refused guard demanded a UNIQUE (table_id, hand_number) constraint that
-- production does not have. It is not deleted here and it is not simply
-- dropped: it is replaced by the assertion it was reaching for, stated about
-- the one pair that now matters.
--
--   Condition 4 is an EXISTS over hand_state_snapshots for (table, hand):
--   SOME row is an un-acted preflop. Condition 5 is a NOT EXISTS over the same
--   rows: EVERY row's every player is already balanced. If two rows could
--   exist for one (table, hand), those two conditions could be speaking about
--   different rows, and "the snapshot" would not be a well-defined object.
--   The guard now asserts, for the pinned pair alone, that
--   count(*) = 1 - which is exactly what conditions 4 and 5 need in order to
--   agree, and which is TRUE in production today (verified: 1 row). The same
--   requirement is ALSO condition 6 of the runtime predicate, so the agreement
--   is enforced at every later call and not merely at install time.
--
--   A real production object is pinned as well: the PARTIAL unique index
--   idx_hand_snapshots_one_active_per_table on (table_id) WHERE
--   is_complete = false, by its exact pg_get_indexdef. It is the right one to
--   pin because condition 4 requires is_complete IS FALSE, so this index -
--   and only this index - bounds the population condition 4 can ever select
--   from: at most one incomplete snapshot per table, platform-wide. The
--   non-unique idx_hand_state_snapshots_table_hand guarantees nothing and is
--   not pinned; hand_state_snapshots_pkey is on (id) and says nothing about
--   (table_id, hand_number).
--
-- THIS IS NOT A WEAKENING. The old guard tested for an object that does not
-- exist, so it could only ever refuse - it protected nothing, it merely
-- stopped everything. What replaces it is a true statement about production
-- that is load-bearing for the two conditions that read the snapshot, checked
-- at install time AND at every call, plus a pin on the real index that bounds
-- condition 4. Note also that count(*) = 1 for the pinned pair is NOT implied
-- by the partial unique index: a second row for the same (table_id,
-- hand_number) with is_complete = true is permitted by that index, and the
-- new assertion is what closes it. The probe feeds exactly that row as drift.
--
-- WHAT THIS CHANGES IN THE TWO FUNCTIONS
--
-- One count test, in both functions, gains one alternative: the count may also
-- be EXACTLY ZERO when the predicate holds - which, by condition 0, can only
-- ever be the pinned hand. Every other assertion in both functions is
-- preserved byte for byte. The orphan-row test that follows the count is
-- untouched, so a card row whose user or seat is not in the roster still
-- refuses - and because any surviving card row fails condition 1, the
-- relaxation is unreachable whenever a card exists at all.
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
-- and a non-pinned hand that satisfies all five conditions, both executed end
-- to end against both functions, runs on a disposable cluster in
-- scripts/dev/probe-inert-abort-missing-hole-cards-pg17.sh.
BEGIN;
SET LOCAL lock_timeout = '3s';
-- The proof block below is a read-only census of all 36,336 rows of
-- public.hand_state_snapshots, twice over, plus the un-pinned five-condition
-- count that reproduces the 468. Measured on kuklfnapbkmacvwxktbh on
-- 2026-09-20 with EXPLAIN ANALYZE: the un-pinned census is 4.27s, the pinned
-- ones are 0.73s each because the identity equality short-circuits every other
-- term. A DO block is ONE top-level statement, so statement_timeout bounds the
-- whole proof, not each proof. 120s leaves roughly ten times the measured cost
-- for a loaded database; lock_timeout stays at 3s, because THAT is the one
-- that bounds how long this migration can block anybody.
SET LOCAL statement_timeout = '120s';

DO $inert_preimage$
DECLARE snap oid := to_regprocedure('smarter_private.f06_retired_origin_snapshot(jsonb)');
        mixed oid := to_regprocedure('smarter_private.f06_retained_mtt_abort_snapshot(jsonb)');
        helper oid := to_regprocedure('smarter_private.f06_zero_cards_abort_is_inert(uuid,uuid,bigint)');
        cohort jsonb;
BEGIN
 -- PRE-IMAGE. The live identity of both functions this repair edits, captured
 -- from kuklfnapbkmacvwxktbh on 2026-09-20: definition md5, body md5, owner,
 -- ACL, proconfig, security mode and volatility. Anything else is refused.
 -- The second md5 pair in each row is this migration's own result, so
 -- re-applying it is a clean no-op rather than a refusal.
 IF current_user <> 'postgres' OR snap IS NULL OR mixed IS NULL THEN
  RAISE EXCEPTION 'F06_NOON_ONLY_CARDS_PREIMAGE_CHANGED' USING ERRCODE='55000';
 END IF;
 IF (md5(pg_get_functiondef(snap)) IS DISTINCT FROM 'e821cf8a38c6718237f1d45110bf7f00'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid=snap)) IS DISTINCT FROM 'eef2b4beccc02dffd5efeffe57081a0e')
 AND (md5(pg_get_functiondef(snap)) IS DISTINCT FROM 'f1dc5d4b2a952ebb783e6ae66b844b94'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid=snap)) IS DISTINCT FROM 'af779e9bdaa72cefab1026b6fd236885') THEN
  RAISE EXCEPTION 'F06_NOON_ONLY_CARDS_PREIMAGE_CHANGED: f06_retired_origin_snapshot' USING ERRCODE='55000';
 END IF;
 IF (md5(pg_get_functiondef(mixed)) IS DISTINCT FROM '2d40c8218d043e644faa40f7b78ff772'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid=mixed)) IS DISTINCT FROM '45d5e92898dd9fb2fb72f33917cf96d8')
 AND (md5(pg_get_functiondef(mixed)) IS DISTINCT FROM '269b7f20c326e04788c003f2a8b081ad'
     OR md5((SELECT prosrc FROM pg_proc WHERE oid=mixed)) IS DISTINCT FROM '1339225a48748a2e8cedd9ad882f35d9') THEN
  RAISE EXCEPTION 'F06_NOON_ONLY_CARDS_PREIMAGE_CHANGED: f06_retained_mtt_abort_snapshot' USING ERRCODE='55000';
 END IF;
 -- Owner, ACL, proconfig, security mode and volatility, for both, preserved
 -- exactly. CREATE OR REPLACE keeps them; this refuses to start if they have
 -- already moved, and the post-image below proves they did not move here.
 IF (SELECT count(*) FROM pg_proc WHERE oid IN (snap,mixed)
      AND proowner='postgres'::regrole AND prosecdef AND provolatile='v'
      AND proacl::text='{postgres=X/postgres}'
      AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']::text[]) <> 2 THEN
  RAISE EXCEPTION 'F06_NOON_ONLY_CARDS_PREIMAGE_CHANGED: definer identity' USING ERRCODE='55000';
 END IF;
 -- A predicate of this name that is not the one written below is somebody
 -- else's object; replacing it blind would change their behaviour.
 IF helper IS NOT NULL
 AND md5(pg_get_functiondef(helper)) IS DISTINCT FROM '41e3b42c1b203814d8a90eca9dd5a7a1' THEN
  RAISE EXCEPTION 'F06_NOON_ONLY_CARDS_HELPER_CHANGED' USING ERRCODE='55000';
 END IF;

 -- PROVENANCE OF THE THREE LITERALS. They are not a guess: they are the Noon
 -- cohort's own reserved permit, as the IMMUTABLE house record spells it. If
 -- that record ever names a different hand, these literals stop being the
 -- reviewed one and this migration must not install.
 cohort := smarter_private.f06_retired_origin_cohort('5a387a75-754a-416e-8fee-b85b15fc2702');
 IF cohort IS NULL
 OR cohort#>>'{permit,tournament_id}' IS DISTINCT FROM '5a387a75-754a-416e-8fee-b85b15fc2702'
 OR cohort#>>'{permit,table_id}'      IS DISTINCT FROM '2c621856-e728-4e8b-bf08-4c56746a8649'
 OR cohort#>>'{permit,hand_number}'   IS DISTINCT FROM '12942021'
 OR cohort#>>'{permit,state}'         IS DISTINCT FROM 'reserved'
 OR cohort#>>'{permit,permit_id}'     IS DISTINCT FROM '098c0945-54f9-4c48-a600-3b8845da267b' THEN
  RAISE EXCEPTION 'F06_NOON_ONLY_CARDS_PIN_UNREVIEWED' USING ERRCODE='55000';
 END IF;

 -- The columns the conditions compare, in the types they compare them in. If
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
  RAISE EXCEPTION 'F06_NOON_ONLY_CARDS_DEPENDENCY_CHANGED' USING ERRCODE='55000';
 END IF;

 -- ONE SNAPSHOT ROW FOR THE PINNED PAIR. This is what conditions 4 and 5 need
 -- in order to be speaking about the same row: 4 asks whether SOME row is an
 -- un-acted preflop, 5 asks whether EVERY row is already balanced. Production
 -- has exactly one (verified read-only on 2026-09-20). This replaces the
 -- refused guard's demand for a UNIQUE (table_id, hand_number) constraint,
 -- which production does not have and never had.
 IF (SELECT count(*) FROM public.hand_state_snapshots
      WHERE table_id='2c621856-e728-4e8b-bf08-4c56746a8649'::uuid
        AND hand_number=12942021) <> 1 THEN
  RAISE EXCEPTION 'F06_NOON_ONLY_CARDS_DEPENDENCY_CHANGED: snapshot is not exactly one row'
   USING ERRCODE='55000';
 END IF;
 -- The real production index that bounds condition 4: at most ONE incomplete
 -- snapshot per table, platform-wide. Condition 4 requires is_complete IS
 -- FALSE, so this partial unique index is precisely the object that makes the
 -- set condition 4 can select from a bounded one. Pinned by its exact
 -- definition rather than by name alone.
 IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
                 WHERE i.indrelid=to_regclass('public.hand_state_snapshots')
                   AND c.relname='idx_hand_snapshots_one_active_per_table'
                   AND i.indisunique
                   AND pg_get_indexdef(i.indexrelid)=
                       'CREATE UNIQUE INDEX idx_hand_snapshots_one_active_per_table ON public.hand_state_snapshots USING btree (table_id) WHERE (is_complete = false)') THEN
  RAISE EXCEPTION 'F06_NOON_ONLY_CARDS_DEPENDENCY_CHANGED: one-active-snapshot index'
   USING ERRCODE='55000';
 END IF;
END $inert_preimage$;

CREATE OR REPLACE FUNCTION smarter_private.f06_zero_cards_abort_is_inert(p_tournament_id uuid, p_table_id uuid, p_hand_number bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'smarter_private'
AS $function$
  -- TRUE only for ONE reviewed hand - Noon tournament
  -- 5a387a75-754a-416e-8fee-b85b15fc2702, table
  -- 2c621856-e728-4e8b-bf08-4c56746a8649, hand 12942021 - whose hole cards
  -- were destroyed by public.cleanup_old_hole_cards() while its permit was
  -- still reserved, AND only while aborting it is still provably financially
  -- inert. All seven conditions must hold; any one of them failing leaves
  -- F06_RETAINED_CARDS_CHANGED standing. Never widen this, and in particular
  -- never make the identity a parameter, a table lookup or a cohort call: the
  -- same five conditions without the identity pin admit 468 hands across 322
  -- tournaments. Reads only; decides nothing else.
  SELECT
    -- 0. IDENTITY. The exact reviewed tournament, table and hand, hardcoded.
    --    This is the whole blast radius and it is visible here in full.
    p_tournament_id = '5a387a75-754a-416e-8fee-b85b15fc2702'::uuid
    AND p_table_id  = '2c621856-e728-4e8b-bf08-4c56746a8649'::uuid
    AND p_hand_number = 12942021::bigint
    -- 1. EXACTLY zero hole cards for this exact table and hand. A PARTIAL set
    --    means some rows survived and some did not, which is real drift.
    AND NOT EXISTS (SELECT 1 FROM public.table_hole_cards c
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
    -- 5. FINANCIAL INERTNESS. For EVERY player in the snapshot the durable
    --    balance ALREADY equals that player's pre-hand total (stack +
    --    totalInvested), in public.tournament_players AND in the live
    --    public.table_seats row. The pot therefore exists only inside
    --    state_json and was never deducted from anything durable, so aborting
    --    the hand as unsettled restores exactly what is already durable: it
    --    awards nothing, takes nothing and decides no winner. Note that for an
    --    un-acted preflop this is close to vacuous - it is the identity pin
    --    above, not this, that bounds the scope - but it is still the thing
    --    that would go false first if chips moved underneath the pinned hand
    --    between this migration and its disposition, so it is kept.
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
                                  = (x->>'stack')::numeric + (x->>'totalInvested')::numeric)))
    -- 6. EXACTLY ONE snapshot row for this exact (table_id, hand_number), so
    --    conditions 4 and 5 are speaking about the same row. Production has
    --    no UNIQUE (table_id, hand_number); the partial unique index
    --    idx_hand_snapshots_one_active_per_table permits a second row here as
    --    long as it is is_complete = true. This closes that.
    AND (SELECT count(*) FROM public.hand_state_snapshots s
          WHERE s.table_id = p_table_id AND s.hand_number = p_hand_number) = 1;
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
          'smarter_private.f06_retired_origin_snapshot(jsonb)',     'f1dc5d4b2a952ebb783e6ae66b844b94',
          'smarter_private.f06_retained_mtt_abort_snapshot(jsonb)', '269b7f20c326e04788c003f2a8b081ad');
BEGIN
 FOREACH sig IN ARRAY ARRAY['smarter_private.f06_retired_origin_snapshot(jsonb)',
                            'smarter_private.f06_retained_mtt_abort_snapshot(jsonb)'] LOOP
  target := to_regprocedure(sig);
  want := pins->>sig;
  IF md5(pg_get_functiondef(target)) = want THEN
   RAISE NOTICE '% already admits the reviewed Noon zero-card abort; body unchanged', sig;
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
$after$ -- The hole cards of ONE reviewed hand were destroyed by age while that hand
 -- was still unresolved, and they are unrecoverable: Noon tournament
 -- 5a387a75-754a-416e-8fee-b85b15fc2702, table
 -- 2c621856-e728-4e8b-bf08-4c56746a8649, hand 12942021. Admit that hand, and
 -- ONLY that hand - the predicate hardcodes all three identifiers - and only
 -- while the abort provably moves no chips: exactly zero cards survive, the
 -- hand never committed, nothing committed after it at this table, the
 -- snapshot is a single un-acted preflop row, and every durable balance
 -- ALREADY equals that player's pre-hand total. Such an abort awards nothing,
 -- takes nothing and decides no winner, so no hole card can affect any
 -- financial outcome - there is no financial outcome to affect. Every OTHER
 -- hand, including the 468 un-acted preflops that satisfy the financial
 -- conditions and the second tournament in the retired-origin cohort, still
 -- refuses here. A PARTIAL set is real drift and still refuses.
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
   RAISE EXCEPTION 'F06_NOON_ONLY_CARDS_COMPOSITION_CHANGED: %', sig USING ERRCODE='55000';
  END IF;
  EXECUTE replacement;
  SELECT to_jsonb(p)-'prosrc' INTO after_metadata FROM pg_proc p WHERE oid=target;
  -- POST-IMAGE. Owner, ACL, search_path, volatility and security mode must be
  -- byte-identical to the pre-image; only the body may have moved.
  IF after_metadata IS DISTINCT FROM before_metadata
  OR pg_get_functiondef(target) IS DISTINCT FROM replacement THEN
   RAISE EXCEPTION 'F06_NOON_ONLY_CARDS_POSTIMAGE_CHANGED: %', sig USING ERRCODE='55000';
  END IF;
 END LOOP;
END $inert_edit$;

DO $inert_postimage$
DECLARE snap oid := to_regprocedure('smarter_private.f06_retired_origin_snapshot(jsonb)');
        mixed oid := to_regprocedure('smarter_private.f06_retained_mtt_abort_snapshot(jsonb)');
        helper oid := to_regprocedure('smarter_private.f06_zero_cards_abort_is_inert(uuid,uuid,bigint)');
BEGIN
 -- POST-IMAGE, all three objects, read back from the catalog.
 IF md5(pg_get_functiondef(snap)) IS DISTINCT FROM 'f1dc5d4b2a952ebb783e6ae66b844b94'
 OR md5((SELECT prosrc FROM pg_proc WHERE oid=snap)) IS DISTINCT FROM 'af779e9bdaa72cefab1026b6fd236885'
 OR md5(pg_get_functiondef(mixed)) IS DISTINCT FROM '269b7f20c326e04788c003f2a8b081ad'
 OR md5((SELECT prosrc FROM pg_proc WHERE oid=mixed)) IS DISTINCT FROM '1339225a48748a2e8cedd9ad882f35d9'
 OR (SELECT count(*) FROM pg_proc WHERE oid IN (snap,mixed)
      AND proowner='postgres'::regrole AND prosecdef AND provolatile='v'
      AND proacl::text='{postgres=X/postgres}'
      AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']::text[]) <> 2 THEN
  RAISE EXCEPTION 'F06_NOON_ONLY_CARDS_POSTIMAGE_CHANGED' USING ERRCODE='55000';
 END IF;
 IF helper IS NULL
 OR md5(pg_get_functiondef(helper)) IS DISTINCT FROM '41e3b42c1b203814d8a90eca9dd5a7a1'
 OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=helper AND proowner='postgres'::regrole
      AND prosecdef AND provolatile='s'
      AND proacl::text='{postgres=X/postgres}'
      AND proconfig=ARRAY['search_path=pg_catalog, public, smarter_private']::text[]) THEN
  RAISE EXCEPTION 'F06_NOON_ONLY_CARDS_HELPER_CHANGED' USING ERRCODE='55000';
 END IF;
 -- The identity pin is present, in full, in the installed predicate. Three
 -- literals; if any of them is not there, the object in the catalog is not the
 -- one reviewed here.
 IF (SELECT count(*) FROM pg_proc WHERE oid=helper
      AND prosrc LIKE '%5a387a75-754a-416e-8fee-b85b15fc2702%'
      AND prosrc LIKE '%2c621856-e728-4e8b-bf08-4c56746a8649%'
      AND prosrc LIKE '%12942021%') <> 1 THEN
  RAISE EXCEPTION 'F06_NOON_ONLY_CARDS_HELPER_CHANGED: identity pin absent' USING ERRCODE='55000';
 END IF;
 -- Every other assertion is preserved: the two functions still carry exactly
 -- one F06_RETAINED_CARDS_CHANGED each, and the refusal count for the branch
 -- this edit touches is unchanged. Nothing was deleted to make room.
 IF (SELECT count(*) FROM pg_proc WHERE oid IN (snap,mixed)
      AND (length(prosrc)-length(replace(prosrc,'F06_RETAINED_CARDS_CHANGED','')))/26 = 1
      AND (length(prosrc)-length(replace(prosrc,'RAISE EXCEPTION','')))/15 = 23) <> 2 THEN
  RAISE EXCEPTION 'F06_NOON_ONLY_CARDS_POSTIMAGE_CHANGED: assertion count' USING ERRCODE='55000';
 END IF;
END $inert_postimage$;

DO $inert_proof$
DECLARE n bigint; m bigint; hands bigint; admitted bigint; five bigint; r record;
BEGIN
 -- EXECUTABLE PROOF, read-only, in this same transaction. public.table_hole_
 -- cards is writer-guarded and smarter_private.f06_hand_permits is
 -- immutability-guarded, so these proofs run over real rows rather than
 -- inserted ones; the writing proofs are in the PG17 probe.

 -- (1) THE SCOPE IS EXACTLY ONE HAND, AND IT IS THE REVIEWED ONE. This is the
 --     proof the previous attempt did not have. Every snapshot in the database
 --     is offered to the predicate; exactly one may be admitted, and it must be
 --     the pinned triple. Anything else - none, two, or a different hand -
 --     raises and rolls the whole migration back.
 admitted := 0;
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
  admitted := admitted + 1;
  IF r.tournament_id IS DISTINCT FROM '5a387a75-754a-416e-8fee-b85b15fc2702'::uuid
  OR r.table_id      IS DISTINCT FROM '2c621856-e728-4e8b-bf08-4c56746a8649'::uuid
  OR r.hand_number   IS DISTINCT FROM 12942021 THEN
   RAISE EXCEPTION 'F06_NOON_ONLY_CARDS_PROOF_SCOPE_ESCAPED: tournament % table % hand %',
    r.tournament_id, r.table_id, r.hand_number USING ERRCODE='55000';
  END IF;
  IF r.durable_total IS DISTINCT FROM r.pre_hand_total THEN
   RAISE EXCEPTION 'F06_NOON_ONLY_CARDS_PROOF_NOT_INERT: table % hand % durable % <> pre-hand %',
    r.table_id, r.hand_number, r.durable_total, r.pre_hand_total USING ERRCODE='55000';
  END IF;
  RAISE NOTICE 'noon-only admits table % hand % (tournament %): % players, snapshot pot %, pre-hand total % = durable total %',
   r.table_id, r.hand_number, r.tournament_id, r.players, r.snapshot_pot, r.pre_hand_total, r.durable_total;
 END LOOP;
 IF admitted <> 1 THEN
  RAISE EXCEPTION 'F06_NOON_ONLY_CARDS_PROOF_SCOPE_CHANGED: % hand(s) admitted, expected exactly 1', admitted
   USING ERRCODE='55000';
 END IF;
 RAISE NOTICE 'noon-only proof: exactly % hand admitted, and it is the reviewed triple', admitted;

 -- (2) THE PIN IS WHAT DOES THE NARROWING, MEASURED. The same five financial
 --     conditions WITHOUT the identity pin are re-derived inline here and
 --     counted. That count is the blast radius the previous attempt would have
 --     had; this migration's is 1. The number is printed so the operator can
 --     see both. It is not asserted to any particular value - it is live data
 --     and may drift - but it must be at least the one hand, and every hand in
 --     it other than the pinned one must be REFUSED by the predicate.
 SELECT count(*) INTO five FROM public.hand_state_snapshots s JOIN public.tables tb ON tb.id=s.table_id
  WHERE NOT EXISTS (SELECT 1 FROM public.table_hole_cards c
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
                               WHERE p.tournament_id=tb.tournament_id AND p.user_id=(x->>'user_id')::uuid
                                 AND p.chips::numeric=(x->>'stack')::numeric+(x->>'totalInvested')::numeric)
                  AND EXISTS (SELECT 1 FROM public.table_seats q
                               WHERE q.table_id=s.table_id AND q.user_id=(x->>'user_id')::uuid
                                 AND q.left_at IS NULL
                                 AND q.stack::numeric=(x->>'stack')::numeric+(x->>'totalInvested')::numeric)));
 IF five < 1 THEN
  RAISE EXCEPTION 'F06_NOON_ONLY_CARDS_PROOF_FIVE_CONDITIONS_VANISHED' USING ERRCODE='55000';
 END IF;
 RAISE NOTICE 'noon-only proof: the five financial conditions alone would admit % hand(s); the identity pin admits 1', five;

 -- (3) NO NON-PINNED HAND IS ADMITTED, stated as its own assertion over every
 --     snapshot in the database rather than inferred from the count above.
 SELECT count(*) INTO n
   FROM public.hand_state_snapshots s JOIN public.tables tb ON tb.id=s.table_id
  WHERE smarter_private.f06_zero_cards_abort_is_inert(tb.tournament_id, s.table_id, s.hand_number)
    AND (tb.tournament_id, s.table_id, s.hand_number::bigint) IS DISTINCT FROM
        ('5a387a75-754a-416e-8fee-b85b15fc2702'::uuid,'2c621856-e728-4e8b-bf08-4c56746a8649'::uuid,12942021::bigint);
 IF n <> 0 THEN
  RAISE EXCEPTION 'F06_NOON_ONLY_CARDS_PROOF_SCOPE_ESCAPED: % non-pinned hand(s) admitted', n USING ERRCODE='55000';
 END IF;
 RAISE NOTICE 'noon-only proof: no non-pinned snapshot is admitted';

 -- (4) THE OTHER COHORT TOURNAMENT IS REFUSED. Afternoon is the hand a
 --     cohort-derived pin would also have admitted. It is asked directly, by
 --     the cohort's own identifiers, and must come back false.
 IF smarter_private.f06_zero_cards_abort_is_inert(
      '615783bf-15e3-40b7-9368-75f21b6ac53b'::uuid,
      (smarter_private.f06_retired_origin_cohort('615783bf-15e3-40b7-9368-75f21b6ac53b')#>>'{permit,table_id}')::uuid,
      (smarter_private.f06_retired_origin_cohort('615783bf-15e3-40b7-9368-75f21b6ac53b')#>>'{permit,hand_number}')::bigint) THEN
  RAISE EXCEPTION 'F06_NOON_ONLY_CARDS_PROOF_COHORT_WIDER: the second cohort tournament is admitted'
   USING ERRCODE='55000';
 END IF;
 RAISE NOTICE 'noon-only proof: the second retired-origin cohort tournament is refused';

 -- (5) A PARTIAL SET STILL REFUSES, executed over every hand that actually has
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
  RAISE EXCEPTION 'F06_NOON_ONLY_CARDS_PROOF_NONEMPTY_SET_ADMITTED: % of % hand(s)', n, hands
   USING ERRCODE='55000';
 END IF;
 RAISE NOTICE 'noon-only proof: % hand(s) still hold cards and every one of them is refused', hands;

 -- (6) THE PREDICATE IS EXACTLY ITS SEVEN CONDITIONS, re-derived inline from
 --     the same tables and compared over every hand that has a snapshot. If
 --     the predicate is ever edited into something wider or narrower than the
 --     conditions it claims, this disagrees and the migration refuses.
 SELECT count(*), count(*) FILTER (WHERE agree) INTO n, m FROM (
   SELECT smarter_private.f06_zero_cards_abort_is_inert(tb.tournament_id, s.table_id, s.hand_number)
          IS NOT DISTINCT FROM (
            tb.tournament_id='5a387a75-754a-416e-8fee-b85b15fc2702'::uuid
        AND s.table_id='2c621856-e728-4e8b-bf08-4c56746a8649'::uuid
        AND s.hand_number=12942021
        AND NOT EXISTS (SELECT 1 FROM public.table_hole_cards c
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
        AND (SELECT count(*) FROM public.hand_state_snapshots z
              WHERE z.table_id=s.table_id AND z.hand_number=s.hand_number)=1
          ) AS agree
     FROM public.hand_state_snapshots s JOIN public.tables tb ON tb.id=s.table_id) q;
 IF n <> m THEN
  RAISE EXCEPTION 'F06_NOON_ONLY_CARDS_PROOF_CONTRACT_DIVERGED: % of % snapshot(s)', n-m, n
   USING ERRCODE='55000';
 END IF;
 RAISE NOTICE 'noon-only proof: the predicate equals its seven stated conditions on all % snapshot(s)', n;

 -- (7) THE REFUSAL ALGEBRA, exactly as the edited functions now spell it:
 --     ((count <> roster) AND NOT inert) OR orphan. The combination that is
 --     newly accepted is the only one that changed; a partial set, a partial
 --     set with an orphan, a full set with an orphan, a zero set that is not
 --     inert, and an over-large set all still refuse. Condition 1 is what
 --     makes "inert" unreachable for every row with count > 0, and proof (5)
 --     above establishes that over real data.
 FOR r IN SELECT * FROM (VALUES
     (0, 2, true,  false, false, 'zero cards, the pinned hand, provably inert - THE RELAXATION'),
     (1, 2, false, false, true,  'PARTIAL SET - still refuses'),
     (2, 2, false, false, false, 'full matching set - unchanged'),
     (2, 2, false, true,  true,  'full set with an orphan row - still refuses'),
     (1, 2, false, true,  true,  'partial set with an orphan row - still refuses'),
     (0, 2, false, false, true,  'zero cards but NOT the pinned hand - still refuses'),
     (3, 2, false, false, true,  'more cards than seats - still refuses')
   ) AS t(cards_count, roster_len, inert, orphan, must_refuse)
 LOOP
  IF (((r.cards_count <> r.roster_len) AND NOT r.inert) OR r.orphan) IS DISTINCT FROM r.must_refuse THEN
   RAISE EXCEPTION 'F06_NOON_ONLY_CARDS_PROOF_ALGEBRA_CHANGED: %', r.must_refuse USING ERRCODE='55000';
  END IF;
  IF r.inert AND r.cards_count <> 0 THEN
   RAISE EXCEPTION 'F06_NOON_ONLY_CARDS_PROOF_ALGEBRA_CHANGED: inert with cards' USING ERRCODE='55000';
  END IF;
 END LOOP;
 RAISE NOTICE 'noon-only proof: the refusal algebra holds for all 7 reviewed card shapes';
END $inert_proof$;

COMMENT ON FUNCTION smarter_private.f06_zero_cards_abort_is_inert(uuid, uuid, bigint) IS
 'True for EXACTLY ONE reviewed hand - tournament 5a387a75-754a-416e-8fee-b85b15fc2702, table 2c621856-e728-4e8b-bf08-4c56746a8649, hand 12942021, all three hardcoded - and only while aborting it as unsettled is provably financially inert: exactly zero surviving hole cards, no atomic commit for that hand or any later hand at that table, exactly one incomplete un-acted preflop snapshot row, and every snapshot player''s durable chips (tournament_players.chips and the live table_seats.stack) already equal stack + totalInvested. Such an abort awards nothing and takes nothing, so its destroyed hole cards cannot affect any outcome. The financial conditions WITHOUT the identity pin admit 468 hands across 322 tournaments, so the pin is what bounds this, not the conditions. A partial card set is drift and is never admitted. Read-only; never widen.';
COMMIT;
