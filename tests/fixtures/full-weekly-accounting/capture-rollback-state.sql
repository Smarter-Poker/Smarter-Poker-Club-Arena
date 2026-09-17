-- Protected disposable fixture only. Read every captured application/auth/cron
-- table, retaining counts and stable row digests rather than fixture contents.
-- Sequence allocation is intentionally excluded: PostgreSQL sequence gaps do
-- not roll back and are not accounting movements or lost source identities.
CREATE TEMP TABLE rollback_table_state(relation text PRIMARY KEY,row_count bigint,rows_md5 text);
DO $$
DECLARE relation_record record;observed_count bigint;observed_digest text;
BEGIN
 FOR relation_record IN SELECT n.nspname,c.relname FROM pg_class c
  JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname IN('public','auth','cron','operational_source_intake') AND c.relkind IN('r','p')
  ORDER BY n.nspname,c.relname LOOP
  EXECUTE format('SELECT count(*),md5(COALESCE(jsonb_agg(x.record_value ORDER BY x.record_value::text)::text,''[]''))
    FROM (SELECT to_jsonb(t) AS record_value FROM %I.%I t)x',relation_record.nspname,relation_record.relname)
   INTO observed_count,observed_digest;
  INSERT INTO rollback_table_state VALUES(format('%I.%I',relation_record.nspname,relation_record.relname),observed_count,observed_digest);
 END LOOP;
END $$;
SELECT relation,row_count,rows_md5 FROM rollback_table_state ORDER BY relation;
