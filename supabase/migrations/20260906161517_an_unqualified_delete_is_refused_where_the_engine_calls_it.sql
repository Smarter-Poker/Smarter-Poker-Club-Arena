-- ═══════════════════════════════════════════════════════════════════════════
--  AN UNQUALIFIED DELETE IS REFUSED WHERE THE ENGINE CALLS IT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- MY OWN REGRESSION, FOUND IN THE ENGINE LOG NINETY MINUTES AFTER I SHIPPED IT.
--
-- `20260906150328_the_realtime_poller_decodes_only_what_someone_reads` patched
-- `fn_aggregate_gto_v31_next` to stop churning temp-table DDL on every call:
--
--     create temp table ... on commit drop   ->  on commit delete rows
--     truncate table tmp_agg31;              ->  delete from tmp_agg31;
--
-- The first half was right and stays. The second half is broken, and it is
-- broken in a way no amount of reading the SQL would show, because the refusal
-- does not come from Postgres:
--
--     select rolname, rolconfig from pg_roles where rolname = 'authenticator';
--     -> session_preload_libraries=safeupdate
--
-- **The `authenticator` role - which PostgREST runs as, and therefore every
-- RPC the engine makes through supabase-js - preloads `safeupdate`, and
-- safeupdate raises on an UPDATE or DELETE with no WHERE clause.** So the
-- statement is legal SQL, legal plpgsql, and legal when I ran it as `postgres`
-- from a migration; it fails only on the one path that actually calls it.
--
-- What that looked like, in `docker logs club-arena-engine`:
--
--     [GtoAggregationDriverV31.tick] Error: DELETE requires a WHERE clause
--
-- 27 times in a nine-minute window, and continuously since the migration
-- applied at 15:03 UTC. The GTO aggregation driver has done no work since. It
-- reports and continues rather than throwing, which is why nothing else went
-- red - the same reason it needed to be looked for rather than waited for.
--
-- THE FIX is one word. `where true` satisfies safeupdate and changes nothing
-- about what the statement does, and it keeps the reason the TRUNCATE was
-- removed: TRUNCATE takes an ACCESS EXCLUSIVE lock and writes catalog
-- invalidations on every call, which is what the original change was removing
-- from a function that runs on a cron tick.
--
-- The function is patched IN PLACE from `pg_get_functiondef` rather than
-- rewritten from a copy in this file, for the same reason the original
-- migration did: it is 9,284 characters of aggregation logic that belongs to
-- another programme, and re-typing it here to change one clause is how a
-- transcription error ships.
--
-- WHAT I SHOULD HAVE DONE, recorded because the rule is more useful than the
-- fix: a statement inside a SECURITY DEFINER function that the engine calls
-- runs under the CALLER's session settings, not the function owner's. Testing
-- it as `postgres` over the MCP proves nothing about the engine's path. The
-- gate added alongside this migration
-- (scripts/ci/check-unqualified-writes.mjs) reads every migration for an
-- unqualified UPDATE or DELETE and refuses it, so the next person does not
-- have to know that safeupdate exists.
--
-- ROLLBACK: there is none worth writing. The previous text is the broken one.

BEGIN;

DO $$
DECLARE
  v_def  text;
  v_new  text;
  v_hits int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'fn_aggregate_gto_v31_next';

  IF v_def IS NULL THEN
    RAISE EXCEPTION
      'fn_aggregate_gto_v31_next does not exist - it was patched by 20260906150328 and something has since dropped it. Re-read before applying.';
  END IF;

  -- Pre-assertion. If the broken statement is not there, somebody else has
  -- already fixed it (or changed it into something this migration must not
  -- rewrite blind), and this must say so rather than report success for work
  -- it did not do.
  SELECT count(*) INTO v_hits
  FROM regexp_matches(v_def, 'delete\s+from\s+tmp_agg31\s*;', 'gi');

  IF v_hits = 0 THEN
    RAISE NOTICE
      'fn_aggregate_gto_v31_next has no unqualified `delete from tmp_agg31;` - nothing to patch.';
    RETURN;
  END IF;
  IF v_hits > 1 THEN
    RAISE EXCEPTION
      'fn_aggregate_gto_v31_next has % unqualified deletes of tmp_agg31; this migration was written for exactly one. Read it before re-running.', v_hits;
  END IF;

  v_new := regexp_replace(
    v_def,
    'delete\s+from\s+tmp_agg31\s*;',
    'delete from tmp_agg31 where true;',
    'gi'
  );

  IF v_new = v_def THEN
    RAISE EXCEPTION 'the rewrite changed nothing - refusing to report success for a no-op';
  END IF;

  EXECUTE v_new;
END $$;

COMMIT;

-- ── POST-CHECKS ────────────────────────────────────────────────────────────
-- Separate transaction on purpose: these read the function as it now stands,
-- and a check that can only see its own uncommitted rewrite is not a check.
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'fn_aggregate_gto_v31_next';

  IF v_def !~* 'delete\s+from\s+tmp_agg31\s+where\s+true\s*;' THEN
    RAISE EXCEPTION 'post-check: the qualified delete is not present';
  END IF;

  IF v_def ~* 'delete\s+from\s+tmp_agg31\s*;' THEN
    RAISE EXCEPTION 'post-check: an unqualified delete of tmp_agg31 survives';
  END IF;

  -- The half of the original change that was correct must still be there.
  IF v_def !~* 'on\s+commit\s+delete\s+rows' THEN
    RAISE EXCEPTION
      'post-check: `on commit delete rows` is gone - the temp-table DDL churn this function was fixed for would come back';
  END IF;
  IF v_def ~* 'truncate' THEN
    RAISE EXCEPTION 'post-check: a TRUNCATE came back into the function';
  END IF;

  RAISE NOTICE 'fn_aggregate_gto_v31_next: delete is qualified, on commit delete rows intact, no truncate.';
END $$;
