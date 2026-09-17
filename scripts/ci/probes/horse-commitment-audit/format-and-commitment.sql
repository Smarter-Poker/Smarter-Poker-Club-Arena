-- PREPARED / UNEXECUTED. Actual diagnostic function integration, synthetic rows.
-- Baseline should fail the two-source-shape HU laws; candidate expectations
-- remain unobserved until an approved native execution. Not controller replay.
BEGIN;
SET LOCAL statement_timeout='15s';
CREATE TEMP TABLE cases(
  name text PRIMARY KEY,variant text NOT NULL DEFAULT 'nlh',kind text,
  table_size integer,max_players integer,dealt integer NOT NULL DEFAULT 2,
  bb numeric DEFAULT 2,net jsonb DEFAULT '21',refund jsonb DEFAULT '0',
  refund_map boolean DEFAULT true,expected_format text NOT NULL,
  expected_eligibility text DEFAULT 'over_10bb',format_gap boolean DEFAULT false
);
INSERT INTO cases(name,kind,table_size,max_players,dealt,expected_format) VALUES
 ('created_hu_sng','SNG',2,2,2,'hu_sng'),
 ('documented_legacy_hu_sng','SNG',9,2,2,'hu_sng'),
 ('lowercase_created_hu','sng',2,2,2,'hu_sng'),
 ('sng6_two_remaining','SNG',6,6,2,'sng'),
 ('sng9_two_remaining','SNG',9,9,2,'sng'),
 ('mtt_two_remaining','MTT',9,100,2,'mtt'),
 ('cash_heads_up',NULL,NULL,NULL,2,'hu_cash'),
 ('cash_three_seats',NULL,NULL,NULL,3,'cash'),
 ('spin_two_seats','SPIN',2,2,2,'spin'),
 ('spin_three_seats','SPIN',3,3,3,'spin'),
 ('spin_alias_two_seats','SPIN_AND_GOLD',2,2,2,'spin'),
 ('legacy_hu_type','HU_SNG',NULL,NULL,2,'hu_sng'),
 ('legacy_headsup_type','HEADS_UP_SNG',NULL,NULL,2,'hu_sng'),
 ('sng_missing_both_counts','SNG',NULL,NULL,2,'sng'),
 ('sng_missing_max','SNG',2,NULL,2,'sng'),
 ('sng_missing_table','SNG',NULL,2,2,'sng'),
 ('sng_contradictory_two_six','SNG',2,6,2,'sng'),
 ('sng_invalid_zero_max','SNG',2,0,2,'sng'),
 ('sng_unreviewed_six_two','SNG',6,2,2,'sng'),
 ('sng_invalid_zero_table','SNG',0,2,2,'sng'),
 ('unknown_type_two_seats','UNRECOGNIZED',2,2,2,'tournament_unknown'),
 ('preexisting_hu_mislabeled','SNG',2,2,2,'sng');
UPDATE cases SET format_gap=true WHERE name IN(
 'sng_missing_both_counts','sng_missing_max','sng_missing_table',
 'sng_contradictory_two_six','sng_invalid_zero_max',
 'sng_unreviewed_six_two','sng_invalid_zero_table'
);

-- Accepted monetary facts, deliberately without claiming a real action frame.
-- Each threshold/refund outcome is checked across all nine current families.
INSERT INTO cases(name,variant,net,refund,expected_format,expected_eligibility)
SELECT v||'_'||x.name,v,to_jsonb(x.net),to_jsonb(x.refund),'hu_cash',x.eligibility
FROM unnest(ARRAY['nlh','plo4','plo5','plo6','plo8','short_deck','pineapple','flh','flo8']) v
CROSS JOIN (VALUES
 ('exact_10bb',20::numeric,0::numeric,NULL::text),
 ('one_cent_over',20.01,0,'over_10bb'),
 ('short_all_in_10_5bb',21,0,'over_10bb'),
 ('short_all_in_below',19.99,0,NULL),
 ('returned_excess_restores_gross',4,17,'over_10bb'),
 ('fully_returned_10_5bb',0,21,'over_10bb')
) x(name,net,refund,eligibility);
INSERT INTO cases(name,bb,net,refund,refund_map,expected_format,expected_eligibility) VALUES
 ('missing_blind',NULL,'21','0',true,'hu_cash','unknown'),
 ('zero_blind',0,'21','0',true,'hu_cash','unknown'),
 ('negative_blind',-2,'21','0',true,'hu_cash','unknown'),
 ('nan_blind','NaN','21','0',true,'hu_cash','unknown'),
 ('missing_refund_map',2,'21','0',false,'hu_cash','unknown'),
 ('numeric_string_contribution',2,'"21"','0',true,'hu_cash','unknown'),
 ('negative_contribution',2,'-1','0',true,'hu_cash','unknown'),
 ('numeric_string_refund',2,'4','"17"',true,'hu_cash','unknown'),
 ('fractional_cent_contribution',2,'20.001','0',true,'hu_cash','unknown');

