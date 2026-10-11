-- Who may read a club's books (migration 20261010010632).
-- Run by scripts/ci/test-finance-gate-db-postgres.py as the session user
-- authenticator, the way PostgREST calls it, once on production's live
-- ca_can_view_club_finances (where exactly the four assertions the harness
-- names must FAIL) and once after the migration (where all ten must PASS).
--
-- Club u(100) is owned by u(1). Staff: u(2) co-owner (approved), u(3) admin,
-- u(4) super agent with an active agents row, u(5) super agent the club
-- suspended (agents.status), u(6) super agent with no agents row, u(14) super
-- agent whose active agents row is in another club, u(7) admin whose
-- membership is pending, u(8) a banned admin. u(9) is an agent, u(10) a
-- player, u(11) a platform admin in no club, u(12) owns club u(200) with no
-- membership row, u(13) is in no club.
CREATE TEMP TABLE scenario_result(name text, ok boolean);

CREATE FUNCTION pg_temp.check(ok boolean, name text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO scenario_result VALUES (name, coalesce(ok, false));
  IF coalesce(ok, false) THEN RAISE NOTICE 'PASS: %', name; ELSE RAISE NOTICE 'FAIL: %', name; END IF;
END $$;

-- The gate's answer for one caller, asked as the browser asks it.
CREATE FUNCTION pg_temp.can(viewer int, club int DEFAULT 100) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE r boolean;
BEGIN
  PERFORM public.as_user(viewer);
  SET LOCAL ROLE authenticated;
  r := public.ca_can_view_club_finances(public.u(club));
  RESET ROLE;
  RETURN r;
END $$;

-- What the rake audit policy lets the same caller read.
CREATE FUNCTION pg_temp.audit_rows(viewer int) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE r bigint;
BEGIN
  PERFORM public.as_user(viewer);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO r FROM public.rake_rate_audit;
  RESET ROLE;
  RETURN r;
END $$;

SELECT pg_temp.check(pg_temp.can(1) AND pg_temp.audit_rows(1) = 2,
  'the owner reads the books');
SELECT pg_temp.check(pg_temp.can(2) AND pg_temp.can(3),
  'an approved co-owner and an active admin read the books');
SELECT pg_temp.check(pg_temp.can(4) AND pg_temp.audit_rows(4) = 2,
  'an active super agent reads the books');
SELECT pg_temp.check(NOT pg_temp.can(5) AND pg_temp.audit_rows(5) = 0,
  'a super agent the club suspended does not, through the reports or the audit policy');
SELECT pg_temp.check(NOT pg_temp.can(6),
  'a super agent with no agents row does not');
SELECT pg_temp.check(NOT pg_temp.can(14),
  'a super agent whose active agents row is in another club does not');
SELECT pg_temp.check(NOT pg_temp.can(7),
  'an admin whose membership is pending does not');
SELECT pg_temp.check(NOT pg_temp.can(8) AND NOT pg_temp.can(9) AND NOT pg_temp.can(10) AND NOT pg_temp.can(13)
                 AND pg_temp.audit_rows(10) = 0,
  'a banned admin, an agent, a player and a stranger do not');
SELECT pg_temp.check(pg_temp.can(12, 200) AND NOT pg_temp.can(12, 100) AND pg_temp.can(11) AND pg_temp.audit_rows(11) = 2,
  'the owner of a club by ownership alone, and a platform admin, read the books with no membership row');

CREATE FUNCTION pg_temp.as_service() RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE r boolean;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role": "service_role"}', false);
  SET LOCAL ROLE service_role;
  r := public.ca_can_view_club_finances(public.u(100));
  RESET ROLE;
  RETURN r;
END $$;
CREATE FUNCTION pg_temp.as_nobody() RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE r boolean;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"role": "authenticated"}', false);
  SET LOCAL ROLE authenticated;
  r := public.ca_can_view_club_finances(public.u(100));
  RESET ROLE;
  RETURN r;
END $$;
SELECT pg_temp.check(pg_temp.as_service() AND NOT pg_temp.as_nobody(),
  'the service role does, and a caller with no account does not');

SELECT CASE WHEN count(*) FILTER (WHERE NOT ok) = 0 THEN 'SCENARIO PASSED ' || count(*)
            ELSE 'SCENARIO FAILED ' || count(*) FILTER (WHERE NOT ok) || ' OF ' || count(*) END
  FROM scenario_result;
