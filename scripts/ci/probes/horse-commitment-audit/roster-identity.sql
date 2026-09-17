-- PREPARED / UNEXECUTED. Fresh synthetic schema from unchanged tests/setup.sql
-- and baseline/migration.sql; choose frozen R1 or R2 function-only body.
-- No real profiles, accepted rows, financial RPC, authority or installation.
BEGIN;
SET LOCAL statement_timeout='15s';
SET LOCAL timezone='Pacific/Honolulu';
CREATE TEMP TABLE roster_cases(
 name text PRIMARY KEY,players jsonb,valid_roster boolean NOT NULL DEFAULT false,
 expected_horses integer NOT NULL DEFAULT 0,identity_gap boolean NOT NULL DEFAULT false,
 existing_review boolean NOT NULL DEFAULT false
);
DO $cases$
DECLARE
 horse_a text:='aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
 horse_b text:='bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
 human_a text:='cccccccc-3333-4333-8333-cccccccccccc';
 human_b text:='eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
 missing text:='dddddddd-4444-4444-8444-dddddddddddd';
 a jsonb; b jsonb; h jsonb;
BEGIN
 a:=jsonb_build_object('userId',horse_a,'cards',jsonb_build_array('PRIVATE_ROSTER_SENTINEL'));
 b:=jsonb_build_object('userId',horse_b);h:=jsonb_build_object('userId',human_a);
 INSERT INTO roster_cases(name,players) VALUES
  ('same_lower_duplicate',jsonb_build_array(a,a)),
  ('same_upper_duplicate',jsonb_build_array(jsonb_build_object('userId',upper(horse_a)),jsonb_build_object('userId',upper(horse_a)))),
  ('mixed_case_duplicate',jsonb_build_array(a,jsonb_build_object('userId',upper(horse_a)))),
  ('mixed_case_existing_review',jsonb_build_array(a,jsonb_build_object('userId',upper(horse_a)))),
  ('three_seat_case_duplicate',jsonb_build_array(a,jsonb_build_object('userId',upper(horse_a)),b)),
  ('missing_id',jsonb_build_array(a,'{}'::jsonb)),
  ('null_id',jsonb_build_array(a,jsonb_build_object('userId',NULL))),
  ('numeric_id',jsonb_build_array(a,jsonb_build_object('userId',123))),
  ('object_id',jsonb_build_array(a,jsonb_build_object('userId',jsonb_build_object('id',horse_b)))),
  ('array_id',jsonb_build_array(a,jsonb_build_object('userId',jsonb_build_array(horse_b)))),
  ('short_id',jsonb_build_array(a,jsonb_build_object('userId','a'))),
  ('invalid_hex',jsonb_build_array(a,jsonb_build_object('userId','gggggggg-2222-4222-8222-bbbbbbbbbbbb'))),
  ('unhyphenated_id',jsonb_build_array(a,jsonb_build_object('userId',replace(horse_b,'-','')))),
  ('string_row',jsonb_build_array(a,to_jsonb(horse_b))),
  ('null_roster','null'::jsonb),
  ('object_roster',a),
  ('single_seat',jsonb_build_array(a)),
  ('empty_roster','[]'::jsonb),
  ('eleven_seats',(SELECT jsonb_agg(a) FROM generate_series(1,11)));
 INSERT INTO roster_cases(name,players,valid_roster,expected_horses,identity_gap) VALUES
  ('lower_unique',jsonb_build_array(a,b),true,2,false),
  ('uppercase_unique',jsonb_build_array(jsonb_build_object('userId',upper(horse_a)),jsonb_build_object('userId',upper(horse_b))),true,2,false),
  ('mixed_case_unique',jsonb_build_array(jsonb_build_object('userId',upper(horse_a)),h),true,1,false),
  ('known_humans_only',jsonb_build_array(h,jsonb_build_object('userId',upper(human_b))),true,0,false),
  ('known_horse_unknown_profile',jsonb_build_array(a,jsonb_build_object('userId',missing)),true,1,true);
 UPDATE roster_cases SET existing_review=true WHERE name='mixed_case_existing_review';
END $cases$;
INSERT INTO public.profiles VALUES
 ('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',true),
 ('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',true),
 ('cccccccc-3333-4333-8333-cccccccccccc',false),
 ('eeeeeeee-5555-4555-8555-eeeeeeeeeeee',false);
DO $source$
DECLARE c record; hand uuid; payload jsonb;
BEGIN
 FOR c IN SELECT * FROM roster_cases ORDER BY name LOOP
  hand:=md5('synthetic-roster-r2-'||c.name)::uuid;
  INSERT INTO public.hand_history VALUES(hand,'33333333-3333-4333-8333-333333333333',
   (((transaction_timestamp() AT TIME ZONE 'UTC')::date-1)::timestamp AT TIME ZONE 'UTC')+interval '12 hours',
   'nlh',2,c.players,NULL);
  payload:=jsonb_build_object('accepted_hand_facts',jsonb_build_object(
   'contributions',jsonb_build_object('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',21,
    'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',21), 'returned_uncalled','{}'::jsonb));
  INSERT INTO public.hand_atomic_commits VALUES(hand,'33333333-3333-4333-8333-333333333333',
   repeat('a',64),encode(extensions.digest(convert_to(payload::text,'UTF8'),'sha256'),'hex'),payload);
 END LOOP;
