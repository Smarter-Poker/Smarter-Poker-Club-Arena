-- 20261007000616_the_club_money_panel_is_a_read_and_says_so.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- fn_club_money_panel(uuid) is the read behind the club wallet panel that
-- /clubs/:clubId/financials mounts. Its body is SELECTs into variables and a
-- jsonb result: no INSERT, UPDATE, DELETE or MERGE, and its only callees are
-- auth.uid() (STABLE) and sum() (IMMUTABLE). It was declared without a
-- volatility, so Postgres recorded the default, VOLATILE, and the catalogue
-- has said "this function may write" about a function that cannot.
--
-- That label is the cause of a real failure. The Financial Admin production
-- certificate (tests/e2e/financial-admin-deep.spec.ts) admits an RPC POST only
-- when pg_proc.provolatile proves it is a read, so the Financials console it
-- certifies could never be shown under the read-only guard. Labelling the
-- function truthfully is the fix; widening the guard to a VOLATILE function
-- would teach it to trust a function the catalogue says can write.
--
-- STABLE is exact: the result depends on table contents and now(), both fixed
-- within one statement. PostgREST runs a STABLE RPC in a READ ONLY transaction,
-- which this function satisfies. Nothing else changes: the body, arguments,
-- SECURITY DEFINER, search_path and grants are asserted identical below.
--
-- Probe: read-only catalogue SELECTs on production (2026-10-07 00:05 UTC)
-- returned def md5 b565ebe80035c2b1af996013c4489211 (the post-image pinned by
-- 20261002194128), prosrc md5 ae32bb8e315f339b1ba954325e8cc524 and the ACL
-- asserted below. No DDL was probed.
--
-- @live-proof: (SELECT provolatile = 's' FROM pg_proc WHERE oid = 'public.fn_club_money_panel(uuid)'::regprocedure)

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $volatility$
DECLARE
  v_fn constant regprocedure := 'public.fn_club_money_panel(uuid)'::regprocedure;
  v_acl text;
  v_cfg text[];
BEGIN
  IF md5(pg_get_functiondef(v_fn)) <> 'b565ebe80035c2b1af996013c4489211' THEN
    RAISE EXCEPTION 'fn_club_money_panel is not the pinned text (md5 %)',
      md5(pg_get_functiondef(v_fn));
  END IF;
  IF (SELECT p.provolatile FROM pg_proc p WHERE p.oid = v_fn) <> 'v' THEN
    RAISE EXCEPTION 'fn_club_money_panel is no longer VOLATILE; this migration has nothing to do';
  END IF;
  IF (SELECT p.prosrc ~* '\m(insert[[:space:]]+into|update[[:space:]]+[a-z_.]+[[:space:]]+set|delete[[:space:]]+from|merge[[:space:]]+into)\M'
        FROM pg_proc p WHERE p.oid = v_fn) THEN
    RAISE EXCEPTION 'fn_club_money_panel writes; it cannot be declared STABLE';
  END IF;

  SELECT p.proacl::text, p.proconfig INTO v_acl, v_cfg FROM pg_proc p WHERE p.oid = v_fn;

  ALTER FUNCTION public.fn_club_money_panel(uuid) STABLE;

  IF (SELECT p.provolatile FROM pg_proc p WHERE p.oid = v_fn) <> 's' THEN
    RAISE EXCEPTION 'fn_club_money_panel did not become STABLE';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = v_fn) <> 'ae32bb8e315f339b1ba954325e8cc524' THEN
    RAISE EXCEPTION 'fn_club_money_panel: its body changed';
  END IF;
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_fn) THEN
    RAISE EXCEPTION 'fn_club_money_panel: it is no longer SECURITY DEFINER';
  END IF;
  IF (SELECT p.proacl::text FROM pg_proc p WHERE p.oid = v_fn) IS DISTINCT FROM v_acl
     OR (SELECT p.proconfig FROM pg_proc p WHERE p.oid = v_fn) IS DISTINCT FROM v_cfg
     OR has_function_privilege('anon', 'public.fn_club_money_panel(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_club_money_panel: its privileges or settings changed';
  END IF;
END
$volatility$;

COMMIT;
