-- P14.3 selection receipts: synthetic rows in a disposable fixture database.
-- Runs after 20261007075304_horse_commitment_selection_receipts.sql is
-- installed. Every mutation is rolled back by the final ROLLBACK; helpers
-- live in pg_temp. No production object, connection or credential.
-- Each named check counts once; the wrapper requires the exact total.
BEGIN;
SET LOCAL statement_timeout='60s';
CREATE TEMP TABLE checks(name text PRIMARY KEY);
GRANT SELECT,INSERT ON checks TO service_role,anon,authenticated;
CREATE FUNCTION pg_temp.ok(name text, cond boolean) RETURNS void LANGUAGE plpgsql AS $ok$
BEGIN
  IF cond IS DISTINCT FROM true THEN RAISE EXCEPTION 'selection_check_failed: %', name; END IF;
  INSERT INTO checks VALUES(name);
END $ok$;
-- Run one statement in a subtransaction; true only for the exact refusal.
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
CREATE FUNCTION pg_temp.hid(seed text) RETURNS uuid LANGUAGE sql AS $h$ SELECT md5('p143-'||seed)::uuid $h$;
CREATE TEMP TABLE fx AS SELECT
  (transaction_timestamp() AT TIME ZONE 'UTC')::date-1 AS d,
  (transaction_timestamp() AT TIME ZONE 'UTC')::date-2 AS d2,
  (transaction_timestamp() AT TIME ZONE 'UTC')::date-3 AS d3,
  (((transaction_timestamp() AT TIME ZONE 'UTC')::date-1)::timestamp AT TIME ZONE 'UTC') AS d0,
  '33333333-3333-4333-8333-333333333333'::uuid AS tbl,
  '11111111-1111-4111-8111-111111111111'::uuid AS horse,
  '22222222-2222-4222-8222-222222222222'::uuid AS human1,
  '44444444-4444-4444-8444-444444444444'::uuid AS human2;
GRANT SELECT ON fx TO service_role,anon,authenticated;
INSERT INTO public.profiles SELECT horse,true FROM fx UNION ALL SELECT human1,false FROM fx UNION ALL SELECT human2,false FROM fx;

