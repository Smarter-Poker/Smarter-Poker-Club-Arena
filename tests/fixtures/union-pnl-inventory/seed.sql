CREATE FUNCTION pg_temp.u(n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$SELECT lpad(n::text,32,'0')::uuid$$;
CREATE FUNCTION pg_temp.assert(v boolean,label text) RETURNS void LANGUAGE plpgsql AS $$BEGIN IF v IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF; RAISE NOTICE 'PASS: %',label; END$$;
-- Populate mandatory fields of captured column contracts, then override only
-- the stated synthetic test facts. This helper has no financial behavior.
CREATE FUNCTION pg_temp.seed(rel regclass, facts jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE base jsonb; cols text; expr text;
BEGIN
 SELECT jsonb_object_agg(a.attname,CASE t.typname WHEN 'uuid' THEN to_jsonb(pg_temp.u(900))
  WHEN 'bool' THEN 'false'::jsonb WHEN 'int2' THEN '0'::jsonb WHEN 'int4' THEN '0'::jsonb WHEN 'int8' THEN '0'::jsonb
  WHEN 'numeric' THEN '0'::jsonb WHEN 'timestamptz' THEN to_jsonb(clock_timestamp()) ELSE '"fixture"'::jsonb END)
 INTO base FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid WHERE a.attrelid=rel AND a.attnum>0 AND a.attnotnull;
 SELECT string_agg(format('%I',attname),',' ORDER BY attnum),string_agg(format('r.%I',attname),',' ORDER BY attnum) INTO cols,expr FROM pg_attribute WHERE attrelid=rel AND attnum>0 AND NOT attisdropped AND attgenerated='';
 EXECUTE format('INSERT INTO %s(%s) SELECT %s FROM jsonb_populate_record(NULL::%s,$1) r',rel,cols,expr,rel) USING COALESCE(base,'{}')||facts;
END $$;
SELECT pg_temp.seed('union_clubs',jsonb_build_object('id',pg_temp.u(1),'club_id',pg_temp.u(101),'union_id',pg_temp.u(201)));
SELECT pg_temp.seed('tables',jsonb_build_object('id',pg_temp.u(2),'club_id',pg_temp.u(101),'union_id',pg_temp.u(201),'is_private',false));
SELECT pg_temp.seed('table_seats',jsonb_build_object('id',pg_temp.u(3),'table_id',pg_temp.u(2),'club_id',pg_temp.u(101),'user_id',pg_temp.u(301),'occupancy_id',pg_temp.u(401),'stack',100,'joined_at',clock_timestamp()));
SELECT pg_temp.seed('tournaments',jsonb_build_object('id',pg_temp.u(4),'club_id',pg_temp.u(101),'union_id',pg_temp.u(201),'status','RUNNING','prize_pool',1000));
SELECT pg_temp.seed('tournament_players',jsonb_build_object('id',pg_temp.u(5),'tournament_id',pg_temp.u(4),'club_id',pg_temp.u(101),'user_id',pg_temp.u(301),'status','playing'));
SELECT pg_temp.seed('tournaments',jsonb_build_object('id',pg_temp.u(6),'club_id',pg_temp.u(101),'union_id',pg_temp.u(201),'status','COMPLETED','prize_pool',2000));
SELECT pg_temp.seed('tournament_players',jsonb_build_object('id',pg_temp.u(7),'tournament_id',pg_temp.u(6),'club_id',pg_temp.u(101),'user_id',pg_temp.u(302),'status','eliminated'));
