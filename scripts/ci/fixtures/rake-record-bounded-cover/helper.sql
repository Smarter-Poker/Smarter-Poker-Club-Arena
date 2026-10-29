CREATE FUNCTION smarter_private.rake_record_jsonb_raw_size(p_value jsonb)RETURNS integer LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE SET search_path=pg_catalog AS $function$BEGIN RETURN pg_catalog.pg_column_size(pg_catalog.jsonb_extract_path(p_value,VARIADIC '{}'::text[]));END$function$;
ALTER FUNCTION smarter_private.rake_record_jsonb_raw_size(jsonb)OWNER TO postgres;
REVOKE ALL ON FUNCTION smarter_private.rake_record_jsonb_raw_size(jsonb)FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION smarter_private.rake_record_jsonb_raw_size(jsonb)TO service_role;
