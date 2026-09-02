-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260825194803; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ca_hand_player_facts was reachable from any logged-in browser. That is a leak
-- of every player's per-hand results, not a performance nit: the function is
-- SECURITY DEFINER, takes an arbitrary time range, and returns one row per
-- (player, hand) for EVERY player in that range. Anyone with a session could
-- have POSTed /rest/v1/rpc/ca_hand_player_facts and read the table.
--
-- WHY IT LOOKED CLOSED AND WAS NOT. The migration that created it did:
--   REVOKE ALL ... FROM PUBLIC;  REVOKE ALL ... FROM anon;  GRANT ... TO service_role;
-- which is the pattern used elsewhere in this repo, and it is not sufficient
-- here. This database carries
--   ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role
-- so a newly created function gets an EXPLICIT grant to `authenticated` at
-- creation time. Revoking PUBLIC does not touch it, and revoking anon removes
-- only half of what the default handed out. Caught by the Supabase security
-- advisor (authenticated_security_definer_function_executable), not by the
-- migration's own assertion, which is the second bug fixed below.
--
-- ca_player_stats_full still deliberately keeps its `authenticated` grant: that
-- one IS the page's entry point and returns a single player's summary.
REVOKE ALL ON FUNCTION public.ca_hand_player_facts(timestamptz, timestamptz) FROM authenticated;

-- Nothing breaks by removing it. ca_player_stats_full is itself SECURITY
-- DEFINER and owned by postgres, so it calls the facts function with the
-- owner's rights; the caller never needs EXECUTE on the inner function.

DO $$
DECLARE v_leaky text;
BEGIN
  -- The assertion this migration exists because of. The original only looked for
  -- grantee = 0 (PUBLIC) and anon, so an explicit `authenticated` grant - the one
  -- the database's own default privileges hand out to every new function - passed
  -- it silently. Every internal function is checked, every client role is named.
  SELECT string_agg(DISTINCT p.proname, ', ') INTO v_leaky
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a ON true
  WHERE n.nspname = 'public'
    AND p.proname IN ('ca_hand_player_facts', 'ca_roll_hand_stats',
                      'ca_roll_hand_stats_forward', 'ca_prune_hand_player_stat')
    AND (a.grantee = 0
         OR a.grantee = 'anon'::regrole
         OR a.grantee = 'authenticated'::regrole);

  IF v_leaky IS NOT NULL THEN
    RAISE EXCEPTION 'Internal rollup function(s) reachable from a browser: %', v_leaky;
  END IF;
END $$;
