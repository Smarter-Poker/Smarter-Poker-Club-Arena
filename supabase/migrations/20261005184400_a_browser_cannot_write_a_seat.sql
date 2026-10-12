-- Applied to production as version 20261005184400 (match by name).
--
-- A BROWSER CANNOT WRITE A SEAT, AND A LOGGED-OUT VISITOR CANNOT WRITE A MEMBERSHIP
--
-- table_seats carried INSERT, UPDATE, DELETE, REFERENCES, TRIGGER and MAINTAIN
-- for anon and authenticated (2026-10-05). Row level security already refused
-- every browser write - the only write policy is to service_role - so nothing
-- was written, but the grant was one mistaken policy away from letting a
-- logged-out visitor move chips between seats. The engine owns every seat
-- write (it runs as service_role), and the last browser write - the time-bank
-- refresh in TablePage - was removed in #6164, which is live before this runs.
--
-- club_members: anon held INSERT, UPDATE, REFERENCES, TRIGGER and MAINTAIN.
-- A logged-out visitor has no uid, so the two public policies ("Users can join
-- clubs", "club_members_update") never matched, but the grant stays closed the
-- same way. authenticated keeps INSERT and UPDATE, which joining a club uses;
-- REFERENCES, TRIGGER and MAINTAIN, which no browser path needs, go from both.
--
-- SELECT is untouched: the column grants from
-- 20261005115325_a_browser_cannot_read_which_seat_or_member_is_a_horse stay.
-- No REVOKE ALL here, because revoking a table privilege also revokes the
-- same privilege on every column, and that would take the column SELECTs too.
--
-- @live-proof: (NOT has_table_privilege('anon', 'public.table_seats', 'INSERT') AND NOT has_table_privilege('authenticated', 'public.table_seats', 'UPDATE') AND NOT has_table_privilege('anon', 'public.club_members', 'INSERT') AND has_table_privilege('authenticated', 'public.club_members', 'INSERT'))

DO $pre$
DECLARE v text;
BEGIN
  -- An invoker function a browser can call that writes table_seats would start
  -- failing. There is none; refuse if one appears.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND NOT p.prosecdef
     AND p.prorettype <> 'trigger'::regtype
     AND (has_function_privilege('anon', p.oid, 'EXECUTE')
          OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
     AND p.prosrc ~* '(insert\s+into|update|delete\s+from)\s+(public\.)?table_seats\M';
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'a browser-callable invoker function writes table_seats: %', v;
  END IF;

  IF NOT has_any_column_privilege('authenticated', 'public.table_seats', 'SELECT') THEN
    RAISE EXCEPTION 'expected the column SELECT grants on table_seats to be in place';
  END IF;
END
$pre$;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON TABLE public.table_seats FROM PUBLIC, anon, authenticated;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON TABLE public.club_members FROM PUBLIC, anon;

REVOKE REFERENCES, TRIGGER, MAINTAIN
  ON TABLE public.club_members FROM authenticated;

DO $post$
DECLARE v text;
BEGIN
  SELECT string_agg(format('%s %s', rl, pv), ', ') INTO v
    FROM unnest(ARRAY['anon', 'authenticated']) rl,
         unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) pv
   WHERE has_table_privilege(rl, 'public.table_seats', pv)
      OR (pv IN ('INSERT', 'UPDATE', 'REFERENCES')
          AND has_any_column_privilege(rl, 'public.table_seats', pv));
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'a browser role can still write table_seats: %', v;
  END IF;

  SELECT string_agg(pv, ', ') INTO v
    FROM unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) pv
   WHERE has_table_privilege('anon', 'public.club_members', pv)
      OR (pv IN ('INSERT', 'UPDATE', 'REFERENCES')
          AND has_any_column_privilege('anon', 'public.club_members', pv));
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'a logged-out visitor can still write club_members: %', v;
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.club_members', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.club_members', 'UPDATE') THEN
    RAISE EXCEPTION 'joining a club needs INSERT and UPDATE on club_members for authenticated';
  END IF;

  IF NOT has_column_privilege('authenticated', 'public.table_seats', 'player_id', 'SELECT')
     OR has_column_privilege('authenticated', 'public.table_seats', 'horse_id', 'SELECT')
     OR NOT has_column_privilege('anon', 'public.club_members', 'club_id', 'SELECT')
     OR has_column_privilege('anon', 'public.club_members', 'is_bot', 'SELECT') THEN
    RAISE EXCEPTION 'the column SELECT grants changed; they must be exactly as before';
  END IF;

  IF NOT has_table_privilege('service_role', 'public.table_seats', 'INSERT,UPDATE,DELETE')
     OR NOT has_table_privilege('service_role', 'public.club_members', 'INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'the service role lost a write';
  END IF;
END
$post$;
