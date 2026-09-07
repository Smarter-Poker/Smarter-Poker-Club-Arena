-- 20260907161706_no_browser_role_may_write_the_jackpot.sql
--
-- Named for the version the Supabase MCP recorded when it applied this.
--
-- ═══════════════════════════════════════════════════════════════════════════
--  NO BROWSER ROLE MAY WRITE THE JACKPOT
--  BBJ build plan phase 5.2 (docs/BBJ-BUILD-PLAN.md)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT WAS TRUE UNTIL NOW, measured on production and then proved rather than
-- reasoned about. `authenticated` held these on `bbj_pools`:
--
--     DELETE, INSERT, REFERENCES, SELECT, TRIGGER, UPDATE
--
-- and the same on `bbj_payouts`, `bbj_winners`, `bbj_payout_recipients`,
-- `bbj_contributions` and five more. Every one of those is money, or the record
-- of money. The pool held 108,710.96 when this was written.
--
-- A browser could not actually use them. A probe that became `authenticated`
-- and ran `UPDATE bbj_pools SET main_balance = 1` was refused - but the refusal
-- came from ROW-LEVEL SECURITY MATCHING NO ROW, not from the grant. So the
-- jackpot was protected by exactly one thing: the absence of a permissive write
-- policy. Add one `FOR ALL` policy to any of these tables, for any reason that
-- sounds good at the time, and the grant behind it is already open.
--
-- This is the same defect I shipped twice inside this programme - on
-- `bbj_unclaimed_shares` in phase 2 and on `bbj_notify_thresholds` in phase 3 -
-- and both times Supabase's default `GRANT ALL ... TO anon, authenticated` on a
-- new public table put it there. The older tables have carried it since they
-- were created.
--
-- ═══ THE PLAN SAID THIS NEEDED THREE FUNCTIONS CONVERTED FIRST. IT DOES NOT ══
--
-- Phase 5.2 was written as "convert the three SECURITY INVOKER writers
-- (`record_rake`, `fn_resolve_bbj_pool`, `fn_union_fund_bbj_pool`) so
-- INSERT/UPDATE/DELETE can be revoked". A SECURITY INVOKER function runs with
-- the caller's rights, so the fear was that revoking would break them.
--
-- Read, not assumed: none of the three is reachable by a browser role at all.
--
--     has_function_privilege('authenticated', 'record_rake...')            false
--     has_function_privilege('authenticated', 'fn_union_fund_bbj_pool...') false
--     has_function_privilege('authenticated', 'fn_resolve_bbj_pool...')    false
--
-- They are called by the engine as `service_role`, which holds its own grants
-- and bypasses RLS, so the caller's rights were never `anon`'s or
-- `authenticated`'s. Revoking a privilege from a role that cannot call the
-- function changes nothing about the function.
--
-- PROVED, in one self-aborting transaction on production (CLAUDE.md 11.5): the
-- REVOKE below was applied and then `record_rake` - the live rake path, one of
-- the three - was called inside the same doomed transaction.
--
--     writes still held by a browser role: NONE
--     record_rake returned: {"success": true, "rake": 1.00,
--                            "bbj_contribution": 100.0000, ...}
--
-- So the three functions stay exactly as they are. Converting them would have
-- been a large change to three money paths to buy nothing.
--
-- ═══ THE RULE, AND ITS ONE LEGITIMATE EXCEPTION ═════════════════════════════
--
-- The first version of this migration asserted "SELECT is the only privilege a
-- browser may hold on a bbj_ table" and its own assertion refused it, correctly:
-- `bbj_notify_thresholds` DOES grant INSERT/UPDATE/DELETE to `authenticated`,
-- because phase 3.4 gives a club admin a panel to set jackpot announcement
-- thresholds, scoped by the `bbj_thresholds_admin_write` policy.
--
-- So the rule is not "no browser writes". It is: A BROWSER WRITE GRANT IS
-- ALLOWED ONLY WHERE A BROWSER WRITE POLICY EXISTS TO JUSTIFY IT. A grant with
-- no policy behind it is the dangerous kind - it does nothing today and
-- everything the moment somebody adds a policy - and that is what this removes.
--
-- SELECT is kept everywhere it exists: the jackpot page reads `bbj_pools`, the
-- ticker reads `bbj_winners`, and RLS scopes both.
--
-- ROLLBACK (there is no reason to want this):
--   GRANT INSERT, UPDATE, DELETE ON public.bbj_pools TO authenticated;

BEGIN;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON
  public.bbj_pools,
  public.bbj_payouts,
  public.bbj_payout_recipients,
  public.bbj_winners,
  public.bbj_contributions,
  public.bbj_hand_evidence_log,
  public.bbj_snapshot_alert_collapse_log,
  public.bbj_daily_user,
  public.bbj_qualifying_hands,
  public.bbj_stakes_tiers
FROM anon, authenticated;

DO $$
DECLARE v_bad text;
BEGIN
  /* THE GENERAL RULE, across every bbj_ table rather than the ten being
     changed, so the next one cannot ship with the default grants and have
     nobody notice: a browser write grant must have a browser write POLICY
     behind it. */
  SELECT string_agg(g.table_name || '.' || g.grantee || ':' || g.privilege_type, ', ')
    INTO v_bad
    FROM information_schema.role_table_grants g
   WHERE g.table_schema = 'public'
     AND g.table_name LIKE 'bbj%'
     AND g.grantee IN ('anon', 'authenticated')
     AND g.privilege_type <> 'SELECT'
     AND NOT EXISTS (
       SELECT 1 FROM pg_policies p
        WHERE p.schemaname = 'public'
          AND p.tablename = g.table_name
          AND p.cmd IN ('ALL', 'INSERT', 'UPDATE', 'DELETE')
          AND p.roles::text[] && ARRAY['anon', 'authenticated']
     );
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'a browser role holds a write grant with no policy behind it: %', v_bad;
  END IF;

  /* And the engine did not lose anything. */
  IF NOT (has_table_privilege('service_role', 'public.bbj_pools', 'UPDATE')
      AND has_table_privilege('service_role', 'public.bbj_payouts', 'INSERT')
      AND has_table_privilege('service_role', 'public.bbj_winners', 'INSERT')
      AND has_table_privilege('service_role', 'public.bbj_contributions', 'INSERT')) THEN
    RAISE EXCEPTION 'service_role lost a privilege the payout path needs';
  END IF;

  /* And a player can still read what they are shown. */
  IF NOT (has_table_privilege('authenticated', 'public.bbj_pools', 'SELECT')
      AND has_table_privilege('authenticated', 'public.bbj_winners', 'SELECT')) THEN
    RAISE EXCEPTION 'a player can no longer read the jackpot or its winners';
  END IF;
END $$;

COMMIT;
