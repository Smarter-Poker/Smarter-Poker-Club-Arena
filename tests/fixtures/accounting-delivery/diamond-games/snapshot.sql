-- Every public/auth table, including journals/refusals/incidents, must roll back.
-- PostgreSQL sequences are nontransactional and intentionally excluded.
SELECT format('SELECT %L || ''|'' || COALESCE(jsonb_agg(row_value ORDER BY row_value)::text,''[]'') FROM (SELECT to_jsonb(t) AS row_value FROM %I.%I t) rows',
 n.nspname||'.'||c.relname,n.nspname,c.relname)
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE c.relkind IN ('r','p') AND n.nspname IN ('public','auth')
 ORDER BY n.nspname,c.relname
\gexec