-- Source hands for day D. 300 horse hands (two batches), 10 all-human hands
-- with an invalid big blind, and three all-human missing-source hands: no
-- commit row, a commit with no payload, an oversized payload.
CREATE FUNCTION pg_temp.hand(seed text, at timestamptz, bb numeric, horse_seat boolean, commit_kind text,
  hand_number integer DEFAULT NULL, committed timestamptz DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $hand$
DECLARE f fx%ROWTYPE; id uuid:=pg_temp.hid(seed); roster jsonb; payload jsonb; first_player uuid;
BEGIN
  SELECT * INTO f FROM fx;
  first_player:=CASE WHEN horse_seat THEN f.horse ELSE f.human2 END;
  roster:=jsonb_build_array(jsonb_build_object('userId',first_player,'seat',1),jsonb_build_object('userId',f.human1,'seat',2));
  INSERT INTO public.hand_history(id,table_id,created_at,game_variant,big_blind,players,tournament_id,hand_number,actions)
    VALUES(id,f.tbl,at,'nlh',bb,roster,NULL,hand_number,
      jsonb_build_array(jsonb_build_object('userId',first_player,'seat',1,'action','raise','amount',21)));
  IF commit_kind='none' THEN RETURN id; END IF;
  payload:=CASE commit_kind
    WHEN 'null' THEN NULL
    WHEN 'oversized' THEN jsonb_build_object('accepted_hand_facts',jsonb_build_object('contributions','{}'::jsonb,
      'returned_uncalled','{}'::jsonb),'pad',(SELECT string_agg(md5(i::text||seed),'') FROM generate_series(1,20000) i))
    ELSE jsonb_build_object('accepted_hand_facts',jsonb_build_object(
      'contributions',jsonb_build_object(first_player,21,f.human1,21),'returned_uncalled','{}'::jsonb)) END;
  INSERT INTO public.hand_atomic_commits(hand_id,table_id,payload_hash,post_commit_payload_hash,post_commit_payload,
      hand_number,stack_result,committed_at,post_commit_request_hash,post_commit_completed_at)
    VALUES(id,f.tbl,repeat('a',64),
      CASE WHEN payload IS NULL THEN NULL ELSE encode(extensions.digest(convert_to(payload::text,'UTF8'),'sha256'),'hex') END,
      payload,hand_number,
      jsonb_build_object('success',true,'hand_id',md5('settle-'||seed)::uuid,'table_id',f.tbl,'hand_number',hand_number),
      coalesce(committed,clock_timestamp()),repeat('b',64),NULL);
  RETURN id;
END $hand$;
SELECT count(pg_temp.hand('h'||i, (SELECT d0 FROM fx)+interval '10 hours'+i*interval '1 second',2,true,'ok')) FROM generate_series(1,300) i;
SELECT count(pg_temp.hand('bb'||i, (SELECT d0 FROM fx)+interval '13 hours'+i*interval '1 second',NULL,false,'ok')) FROM generate_series(1,10) i;
SELECT pg_temp.hand('no-commit',(SELECT d0 FROM fx)+interval '14 hours 1 second',2,false,'none');
SELECT pg_temp.hand('null-payload',(SELECT d0 FROM fx)+interval '14 hours 2 seconds',2,false,'null');
SELECT pg_temp.hand('oversized',(SELECT d0 FROM fx)+interval '14 hours 3 seconds',2,false,'oversized');
SELECT pg_temp.ok('oversized_fixture_is_oversized',
  (SELECT pg_column_size(post_commit_payload)>262144 FROM public.hand_atomic_commits WHERE hand_id=pg_temp.hid('oversized')));

-- A legacy day row (D2): a pass that began before receipts existed carries
-- NULL selection counters and must complete WITHOUT a partial receipt.
INSERT INTO public.horse_commitment_audit_days(day,hands_without_commit,missing_source_hands,late_arrival_hands)
  SELECT d2,NULL,NULL,NULL FROM fx;

CREATE TEMP TABLE steps(n serial, result jsonb);
GRANT SELECT,INSERT ON steps TO service_role;
GRANT USAGE ON SEQUENCE steps_n_seq TO service_role;
SET LOCAL ROLE service_role;
INSERT INTO steps(result) SELECT public.fn_horse_commitment_audit_step();  -- D3 empty pass 1
INSERT INTO steps(result) SELECT public.fn_horse_commitment_audit_step();  -- D2 legacy pass 1
INSERT INTO steps(result) SELECT public.fn_horse_commitment_audit_step();  -- D batch 1 (256)
RESET ROLE;
SELECT pg_temp.ok('first_batch_recorded_not_complete',
  (SELECT result->>'status'='recorded' AND (result->>'scannedHands')::int=256 AND result->>'day'=(SELECT d::text FROM fx) FROM steps WHERE n=3));
SELECT pg_temp.ok('no_receipt_before_pass_completes',
  NOT EXISTS(SELECT 1 FROM public.horse_commitment_audit_passes WHERE day=(SELECT d FROM fx)));
SET LOCAL ROLE service_role;
INSERT INTO steps(result) SELECT public.fn_horse_commitment_audit_step();  -- D batch 2 completes
INSERT INTO steps(result) SELECT public.fn_horse_commitment_audit_step();  -- idle
RESET ROLE;
SELECT pg_temp.ok('return_contract_unchanged',
  (SELECT bool_and(pg_temp.keys(result)=CASE WHEN result->>'status' IN ('idle','busy')
     THEN ARRAY['activationAuthorized','sourceCoverage','status','version']
     ELSE ARRAY['activationAuthorized','day','flaggedHorseHands','gtoVerdict','handGaps','horseHands',
       'scannedHands','sourceCoverage','status','unknownHorseHands','version'] END
     AND result->>'sourceCoverage'='not_established' AND (result->>'version')::int=1) FROM steps)
  AND (SELECT result->>'status' FROM steps WHERE n=5)='idle');
SELECT pg_temp.ok('second_batch_completes_pass',
  (SELECT result->>'status'='pass_complete' AND (result->>'scannedHands')::int=57 FROM steps WHERE n=4));
SELECT pg_temp.ok('empty_day_receipt',
  (SELECT count(*)=1 AND bool_and(pass=1 AND scanned_hands=0 AND max_scanned_created_at IS NULL
     AND final_after_created_at IS NULL AND hands_without_commit=0)
   FROM public.horse_commitment_audit_passes WHERE day=(SELECT d3 FROM fx)));
SELECT pg_temp.ok('legacy_null_counters_get_no_partial_receipt',
  NOT EXISTS(SELECT 1 FROM public.horse_commitment_audit_passes WHERE day=(SELECT d2 FROM fx))
  AND (SELECT finished_at IS NOT NULL AND hands_without_commit IS NULL FROM public.horse_commitment_audit_days WHERE day=(SELECT d2 FROM fx)));
SELECT pg_temp.ok('pass1_receipt_counts',
  (SELECT count(*)=1 AND bool_and(p.pass=1 AND p.scanned_hands=313 AND p.horse_hands=300 AND p.flagged_horse_hands=300
     AND p.unknown_horse_hands=0 AND p.hand_gaps=13 AND p.hands_without_commit=1 AND p.missing_source_hands=3
     AND p.late_arrival_hands=0)
   FROM public.horse_commitment_audit_passes p WHERE p.day=(SELECT d FROM fx)));
SELECT pg_temp.ok('pass1_receipt_equals_day_row',
  (SELECT p.scanned_hands=y.scanned_hands AND p.horse_hands=y.horse_hands AND p.flagged_horse_hands=y.flagged_horse_hands
     AND p.unknown_horse_hands=y.unknown_horse_hands AND p.hand_gaps=y.hand_gaps
     AND p.hands_without_commit=y.hands_without_commit AND p.missing_source_hands=y.missing_source_hands
     AND p.late_arrival_hands=y.late_arrival_hands AND p.started_at=y.started_at AND p.finished_at=y.finished_at
     AND p.final_after_created_at=y.after_created_at AND p.final_after_hand_id=y.after_hand_id
   FROM public.horse_commitment_audit_passes p JOIN public.horse_commitment_audit_days y USING(day,pass)
   WHERE p.day=(SELECT d FROM fx)));
SELECT pg_temp.ok('pass1_receipt_window_cursor_cutover',
  (SELECT p.window_start=f.d0 AND p.window_end=f.d0+interval '1 day'
     AND p.max_scanned_created_at=(SELECT max(created_at) FROM public.hand_history WHERE created_at>=f.d0 AND created_at<f.d0+interval '1 day')
     AND p.final_after_hand_id=pg_temp.hid('oversized') AND p.cutover>=p.finished_at
     AND p.source_coverage='not_established' AND p.identity_basis='current_profile_is_horse'
   FROM public.horse_commitment_audit_passes p, fx f WHERE p.day=f.d));
SELECT pg_temp.ok('missing_source_gap_reasons',
  (SELECT reasons @> ARRAY['accepted_commitment_facts_missing','hand_without_commit'] FROM public.horse_commitment_audit_gaps WHERE hand_id=pg_temp.hid('no-commit'))
  AND (SELECT reasons=ARRAY['accepted_commitment_facts_missing'] FROM public.horse_commitment_audit_gaps WHERE hand_id=pg_temp.hid('null-payload'))
  AND (SELECT reasons=ARRAY['accepted_payload_oversized'] FROM public.horse_commitment_audit_gaps WHERE hand_id=pg_temp.hid('oversized')));
CREATE TEMP TABLE pass1 AS SELECT to_jsonb(p) AS row FROM public.horse_commitment_audit_passes p WHERE day=(SELECT d FROM fx);

-- Receipts are immutable, even to the owner.
SELECT pg_temp.ok('receipt_update_refused',
  pg_temp.refused('UPDATE public.horse_commitment_audit_passes SET scanned_hands=0 WHERE true','55000','horse_commitment_audit_pass_immutable'));
SELECT pg_temp.ok('receipt_delete_refused',
  pg_temp.refused('DELETE FROM public.horse_commitment_audit_passes WHERE true','55000','horse_commitment_audit_pass_immutable'));
SELECT pg_temp.ok('receipt_truncate_refused',
  pg_temp.refused('TRUNCATE public.horse_commitment_audit_passes','55000','horse_commitment_audit_pass_immutable'));
SELECT pg_temp.ok('receipt_invariant_check',
  pg_temp.refused($$INSERT INTO public.horse_commitment_audit_passes(day,pass,window_start,window_end,cutover,scanned_hands,
    horse_hands,flagged_horse_hands,unknown_horse_hands,hand_gaps,hands_without_commit,missing_source_hands,late_arrival_hands,
    started_at,finished_at) SELECT d,99,d0,d0+interval '1 day',now(),1,0,0,0,0,2,1,0,now(),now() FROM fx$$,'23514',NULL));

-- Late arrivals after pass 1: one beyond the final cursor, one below it but
-- committed after the cutover, and one below it committed before the cutover
-- (not provably late, so honestly NOT labelled late).
SELECT pg_temp.hand('late-cursor',(SELECT d0 FROM fx)+interval '20 hours',2,false,'ok',NULL,
  (SELECT cutover-interval '1 hour' FROM public.horse_commitment_audit_passes WHERE day=(SELECT d FROM fx)));
SELECT pg_temp.hand('late-clock',(SELECT d0 FROM fx)+interval '1 hour',2,false,'ok',NULL,
  (SELECT cutover+interval '1 second' FROM public.horse_commitment_audit_passes WHERE day=(SELECT d FROM fx)));
SELECT pg_temp.hand('not-provably-late',(SELECT d0 FROM fx)+interval '1 hour 30 minutes',2,false,'ok',NULL,
  (SELECT cutover-interval '1 hour' FROM public.horse_commitment_audit_passes WHERE day=(SELECT d FROM fx)));
UPDATE public.horse_commitment_audit_days SET finished_at=transaction_timestamp()-interval '25 hours'
  WHERE day IN ((SELECT d FROM fx),(SELECT d2 FROM fx));
SET LOCAL ROLE service_role;
INSERT INTO steps(result) SELECT public.fn_horse_commitment_audit_step();  -- D2 re-pass completes
INSERT INTO steps(result) SELECT public.fn_horse_commitment_audit_step();  -- D pass 2 batch 1
INSERT INTO steps(result) SELECT public.fn_horse_commitment_audit_step();  -- D pass 2 batch 2
INSERT INTO steps(result) SELECT public.fn_horse_commitment_audit_step();  -- idle
RESET ROLE;
SELECT pg_temp.ok('repass_order_and_completion',
  (SELECT array_agg(result->>'status' ORDER BY n)=ARRAY['pass_complete','recorded','pass_complete','idle'] FROM steps WHERE n>5));
SELECT pg_temp.ok('legacy_day_receipted_from_next_pass',
  (SELECT count(*)=1 AND bool_and(pass=2 AND scanned_hands=0) FROM public.horse_commitment_audit_passes WHERE day=(SELECT d2 FROM fx))
  AND (SELECT hands_without_commit=0 AND late_arrival_hands=0 FROM public.horse_commitment_audit_days WHERE day=(SELECT d2 FROM fx)));
SELECT pg_temp.ok('pass1_receipt_unchanged_by_repass',
  (SELECT row FROM pass1)=(SELECT to_jsonb(p) FROM public.horse_commitment_audit_passes p WHERE day=(SELECT d FROM fx) AND pass=1));
SELECT pg_temp.ok('pass2_receipt_counts',
  (SELECT p.scanned_hands=316 AND p.horse_hands=300 AND p.flagged_horse_hands=300 AND p.unknown_horse_hands=0
     AND p.hand_gaps=15 AND p.hands_without_commit=1 AND p.missing_source_hands=3 AND p.late_arrival_hands=2
     AND p.final_after_hand_id=pg_temp.hid('late-cursor')
   FROM public.horse_commitment_audit_passes p WHERE day=(SELECT d FROM fx) AND pass=2));
SELECT pg_temp.ok('day_counters_are_current_pass_only',
  (SELECT pass=2 AND scanned_hands=316 AND late_arrival_hands=2 FROM public.horse_commitment_audit_days WHERE day=(SELECT d FROM fx)));
SELECT pg_temp.ok('history_retained_across_passes',
  (SELECT array_agg(scanned_hands ORDER BY pass)=ARRAY[313,316]::bigint[] FROM public.horse_commitment_audit_passes WHERE day=(SELECT d FROM fx)));
SELECT pg_temp.ok('late_by_cursor_reason',
  (SELECT reasons=ARRAY['late_arrival_after_pass:1'] FROM public.horse_commitment_audit_gaps WHERE hand_id=pg_temp.hid('late-cursor')));
SELECT pg_temp.ok('late_by_commit_clock_reason',
  (SELECT reasons=ARRAY['late_arrival_after_pass:1'] FROM public.horse_commitment_audit_gaps WHERE hand_id=pg_temp.hid('late-clock')));
SELECT pg_temp.ok('unprovable_late_not_labelled',
  NOT EXISTS(SELECT 1 FROM public.horse_commitment_audit_gaps WHERE hand_id=pg_temp.hid('not-provably-late')));
SELECT pg_temp.ok('first_pass_hands_not_late_on_repass',
  NOT EXISTS(SELECT 1 FROM public.horse_commitment_audit_gaps g WHERE EXISTS(SELECT 1 FROM unnest(g.reasons) x WHERE x LIKE 'late%')
    AND g.hand_id NOT IN (pg_temp.hid('late-cursor'),pg_temp.hid('late-clock'))));
SELECT pg_temp.ok('horse_reviews_not_duplicated',
  (SELECT count(*)=300 AND bool_and(eligibility='over_10bb' AND horse_user_id=(SELECT horse FROM fx)) FROM public.horse_commitment_reviews));

-- ===================== fn_horse_commitment_selection_receipt ==============
-- Bound/format controls on D3: direct gap-only rows with unreadable reasons
-- and no hand_history row (tableId null).
INSERT INTO public.horse_commitment_audit_gaps(hand_id,played_at,reasons)
SELECT pg_temp.hid('bounds-nested'),d0-interval '2 days'+interval '1 hour',ARRAY[['a','b']] FROM fx UNION ALL
SELECT pg_temp.hid('bounds-long'),d0-interval '2 days'+interval '2 hours',ARRAY[repeat('x',161)] FROM fx UNION ALL
SELECT pg_temp.hid('bounds-many'),d0-interval '2 days'+interval '3 hours',array_fill('r'::text,ARRAY[33]) FROM fx UNION ALL
SELECT pg_temp.hid('bounds-empty'),d0-interval '2 days'+interval '4 hours','{}'::text[] FROM fx UNION ALL
SELECT pg_temp.hid('bounds-ok'),d0-interval '2 days'+interval '5 hours',ARRAY['dealt_roster_invalid'] FROM fx;

SELECT pg_temp.ok('reader_anon_has_no_execute',
  NOT has_function_privilege('anon','public.fn_horse_commitment_selection_receipt(date,timestamptz,uuid,integer)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.fn_horse_commitment_selection_receipt(date,timestamptz,uuid,integer)','EXECUTE')
  AND has_function_privilege('service_role','public.fn_horse_commitment_selection_receipt(date,timestamptz,uuid,integer)','EXECUTE'));
SET LOCAL ROLE anon;
SELECT pg_temp.ok('reader_anon_refused',
  pg_temp.refused('SELECT public.fn_horse_commitment_selection_receipt((SELECT d FROM fx))','42501',NULL));
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT pg_temp.ok('reader_authenticated_refused',
  pg_temp.refused('SELECT public.fn_horse_commitment_selection_receipt((SELECT d FROM fx))','42501',NULL));
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT pg_temp.ok('reader_wrong_claim_refused',
  pg_temp.refused('SELECT public.fn_horse_commitment_selection_receipt((SELECT d FROM fx))','42501','hcsr_role_required'));
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT pg_temp.ok('passes_table_not_readable_by_service_role',
  pg_temp.refused('SELECT 1 FROM public.horse_commitment_audit_passes LIMIT 1','42501',NULL));
SELECT pg_temp.ok('reader_invalid_limit',
  pg_temp.refused('SELECT public.fn_horse_commitment_selection_receipt((SELECT d FROM fx),NULL,NULL,9)','P0001','hcsr_selection_request_invalid'));
SELECT pg_temp.ok('reader_partial_cursor',
  pg_temp.refused('SELECT public.fn_horse_commitment_selection_receipt((SELECT d FROM fx),(SELECT d0 FROM fx))','P0001','hcsr_selection_request_invalid'));
SELECT pg_temp.ok('reader_open_day',
  pg_temp.refused($$SELECT public.fn_horse_commitment_selection_receipt((statement_timestamp() AT TIME ZONE 'UTC')::date)$$,'P0001','hcsr_selection_request_invalid'));
SELECT pg_temp.ok('reader_cursor_outside_day',
  pg_temp.refused($$SELECT public.fn_horse_commitment_selection_receipt((SELECT d FROM fx),(SELECT d0+interval '1 day' FROM fx),gen_random_uuid())$$,'P0001','hcsr_selection_request_invalid'));
SELECT pg_temp.ok('reader_null_and_ancient_day',
  pg_temp.refused('SELECT public.fn_horse_commitment_selection_receipt(NULL)','P0001','hcsr_selection_request_invalid')
  AND pg_temp.refused($$SELECT public.fn_horse_commitment_selection_receipt('1999-12-31')$$,'P0001','hcsr_selection_request_invalid'));
CREATE TEMP TABLE pages(k text PRIMARY KEY, v jsonb);
INSERT INTO pages SELECT 'empty',public.fn_horse_commitment_selection_receipt('2020-01-01');
INSERT INTO pages SELECT 'p1',public.fn_horse_commitment_selection_receipt((SELECT d FROM fx));
INSERT INTO pages SELECT 'p2',public.fn_horse_commitment_selection_receipt((SELECT d FROM fx),
  ((SELECT v FROM pages WHERE k='p1')#>>'{next,playedAt}')::timestamptz,((SELECT v FROM pages WHERE k='p1')#>>'{next,handId}')::uuid,8);
INSERT INTO pages SELECT 'bounds',public.fn_horse_commitment_selection_receipt((SELECT d3 FROM fx));
RESET ROLE;
SELECT pg_temp.ok('reader_top_level_keys',
  (SELECT bool_and(pg_temp.keys(v)=ARRAY['activationAllowed','after','day','dayState','gaps','gtoVerified','hasMore',
     'identityBasis','limit','next','passes','readAt','source','sourceCoverage','version']
     AND v->'version'='1' AND v->>'source'='horse_commitment_selection_receipt' AND v->'limit'='8'
     AND v->>'sourceCoverage'='not_established' AND v->>'identityBasis'='current_profile_is_horse'
     AND v->'gtoVerified'='false' AND v->'activationAllowed'='false'
     AND v->>'readAt' ~ '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$'
     AND octet_length(v::text)<=65536) FROM pages));
SELECT pg_temp.ok('reader_missing_day_is_honest',
  (SELECT v->'dayState'='null' AND v->'passes'='[]' AND v->'gaps'='[]' AND v->'hasMore'='false' AND v->'next'='null'
     AND v->'after'='null' FROM pages WHERE k='empty'));
SELECT pg_temp.ok('reader_day_state_shape',
  (SELECT pg_temp.keys(v->'dayState')=ARRAY['cursor','finishedAt','flaggedHorseHands','handGaps','horseHands','lastBatchAt',
     'pass','scannedHands','startedAt','unknownHorseHands']
     AND (v#>>'{dayState,pass}')::int=2 AND (v#>>'{dayState,scannedHands}')::int=316
     AND pg_temp.keys(v#>'{dayState,cursor}')=ARRAY['createdAt','handId']
     AND v#>>'{dayState,cursor,handId}'=pg_temp.hid('late-cursor')::text FROM pages WHERE k='p1'));
SELECT pg_temp.ok('reader_passes_shape_and_order',
  (SELECT jsonb_array_length(v->'passes')=2 AND (v#>>'{passes,0,pass}')::int=1 AND (v#>>'{passes,1,pass}')::int=2
     AND pg_temp.keys(v#>'{passes,0}')=ARRAY['cutover','finalCursor','finishedAt','flaggedHorseHands','handGaps',
       'handsWithoutCommit','horseHands','identityBasis','lateArrivalHands','maxScannedCreatedAt','missingSourceHands',
       'pass','scannedHands','sourceCoverage','startedAt','unknownHorseHands','windowEnd','windowStart']
     AND (v#>>'{passes,1,lateArrivalHands}')::int=2 AND (v#>>'{passes,0,missingSourceHands}')::int=3
     AND (v#>>'{passes,0,handsWithoutCommit}')::int=1
     AND v#>>'{passes,0,windowStart}'=(SELECT d::text FROM fx)||'T00:00:00.000000Z'
     AND v#>>'{passes,1,finalCursor,handId}'=pg_temp.hid('late-cursor')::text FROM pages WHERE k='p1'));
SELECT pg_temp.ok('reader_gap_page_one',
  (SELECT jsonb_array_length(v->'gaps')=8 AND v->'hasMore'='true' AND v->'next'=jsonb_build_object('playedAt',v#>'{gaps,7,playedAt}','handId',v#>'{gaps,7,handId}')
     AND v#>>'{gaps,0,handId}'=pg_temp.hid('late-clock')::text
     AND v#>'{gaps,0,reasons}'='["late_arrival_after_pass:1"]'
     AND v#>>'{gaps,0,tableId}'=(SELECT tbl::text FROM fx)
     AND (SELECT bool_and(pg_temp.keys(g)=ARRAY['handId','playedAt','reasons','tableId']) FROM jsonb_array_elements(v->'gaps') g)
     FROM pages WHERE k='p1'));
SELECT pg_temp.ok('reader_gap_page_two_resumes',
  (SELECT jsonb_array_length(v->'gaps')=7 AND v->'hasMore'='false' AND v->'after'=(SELECT v->'next' FROM pages WHERE k='p1')
     AND v#>>'{gaps,6,handId}'=pg_temp.hid('late-cursor')::text
     AND v->'next'=jsonb_build_object('playedAt',v#>'{gaps,6,playedAt}','handId',v#>'{gaps,6,handId}')
     FROM pages WHERE k='p2'));
SELECT pg_temp.ok('reader_gap_only_population_exact',
  (SELECT array_agg(g->>'handId' ORDER BY g->>'handId') FROM pages p, jsonb_array_elements(p.v->'gaps') g WHERE p.k IN ('p1','p2'))
  =(SELECT array_agg(hand_id::text ORDER BY hand_id::text) FROM public.horse_commitment_audit_gaps g, fx
     WHERE g.played_at>=fx.d0 AND g.played_at<fx.d0+interval '1 day'
       AND NOT EXISTS(SELECT 1 FROM public.horse_commitment_reviews r WHERE r.hand_id=g.hand_id))
  AND (SELECT count(*)=15 FROM pages p, jsonb_array_elements(p.v->'gaps') g WHERE p.k IN ('p1','p2')));
SELECT pg_temp.ok('reader_excludes_reviewed_hands',
  NOT EXISTS(SELECT 1 FROM pages p, jsonb_array_elements(p.v->'gaps') g JOIN public.horse_commitment_reviews r ON r.hand_id::text=g->>'handId'));
SELECT pg_temp.ok('reader_bounds_fall_back_explicitly',
  (SELECT jsonb_array_length(v->'gaps')=5
     AND (SELECT count(*)=4 FROM jsonb_array_elements(v->'gaps') g WHERE g->'reasons'='["daily_gap_reasons_unavailable"]')
     AND v#>'{gaps,4,reasons}'='["dealt_roster_invalid"]'
     AND (SELECT bool_and(g->'tableId'='null') FROM jsonb_array_elements(v->'gaps') g)
     AND (v#>>'{passes,0,pass}')::int=1 FROM pages WHERE k='bounds'));

-- ===================== fn_horse_accepted_source_rows =======================
SELECT pg_temp.hand('src-a',(SELECT d0 FROM fx)+interval '15 hours',2,true,'ok',1000001);
SELECT pg_temp.hand('src-b',(SELECT d0 FROM fx)+interval '15 hours 1 second',2,true,'ok',1000002);
SELECT pg_temp.hand('src-big',(SELECT d0 FROM fx)+interval '15 hours 2 seconds',2,false,'oversized',1000003);
SELECT pg_temp.hand('src-mismatch',(SELECT d0 FROM fx)+interval '15 hours 3 seconds',2,true,'ok',1000004);
SELECT pg_temp.hand('src-other',(SELECT d0 FROM fx)+interval '15 hours 4 seconds',2,true,'ok',1000005);
UPDATE public.hand_atomic_commits SET hand_number=1000099 WHERE hand_id=pg_temp.hid('src-mismatch');
UPDATE public.hand_atomic_commits SET post_commit_completed_at=committed_at+interval '1 second' WHERE hand_id=pg_temp.hid('src-a');
INSERT INTO smarter_private.hand_submissions(submission_id,table_id,hand_number,instance_id,lease_generation,request,request_hash)
SELECT md5('sub-a')::uuid,tbl,1000001,'engine-1',md5('lease-a')::uuid,'{"k":1}'::jsonb,repeat('c',64) FROM fx UNION ALL
SELECT md5('sub-other')::uuid,tbl,1000005,'engine-1',md5('lease-other')::uuid,'{"k":2}'::jsonb,repeat('c',64) FROM fx;
INSERT INTO smarter_private.accepted_hand_rosters(table_id,hand_number,hand_id,post_commit_payload_hash,status,roster)
SELECT f.tbl,1000001,c.hand_id,c.post_commit_payload_hash,'captured','{"version":1,"actors":[]}'::jsonb
FROM fx f JOIN public.hand_atomic_commits c ON c.hand_id=pg_temp.hid('src-a');
CREATE FUNCTION pg_temp.coord(seed text) RETURNS jsonb LANGUAGE sql AS
 $c$ SELECT jsonb_build_object('hand_id',pg_temp.hid(seed),'table_id',tbl) FROM fx $c$;
SELECT pg_temp.ok('source_rpc_acl',
  NOT has_function_privilege('anon','public.fn_horse_accepted_source_rows(jsonb)','EXECUTE')
  AND NOT has_function_privilege('authenticated','public.fn_horse_accepted_source_rows(jsonb)','EXECUTE')
  AND has_function_privilege('service_role','public.fn_horse_accepted_source_rows(jsonb)','EXECUTE')
  AND (SELECT prosecdef AND provolatile='s' FROM pg_proc WHERE oid='public.fn_horse_accepted_source_rows(jsonb)'::regprocedure));
SET LOCAL ROLE anon;
SELECT pg_temp.ok('source_anon_refused',
  pg_temp.refused($$SELECT public.fn_horse_accepted_source_rows(jsonb_build_array(pg_temp.coord('src-a')))$$,'42501',NULL));
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT pg_temp.ok('source_wrong_claim_refused',
  pg_temp.refused($$SELECT public.fn_horse_accepted_source_rows(jsonb_build_array(pg_temp.coord('src-a')))$$,'42501','hcsr_role_required'));
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT pg_temp.ok('source_malformed_refused',
  pg_temp.refused('SELECT public.fn_horse_accepted_source_rows(NULL)','P0001','hcsr_hands_invalid')
  AND pg_temp.refused($$SELECT public.fn_horse_accepted_source_rows('{}')$$,'P0001','hcsr_hands_invalid')
  AND pg_temp.refused($$SELECT public.fn_horse_accepted_source_rows(to_jsonb(repeat('x',5000)))$$,'P0001','hcsr_hands_invalid')
  AND pg_temp.refused($$SELECT public.fn_horse_accepted_source_rows('[]')$$,'P0001','hcsr_hands_count_invalid')
  AND pg_temp.refused($$SELECT public.fn_horse_accepted_source_rows((SELECT jsonb_agg(pg_temp.coord('n'||i)) FROM generate_series(1,9) i))$$,'P0001','hcsr_hands_count_invalid')
  AND pg_temp.refused($$SELECT public.fn_horse_accepted_source_rows('["x"]')$$,'P0001','hcsr_coordinate_invalid')
  AND pg_temp.refused($$SELECT public.fn_horse_accepted_source_rows(jsonb_build_array(pg_temp.coord('src-a')||'{"extra":1}'))$$,'P0001','hcsr_coordinate_invalid')
  AND pg_temp.refused($$SELECT public.fn_horse_accepted_source_rows(jsonb_build_array(pg_temp.coord('src-a')-'table_id'))$$,'P0001','hcsr_coordinate_invalid')
  AND pg_temp.refused($$SELECT public.fn_horse_accepted_source_rows(jsonb_build_array(jsonb_build_object('hand_id',upper(pg_temp.hid('src-a')::text),'table_id',(SELECT tbl FROM fx))))$$,'P0001','hcsr_coordinate_invalid')
  AND pg_temp.refused($$SELECT public.fn_horse_accepted_source_rows(jsonb_build_array(jsonb_build_object('hand_id',1,'table_id',(SELECT tbl FROM fx))))$$,'P0001','hcsr_coordinate_invalid')
  AND pg_temp.refused($$SELECT public.fn_horse_accepted_source_rows(jsonb_build_array(pg_temp.coord('src-a'),pg_temp.coord('src-a')))$$,'P0001','hcsr_coordinate_duplicate'));
CREATE TEMP TABLE src(k text PRIMARY KEY, v jsonb);
INSERT INTO src SELECT 'main',public.fn_horse_accepted_source_rows(jsonb_build_array(
  pg_temp.coord('src-b'),pg_temp.coord('src-big'),pg_temp.coord('src-a'),pg_temp.coord('src-mismatch'),pg_temp.coord('no-commit')));
INSERT INTO src SELECT 'wrong-table',public.fn_horse_accepted_source_rows(jsonb_build_array(
  jsonb_build_object('hand_id',pg_temp.hid('src-a'),'table_id',gen_random_uuid())));
RESET ROLE;
SELECT pg_temp.ok('source_reply_envelope',
  (SELECT pg_temp.keys(v)=ARRAY['rows','version'] AND v->'version'='1' FROM src WHERE k='main'));
SELECT pg_temp.ok('source_returns_only_admissible_requested_rows_in_order',
  (SELECT array_agg(r->>'hand_id' ORDER BY o)=ARRAY[pg_temp.hid('src-b')::text,pg_temp.hid('src-a')::text]
   FROM src, jsonb_array_elements(v->'rows') WITH ORDINALITY x(r,o) WHERE k='main'));
SELECT pg_temp.ok('source_never_returns_other_hands',
  (SELECT v->'rows'='[]' FROM src WHERE k='wrong-table')
  AND NOT EXISTS(SELECT 1 FROM src, jsonb_array_elements(v->'rows') r
    WHERE r->>'hand_id' IN (pg_temp.hid('src-other')::text,pg_temp.hid('src-big')::text,pg_temp.hid('src-mismatch')::text)));
SELECT pg_temp.ok('source_row_exact_columns',
  (SELECT bool_and(pg_temp.keys(r)=ARRAY['actions_text','atomic_hand_id','atomic_hand_number','atomic_table_id','big_blind',
     'committed_at','core_payload_digest','game_variant','hand_id','hand_number','lease_generation','payload_digest',
     'payload_text','players_text','post_commit_completed_at','post_commit_request_digest','read_at','roster_hand_id',
     'roster_payload_digest','roster_producer_version','roster_status','roster_text','snapshot_id','stack_result_text',
     'table_id','tournament_id']
     AND NOT EXISTS(SELECT 1 FROM jsonb_each(r) e WHERE jsonb_typeof(e.value) NOT IN ('string','null')))
   FROM src, jsonb_array_elements(v->'rows') r WHERE k='main'));
SELECT pg_temp.ok('source_row_values_are_exact_source_text',
  (SELECT bool_and(r->>'table_id'=h.table_id::text AND r->>'hand_number'=h.hand_number::text
     AND r->>'atomic_hand_id'=c.hand_id::text AND r->>'atomic_table_id'=c.table_id::text
     AND r->>'atomic_hand_number'=c.hand_number::text AND r->>'big_blind'=h.big_blind::text
     AND r->>'game_variant'=h.game_variant AND r->'tournament_id'='null'
     AND r->>'actions_text'=h.actions::text AND r->>'players_text'=h.players::text
     AND r->>'payload_text'=c.post_commit_payload::text AND r->>'payload_digest'=c.post_commit_payload_hash
     AND r->>'payload_digest'=encode(extensions.digest(convert_to(r->>'payload_text','UTF8'),'sha256'),'hex')
     AND r->>'core_payload_digest'=c.payload_hash AND r->>'post_commit_request_digest'=c.post_commit_request_hash
     AND r->>'stack_result_text'=c.stack_result::text
     AND (r->>'committed_at')::timestamptz=c.committed_at AND r->>'committed_at' ~ '\+00$'
     AND r->>'snapshot_id' ~ '^[0-9]+:[0-9]+:([0-9]+(,[0-9]+)*)?$')
   FROM src, jsonb_array_elements(v->'rows') r
   JOIN public.hand_history h ON h.id::text=r->>'hand_id' JOIN public.hand_atomic_commits c ON c.hand_id=h.id WHERE k='main'));
SELECT pg_temp.ok('source_lease_generation_join',
  (SELECT r->>'lease_generation'=md5('lease-a')::uuid::text AND r->>'roster_status'='captured'
     AND r->>'roster_hand_id'=r->>'hand_id' AND r->>'roster_payload_digest'=r->>'payload_digest'
     AND r->>'roster_producer_version'='accepted_hand_roster_v1' AND (r->>'roster_text')::jsonb='{"version":1,"actors":[]}'
     AND (r->>'post_commit_completed_at')::timestamptz>(r->>'committed_at')::timestamptz
   FROM src, jsonb_array_elements(v->'rows') r WHERE k='main' AND r->>'hand_id'=pg_temp.hid('src-a')::text));
SELECT pg_temp.ok('source_absent_submission_and_roster_are_null',
  (SELECT r->'lease_generation'='null' AND r->'roster_status'='null' AND r->'roster_text'='null' AND r->'roster_hand_id'='null'
     AND r->'post_commit_completed_at'='null'
   FROM src, jsonb_array_elements(v->'rows') r WHERE k='main' AND r->>'hand_id'=pg_temp.hid('src-b')::text));
SELECT pg_temp.ok('source_one_snapshot',
  (SELECT count(DISTINCT r->>'snapshot_id')=1 AND count(DISTINCT r->>'read_at')=1 FROM src, jsonb_array_elements(v->'rows') r WHERE k='main'));
SELECT pg_temp.ok('readers_wrote_nothing',
  (SELECT count(*) FROM public.horse_commitment_audit_passes)=4
  AND (SELECT count(*) FROM public.horse_commitment_reviews)=300);

DO $total$ BEGIN
  IF (SELECT count(*) FROM checks)<>58 THEN RAISE EXCEPTION 'selection_check_population_changed: %',(SELECT count(*) FROM checks); END IF;
END $total$;
SELECT 'synthetic_selection_controls_only_if_executed' AS scope,(SELECT count(*) FROM checks) AS named_checks;
ROLLBACK;
