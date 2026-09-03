-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826173758; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Nine SECURITY DEFINER functions in `public` had no search_path pinned. Five
-- of those were executable from the browser, and three of the five belong to
-- PostGIS/dblink and are owned by supabase_admin, so they are not ours to
-- change. The two that are ours:
--
--   fn_purchase_time_banks(p_quantity integer)  -- authenticated, and it DEBITS
--       DIAMONDS: it updates profiles.diamonds, inserts diamond_transactions,
--       inserts feature_purchases. SECURITY DEFINER, owned by postgres, and it
--       resolved every one of those names through the CALLER's search_path.
--   fn_bbj_gap_decomposition()                  -- authenticated, reporting
--
-- Two more are not browser-reachable but are money settlement, same owner, same
-- gap, and cost nothing to close:
--   fn_settle_round2_club_to_agents(...)
--   fn_settle_round3_agents_to_players(...)
--
-- WHY IT MATTERS: a SECURITY DEFINER function runs as its owner - here
-- `postgres`. With an unpinned search_path, every unqualified name in the body
-- is resolved through whatever the CALLER's search_path says. Anyone able to
-- create an object in a schema that sorts ahead of `public` can shadow
-- `profiles` or `diamond_transactions` and have their version executed with
-- postgres privileges. `authenticated` cannot normally CREATE in this database,
-- so this is hardening rather than an open door - but it is one ALTER per
-- function, and the alternative is relying on that staying true.
--
-- WHY THIS IS SAFE: checked before applying, every one of the four bodies
-- references only `public` objects plus `auth.uid()`. `auth.uid()` is already
-- schema-qualified and resolves regardless of search_path. No body touches
-- extensions, storage, graphql, vault, cron or net, so `public` is the complete
-- set. ALTER FUNCTION ... SET search_path changes no function body.
--
-- pg_temp is listed LAST deliberately. Postgres searches the temp schema FIRST
-- unless it is named explicitly, so naming it last is the point of the exercise.
--
-- ROLLBACK:
--   ALTER FUNCTION public.fn_purchase_time_banks(integer) RESET search_path;
--   ALTER FUNCTION public.fn_bbj_gap_decomposition() RESET search_path;
--   ALTER FUNCTION public.fn_settle_round2_club_to_agents(uuid, timestamptz, timestamptz) RESET search_path;
--   ALTER FUNCTION public.fn_settle_round3_agents_to_players(uuid, timestamptz, timestamptz) RESET search_path;

ALTER FUNCTION public.fn_purchase_time_banks(integer)                                    SET search_path = public, pg_temp;
ALTER FUNCTION public.fn_bbj_gap_decomposition()                                         SET search_path = public, pg_temp;
ALTER FUNCTION public.fn_settle_round2_club_to_agents(uuid, timestamptz, timestamptz)    SET search_path = public, pg_temp;
ALTER FUNCTION public.fn_settle_round3_agents_to_players(uuid, timestamptz, timestamptz) SET search_path = public, pg_temp;

DO $check$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public' AND p.prosecdef AND p.proconfig IS NULL
    AND p.proname IN ('fn_purchase_time_banks','fn_bbj_gap_decomposition',
                      'fn_settle_round2_club_to_agents','fn_settle_round3_agents_to_players');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'search_path still unpinned on: %', v_bad;
  END IF;

  -- the functions must still exist, still be SECURITY DEFINER, and still be
  -- callable by the roles that called them before
  IF NOT has_function_privilege('authenticated','public.fn_purchase_time_banks(integer)','EXECUTE') THEN
    RAISE EXCEPTION 'fn_purchase_time_banks is no longer callable by authenticated - the time-bank store would break';
  END IF;

  -- and the function still works: a rolled-back probe, per CLAUDE.md 11.5.
  -- No auth.uid() in this session, so it returns the not-authenticated verdict
  -- without touching a single row. That is the whole point - we want the error,
  -- not the side effect.
  IF (public.fn_purchase_time_banks(1) ->> 'error') IS DISTINCT FROM 'Not authenticated' THEN
    RAISE EXCEPTION 'fn_purchase_time_banks did not return its expected unauthenticated verdict after the ALTER';
  END IF;
END
$check$;
