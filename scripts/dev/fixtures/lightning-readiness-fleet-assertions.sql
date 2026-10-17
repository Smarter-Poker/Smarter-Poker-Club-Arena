\set ON_ERROR_STOP on
-- Execute the actual readiness catalog expression, not a copied classifier.
CREATE FUNCTION witness.readiness_law() RETURNS boolean LANGUAGE plpgsql AS $witness$
DECLARE expression text; answer boolean;
BEGIN
 SELECT substring(prosrc from 'v_law := (.*?);') INTO expression
 FROM pg_proc WHERE oid='public.fn_lightning_rollout_readiness(uuid)'::regprocedure;
 IF expression IS NULL THEN RAISE EXCEPTION 'readiness law expression missing'; END IF;
 expression := replace(expression,'v_strip',quote_literal('--[^'||chr(10)||']*'));
 expression := replace(expression,'v_horse',quote_literal('is_horse|horse_id'));
 EXECUTE 'SELECT '||expression INTO answer;
 RETURN answer;
END $witness$;
DO $$ BEGIN
 IF witness.readiness_law() IS DISTINCT FROM false THEN RAISE EXCEPTION 'BEFORE guard did not reject actual authorized control'; END IF;
 IF md5(pg_get_functiondef('public.fn_lightning_pilot_assignment_set(boolean,uuid,text,uuid[],text)'::regprocedure))<>'42ad4c77c5fbf91c56ba84401a8acb31' THEN RAISE EXCEPTION 'actual control preimage differs'; END IF;
END $$;
