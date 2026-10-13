SET timezone='UTC';
CREATE TABLE grid(label text,t timestamptz);
INSERT INTO grid VALUES('null',NULL),('minus_inf','-infinity'),('plus_inf','infinity'),('low','4713-01-01 BC'),('high','294276-12-31 23:59:59.999999Z');
INSERT INTO grid SELECT '1883_'||n,timestamptz'1883-11-18 19:00Z'+n*interval'1 minute'FROM generate_series(0,180)n;
INSERT INTO grid SELECT 'modern_'||n,timestamptz'2026-03-07 00:00Z'+n*interval'30 minute'FROM generate_series(0,120)n;
INSERT INTO grid SELECT 'fall_'||n,timestamptz'2026-10-31 00:00Z'+n*interval'30 minute'FROM generate_series(0,120)n;
INSERT INTO grid SELECT 'monday_'||n,timestamptz'2026-10-12 07:00Z'+n*interval'1 microsecond'FROM generate_series(-5,5)n;
INSERT INTO grid SELECT 'high_'||n,timestamptz'294276-12-01Z'+n*interval'12 hour'FROM generate_series(0,60)n;
CREATE OR REPLACE FUNCTION oldgroup(v timestamptz[])RETURNS text LANGUAGE plpgsql AS $$DECLARE r text;BEGIN SELECT min(fn_union_week_start(t))::text INTO r FROM unnest(v)t WHERE t<'2026-10-12 07:00Z';RETURN r;EXCEPTION WHEN OTHERS THEN RETURN 'ERROR:'||SQLSTATE;END$$;
CREATE OR REPLACE FUNCTION newgroup(v timestamptz[])RETURNS text LANGUAGE plpgsql AS $$DECLARE r text;BEGIN SELECT LEAST(fn_union_week_start(min(t)FILTER(WHERE isfinite(t))),min(t))::text INTO r FROM unnest(v)t WHERE t<'2026-10-12 07:00Z';RETURN r;EXCEPTION WHEN OTHERS THEN RETURN 'ERROR:'||SQLSTATE;END$$;
INSERT INTO grid SELECT 'pastfall_'||n,timestamptz'2025-11-01 00:00Z'+n*interval'30 minute'FROM generate_series(0,144)n;
INSERT INTO grid SELECT 'pastmonday_'||n,timestamptz'2025-11-03 08:00Z'+n*interval'1 microsecond'FROM generate_series(-5,5)n;
INSERT INTO grid SELECT 'lower_'||n,timestamptz'4714-11-24 BC'+n*interval'12 hour'FROM generate_series(0,20)n;
WITH pairs AS(SELECT a.label al,b.label bl,ARRAY[a.t,b.t,NULL,a.t] vals FROM grid a CROSS JOIN grid b),answer AS(
SELECT al,bl,oldgroup(vals)old,newgroup(vals)new FROM pairs)
SELECT jsonb_build_object('pair_groups',count(*),'mismatches',count(*)FILTER(WHERE old IS DISTINCT FROM new),'same_errors',count(*)FILTER(WHERE old LIKE'ERROR:%'AND old=new))FROM answer;
SELECT jsonb_build_object('mixed_old',oldgroup(ARRAY['-infinity'::timestamptz,'4714-11-24 BC'::timestamptz]),'mixed_new',newgroup(ARRAY['-infinity'::timestamptz,'4714-11-24 BC'::timestamptz]),'allnull_old',oldgroup(ARRAY[NULL::timestamptz,NULL]),'allnull_new',newgroup(ARRAY[NULL::timestamptz,NULL]),'minus_only',newgroup(ARRAY['-infinity'::timestamptz]),'plus_only_filtered',newgroup(ARRAY['infinity'::timestamptz]));
