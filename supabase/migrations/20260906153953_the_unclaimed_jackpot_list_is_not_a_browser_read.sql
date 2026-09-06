-- ═══════════════════════════════════════════════════════════════════════════
--  THE UNCLAIMED JACKPOT LIST IS NOT A BROWSER READ
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT WAS OPEN, and for how long
--
-- `fn_bbj_unclaimed_shares()` returns EVERY unpaid bad-beat-jackpot share on
-- the platform: the player's id, their arena name, the amount they are owed,
-- the table, the hand number and the reason their wallet could not be reached.
-- It is SECURITY DEFINER, so the RLS on `bbj_unclaimed_shares` does not apply;
-- it takes no argument, so it cannot be scoped to a caller; and it never
-- consults auth.uid(), auth.role() or auth.jwt(), so it cannot tell who is
-- asking. Its ACL was:
--
--     {postgres=X/postgres, authenticated=X/postgres, service_role=X/postgres}
--
-- **Any account that could log in could list every player owed a jackpot
-- share, by name and by amount.**
--
-- THE CAUSE, named rather than guessed. Migration
-- `20260906152640_an_unpayable_jackpot_share_is_parked_not_lost` created the
-- function and wrote no REVOKE and no GRANT. That is not an oversight anybody
-- should feel bad about - it is the documented default and the single most
-- common way this happens: **Postgres grants EXECUTE to PUBLIC on every new
-- function**, and `authenticated` inherits PUBLIC. Silence is not "closed",
-- silence is "open to everyone". `scripts/ci/check-definer-authorization.mjs`
-- says so in its own header, and it did not catch this one because its RULE 1
-- only judges definers that WRITE and its RULE 2 only judges definers `anon`
-- can reach. This one is a read, reachable by `authenticated`, and fell
-- between them. The live check `check-telemetry-exposure.mjs` did catch it,
-- fourteen minutes after it landed, which is the net doing its job.
--
-- NOBODY IS OWED ANYTHING RIGHT NOW. Read before writing this migration:
-- `bbj_unclaimed_shares` holds **0** rows with `paid_at IS NULL`, 0 distinct
-- players, 0.00 in total. So this is an exposure defect and not a money
-- defect: no jackpot share is unpaid, and nothing here moves a chip.
--
-- THE FIX, and why it is this one. There are two honest options and the
-- choice is decided by evidence, not taste:
--
--   * scope it to the caller (`WHERE u.user_id = auth.uid()`), if a player is
--     meant to see their own parked share; or
--   * close it to the browser entirely, if it is an operator read.
--
-- It is an operator read. `fn_bbj_unclaimed_shares` has **no caller anywhere**
-- - not in Club Arena's `src/` or `server/src/`, not in the World Hub's
-- `pages/`, `src/` or `scripts/`. Its only two executions in
-- `pg_stat_statements` are the audits that found it. A function no client
-- calls does not need a browser grant, so it gets the narrow answer: revoke
-- from PUBLIC and every browser role, grant to `service_role`.
--
-- This does NOT reduce what an operator can see. `service_role` is what the
-- engine and every server-side route use, so the reconciler, the alerting and
-- any future operator page reach it exactly as before; only the browser is
-- shut out. If a player-facing view of their OWN parked share is wanted later,
-- the right shape is a second function scoped by `auth.uid()`, never a grant
-- back to this one.
--
-- WHY NOT THE ALLOWLIST. `public.ca_browser_definer_allowlist` exists for a
-- definer a browser genuinely needs, with a written reason. Nothing needs this
-- one, so recording a reason would be recording a fiction to silence a check.
--
-- ROLLBACK (only if a browser is genuinely given this read, which needs a
-- scoping argument first):
--   GRANT EXECUTE ON FUNCTION public.fn_bbj_unclaimed_shares() TO authenticated;

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.fn_bbj_unclaimed_shares()') IS NULL THEN
    RAISE EXCEPTION
      'fn_bbj_unclaimed_shares() does not exist - it was created by 20260906152640 and something has since dropped or re-signatured it. Re-read before applying.';
  END IF;

  -- If somebody has already closed it, say so rather than reporting success
  -- for work that was not done.
  IF NOT has_function_privilege('authenticated', 'public.fn_bbj_unclaimed_shares()', 'EXECUTE') THEN
    RAISE NOTICE 'fn_bbj_unclaimed_shares() is already closed to authenticated; the revoke below is a no-op.';
  END IF;
END $$;

-- PUBLIC is named as well as the roles. Revoking a role while PUBLIC still
-- holds EXECUTE reads as a fix and does nothing - the trap
-- check-definer-authorization.mjs calls out by name.
REVOKE ALL ON FUNCTION public.fn_bbj_unclaimed_shares() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bbj_unclaimed_shares() TO service_role;

DO $$
DECLARE v_open int;
BEGIN
  IF has_function_privilege('authenticated', 'public.fn_bbj_unclaimed_shares()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fn_bbj_unclaimed_shares()', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-check: a browser role can still execute fn_bbj_unclaimed_shares()';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_bbj_unclaimed_shares()', 'EXECUTE') THEN
    RAISE EXCEPTION 'post-check: service_role lost EXECUTE - the reconciler and operator reads would break';
  END IF;

  -- And the class, not just the instance: the live judgement function is the
  -- same one check-telemetry-exposure.mjs reads, so zero here is the same
  -- zero CI asks for.
  SELECT count(*) INTO v_open FROM public.fn_ca_browser_reachable_telemetry();
  IF v_open <> 0 THEN
    RAISE EXCEPTION
      'post-check: % unscoped SECURITY DEFINER routine(s) are still browser-reachable', v_open;
  END IF;
END $$;

COMMIT;
