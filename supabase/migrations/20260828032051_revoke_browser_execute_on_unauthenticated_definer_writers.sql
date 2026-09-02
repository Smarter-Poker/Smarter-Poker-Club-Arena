-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828032051; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.


-- ═══════════════════════════════════════════════════════════════════════════
--  SEVENTEEN MAINTENANCE RPCs WERE CALLABLE FROM A BROWSER
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A sweep of every function in `public` on 2026-08-27, after fixing
-- fn_mystery_bounty_reveal and commander_clock_write, found the same shape
-- repeated: 269 SECURITY DEFINER functions that WRITE hold EXECUTE for
-- `authenticated`, and 19 of them never reference auth.uid(), auth.role() or
-- auth.jwt() anywhere in their body. A function that never asks who is calling
-- cannot be authorising anything. SECURITY DEFINER then runs it as postgres,
-- which has BYPASSRLS, so the table policies do not stand behind it either.
--
-- PROVEN, not assumed. Inside a transaction that rolled itself back, as an
-- ordinary member holding nothing but their own JWT, with SET LOCAL ROLE
-- authenticated so the grant was really exercised:
--
--   PROBE3 club "SHARK CLUB" member_count 592->10591
--          | fn_table_lifecycle_pass ALSO RAN
--
-- These are backfills, sweeps, repair passes and lane assignments. They are
-- run by the engine on the service key, by World Hub cron on the service key,
-- or by a human at a SQL console. Every caller was checked before revoking:
--
--   ca_backfill_club_hand_daily            World Hub pages/api/cron/club-stats-maintenance.js, admin.rpc
--   fn_charge_place_overpays               server/src/GameServer.ts:2902 (engine, service key)
--   fn_repair_tournament_rake_attribution  server/src/GameServer.ts:2933 (engine, service key)
--   fn_assign_horse_lanes                  server/src/services/HorseLaneLoader.ts:54 (engine)
--   fn_table_lifecycle_pass                server/src/services/HorseFleetManager.ts:922 (engine)
--   increment_member_count                 no caller. InvitePage.tsx removed it and
--                                          tests/the-lobby-action-bar-actually-works.test.ts
--                                          pins that it stays removed.
--   the other eleven                       no caller in any of the seven repos
--
-- Revoking EXECUTE from a browser role does not touch service_role, so every
-- one of those callers is unaffected. REVOKE names PUBLIC as well as anon and
-- authenticated on purpose: a grant to PUBLIC would let `authenticated`
-- straight back in, and revoking only the named role would look correct and do
-- nothing. That is the same shape as the column-level REVOKE that read as a
-- fix and was a no-op on 2026-08-27.
--
-- NOT IN THIS LIST, deliberately, both reviewed and both kept:
--   get_current_settlement_period()   takes no arguments, get-or-creates the one
--                                     open weekly period, refuses when there is
--                                     no single owning union, ON CONFLICT DO
--                                     NOTHING. A caller cannot point it at
--                                     anything. src/services/SettlementService.ts:122
--   recalculate_leaderboard_ranks()   recomputes dense_rank from scores that are
--                                     already there. Idempotent, moves no money,
--                                     and the worst an attacker achieves is the
--                                     correct answer. src/services/PromotionService.ts:365

DO $$
DECLARE
  sig text;
  sigs text[] := ARRAY[
    'public.ca_backfill_club_hand_daily(uuid, date, boolean)',
    'public.fn_assign_horse_lanes()',
    'public.fn_backfill_unranked_survivors(boolean, integer)',
    'public.fn_bbj_relink_payouts()',
    'public.fn_charge_place_overpays(integer)',
    'public.fn_horse_audit_set_agent_analysis(date, jsonb)',
    'public.fn_platform_invariants_health()',
    'public.fn_rank_survivors(uuid)',
    'public.fn_renumber_duplicate_places(boolean, integer)',
    'public.fn_repair_tournament_rake_attribution(integer)',
    'public.fn_spin_reap_stale_boards(integer, boolean, boolean, integer)',
    'public.fn_spin_unpaid_check(integer)',
    'public.fn_table_lifecycle_pass()',
    'public.increment_member_count(uuid, integer)',
    'public.reserve_clip(text, text, text, uuid)',
    'public.reserve_sports_clip(text, text, text, uuid)',
    'public.update_live_peak_viewers(uuid, integer)'
  ];
BEGIN
  FOREACH sig IN ARRAY sigs LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', sig);
  END LOOP;
END $$;

-- Proof, in the migration, that every one of them is now shut to a browser and
-- open to the engine. If a signature above were wrong, format() would have
-- raised; if a revoke were a no-op, this raises instead of shipping quietly.
DO $$
DECLARE
  r record;
  bad text := '';
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure::text AS sig,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS browser,
           has_function_privilege('service_role', p.oid, 'EXECUTE') AS engine
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('ca_backfill_club_hand_daily','fn_assign_horse_lanes',
         'fn_backfill_unranked_survivors','fn_bbj_relink_payouts','fn_charge_place_overpays',
         'fn_horse_audit_set_agent_analysis','fn_platform_invariants_health','fn_rank_survivors',
         'fn_renumber_duplicate_places','fn_repair_tournament_rake_attribution',
         'fn_spin_reap_stale_boards','fn_spin_unpaid_check','fn_table_lifecycle_pass',
         'increment_member_count','reserve_clip','reserve_sports_clip','update_live_peak_viewers')
  LOOP
    IF r.browser OR NOT r.engine THEN
      bad := bad || format('%s browser=%s engine=%s; ', r.sig, r.browser, r.engine);
    END IF;
  END LOOP;
  IF bad <> '' THEN
    RAISE EXCEPTION 'revoke did not take: %', bad;
  END IF;
END $$;

