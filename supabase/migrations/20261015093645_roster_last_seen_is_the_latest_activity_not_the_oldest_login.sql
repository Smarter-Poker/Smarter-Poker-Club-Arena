-- 20261015093645_roster_last_seen_is_the_latest_activity_not_the_oldest_login.sql
--
-- Version reserved by scripts/new-migration.mjs.
--
-- ROOT CAUSE (read live 2026-10-15 in SHARK CLUB's Player Management): players
-- who were "At Table" minutes earlier showed "Seen 7mo Ago" once they stood up.
-- ca_club_roster_rows reported activity as
--   coalesce(pr.last_login, pr.last_seen, b.m_last_active_at)
-- which returns the FIRST non-null value, not the latest. profiles.last_login
-- is only written by an interactive sign-in, so for any player whose session
-- outlives the login (and for every horse, which has no browser) it is months
-- old while profiles.last_seen is minutes old. Read: player 431185 last_login
-- 2026-01-13, last_seen 2026-10-14 20:21; player 983754 last_login 2026-03-15,
-- last_seen 2026-10-13 23:45. The same column drives the page's Recent
-- Activity sort, its export, and the Inactive 30/60/90 filters, so active
-- players were also sorted last and filtered as inactive. ca_club_member_detail
-- had the same coalesce for its last_login field.
--
-- THE FIX: the latest of the three, greatest() ignoring nulls. Nothing else in
-- either function changes; each is patched against its exact current
-- definition and aborts if that definition has moved.
--
-- @live-proof: (SELECT position('greatest(pr.last_login, pr.last_seen, b.m_last_active_at)' IN pg_get_functiondef('public.ca_club_roster_rows(uuid)'::regprocedure))>0 AND position('greatest(pr.last_login, pr.last_seen)' IN pg_get_functiondef('public.ca_club_member_detail(uuid,uuid,date,date)'::regprocedure))>0)

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $patch$
DECLARE v_definition text; v_old text; v_new text;
BEGIN
  SELECT pg_get_functiondef('public.ca_club_roster_rows(uuid)'::regprocedure) INTO v_definition;
  IF md5(v_definition) <> '1f5b38ddcec455a0caa83dea1012eafb' THEN
    RAISE EXCEPTION 'ca_club_roster_rows preimage changed; qualify current source';
  END IF;
  v_old := 'coalesce(pr.last_login, pr.last_seen, b.m_last_active_at)';
  v_new := 'greatest(pr.last_login, pr.last_seen, b.m_last_active_at)';
  IF (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'ca_club_roster_rows activity expression not found exactly once';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);

  SELECT pg_get_functiondef('public.ca_club_member_detail(uuid,uuid,date,date)'::regprocedure) INTO v_definition;
  IF md5(v_definition) <> '046be8cdb2d9c94e87c8f37d895640ab' THEN
    RAISE EXCEPTION 'ca_club_member_detail preimage changed; qualify current source';
  END IF;
  v_old := 'coalesce(pr.last_login, pr.last_seen)';
  v_new := 'greatest(pr.last_login, pr.last_seen)';
  IF (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'ca_club_member_detail activity expression not found exactly once';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END
$patch$;

DO $verify$
BEGIN
  IF position('greatest(pr.last_login, pr.last_seen, b.m_last_active_at)' IN
       pg_get_functiondef('public.ca_club_roster_rows(uuid)'::regprocedure)) = 0
     OR position('greatest(pr.last_login, pr.last_seen)' IN
       pg_get_functiondef('public.ca_club_member_detail(uuid,uuid,date,date)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'roster activity install verification failed';
  END IF;
END
$verify$;

COMMIT;
