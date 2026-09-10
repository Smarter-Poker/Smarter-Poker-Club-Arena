-- Prospective private duration authority, deliberately outside migrations.
-- This file creates no activation RPC and does not replace the live resolver.
CREATE OR REPLACE FUNCTION smarter_private.fn_ca_clock_duration_number(p_value jsonb)
RETURNS double precision LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $fn$
DECLARE v_value double precision;v_text text;
BEGIN
 IF p_value IS NULL OR p_value='null'::jsonb THEN RETURN 0; END IF;
 IF jsonb_typeof(p_value)='boolean' THEN RETURN CASE WHEN p_value='true'::jsonb THEN 1 ELSE 0 END; END IF;
 IF jsonb_typeof(p_value) NOT IN ('number','string') THEN RETURN 0; END IF;
 v_text:=btrim(p_value#>>'{}', E' \t\n\r');
 IF v_text='' THEN RETURN 0; END IF;
 -- Match supported JSON decimal Number scalars, including exponent notation.
 -- Unsupported nondecimal strings are unknown, just like absent duration metadata.
 IF v_text !~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$' THEN RETURN 0; END IF;
 BEGIN v_value:=v_text::double precision;
 EXCEPTION WHEN numeric_value_out_of_range THEN RETURN 0; END;
 IF v_value IN ('Infinity'::double precision,'-Infinity'::double precision,'NaN'::double precision) THEN RETURN 0; END IF;
 RETURN v_value;
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.fn_ca_clock_duration_number(jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION smarter_private.fn_ca_clock_duration(
 p_structure jsonb,p_level integer,p_short boolean,p_accelerated boolean,p_entry_closed boolean)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,smarter_private AS $fn$
DECLARE v_count integer;v_source integer;v_row jsonb;v_camel double precision;v_snake double precision;
 v_minutes double precision;v_seconds double precision;v_raw double precision;v_effective double precision;v_accelerated boolean;
BEGIN
 IF jsonb_typeof(p_structure) IS DISTINCT FROM 'array' OR jsonb_array_length(p_structure)=0 OR p_level IS NULL OR p_level<0 THEN
  RAISE EXCEPTION 'Clock level requires a persisted structure and nonnegative index' USING ERRCODE='55000'; END IF;
 v_count:=jsonb_array_length(p_structure);v_source:=least(p_level,v_count-1);
 IF p_level>=v_count AND NOT COALESCE(p_short,false) THEN
  WHILE v_source>0 AND p_structure->v_source->'isBreak'='true'::jsonb LOOP v_source:=v_source-1;END LOOP;
 END IF;
 v_row:=p_structure->v_source;
 v_camel:=smarter_private.fn_ca_clock_duration_number(v_row->'durationMinutes');
 v_snake:=smarter_private.fn_ca_clock_duration_number(v_row->'duration_minutes');
 IF v_camel>0 AND v_snake>0 AND v_camel<>v_snake THEN
  RAISE EXCEPTION 'Conflicting advertised level durations' USING ERRCODE='55000';END IF;
 v_minutes:=smarter_private.fn_ca_clock_duration_number(COALESCE(NULLIF(v_row->'durationMinutes','null'::jsonb),v_row->'duration_minutes'));
 v_seconds:=smarter_private.fn_ca_clock_duration_number(v_row->'duration');
 BEGIN
  v_raw:=CASE WHEN v_minutes>0 THEN (v_minutes*60::double precision)*1000::double precision
              WHEN v_seconds>0 THEN v_seconds*1000::double precision ELSE 600000::double precision END;
 EXCEPTION WHEN numeric_value_out_of_range THEN
  RAISE EXCEPTION 'Level duration is not finite and positive' USING ERRCODE='55000';END;
 IF v_raw<=0 OR v_raw IN ('Infinity'::double precision,'-Infinity'::double precision,'NaN'::double precision) THEN
  RAISE EXCEPTION 'Level duration is not finite and positive' USING ERRCODE='55000';END IF;
 IF p_level>=v_count AND NOT COALESCE(p_short,false) THEN v_raw:=greatest(v_raw,120000::double precision);END IF;
 v_accelerated:=COALESCE(p_accelerated,false) AND COALESCE(p_entry_closed,false);
 v_effective:=CASE WHEN v_accelerated THEN greatest(1::double precision,ceil(v_raw/60000::double precision/2::double precision))*60000::double precision ELSE v_raw END;
 RETURN jsonb_build_object('rawDurationMs',v_raw,'durationMs',v_effective,'sourceIndex',v_source,'accelerated',v_accelerated);
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.fn_ca_clock_duration(jsonb,integer,boolean,boolean,boolean)
 FROM PUBLIC,anon,authenticated,service_role;

-- Database-time due boundary; callers supply no elapsed or remaining time.
CREATE OR REPLACE FUNCTION smarter_private.fn_ca_clock_due_transition(
 p_structure jsonb,p_level integer,p_anchor timestamptz,p_duration_ms double precision)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog SET timezone='UTC' AS $fn$
DECLARE v_deadline timestamptz;v_next integer;v_now timestamptz;
BEGIN
 IF p_anchor IS NULL OR NOT isfinite(p_anchor) OR p_duration_ms IS NULL OR p_duration_ms<=0
    OR p_duration_ms IN ('Infinity'::double precision,'-Infinity'::double precision,'NaN'::double precision)
    OR p_level IS NULL OR p_level<0 OR jsonb_typeof(p_structure) IS DISTINCT FROM 'array' OR jsonb_array_length(p_structure)=0 THEN
  RAISE EXCEPTION 'CLOCK_CANONICAL_TIME_REQUIRED' USING ERRCODE='55000';END IF;
 v_deadline:=p_anchor+make_interval(secs=>p_duration_ms/1000::double precision);
 IF v_deadline<=p_anchor THEN RAISE EXCEPTION 'CLOCK_DURATION_BELOW_DATABASE_PRECISION' USING ERRCODE='55000';END IF;
 v_now:=clock_timestamp();
 IF v_now<v_deadline THEN RAISE EXCEPTION 'CLOCK_LEVEL_NOT_DUE' USING ERRCODE='55000';END IF;
 v_next:=p_level+1;
 WHILE v_next<jsonb_array_length(p_structure) AND p_structure->v_next->'isBreak'='true'::jsonb LOOP v_next:=v_next+1;END LOOP;
 RETURN jsonb_build_object('next_level',v_next,'next_anchor',v_deadline,'accepted_at',v_now);
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.fn_ca_clock_due_transition(jsonb,integer,timestamptz,double precision)
 FROM PUBLIC,anon,authenticated,service_role;

-- A typed instant is normalized numerically before entering an immutable
-- operation request. Different textual time zones cannot change replay identity.
CREATE OR REPLACE FUNCTION smarter_private.fn_ca_clock_instant(p_at timestamptz)
RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $fn$
 SELECT CASE WHEN p_at IS NULL THEN NULL ELSE extract(epoch FROM p_at)*1000000 END
$fn$;
REVOKE ALL ON FUNCTION smarter_private.fn_ca_clock_instant(timestamptz) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION smarter_private.fn_ca_clock_epoch_seconds(
 p_epoch_start timestamptz,p_interval_start timestamptz,p_interval_end timestamptz)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $fn$
BEGIN
 IF p_epoch_start IS NULL OR p_interval_start IS NULL OR p_interval_end IS NULL
 OR NOT isfinite(p_epoch_start) OR NOT isfinite(p_interval_start) OR NOT isfinite(p_interval_end)
 OR p_interval_end<p_interval_start THEN
  RAISE EXCEPTION 'CLOCK_CREDIT_INTERVAL_REQUIRED' USING ERRCODE='55000';END IF;
 RETURN greatest(0::numeric,extract(epoch FROM p_interval_end-greatest(p_epoch_start,p_interval_start)));
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.fn_ca_clock_epoch_seconds(timestamptz,timestamptz,timestamptz)
 FROM PUBLIC,anon,authenticated,service_role;
