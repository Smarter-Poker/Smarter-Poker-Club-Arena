CREATE SCHEMA native_original_assert;
CREATE TABLE native_original_assert.originals AS
 SELECT s.submission_id,md5(s.request::text) request_md5,
 md5(to_jsonb(h)::text) handoff_md5,md5(to_jsonb(r)::text) result_md5,
 s.request FROM smarter_private.hand_submissions s
 JOIN smarter_private.hand_submission_handoffs h USING(submission_id)
 JOIN smarter_private.hand_submission_handoff_results r USING(submission_id);
CREATE FUNCTION native_original_assert.financial_sets() RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE n text;v jsonb;z jsonb:='{}';
BEGIN
 FOREACH n IN ARRAY ARRAY['profiles','clubs','club_members','chip_ledger','chip_transactions','poker_diamond_custody','poker_diamond_movements','poker_diamond_tournament_ledger','poker_diamond_jackpot_hits','poker_diamond_jackpot_ledger','poker_diamond_jackpot_pools'] LOOP
  IF to_regclass('public.'||n) IS NULL THEN RAISE EXCEPTION 'MANDATORY_MONETARY_RELATION_MISSING %',n;END IF;
  BEGIN
   EXECUTE format('SELECT jsonb_build_object(''count'',count(*),''md5'',md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),''[]''::jsonb)::text)) FROM public.%I t',n) INTO v;
   z:=z||jsonb_build_object(n,v);
  END;
 END LOOP;RETURN z;
END $f$;
CREATE TABLE native_original_assert.before_financial AS SELECT native_original_assert.financial_sets() sets;
CREATE FUNCTION native_original_assert.consumer_return(r jsonb,t uuid,e uuid,h bigint,q text) RETURNS boolean LANGUAGE plpgsql AS $f$
BEGIN
 IF r->'found' IS DISTINCT FROM 'true'::jsonb OR r->'completed' IS DISTINCT FROM 'true'::jsonb
 OR r->'success' IS DISTINCT FROM 'true'::jsonb OR r->'atomic_hand_commit' IS DISTINCT FROM 'true'::jsonb
 OR r->'snapshot_completed' IS DISTINCT FROM 'true'::jsonb OR r->'post_commit_completed' IS DISTINCT FROM 'true'::jsonb
 OR r->>'table_id' IS DISTINCT FROM t::text OR r->>'history_id' IS DISTINCT FROM e::text
 OR r->>'submission_id' IS DISTINCT FROM e::text OR r->>'submission_hash' IS DISTINCT FROM q
 OR r->>'hand_number' IS DISTINCT FROM h::text THEN RAISE EXCEPTION 'ESTABLISHED_ENGINE_CONSUMER_CONTRACT_REFUSED';END IF;
 RETURN true;
END $f$;