END $source$;
-- A preexisting review can outlive a later malformed roster observation. Keep
-- the old row exactly; add a hand gap and never count a duplicate actor now.
INSERT INTO public.horse_commitment_reviews(
 hand_id,horse_user_id,table_id,played_at,source_payload_hash,game_variant,format,
 seats,big_blind,net_contribution,returned_uncalled,committed_amount,committed_bb,eligibility,reasons)
SELECT h.id,'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',h.table_id,h.created_at,c.post_commit_payload_hash,
 'nlh','hu_cash',2,2,21,0,21,10.5,'over_10bb',ARRAY['decision_replay_not_matched','reference_not_matched']
FROM public.hand_history h JOIN public.hand_atomic_commits c ON c.hand_id=h.id
WHERE h.id=md5('synthetic-roster-r2-mixed_case_existing_review')::uuid;
CREATE TEMP TABLE original_review AS SELECT * FROM public.horse_commitment_reviews;
SET LOCAL ROLE service_role;
SELECT public.fn_horse_commitment_audit_step();
SELECT public.fn_horse_commitment_audit_step();
SELECT public.fn_horse_commitment_audit_step();
SELECT public.fn_horse_commitment_audit_step();
RESET ROLE;
DO $assertions$
DECLARE c record; hand uuid; d public.horse_commitment_audit_days%ROWTYPE;
BEGIN
 IF (SELECT count(*) FROM roster_cases)<>24 THEN RAISE EXCEPTION 'roster_fixture_population_changed'; END IF;
 FOR c IN SELECT * FROM roster_cases ORDER BY name LOOP
  hand:=md5('synthetic-roster-r2-'||c.name)::uuid;
  IF (SELECT count(*) FROM public.horse_commitment_reviews r WHERE r.hand_id=hand)<>
   (c.expected_horses+CASE WHEN c.existing_review THEN 1 ELSE 0 END)
  THEN RAISE EXCEPTION 'roster_review_count: %',c.name; END IF;
  IF (EXISTS(SELECT 1 FROM public.horse_commitment_audit_gaps g WHERE g.hand_id=hand
   AND g.reasons @> ARRAY['dealt_roster_invalid'])) IS DISTINCT FROM (NOT c.valid_roster)
  THEN RAISE EXCEPTION 'roster_invalid_gap: %',c.name; END IF;
  IF (EXISTS(SELECT 1 FROM public.horse_commitment_audit_gaps g WHERE g.hand_id=hand
   AND g.reasons @> ARRAY['horse_identity_unknown'])) IS DISTINCT FROM c.identity_gap
  THEN RAISE EXCEPTION 'identity_unknown_gap: %',c.name; END IF;
 END LOOP;
 SELECT * INTO d FROM public.horse_commitment_audit_days
 WHERE day=(transaction_timestamp() AT TIME ZONE 'UTC')::date-1;
 IF NOT FOUND OR d.scanned_hands<>24 OR d.horse_hands<>6 OR d.flagged_horse_hands<>6
  OR d.unknown_horse_hands<>0 OR d.hand_gaps<>20 OR d.finished_at IS NULL
  OR d.source_coverage<>'not_established' OR d.identity_basis<>'current_profile_is_horse'
 THEN RAISE EXCEPTION 'duplicate_count_or_false_population'; END IF;
 IF EXISTS((SELECT r.* FROM public.horse_commitment_reviews r JOIN original_review o USING(hand_id,horse_user_id)
   EXCEPT SELECT * FROM original_review)
  UNION ALL (SELECT * FROM original_review EXCEPT
   SELECT r.* FROM public.horse_commitment_reviews r JOIN original_review o USING(hand_id,horse_user_id)))
 THEN RAISE EXCEPTION 'preexisting_review_rewritten'; END IF;
 IF EXISTS(SELECT 1 FROM public.horse_commitment_reviews WHERE horse_user_id NOT IN
  ('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa','bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb')
  OR eligibility<>'over_10bb' OR committed_bb<>10.5 OR gto_verdict<>'unverified'
  OR to_jsonb(horse_commitment_reviews)::text LIKE '%PRIVATE_ROSTER_SENTINEL%')
 THEN RAISE EXCEPTION 'identity_authority_threshold_or_privacy_changed'; END IF;
END $assertions$;
CREATE TEMP TABLE before_resweep AS SELECT * FROM public.horse_commitment_reviews;
UPDATE public.horse_commitment_audit_days SET finished_at=transaction_timestamp()-interval '25 hours'
 WHERE day=(transaction_timestamp() AT TIME ZONE 'UTC')::date-1;
SET LOCAL ROLE service_role;
SELECT public.fn_horse_commitment_audit_step();
RESET ROLE;
DO $resweep$
BEGIN
 IF EXISTS((SELECT * FROM public.horse_commitment_reviews EXCEPT SELECT * FROM before_resweep)
  UNION ALL (SELECT * FROM before_resweep EXCEPT SELECT * FROM public.horse_commitment_reviews))
 THEN RAISE EXCEPTION 'resweep_mutated_original_reviews'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.horse_commitment_audit_days
  WHERE day=(transaction_timestamp() AT TIME ZONE 'UTC')::date-1 AND pass=2
   AND scanned_hands=24 AND horse_hands=6 AND flagged_horse_hands=6
   AND unknown_horse_hands=0 AND hand_gaps=20 AND source_coverage='not_established')
 THEN RAISE EXCEPTION 'resweep_duplicate_counts'; END IF;
END $resweep$;
SELECT 'synthetic_roster_controls_only_if_executed' AS scope,24 AS synthetic_case_rows;
ROLLBACK;
-- External approved controller must enforce output/resource bounds and prove
-- owned rollback/session cleanup independently after failure as well as success.
