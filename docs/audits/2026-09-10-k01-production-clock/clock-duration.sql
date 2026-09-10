-- Prospective private duration authority, deliberately outside migrations.
-- Explicit admitted terms; no activation RPC or replacement of the live resolver.
CREATE OR REPLACE FUNCTION smarter_private.fn_ca_clock_duration_number(p_value jsonb)
RETURNS double precision LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $fn$
DECLARE v_value double precision;
BEGIN
 IF jsonb_typeof(p_value) IS DISTINCT FROM 'number' THEN
  RAISE EXCEPTION 'Invalid advertised level duration' USING ERRCODE='55000';END IF;
 BEGIN v_value:=(p_value#>>'{}')::double precision;
 EXCEPTION WHEN numeric_value_out_of_range THEN
  RAISE EXCEPTION 'Invalid advertised level duration' USING ERRCODE='55000';END;
 IF v_value<=0 OR v_value IN ('Infinity'::double precision,'-Infinity'::double precision,'NaN'::double precision) THEN
  RAISE EXCEPTION 'Invalid advertised level duration' USING ERRCODE='55000';END IF;
 RETURN v_value;
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.fn_ca_clock_duration_number(jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION smarter_private.fn_ca_clock_duration_micros(p_ms double precision)
RETURNS bigint LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $fn$
DECLARE v_units double precision;v_integer double precision;
BEGIN
 BEGIN v_units:=p_ms*1000::double precision;
 EXCEPTION WHEN numeric_value_out_of_range THEN
  RAISE EXCEPTION 'Clock duration exceeds finite microsecond precision' USING ERRCODE='55000';END;
 v_integer:=floor(v_units);
 IF v_units-v_integer>=0.5::double precision THEN v_integer:=v_integer+1::double precision;END IF;
 IF v_integer IS NULL OR v_integer<=0 OR v_integer>9007199254740991::double precision
    OR v_integer IN ('Infinity'::double precision,'-Infinity'::double precision,'NaN'::double precision) THEN
  RAISE EXCEPTION 'Clock duration exceeds finite microsecond precision' USING ERRCODE='55000';END IF;
 RETURN v_integer::bigint;
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.fn_ca_clock_duration_micros(double precision) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION smarter_private.fn_ca_clock_duration(
 p_structure jsonb,p_level integer,p_short boolean,p_accelerated boolean,p_entry_closed boolean)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,smarter_private AS $fn$
DECLARE v_count integer;v_source integer;v_row jsonb;v_key text;v_term double precision;
 v_raw bigint;v_micros bigint;v_ms double precision;v_effective bigint;v_accelerated boolean;
BEGIN
 IF jsonb_typeof(p_structure) IS DISTINCT FROM 'array' OR jsonb_array_length(p_structure)=0 OR p_level IS NULL OR p_level<0 THEN
  RAISE EXCEPTION 'Clock level requires a persisted structure and nonnegative index' USING ERRCODE='55000';END IF;
 v_count:=jsonb_array_length(p_structure);v_source:=least(p_level,v_count-1);
 IF p_level>=v_count AND NOT COALESCE(p_short,false) THEN
  WHILE v_source>0 AND p_structure->v_source->'isBreak'='true'::jsonb LOOP v_source:=v_source-1;END LOOP;
 END IF;
 v_row:=p_structure->v_source;
 FOREACH v_key IN ARRAY ARRAY['durationMinutes','duration_minutes','duration'] LOOP
  IF NOT v_row ? v_key THEN CONTINUE;END IF;
  v_term:=smarter_private.fn_ca_clock_duration_number(v_row->v_key);
  BEGIN
   v_ms:=CASE WHEN v_key='duration' THEN v_term*1000::double precision ELSE (v_term*60::double precision)*1000::double precision END;
  EXCEPTION WHEN numeric_value_out_of_range THEN
   RAISE EXCEPTION 'Clock duration exceeds finite microsecond precision' USING ERRCODE='55000';END;
  v_micros:=smarter_private.fn_ca_clock_duration_micros(v_ms);
  IF v_raw IS NOT NULL AND v_raw<>v_micros THEN
   RAISE EXCEPTION 'Conflicting advertised level durations' USING ERRCODE='55000';END IF;
  v_raw:=v_micros;
 END LOOP;
 IF v_raw IS NULL THEN RAISE EXCEPTION 'Advertised level duration is required' USING ERRCODE='55000';END IF;
 v_accelerated:=COALESCE(p_accelerated,false) AND COALESCE(p_entry_closed,false);
 v_effective:=CASE WHEN v_accelerated THEN
  smarter_private.fn_ca_clock_duration_micros(greatest(1::double precision,ceil((v_raw::double precision/1000::double precision)/60000::double precision/2::double precision))*60000::double precision)
 ELSE v_raw END;
 RETURN jsonb_build_object('rawDurationMs',v_raw::double precision/1000::double precision,'rawDurationMicros',v_raw,
 'durationMs',v_effective::double precision/1000::double precision,'durationMicros',v_effective,'sourceIndex',v_source,'accelerated',v_accelerated);
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.fn_ca_clock_duration(jsonb,integer,boolean,boolean,boolean)
 FROM PUBLIC,anon,authenticated,service_role;

-- Construct from integer components, never re-round a duration float at a tie.
CREATE OR REPLACE FUNCTION smarter_private.fn_ca_clock_interval(p_micros bigint)
RETURNS interval LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $fn$
BEGIN
 IF p_micros IS NULL OR p_micros<=0 OR p_micros>9007199254740991 THEN
  RAISE EXCEPTION 'CLOCK_CANONICAL_TIME_REQUIRED' USING ERRCODE='55000';END IF;
 RETURN make_interval(days=>(p_micros/86400000000)::integer,
   secs=>((p_micros%86400000000)/1000000)::double precision)
   +(p_micros%1000000)::double precision*interval '1 microsecond';
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.fn_ca_clock_interval(bigint) FROM PUBLIC,anon,authenticated,service_role;

-- Database-time due boundary; callers supply no elapsed or remaining time.
CREATE OR REPLACE FUNCTION smarter_private.fn_ca_clock_due_transition(
 p_structure jsonb,p_level integer,p_anchor timestamptz,p_duration_micros bigint)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog SET timezone='UTC' AS $fn$
DECLARE v_deadline timestamptz;v_next integer;v_now timestamptz;
BEGIN
 IF p_anchor IS NULL OR NOT isfinite(p_anchor) OR p_duration_micros IS NULL OR p_duration_micros<=0 OR p_duration_micros>9007199254740991
    OR p_level IS NULL OR p_level<0 OR jsonb_typeof(p_structure) IS DISTINCT FROM 'array' OR jsonb_array_length(p_structure)=0 THEN
  RAISE EXCEPTION 'CLOCK_CANONICAL_TIME_REQUIRED' USING ERRCODE='55000';END IF;
 v_deadline:=p_anchor+smarter_private.fn_ca_clock_interval(p_duration_micros);
 IF v_deadline<=p_anchor THEN RAISE EXCEPTION 'CLOCK_DURATION_BELOW_DATABASE_PRECISION' USING ERRCODE='55000';END IF;
 v_now:=clock_timestamp();
 IF v_now<v_deadline THEN RAISE EXCEPTION 'CLOCK_LEVEL_NOT_DUE' USING ERRCODE='55000';END IF;
 v_next:=p_level+1;
 WHILE v_next<jsonb_array_length(p_structure) AND p_structure->v_next->'isBreak'='true'::jsonb LOOP v_next:=v_next+1;END LOOP;
 RETURN jsonb_build_object('next_level',v_next,'next_anchor',v_deadline,'accepted_at',v_now);
END $fn$;
REVOKE ALL ON FUNCTION smarter_private.fn_ca_clock_due_transition(jsonb,integer,timestamptz,bigint)
 FROM PUBLIC,anon,authenticated,service_role;

-- A typed instant is normalized numerically before entering an immutable
-- operation request. Different textual time zones cannot change replay identity.
CREATE OR REPLACE FUNCTION smarter_private.fn_ca_clock_instant(p_at timestamptz)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $fn$
BEGIN
 IF p_at IS NULL THEN RETURN NULL;END IF;
 IF NOT isfinite(p_at) THEN RAISE EXCEPTION 'CLOCK_FINITE_INSTANT_REQUIRED' USING ERRCODE='55000';END IF;
 RETURN extract(epoch FROM p_at)*1000000;
END $fn$;
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
