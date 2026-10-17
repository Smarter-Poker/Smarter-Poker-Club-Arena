\set ON_ERROR_STOP on
DO $$ BEGIN
 IF witness.readiness_law() IS DISTINCT FROM true THEN RAISE EXCEPTION 'AFTER exact authorized control rejected'; END IF;
END $$;
BEGIN;
CREATE FUNCTION public.fn_lightning_unknown_horse_gate() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN RETURN current_setting('is_horse',true)='true'; END $$;
DO $$ BEGIN IF witness.readiness_law() IS DISTINCT FROM false THEN RAISE EXCEPTION 'new horse-sensitive function admitted'; END IF; END $$;
ROLLBACK;
BEGIN;
CREATE FUNCTION public.fn_lightning_comment_only() RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN
-- is_horse horse_id are documentation, not behavior.
RETURN true; END $$;
DO $$ BEGIN IF witness.readiness_law() IS DISTINCT FROM true THEN RAISE EXCEPTION 'comment-only marker rejected'; END IF; END $$;
ROLLBACK;
BEGIN;
DO $mutate$ DECLARE source text; BEGIN
 SELECT pg_get_functiondef('public.fn_lightning_pilot_assignment_set(boolean,uuid,text,uuid[],text)'::regprocedure) INTO source;
 EXECUTE replace(source,'IF p_active THEN','IF NOT p_active THEN');
 IF witness.readiness_law() IS DISTINCT FROM false THEN RAISE EXCEPTION 'changed reviewed control admitted'; END IF;
END $mutate$;
ROLLBACK;
BEGIN;
DO $mutate$ DECLARE source text; BEGIN
 SELECT pg_get_functiondef('public.fn_lightning_pilot_assignment_set(boolean,uuid,text,uuid[],text)'::regprocedure) INTO source;
 EXECUTE replace(source,'IF p_active THEN',E'-- changed reviewed definition\n IF p_active THEN');
 IF witness.readiness_law() IS DISTINCT FROM false THEN RAISE EXCEPTION 'unknown comment revision of reviewed control admitted'; END IF;
END $mutate$;
ROLLBACK;
DO $$ BEGIN IF witness.readiness_law() IS DISTINCT FROM true THEN RAISE EXCEPTION 'adversary rollback failed'; END IF; END $$;