INSERT INTO public.profiles VALUES
 ('11111111-1111-4111-8111-111111111111',true),
 ('22222222-2222-4222-8222-222222222222',false),
 ('44444444-4444-4444-8444-444444444444',false);
DO $fixture$
DECLARE c record; hand_id uuid; tournament_id uuid; payload jsonb; roster jsonb;
BEGIN
 FOR c IN SELECT * FROM cases ORDER BY name LOOP
  hand_id:=md5('synthetic-hand-'||c.name)::uuid;
  tournament_id:=CASE WHEN c.kind IS NULL THEN NULL ELSE md5('synthetic-event-'||c.name)::uuid END;
  IF tournament_id IS NOT NULL THEN
   INSERT INTO public.tournaments VALUES(tournament_id,c.kind,c.table_size,c.max_players);
  END IF;
  roster:='[{"userId":"11111111-1111-4111-8111-111111111111","seat":1,"cards":["PRIVATE_CARD_SENTINEL"]},{"userId":"22222222-2222-4222-8222-222222222222","seat":2}]';
  IF c.dealt=3 THEN roster:=roster||'[{"userId":"44444444-4444-4444-8444-444444444444","seat":3}]'; END IF;
  INSERT INTO public.hand_history VALUES(hand_id,'33333333-3333-4333-8333-333333333333',
   (((transaction_timestamp() AT TIME ZONE 'UTC')::date-1)::timestamp AT TIME ZONE 'UTC')+interval '12 hours',
   c.variant,c.bb,roster,tournament_id);
  payload:=jsonb_build_object('accepted_hand_facts',jsonb_build_object(
   'contributions',jsonb_build_object('11111111-1111-4111-8111-111111111111',c.net,
    '22222222-2222-4222-8222-222222222222',21),
   'returned_uncalled',CASE WHEN c.refund_map THEN
    jsonb_build_object('11111111-1111-4111-8111-111111111111',c.refund) ELSE NULL END));
  INSERT INTO public.hand_atomic_commits VALUES(hand_id,'33333333-3333-4333-8333-333333333333',
   repeat('a',64),encode(extensions.digest(convert_to(payload::text,'UTF8'),'sha256'),'hex'),payload);
 END LOOP;
END;
$fixture$;

-- First-write review from the old classifier. It must remain byte-identical;
-- a new observation reports a conflict rather than rewriting old evidence.
INSERT INTO public.horse_commitment_reviews(
 hand_id,horse_user_id,table_id,played_at,source_payload_hash,game_variant,format,
 seats,big_blind,net_contribution,returned_uncalled,committed_amount,committed_bb,eligibility,reasons
)
SELECT h.id,'11111111-1111-4111-8111-111111111111',h.table_id,h.created_at,
 c.post_commit_payload_hash,'nlh','sng',2,2,21,0,21,10.5,'over_10bb',
 ARRAY['decision_replay_not_matched','reference_not_matched']
FROM public.hand_history h JOIN public.hand_atomic_commits c ON c.hand_id=h.id
WHERE h.id=md5('synthetic-hand-preexisting_hu_mislabeled')::uuid;
CREATE TEMP TABLE original_mislabeled AS SELECT * FROM public.horse_commitment_reviews;

