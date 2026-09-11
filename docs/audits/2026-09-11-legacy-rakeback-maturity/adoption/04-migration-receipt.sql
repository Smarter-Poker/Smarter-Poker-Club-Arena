SET LOCAL statement_timeout='2000ms';
SELECT statement_timestamp() checked_at,version,name,cardinality(statements) statement_count,
 CASE WHEN cardinality(statements)=1 THEN encode(sha256(convert_to(statements[1],'UTF8')),'hex') END single_source_sha256,
 encode(sha256(convert_to(array_to_string(statements,E'\n'),'UTF8')),'hex') newline_source_sha256,
 encode(sha256(convert_to(array_to_string(statements,''),'UTF8')),'hex') joined_source_sha256,
 encode(sha256(convert_to(array_to_json(statements)::text,'UTF8')),'hex') statements_array_sha256
FROM supabase_migrations.schema_migrations
WHERE version='20260911070726' OR name='legacy_rakeback_closed_period_single_payer'
ORDER BY version LIMIT 10;
