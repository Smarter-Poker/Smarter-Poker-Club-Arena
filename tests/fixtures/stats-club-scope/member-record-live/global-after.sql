-- Pin every mutable source column consumed by the detail reader.
DO $$
DECLARE col text; datum text; item record; expected text;
BEGIN
 FOR item IN SELECT * FROM (VALUES
 ('player_number','11'),('alias','Changed'),('username','changed'),('display_name','Changed'),
 ('first_name','First'),('last_name','Last'),('full_name','Full'),('arena_avatar_url','/arena.png'),('avatar_url','/avatar.png'),
 ('last_login',now()::text),('last_seen',now()::text),('is_online','true'),('status','deleted')
 ) v(col,datum) LOOP
   TRUNCATE signals;
   EXECUTE format('UPDATE profiles SET %I=%L WHERE id=%L',item.col,item.datum,'10000000-0000-0000-0000-000000000002');
   IF NOT EXISTS(SELECT 1 FROM signals WHERE topic='member-record:10000000-0000-0000-0000-000000000001:10000000-0000-0000-0000-000000000002') THEN
     RAISE EXCEPTION 'Missing profile column %',item.col;
   END IF;
   IF item.col IN ('player_number','alias','username','display_name','first_name','last_name','full_name','status') AND NOT EXISTS
     (SELECT 1 FROM signals WHERE topic='member-record:10000000-0000-0000-0000-000000000001:10000000-0000-0000-0000-000000000003') THEN
     RAISE EXCEPTION 'Missing upline identity column %',item.col;
   END IF;
   IF EXISTS(SELECT 1 FROM signals WHERE topic LIKE '%20000000%') THEN RAISE EXCEPTION 'Unrelated club was invalidated'; END IF;
 END LOOP;
 FOR item IN SELECT * FROM (VALUES ('role','admin'),('status','approved'),('nickname','Nick'),('notes','Remark'),('display_name','Local'),('joined_at',(now()-interval '1 day')::text)) v(col,datum) LOOP
   TRUNCATE signals;
   EXECUTE format('UPDATE club_members SET %I=%L WHERE user_id=%L',item.col,item.datum,'10000000-0000-0000-0000-000000000003');
   IF NOT EXISTS(SELECT 1 FROM signals WHERE topic LIKE '%000000000003') THEN RAISE EXCEPTION 'Missing membership column %',item.col; END IF;
 END LOOP;
END $$;
TRUNCATE signals;
UPDATE clubs SET name='Final first' WHERE id='10000000-0000-0000-0000-000000000001';
UPDATE clubs SET name='Final second' WHERE id='20000000-0000-0000-0000-000000000001';
DO $$ BEGIN
 IF (SELECT count(DISTINCT topic) FROM signals)<>3 THEN RAISE EXCEPTION 'Club rename must cover every member in both clubs'; END IF;
END $$;
TRUNCATE signals;
UPDATE tables SET status='running' WHERE id='10000000-0000-0000-0000-000000000004';
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM signals WHERE topic LIKE '%000000000003') THEN RAISE EXCEPTION 'Table status missing'; END IF; END $$;
DO $$ DECLARE item record; BEGIN
 FOR item IN SELECT * FROM (VALUES ('name','Renamed table'),('stakes','20/40'),('tournament_id','10000000-0000-0000-0000-000000000009'),('is_deleted','true'),('club_id','20000000-0000-0000-0000-000000000001')) v(col,datum) LOOP
   TRUNCATE signals;
   EXECUTE format('UPDATE tables SET %I=%L WHERE id=%L',item.col,item.datum,'10000000-0000-0000-0000-000000000004');
   IF NOT EXISTS(SELECT 1 FROM signals WHERE topic LIKE '%000000000003') THEN RAISE EXCEPTION 'Missing watch-table column %',item.col; END IF;
 END LOOP;
END $$;
TRUNCATE signals;
UPDATE tables SET status=status;
UPDATE clubs SET name=name;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM signals) THEN RAISE EXCEPTION 'No-op context emitted'; END IF; END $$;
INSERT INTO agents VALUES('10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','active',10,20);
DO $$ DECLARE item record; BEGIN
 FOR item IN SELECT * FROM (VALUES ('status','inactive'),('agent_wallet_balance','30'),('promo_wallet_balance','40')) v(col,datum) LOOP
   TRUNCATE signals;
   EXECUTE format('UPDATE agents SET %I=%L',item.col,item.datum);
   IF NOT EXISTS(SELECT 1 FROM signals) THEN RAISE EXCEPTION 'Agent column missing %',item.col; END IF;
 END LOOP;
END $$;
TRUNCATE signals;
DELETE FROM agents;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM signals) THEN RAISE EXCEPTION 'Agent removal missing'; END IF; END $$;
INSERT INTO chip_transactions(from_user_id,to_user_id,club_id,amount,transaction_type,created_at) VALUES
('10000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001',10,'transfer',now());
TRUNCATE signals;
UPDATE chip_transactions SET amount=20;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM signals) THEN RAISE EXCEPTION 'Transaction correction missing'; END IF; END $$;
TRUNCATE signals;
DELETE FROM chip_transactions;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM signals) THEN RAISE EXCEPTION 'Transaction removal missing'; END IF; END $$;
INSERT INTO ca_club_rake_daily_user VALUES('10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001');
INSERT INTO ca_club_member_tournament_fee_daily VALUES('20000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001');
TRUNCATE signals;
DELETE FROM ca_club_rake_daily_user;
DELETE FROM ca_club_member_tournament_fee_daily;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM signals WHERE topic LIKE '%20000000%') OR NOT EXISTS(SELECT 1 FROM signals WHERE topic LIKE '%10000000%') THEN RAISE EXCEPTION 'Fee removal missing'; END IF;
 IF EXISTS(SELECT 1 FROM signals WHERE (payload-'user_id')<>'{}'::jsonb) THEN RAISE EXCEPTION 'Sensitive record payload'; END IF;
 IF has_function_privilege('authenticated','fn_publish_member_record_context()','EXECUTE') THEN RAISE EXCEPTION 'Context helper exposed'; END IF;
END $$;
SELECT 'GLOBAL_MEMBER_FIELD_EVENTS PASS' result;
