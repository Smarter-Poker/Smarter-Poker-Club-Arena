-- UNRUN standalone. Applied by scripts/dev/test-union-weekly-basis.py after the
-- exact installed weekly base and the club-floor migration 20260920232503.
--
-- The coordinator refuses to work at all from minute :45, and its week loops
-- read clock_timestamp() directly, so a fixture that wants to exercise real
-- weeks needs the same declared clock seam weekly-union-continuation uses.
-- Only that seam is replaced; every financial predicate stays exactly as the
-- migration installed it, and the guard below refuses if the club floor is not
-- actually bound into discovery.
\set ON_ERROR_STOP on
DO $$BEGIN IF current_user<>'postgres' OR inet_server_addr() IS NOT NULL THEN
 RAISE EXCEPTION 'private native fixture only';END IF;END$$;

CREATE FUNCTION public.test_clock() RETURNS timestamptz LANGUAGE sql STABLE AS
$$SELECT COALESCE(NULLIF(current_setting('test.clock',true),'')::timestamptz,clock_timestamp())$$;

DO $$DECLARE d text;BEGIN
 SELECT pg_get_functiondef('public.fn_process_weekly_accounting_scope(uuid,uuid)'::regprocedure) INTO d;
 IF (length(d)-length(replace(d,'fn_club_settlement_floor_week','')))/length('fn_club_settlement_floor_week')<>3 THEN
  RAISE EXCEPTION 'club floor is not bound into discovery: fixture must run after 20260920232503';END IF;
 IF (length(d)-length(replace(d,$x$IF v_result->>'success' IS DISTINCT FROM 'true' THEN EXIT$x$,'')))
     /length($x$IF v_result->>'success' IS DISTINCT FROM 'true' THEN EXIT$x$)<>2 THEN
  RAISE EXCEPTION 'head-of-line EXIT rule is not present twice';END IF;
 IF position('clock_timestamp()' IN d)=0 THEN RAISE EXCEPTION 'coordinator clock seam missing';END IF;
 EXECUTE replace(d,'clock_timestamp()','public.test_clock()');
END$$;

-- Two standalone clubs, identical except for the floor. u(152) is the negative
-- control: it is what production did 495 times, and it must still do it.
-- Opening treasuries are zero: this fixture is about discovery, and no
-- synthetic chip movement is introduced into the real ledger triggers.
SET request.jwt.claims='{"role":"service_role","sub":"00000000-0000-0000-0000-000000000900"}';
INSERT INTO clubs(id,name,owner_id,chip_treasury,asset,is_union,union_id) VALUES
 (fixture.u(151),'Floored standalone',fixture.u(901),0,'chips',false,NULL),
 (fixture.u(152),'Floorless standalone',fixture.u(901),0,'chips',false,NULL);
