-- 20260906160939_a_parked_jackpot_share_is_not_a_browser_write.sql
--
-- Version reserved by scripts/new-migration.mjs (as 20260906160853) against
-- origin/main and every remote branch, then RENAMED to 20260906160939, which
-- is the version the Supabase MCP recorded when it applied this. A file whose
-- version is not the version the database recorded would be applied a second
-- time by any rebuild from these files.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  A PARKED JACKPOT SHARE IS NOT A BROWSER WRITE
--  BBJ build plan phase 2.3 follow-up (docs/BBJ-BUILD-PLAN.md)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT IS OPEN, and how it got that way
--
-- `bbj_unclaimed_shares` is the row that says a named player is owed a named
-- number of chips. Created by 20260906152640, it inherited Supabase's default
-- `GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated`, measured
-- on production the same day:
--
--     anon:          INSERT, SELECT, UPDATE, DELETE, REFERENCES, TRIGGER
--     authenticated: INSERT, SELECT, UPDATE, DELETE, REFERENCES, TRIGGER
--
-- NOTHING IS EXPLOITABLE TODAY, and saying so plainly matters more than the
-- fix. Row-level security is enabled on the table and it carries exactly one
-- policy, `bbj_unclaimed_self_select`, which is SELECT-only. RLS is default
-- deny, so a command with no permissive policy is refused whatever the table
-- grant says: an INSERT, UPDATE or DELETE from a browser role is blocked
-- today. This is a latent hazard, not a live hole, and it is being closed
-- while it is still cheap.
--
-- WHY CLOSE IT ANYWAY. The protection rests entirely on nobody ever adding a
-- permissive write policy to this table - and the natural way somebody adds
-- one is `FOR ALL`, which is how a policy meant to let a player see their own
-- row would silently also let them write it. Defence should not depend on a
-- future author's choice of verb. This is also the class of defect CLAUDE.md
-- phase 5 already has on its list ("revoke write grants from anon and
-- authenticated on the bbj_* tables"); that one is blocked on converting three
-- SECURITY INVOKER writers first, and this table has no such blocker.
--
-- READ, NOT ASSUMED: the only two routines that touch this table are
-- `bbj_credit_one_recipient` (writes the parked row) and
-- `fn_bbj_unclaimed_shares` (reads them), and BOTH are SECURITY DEFINER, so
-- neither loses anything when a browser role loses its write grant. The engine
-- and every server route reach the table as `service_role`, which is untouched.
--
-- SELECT IS KEPT. A player reading their own parked share goes through
-- `bbj_unclaimed_self_select`, and that needs the table-level SELECT grant to
-- survive - RLS narrows a grant, it does not create one.
--
-- ROLLBACK (only if a browser is genuinely given a write path here, which
-- would need a policy first):
--   GRANT INSERT, UPDATE, DELETE ON public.bbj_unclaimed_shares TO authenticated;

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.bbj_unclaimed_shares') IS NULL THEN
    RAISE EXCEPTION 'bbj_unclaimed_shares does not exist - 20260906152640 has not been applied here.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.bbj_unclaimed_shares'::regclass) THEN
    RAISE EXCEPTION 'row-level security is off on bbj_unclaimed_shares - fix that before narrowing grants, or the SELECT kept below is unscoped.';
  END IF;
END $$;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.bbj_unclaimed_shares FROM anon, authenticated;

-- Kept deliberately: RLS scopes this to the caller's own row.
GRANT SELECT ON public.bbj_unclaimed_shares TO anon, authenticated;

DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(grantee || ':' || privilege_type, ', ') INTO v_bad
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'bbj_unclaimed_shares'
     AND grantee IN ('anon', 'authenticated')
     AND privilege_type <> 'SELECT';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'a browser role can still write bbj_unclaimed_shares: %', v_bad;
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.bbj_unclaimed_shares', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated lost SELECT - a player can no longer read their own parked share';
  END IF;

  IF NOT has_table_privilege('service_role', 'public.bbj_unclaimed_shares', 'INSERT') THEN
    RAISE EXCEPTION 'service_role lost INSERT - the payout path can no longer park a share';
  END IF;
END $$;

COMMIT;
