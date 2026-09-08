BEGIN;
CREATE SCHEMA stats_index_probe;
CREATE TABLE stats_index_probe.ca_hand_facts(hand_id uuid,played_at timestamptz,was_all_in boolean,went_to_showdown boolean,all_in_street text,all_in_equity numeric,padding text);
INSERT INTO stats_index_probe.ca_hand_facts SELECT md5(g::text)::uuid,now()-(g%14)*interval '1 day',g%100=0,g%200=0,CASE WHEN g%3=0 THEN 'river' WHEN g%3=1 THEN 'flop' ELSE NULL END,CASE WHEN g%400=0 THEN NULL ELSE .5 END,repeat('x',1000) FROM generate_series(1,20000)g;
CREATE TEMP TABLE before_index AS SELECT hand_id,all_in_equity FROM stats_index_probe.ca_hand_facts WHERE was_all_in=true AND went_to_showdown AND coalesce(all_in_street,'')<>'river' AND played_at>=now()-interval '7 days';
-- APPLY_MIGRATION
ANALYZE stats_index_probe.ca_hand_facts;
CREATE TEMP TABLE after_index AS SELECT hand_id,all_in_equity FROM stats_index_probe.ca_hand_facts WHERE was_all_in=true AND went_to_showdown AND coalesce(all_in_street,'')<>'river' AND played_at>=now()-interval '7 days';
DO $$ BEGIN IF EXISTS ((TABLE before_index EXCEPT ALL TABLE after_index) UNION ALL (TABLE after_index EXCEPT ALL TABLE before_index)) THEN RAISE EXCEPTION 'Candidate results changed'; END IF; END $$;
DO $plan$ DECLARE p json; BEGIN EXECUTE 'EXPLAIN (FORMAT JSON) SELECT hand_id,all_in_equity FROM stats_index_probe.ca_hand_facts WHERE was_all_in=true AND went_to_showdown AND coalesce(all_in_street,'''')<>''river'' AND played_at>=now()-interval ''7 days''' INTO p; IF p->0->'Plan'->>'Node Type'<>'Index Only Scan' OR p->0->'Plan'->>'Index Name'<>'idx_ca_hand_facts_runout_time_cover' THEN RAISE EXCEPTION 'Covering plan not selected: %',p; END IF; END $plan$;
ROLLBACK;
