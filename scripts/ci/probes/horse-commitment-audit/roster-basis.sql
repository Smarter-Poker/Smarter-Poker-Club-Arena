-- Accepted-roster identity: synthetic rows in a disposable fixture database.
-- Runs after roster-basis-setup.sql and 20261008041707 are installed, so the
-- epoch is noon UTC two days ago: day D3 is wholly before it, D2 spans it and
-- D1 is wholly after it. Every mutation is rolled back by the final ROLLBACK;
-- helpers live in pg_temp. No production object, connection or credential.
-- Each named check counts once; the wrapper requires the exact total.
BEGIN;
SET LOCAL statement_timeout='60s';
CREATE TEMP TABLE checks(name text PRIMARY KEY);
GRANT SELECT,INSERT ON checks TO service_role,anon,authenticated;
CREATE FUNCTION pg_temp.ok(name text, cond boolean) RETURNS void LANGUAGE plpgsql AS $ok$
BEGIN
  IF cond IS DISTINCT FROM true THEN RAISE EXCEPTION 'roster_basis_check_failed: %', name; END IF;
  INSERT INTO checks VALUES(name);
END $ok$;
CREATE FUNCTION pg_temp.refused(stmt text, state text, message text) RETURNS boolean LANGUAGE plpgsql AS $r$
DECLARE got_state text; got_message text;
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS got_state=RETURNED_SQLSTATE, got_message=MESSAGE_TEXT;
    RETURN got_state=state AND (message IS NULL OR got_message=message);
  END;
  RETURN false;
END $r$;
CREATE FUNCTION pg_temp.keys(v jsonb) RETURNS text[] LANGUAGE sql AS
 $k$ SELECT coalesce(array_agg(k ORDER BY k),'{}') FROM jsonb_object_keys(v) k $k$;
CREATE FUNCTION pg_temp.hid(seed text) RETURNS uuid LANGUAGE sql AS $h$ SELECT md5('rb-'||seed)::uuid $h$;
CREATE TEMP TABLE fx AS SELECT
  (transaction_timestamp() AT TIME ZONE 'UTC')::date-1 AS d1,
  (transaction_timestamp() AT TIME ZONE 'UTC')::date-2 AS d2,
  (transaction_timestamp() AT TIME ZONE 'UTC')::date-3 AS d3,
  (((transaction_timestamp() AT TIME ZONE 'UTC')::date-2)::timestamp AT TIME ZONE 'UTC')+interval '12 hours' AS epoch,
  '35353535-3535-4535-8535-353535353535'::uuid AS tbl,
  '11111111-aaaa-4aaa-8aaa-111111111111'::uuid AS h1,
  '22222222-aaaa-4aaa-8aaa-222222222222'::uuid AS h2,
  '33333333-bbbb-4bbb-8bbb-333333333333'::uuid AS u1,
  '44444444-bbbb-4bbb-8bbb-444444444444'::uuid AS u2,
  -- f1: a human today, a horse when its hands were accepted.
  '55555555-cccc-4ccc-8ccc-555555555555'::uuid AS f1,
  -- f2: a horse today, a human when its hands were accepted.
  '66666666-cccc-4ccc-8ccc-666666666666'::uuid AS f2,
  -- m: seated, with no profile row at all.
  '77777777-dddd-4ddd-8ddd-777777777777'::uuid AS m;
GRANT SELECT ON fx TO service_role,anon,authenticated;
INSERT INTO public.profiles SELECT h1,true FROM fx UNION ALL SELECT h2,true FROM fx UNION ALL SELECT u1,false FROM fx
  UNION ALL SELECT u2,false FROM fx UNION ALL SELECT f1,false FROM fx UNION ALL SELECT f2,true FROM fx;
SELECT pg_temp.ok('epoch_is_the_first_captured_roster',
  (SELECT e.first_captured_at=f.epoch AND e.hand_number=1 AND e.table_id='66666666-6666-4666-8666-666666666666'
     AND e.hand_id='77777777-7777-4777-8777-777777777777' FROM public.horse_commitment_roster_epoch e, fx f)
  AND (SELECT count(*)=1 FROM public.horse_commitment_roster_epoch));