-- Each source day is below256; three closed-day passes then idle. Only the
-- installed fixture service role invokes the actual SECURITY DEFINER function.
SET LOCAL ROLE service_role;
SELECT public.fn_horse_commitment_audit_step();
SELECT public.fn_horse_commitment_audit_step();
SELECT public.fn_horse_commitment_audit_step();
SELECT public.fn_horse_commitment_audit_step();
RESET ROLE;
DO $assertions$
DECLARE c record; r public.horse_commitment_reviews%ROWTYPE;
BEGIN
 IF (SELECT count(*) FROM cases)<>85 THEN RAISE EXCEPTION 'fixture population changed'; END IF;
 FOR c IN SELECT * FROM cases ORDER BY name LOOP
  SELECT * INTO r FROM public.horse_commitment_reviews WHERE hand_id=md5('synthetic-hand-'||c.name)::uuid;
  IF c.expected_eligibility IS NULL THEN
   IF FOUND THEN RAISE EXCEPTION 'unexpected threshold row: %',c.name; END IF;
  ELSE
   IF NOT FOUND OR r.format IS DISTINCT FROM c.expected_format OR r.eligibility IS DISTINCT FROM c.expected_eligibility
    OR r.game_variant IS DISTINCT FROM c.variant THEN RAISE EXCEPTION 'diagnostic case failed: %',c.name; END IF;
   IF r.eligibility='over_10bb' AND (r.committed_amount IS DISTINCT FROM ((c.net#>>'{}')::numeric+(c.refund#>>'{}')::numeric)
    OR r.committed_bb IS DISTINCT FROM (((c.net#>>'{}')::numeric+(c.refund#>>'{}')::numeric)/c.bb))
    THEN RAISE EXCEPTION 'gross commitment changed: %',c.name; END IF;
   IF r.gto_verdict<>'unverified' OR NOT (r.reasons @> ARRAY['decision_replay_not_matched','reference_not_matched'])
    THEN RAISE EXCEPTION 'authority upgraded: %',c.name; END IF;
  END IF;
  IF c.format_gap AND NOT EXISTS(SELECT 1 FROM public.horse_commitment_audit_gaps g
   WHERE g.hand_id=md5('synthetic-hand-'||c.name)::uuid
    AND g.reasons @> ARRAY['tournament_format_metadata_unqualified'])
   THEN RAISE EXCEPTION 'missing format uncertainty: %',c.name; END IF;
  IF NOT c.format_gap AND EXISTS(SELECT 1 FROM public.horse_commitment_audit_gaps g
   WHERE g.hand_id=md5('synthetic-hand-'||c.name)::uuid
    AND g.reasons @> ARRAY['tournament_format_metadata_unqualified'])
   THEN RAISE EXCEPTION 'invented format uncertainty: %',c.name; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM public.horse_commitment_audit_gaps
  WHERE hand_id=md5('synthetic-hand-preexisting_hu_mislabeled')::uuid
   AND reasons @> ARRAY['review_format_changed'])
  THEN RAISE EXCEPTION 'old label conflict suppressed'; END IF;
 IF EXISTS((SELECT stored_review.* FROM public.horse_commitment_reviews stored_review JOIN original_mislabeled o USING(hand_id,horse_user_id)
   EXCEPT SELECT * FROM original_mislabeled)
  UNION ALL (SELECT * FROM original_mislabeled EXCEPT
   SELECT stored_review.* FROM public.horse_commitment_reviews stored_review JOIN original_mislabeled o USING(hand_id,horse_user_id)))
  THEN RAISE EXCEPTION 'old label or other original evidence rewritten'; END IF;
 IF EXISTS(SELECT 1 FROM public.horse_commitment_reviews WHERE horse_user_id<>'11111111-1111-4111-8111-111111111111')
  THEN RAISE EXCEPTION 'non-Horse actor selected'; END IF;
 IF EXISTS(SELECT 1 FROM public.horse_commitment_audit_days WHERE source_coverage<>'not_established'
  OR identity_basis<>'current_profile_is_horse') THEN RAISE EXCEPTION 'source authority upgraded'; END IF;
 IF EXISTS(SELECT 1 FROM public.horse_commitment_reviews stored_review WHERE to_jsonb(stored_review)::text LIKE '%PRIVATE_CARD_SENTINEL%')
  THEN RAISE EXCEPTION 'private card leaked'; END IF;
 IF NOT has_function_privilege('service_role','public.fn_horse_commitment_audit_step()','EXECUTE')
  OR has_function_privilege('anon','public.fn_horse_commitment_audit_step()','EXECUTE')
  OR has_function_privilege('authenticated','public.fn_horse_commitment_audit_step()','EXECUTE')
  THEN RAISE EXCEPTION 'function ACL changed'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) role_name
  CROSS JOIN unnest(ARRAY['horse_commitment_reviews','horse_commitment_audit_days','horse_commitment_audit_gaps']) table_name
  WHERE has_table_privilege(role_name,'public.'||table_name,'SELECT'))
  THEN RAISE EXCEPTION 'private table ACL changed'; END IF;
END;
$assertions$;
CREATE TEMP TABLE before_reviews AS SELECT * FROM public.horse_commitment_reviews;
UPDATE public.horse_commitment_audit_days SET finished_at=transaction_timestamp()-interval '25 hours'
 WHERE day=(transaction_timestamp() AT TIME ZONE 'UTC')::date-1;
SET LOCAL ROLE service_role;
SELECT public.fn_horse_commitment_audit_step();
RESET ROLE;
DO $replay$
BEGIN
 IF EXISTS((SELECT * FROM public.horse_commitment_reviews EXCEPT SELECT * FROM before_reviews)
  UNION ALL (SELECT * FROM before_reviews EXCEPT SELECT * FROM public.horse_commitment_reviews))
  THEN RAISE EXCEPTION 'replay changed or duplicated original diagnostic rows'; END IF;
END;
$replay$;
SELECT 'prepared_expectations_reached_only_if_this_fixture_is_actually_executed' AS scope,85 AS synthetic_case_rows;
ROLLBACK;
