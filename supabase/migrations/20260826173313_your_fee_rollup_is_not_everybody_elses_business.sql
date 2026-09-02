-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826173313; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- public.member_fee_rollup had exactly one policy:
--   member_fee_rollup_read  SELECT  {authenticated}  USING (true)
-- Every logged-in player could read every other player's row, and the row is
--   user_id, day, game_variant, is_mtt, hands, fees, contributed, won, wins,
--   vpip_hands, pfr_hands, three_bet_hands, three_bet_opps, cbet_hands, cbet_opps
-- That is a per-day profit-and-loss AND a poker HUD - VPIP, PFR, 3-bet and
-- c-bet frequencies - for every member of every club, queryable by anyone with
-- an account. On a poker platform that is a game-integrity problem before it is
-- a privacy one: an opponent can profile you before sitting down.
--
-- NOTHING IN EITHER REPO READS THIS TABLE FROM A CLIENT. The only reference is
-- src/services/ClubRosterService.ts calling the RPC ca_touch_member_fee_rollup,
-- which is SECURITY DEFINER and therefore unaffected by this policy. The three
-- functions that touch the table (ca_touch_member_fee_rollup,
-- fn_refresh_member_fee_rollup, sp_backfill_member_fee_rollup) are all SECURITY
-- DEFINER and run as their owner. Server routes use the service role, which
-- bypasses RLS entirely.
--
-- So the policy is narrowed to the row's owner rather than dropped: a player
-- keeps access to their own rollup, which is the only read that was ever
-- legitimate, and a future "my fees" screen still works without another
-- migration.
--
-- auth.uid() is wrapped in a SELECT so the planner evaluates it once per query
-- rather than once per row - the same initplan fix applied to table_chat and
-- vip_reward_claims in #982.
--
-- ROLLBACK:
--   DROP POLICY member_fee_rollup_read ON public.member_fee_rollup;
--   CREATE POLICY member_fee_rollup_read ON public.member_fee_rollup
--     FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS member_fee_rollup_read ON public.member_fee_rollup;

CREATE POLICY member_fee_rollup_read ON public.member_fee_rollup
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DO $check$
DECLARE v_qual text; v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname='public' AND tablename='member_fee_rollup';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'expected exactly one policy on member_fee_rollup, found %', v_n;
  END IF;

  SELECT qual INTO v_qual FROM pg_policies
   WHERE schemaname='public' AND tablename='member_fee_rollup' AND policyname='member_fee_rollup_read';
  IF v_qual IS NULL OR v_qual !~ 'auth\.uid' THEN
    RAISE EXCEPTION 'the new policy does not scope to the caller: %', coalesce(v_qual,'<null>');
  END IF;
  IF btrim(v_qual) IN ('true','(true)') THEN
    RAISE EXCEPTION 'the policy is still USING (true)';
  END IF;

  -- RLS must still be enabled, or the policy is decoration
  IF NOT (SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
           WHERE n.nspname='public' AND c.relname='member_fee_rollup') THEN
    RAISE EXCEPTION 'RLS is not enabled on member_fee_rollup';
  END IF;

  -- the maintenance path must be untouched
  IF NOT (SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='ca_touch_member_fee_rollup' LIMIT 1) THEN
    RAISE EXCEPTION 'ca_touch_member_fee_rollup is no longer SECURITY DEFINER - the roster refresh would break';
  END IF;
END
$check$;