-- One hand. players: the dealt list; every player commits 21 at big blind 2
-- (10.5 BB, over the 10 BB line). roster_kind: none, captured, unavailable,
-- mismatch. actors: [[userId, classification], ...] for a captured roster.
CREATE SEQUENCE pg_temp.hand_numbers START 2000001;
CREATE FUNCTION pg_temp.hand(seed text, at timestamptz, players uuid[], with_commit boolean,
  roster_kind text, actors jsonb DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $hand$
DECLARE f fx%ROWTYPE; id uuid:=pg_temp.hid(seed); n bigint:=nextval('pg_temp.hand_numbers');
  payload jsonb; payload_hash text; dealt jsonb; roster jsonb;
BEGIN
  SELECT * INTO f FROM fx;
  dealt:=(SELECT jsonb_agg(jsonb_build_object('userId',p,'seat',o) ORDER BY o) FROM unnest(players) WITH ORDINALITY u(p,o));
  INSERT INTO public.hand_history(id,table_id,created_at,game_variant,big_blind,players,tournament_id,hand_number,actions)
    VALUES(id,f.tbl,at,'nlh',2,dealt,NULL,n,'[]');
  IF NOT with_commit THEN RETURN id; END IF;
  payload:=jsonb_build_object('accepted_hand_facts',jsonb_build_object(
    'contributions',(SELECT jsonb_object_agg(p::text,21) FROM unnest(players) p),'returned_uncalled','{}'::jsonb));
  payload_hash:=encode(extensions.digest(convert_to(payload::text,'UTF8'),'sha256'),'hex');
  INSERT INTO public.hand_atomic_commits(hand_id,table_id,payload_hash,post_commit_payload_hash,post_commit_payload,
      hand_number,stack_result,committed_at,post_commit_request_hash,post_commit_completed_at)
    VALUES(id,f.tbl,repeat('a',64),payload_hash,payload,n,'{}'::jsonb,at,repeat('b',64),at);
  IF roster_kind='captured' THEN
    roster:=jsonb_build_object('version',1,'basis','profiles_read_in_acceptance_transaction',
      'tableId',f.tbl::text,'handId',id::text,'handNumber',n,
      'capturedAt',to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'actors',(SELECT jsonb_agg(jsonb_build_object('userId',a->>0,'seat',o,'seatId',md5(seed||o)::uuid,
        'seatJoinedAt','2026-01-01T00:00:00Z','classification',a->>1,
        'status',CASE WHEN a->>1='unknown' THEN 'profile_missing' ELSE 'canonical_boolean' END) ORDER BY o)
        FROM jsonb_array_elements(actors) WITH ORDINALITY x(a,o)));
    INSERT INTO smarter_private.accepted_hand_rosters(table_id,hand_number,hand_id,post_commit_payload_hash,status,roster,captured_at)
      VALUES(f.tbl,n,id,payload_hash,'captured',roster,at);
  ELSIF roster_kind='unavailable' THEN
    INSERT INTO smarter_private.accepted_hand_rosters(table_id,hand_number,hand_id,post_commit_payload_hash,status,reasons,roster,captured_at)
      VALUES(f.tbl,n,id,payload_hash,'unavailable',ARRAY['legacy_stack_seat_generation'],NULL,at);
  ELSIF roster_kind='mismatch' THEN
    -- The discriminator at this hand's (table, hand number) is bound to a
    -- different hand id: it is not this hand's roster.
    INSERT INTO smarter_private.accepted_hand_rosters(table_id,hand_number,hand_id,post_commit_payload_hash,status,roster,captured_at)
      VALUES(f.tbl,n,md5('other-'||seed)::uuid,payload_hash,'captured',
        jsonb_build_object('version',1,'tableId',f.tbl::text,'handId',md5('other-'||seed)::uuid::text,
          'actors',jsonb_build_array(jsonb_build_object('userId',f.h1,'classification','horse'),
            jsonb_build_object('userId',f.u1,'classification','human'))),at);
  END IF;
  RETURN id;
END $hand$;

-- D3, wholly before the epoch: the current profile is the only basis.
SELECT pg_temp.hand('pre-horse',(SELECT d3::timestamp AT TIME ZONE 'UTC'+interval '6 hours' FROM fx),(SELECT ARRAY[h1,u1] FROM fx),true,'none');
SELECT pg_temp.hand('pre-flipped',(SELECT d3::timestamp AT TIME ZONE 'UTC'+interval '7 hours' FROM fx),(SELECT ARRAY[f1,u1] FROM fx),true,'none');
-- D2, across the epoch.
SELECT pg_temp.hand('mix-pre',(SELECT d2::timestamp AT TIME ZONE 'UTC'+interval '6 hours' FROM fx),(SELECT ARRAY[h1,u1] FROM fx),true,'none');
SELECT pg_temp.hand('mix-just-before',(SELECT epoch-interval '1 microsecond' FROM fx),(SELECT ARRAY[h2,u1] FROM fx),true,'none');
SELECT pg_temp.hand('mix-at-epoch',(SELECT epoch FROM fx),(SELECT ARRAY[h2,u1] FROM fx),true,'captured',
  (SELECT jsonb_build_array(jsonb_build_array(h2,'human'),jsonb_build_array(u1,'human')) FROM fx));
SELECT pg_temp.hand('mix-post-flipped',(SELECT d2::timestamp AT TIME ZONE 'UTC'+interval '18 hours' FROM fx),(SELECT ARRAY[f1,u1] FROM fx),true,'captured',
  (SELECT jsonb_build_array(jsonb_build_array(f1,'horse'),jsonb_build_array(u1,'human')) FROM fx));
SELECT pg_temp.hand('mix-post-was-human',(SELECT d2::timestamp AT TIME ZONE 'UTC'+interval '18 hours 1 second' FROM fx),(SELECT ARRAY[f2,u1] FROM fx),true,'captured',
  (SELECT jsonb_build_array(jsonb_build_array(f2,'human'),jsonb_build_array(u1,'human')) FROM fx));
-- D1, wholly after the epoch: the accepted roster is the only basis.
SELECT pg_temp.hand('post-horse',(SELECT d1::timestamp AT TIME ZONE 'UTC'+interval '1 hour' FROM fx),(SELECT ARRAY[h1,u1] FROM fx),true,'captured',
  (SELECT jsonb_build_array(jsonb_build_array(h1,'horse'),jsonb_build_array(u1,'human')) FROM fx));
SELECT pg_temp.hand('post-unavailable',(SELECT d1::timestamp AT TIME ZONE 'UTC'+interval '2 hours' FROM fx),(SELECT ARRAY[h1,u1] FROM fx),true,'unavailable');
SELECT pg_temp.hand('post-legacy-missing',(SELECT d1::timestamp AT TIME ZONE 'UTC'+interval '3 hours' FROM fx),(SELECT ARRAY[h1,u1] FROM fx),true,'none');
SELECT pg_temp.hand('post-no-commit',(SELECT d1::timestamp AT TIME ZONE 'UTC'+interval '4 hours' FROM fx),(SELECT ARRAY[h1,u1] FROM fx),false,'none');
SELECT pg_temp.hand('post-mismatch',(SELECT d1::timestamp AT TIME ZONE 'UTC'+interval '5 hours' FROM fx),(SELECT ARRAY[h1,u1] FROM fx),true,'mismatch');
SELECT pg_temp.hand('post-invalid',(SELECT d1::timestamp AT TIME ZONE 'UTC'+interval '6 hours' FROM fx),(SELECT ARRAY[h1,u1] FROM fx),true,'captured',
  (SELECT jsonb_build_array(jsonb_build_array(h1,'horse')) FROM fx));
SELECT pg_temp.hand('post-unknown',(SELECT d1::timestamp AT TIME ZONE 'UTC'+interval '7 hours' FROM fx),(SELECT ARRAY[h1,m] FROM fx),true,'captured',
  (SELECT jsonb_build_array(jsonb_build_array(h1,'horse'),jsonb_build_array(m,'unknown')) FROM fx));
SELECT pg_temp.hand('post-disagree',(SELECT d1::timestamp AT TIME ZONE 'UTC'+interval '8 hours' FROM fx),(SELECT ARRAY[h1,u1] FROM fx),true,'captured',
  (SELECT jsonb_build_array(jsonb_build_array(h1,'horse'),jsonb_build_array(u2,'human')) FROM fx));
SELECT pg_temp.hand('post-dealt-invalid',(SELECT d1::timestamp AT TIME ZONE 'UTC'+interval '9 hours' FROM fx),(SELECT ARRAY[h1] FROM fx),true,'captured',
  (SELECT jsonb_build_array(jsonb_build_array(h1,'horse'),jsonb_build_array(u1,'human')) FROM fx));

-- D1's pass 1 was under way before this body existed, like the production
-- rows at install: the profile-only body already scanned its first hand
-- (post-horse), so its identity counters are NULL and its basis is the
-- profile's. The new body continues it from that cursor.
INSERT INTO public.horse_commitment_audit_days(day,pass,after_created_at,after_hand_id,started_at,last_batch_at,
    scanned_hands,horse_hands,flagged_horse_hands,roster_identity_hands,profile_identity_hands,roster_unavailable_hands,roster_missing_hands)
  SELECT d1,1,h.created_at,h.id,transaction_timestamp(),transaction_timestamp(),1,1,1,NULL,NULL,NULL,NULL
  FROM fx, public.hand_history h WHERE h.id=pg_temp.hid('post-horse');

CREATE TEMP TABLE steps(n serial, result jsonb);
GRANT SELECT,INSERT ON steps TO service_role;
GRANT USAGE ON SEQUENCE steps_n_seq TO service_role;
SET LOCAL ROLE service_role;
INSERT INTO steps(result) SELECT public.fn_horse_commitment_audit_step();  -- D3 pass 1
INSERT INTO steps(result) SELECT public.fn_horse_commitment_audit_step();  -- D2 pass 1
INSERT INTO steps(result) SELECT public.fn_horse_commitment_audit_step();  -- D1 pass 1
INSERT INTO steps(result) SELECT public.fn_horse_commitment_audit_step();  -- idle
RESET ROLE;
SELECT pg_temp.ok('return_contract_unchanged',
  (SELECT bool_and(pg_temp.keys(result)=CASE WHEN result->>'status' IN ('idle','busy')
     THEN ARRAY['activationAuthorized','sourceCoverage','status','version']
     ELSE ARRAY['activationAuthorized','day','flaggedHorseHands','gtoVerdict','handGaps','horseHands',
       'scannedHands','sourceCoverage','status','unknownHorseHands','version'] END
     AND result->>'sourceCoverage'='not_established' AND (result->>'version')::int=1) FROM steps)
  AND (SELECT array_agg(result->>'status' ORDER BY n) FROM steps)=ARRAY['pass_complete','pass_complete','pass_complete','idle']);

-- D3: pre-roster hands fall back to the current profile, and say so.
SELECT pg_temp.ok('pre_roster_day_basis_named',
  (SELECT identity_basis='current_profile_is_horse' AND scanned_hands=2 AND horse_hands=1
     FROM public.horse_commitment_audit_days WHERE day=(SELECT d3 FROM fx)));
SELECT pg_temp.ok('pre_roster_fallback_reads_current_profile',
  EXISTS(SELECT 1 FROM public.horse_commitment_reviews WHERE hand_id=pg_temp.hid('pre-horse') AND horse_user_id=(SELECT h1 FROM fx))
  AND NOT EXISTS(SELECT 1 FROM public.horse_commitment_reviews WHERE hand_id=pg_temp.hid('pre-flipped')));
SELECT pg_temp.ok('pre_roster_day_receipt_counts',
  (SELECT count(*)=1 AND bool_and(identity_basis='current_profile_is_horse' AND profile_identity_hands=2
     AND roster_identity_hands=0 AND roster_unavailable_hands=0 AND roster_missing_hands=0)
   FROM public.horse_commitment_audit_passes WHERE day=(SELECT d3 FROM fx)));

-- D2: the mixed day.
SELECT pg_temp.ok('mixed_day_basis_and_counters',
  (SELECT identity_basis='current_profile_then_accepted_roster' AND scanned_hands=5
     AND profile_identity_hands=2 AND roster_identity_hands=3 AND roster_unavailable_hands=0 AND roster_missing_hands=0
     FROM public.horse_commitment_audit_days WHERE day=(SELECT d2 FROM fx)));
SELECT pg_temp.ok('mixed_day_receipt_equals_day_row',
  (SELECT p.identity_basis=y.identity_basis AND p.roster_identity_hands=y.roster_identity_hands
     AND p.profile_identity_hands=y.profile_identity_hands AND p.roster_unavailable_hands=y.roster_unavailable_hands
     AND p.roster_missing_hands=y.roster_missing_hands AND p.scanned_hands=y.scanned_hands AND p.horse_hands=y.horse_hands
   FROM public.horse_commitment_audit_passes p JOIN public.horse_commitment_audit_days y USING(day,pass)
   WHERE p.day=(SELECT d2 FROM fx)));
SELECT pg_temp.ok('mixed_day_pre_epoch_hand_uses_profile',
  EXISTS(SELECT 1 FROM public.horse_commitment_reviews WHERE hand_id=pg_temp.hid('mix-pre') AND horse_user_id=(SELECT h1 FROM fx))
  AND EXISTS(SELECT 1 FROM public.horse_commitment_reviews WHERE hand_id=pg_temp.hid('mix-just-before') AND horse_user_id=(SELECT h2 FROM fx)));
SELECT pg_temp.ok('hand_at_the_epoch_uses_its_roster',
  NOT EXISTS(SELECT 1 FROM public.horse_commitment_reviews WHERE hand_id=pg_temp.hid('mix-at-epoch')));
SELECT pg_temp.ok('profile_changed_after_acceptance_follows_roster_horse',
  (SELECT count(*)=1 AND bool_and(horse_user_id=(SELECT f1 FROM fx) AND eligibility='over_10bb')
   FROM public.horse_commitment_reviews WHERE hand_id=pg_temp.hid('mix-post-flipped')));
SELECT pg_temp.ok('profile_changed_after_acceptance_follows_roster_human',
  NOT EXISTS(SELECT 1 FROM public.horse_commitment_reviews WHERE hand_id=pg_temp.hid('mix-post-was-human')));
SELECT pg_temp.ok('rostered_hands_carry_no_identity_gap',
  NOT EXISTS(SELECT 1 FROM public.horse_commitment_audit_gaps WHERE hand_id IN
    (pg_temp.hid('mix-at-epoch'),pg_temp.hid('mix-post-flipped'),pg_temp.hid('mix-post-was-human'),pg_temp.hid('post-horse'))));

-- D1, pass 1: begun by the profile-only body, finished by this one. It
-- reached rostered hands, so it is named as both, never as roster alone,
-- and carries no partial identity counters.
SELECT pg_temp.ok('pass_under_way_at_install_named_profile_then_roster',
  (SELECT identity_basis='current_profile_then_accepted_roster' AND scanned_hands=9 AND roster_identity_hands IS NULL
     AND profile_identity_hands IS NULL AND roster_unavailable_hands IS NULL AND roster_missing_hands IS NULL
     FROM public.horse_commitment_audit_days WHERE day=(SELECT d1 FROM fx))
  AND (SELECT count(*)=1 AND bool_and(identity_basis='current_profile_then_accepted_roster' AND roster_identity_hands IS NULL
     AND profile_identity_hands IS NULL AND scanned_hands=9 AND horse_hands=4 AND hands_without_commit=1)
   FROM public.horse_commitment_audit_passes WHERE day=(SELECT d1 FROM fx)));
SELECT pg_temp.ok('unavailable_roster_named_not_replaced',
  (SELECT reasons=ARRAY['accepted_roster_unavailable'] FROM public.horse_commitment_audit_gaps WHERE hand_id=pg_temp.hid('post-unavailable'))
  AND NOT EXISTS(SELECT 1 FROM public.horse_commitment_reviews WHERE hand_id=pg_temp.hid('post-unavailable')));
SELECT pg_temp.ok('legacy_missing_roster_named_not_replaced',
  (SELECT reasons=ARRAY['accepted_roster_legacy_missing'] FROM public.horse_commitment_audit_gaps WHERE hand_id=pg_temp.hid('post-legacy-missing'))
  AND NOT EXISTS(SELECT 1 FROM public.horse_commitment_reviews WHERE hand_id=pg_temp.hid('post-legacy-missing')));
SELECT pg_temp.ok('hand_without_commit_names_missing_roster',
  (SELECT reasons=ARRAY['accepted_commitment_facts_missing','hand_without_commit','accepted_roster_legacy_missing']
   FROM public.horse_commitment_audit_gaps WHERE hand_id=pg_temp.hid('post-no-commit')));
SELECT pg_temp.ok('mismatched_roster_named_not_used',
  (SELECT reasons=ARRAY['accepted_roster_mismatch'] FROM public.horse_commitment_audit_gaps WHERE hand_id=pg_temp.hid('post-mismatch'))
  AND NOT EXISTS(SELECT 1 FROM public.horse_commitment_reviews WHERE hand_id=pg_temp.hid('post-mismatch')));
SELECT pg_temp.ok('invalid_roster_named_not_used',
  (SELECT reasons=ARRAY['accepted_roster_invalid'] FROM public.horse_commitment_audit_gaps WHERE hand_id=pg_temp.hid('post-invalid'))
  AND NOT EXISTS(SELECT 1 FROM public.horse_commitment_reviews WHERE hand_id=pg_temp.hid('post-invalid')));
SELECT pg_temp.ok('roster_unknown_seat_named',
  (SELECT reasons=ARRAY['horse_identity_unknown'] FROM public.horse_commitment_audit_gaps WHERE hand_id=pg_temp.hid('post-unknown'))
  AND (SELECT count(*)=1 AND bool_and(horse_user_id=(SELECT h1 FROM fx)) FROM public.horse_commitment_reviews WHERE hand_id=pg_temp.hid('post-unknown')));
SELECT pg_temp.ok('roster_and_dealt_list_disagree_named',
  (SELECT reasons=ARRAY['accepted_roster_players_disagree'] FROM public.horse_commitment_audit_gaps WHERE hand_id=pg_temp.hid('post-disagree'))
  AND EXISTS(SELECT 1 FROM public.horse_commitment_reviews WHERE hand_id=pg_temp.hid('post-disagree') AND horse_user_id=(SELECT h1 FROM fx)));
SELECT pg_temp.ok('invalid_dealt_list_still_classified_by_roster',
  (SELECT reasons=ARRAY['dealt_roster_invalid'] FROM public.horse_commitment_audit_gaps WHERE hand_id=pg_temp.hid('post-dealt-invalid'))
  AND EXISTS(SELECT 1 FROM public.horse_commitment_reviews WHERE hand_id=pg_temp.hid('post-dealt-invalid') AND horse_user_id=(SELECT h1 FROM fx)));
SELECT pg_temp.ok('roster_identity_reads_no_profile_on_roster_days',
  NOT EXISTS(SELECT 1 FROM public.horse_commitment_reviews r, fx WHERE r.played_at>=fx.epoch AND r.horse_user_id=fx.f2));

-- The naming rule itself: what a pass used, what a pass that has classified
-- nothing will use first, and the whole day for the readers.
SELECT pg_temp.ok('basis_rule_names',
  (SELECT public.fn_horse_commitment_identity_basis(d3,NULL,NULL)='current_profile_is_horse'
     AND public.fn_horse_commitment_identity_basis(d2,NULL,NULL)='current_profile_then_accepted_roster'
     AND public.fn_horse_commitment_identity_basis(d1,NULL,NULL)='accepted_roster'
     AND public.fn_horse_commitment_identity_basis(d2,false,false)='current_profile_is_horse'
     AND public.fn_horse_commitment_identity_basis(d1,false,false)='accepted_roster'
     AND public.fn_horse_commitment_identity_basis(d2,true,false)='current_profile_is_horse'
     AND public.fn_horse_commitment_identity_basis(d3,false,true)='accepted_roster'
     AND public.fn_horse_commitment_identity_basis(d1,true,true)='current_profile_then_accepted_roster' FROM fx)
  AND pg_temp.refused($$SELECT public.fn_horse_commitment_identity_basis(current_date,true,NULL)$$,'P0001','horse_commitment_identity_basis_unavailable'));

-- Re-pass after both profiles flip: the roster days do not move, the
-- pre-roster day follows today's profile and still names that basis.
UPDATE public.profiles SET is_horse=NOT is_horse WHERE id IN ((SELECT h1 FROM fx),(SELECT f1 FROM fx));
UPDATE public.horse_commitment_audit_days SET finished_at=transaction_timestamp()-interval '25 hours'
  WHERE day IN ((SELECT d1 FROM fx),(SELECT d2 FROM fx),(SELECT d3 FROM fx));
CREATE TEMP TABLE reviews_before AS SELECT * FROM public.horse_commitment_reviews;
SET LOCAL ROLE service_role;
INSERT INTO steps(result) SELECT public.fn_horse_commitment_audit_step();
INSERT INTO steps(result) SELECT public.fn_horse_commitment_audit_step();
INSERT INTO steps(result) SELECT public.fn_horse_commitment_audit_step();
RESET ROLE;
SELECT pg_temp.ok('roster_day_counted_pass_basis_and_counters',
  (SELECT count(*)=1 AND bool_and(identity_basis='accepted_roster' AND scanned_hands=9 AND roster_identity_hands=4
     AND profile_identity_hands=0 AND roster_unavailable_hands=2 AND roster_missing_hands=3
     AND hands_without_commit=1 AND source_coverage='not_established')
   FROM public.horse_commitment_audit_passes WHERE day=(SELECT d1 FROM fx) AND pass=2)
  AND (SELECT identity_basis='accepted_roster' AND roster_identity_hands=4 AND roster_unavailable_hands=2 AND roster_missing_hands=3
     FROM public.horse_commitment_audit_days WHERE day=(SELECT d1 FROM fx)));
SELECT pg_temp.ok('repass_roster_day_unmoved_by_profile_flip',
  (SELECT horse_hands=4 FROM public.horse_commitment_audit_passes WHERE day=(SELECT d1 FROM fx) AND pass=2)
  AND (SELECT count(*)=1 AND bool_and(horse_user_id=(SELECT h1 FROM fx))
   FROM public.horse_commitment_reviews WHERE hand_id=pg_temp.hid('post-horse')));
SELECT pg_temp.ok('repass_pre_roster_day_follows_current_profile',
  (SELECT horse_hands=1 AND identity_basis='current_profile_is_horse' AND profile_identity_hands=2 AND roster_identity_hands=0
   FROM public.horse_commitment_audit_passes WHERE day=(SELECT d3 FROM fx) AND pass=2)
  AND EXISTS(SELECT 1 FROM public.horse_commitment_reviews WHERE hand_id=pg_temp.hid('pre-flipped') AND horse_user_id=(SELECT f1 FROM fx)));
SELECT pg_temp.ok('repass_mixed_day_receipt',
  (SELECT identity_basis='current_profile_then_accepted_roster' AND profile_identity_hands=2 AND roster_identity_hands=3
   FROM public.horse_commitment_audit_passes WHERE day=(SELECT d2 FROM fx) AND pass=2));
SELECT pg_temp.ok('repass_rewrites_no_first_review',
  NOT EXISTS((SELECT * FROM reviews_before EXCEPT SELECT r.* FROM public.horse_commitment_reviews r)));

-- Readers name the day's basis at the top level; pass receipts carry theirs.
CREATE TEMP TABLE pages(k text PRIMARY KEY, v jsonb);
GRANT SELECT,INSERT ON pages TO service_role;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',true);
INSERT INTO pages SELECT 'sel_d1',public.fn_horse_commitment_selection_receipt((SELECT d1 FROM fx));
INSERT INTO pages SELECT 'sel_d2',public.fn_horse_commitment_selection_receipt((SELECT d2 FROM fx));
INSERT INTO pages SELECT 'sel_d3',public.fn_horse_commitment_selection_receipt((SELECT d3 FROM fx));
INSERT INTO pages SELECT 'sel_old',public.fn_horse_commitment_selection_receipt('2020-01-01');
INSERT INTO pages SELECT 'page_d1',public.fn_horse_commitment_review_page((SELECT d1 FROM fx));
INSERT INTO pages SELECT 'page_d2',public.fn_horse_commitment_review_page((SELECT d2 FROM fx));
INSERT INTO pages SELECT 'page_old',public.fn_horse_commitment_review_page('2020-01-01');
RESET ROLE;
SELECT pg_temp.ok('selection_reader_names_day_basis',
  (SELECT v->>'identityBasis' FROM pages WHERE k='sel_d1')='accepted_roster'
  AND (SELECT v->>'identityBasis' FROM pages WHERE k='sel_d2')='current_profile_then_accepted_roster'
  AND (SELECT v->>'identityBasis' FROM pages WHERE k='sel_d3')='current_profile_is_horse'
  AND (SELECT v->>'identityBasis' FROM pages WHERE k='sel_old')='current_profile_is_horse');
SELECT pg_temp.ok('selection_reader_pass_receipts_carry_basis',
  (SELECT array_agg(p->>'identityBasis' ORDER BY (p->>'pass')::int) FROM pages, jsonb_array_elements(v->'passes') p WHERE k='sel_d2')
    =ARRAY['current_profile_then_accepted_roster','current_profile_then_accepted_roster']
  AND (SELECT bool_and(pg_temp.keys(v)=ARRAY['activationAllowed','after','day','dayState','gaps','gtoVerified','hasMore',
     'identityBasis','limit','next','passes','readAt','source','sourceCoverage','version']) FROM pages WHERE k LIKE 'sel_%'));
SELECT pg_temp.ok('review_page_names_day_basis',
  (SELECT v->>'identityBasis' FROM pages WHERE k='page_d1')='accepted_roster'
  AND (SELECT v->>'identityBasis' FROM pages WHERE k='page_d2')='current_profile_then_accepted_roster'
  AND (SELECT v->>'identityBasis' FROM pages WHERE k='page_old')='current_profile_is_horse'
  AND (SELECT jsonb_array_length(v->'rows')>=4 FROM pages WHERE k='page_d1'));

-- Immutability, privacy and invariants.
SELECT pg_temp.ok('epoch_update_refused',
  pg_temp.refused('UPDATE public.horse_commitment_roster_epoch SET first_captured_at=now() WHERE true','55000','horse_commitment_roster_epoch_immutable'));
SELECT pg_temp.ok('epoch_delete_refused',
  pg_temp.refused('DELETE FROM public.horse_commitment_roster_epoch WHERE true','55000','horse_commitment_roster_epoch_immutable'));
SELECT pg_temp.ok('epoch_truncate_refused',
  pg_temp.refused('TRUNCATE public.horse_commitment_roster_epoch','55000','horse_commitment_roster_epoch_immutable'));
SELECT pg_temp.ok('epoch_second_row_refused',
  pg_temp.refused($$INSERT INTO public.horse_commitment_roster_epoch(singleton,first_captured_at,table_id,hand_number,hand_id)
    VALUES(true,now(),gen_random_uuid(),2,gen_random_uuid())$$,'23505',NULL)
  AND pg_temp.refused($$INSERT INTO public.horse_commitment_roster_epoch(singleton,first_captured_at,table_id,hand_number,hand_id)
    VALUES(false,now(),gen_random_uuid(),2,gen_random_uuid())$$,'23514',NULL));
SELECT pg_temp.ok('receipt_identity_counters_must_sum_to_scanned',
  pg_temp.refused($$INSERT INTO public.horse_commitment_audit_passes(day,pass,window_start,window_end,cutover,scanned_hands,
    horse_hands,flagged_horse_hands,unknown_horse_hands,hand_gaps,hands_without_commit,missing_source_hands,late_arrival_hands,
    started_at,finished_at,identity_basis,roster_identity_hands,profile_identity_hands,roster_unavailable_hands,roster_missing_hands)
    SELECT d1,99,d1::timestamp AT TIME ZONE 'UTC',(d1+1)::timestamp AT TIME ZONE 'UTC',now(),2,0,0,0,0,0,0,0,now(),now(),
      'accepted_roster',1,0,0,0 FROM fx$$,'23514',NULL));
SELECT pg_temp.ok('basis_name_is_closed',
  pg_temp.refused($$UPDATE public.horse_commitment_audit_days SET identity_basis='profile_today' WHERE day=(SELECT d1 FROM fx)$$,'23514',NULL));
SELECT pg_temp.ok('epoch_and_rule_private',
  NOT has_function_privilege('service_role','public.fn_horse_commitment_identity_basis(date,boolean,boolean)','EXECUTE')
  AND NOT has_function_privilege('anon','public.fn_horse_commitment_identity_basis(date,boolean,boolean)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.fn_horse_commitment_identity_basis(date,boolean,boolean)','EXECUTE')
  AND NOT has_table_privilege('service_role','public.horse_commitment_roster_epoch','SELECT')
  AND (SELECT relrowsecurity FROM pg_class WHERE oid='public.horse_commitment_roster_epoch'::regclass));
SET LOCAL ROLE service_role;
SELECT pg_temp.ok('service_role_cannot_read_epoch',
  pg_temp.refused('SELECT 1 FROM public.horse_commitment_roster_epoch','42501',NULL));
RESET ROLE;
SELECT pg_temp.ok('all_checks_counted', (SELECT count(*)=39 FROM checks));
SELECT 'synthetic_roster_basis_controls_only_if_executed', (SELECT count(*) FROM checks);
ROLLBACK;
