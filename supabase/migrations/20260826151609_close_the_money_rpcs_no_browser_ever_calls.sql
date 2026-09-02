-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826151609; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Continues the 2026-08-26 sweep. Of the 17 money-named SECURITY DEFINER
-- functions that `authenticated` could execute with no auth.uid() reference,
-- five were closed by revoke_authenticated_execute_on_five_economy_functions
-- and three seat functions by an_addon_that_cannot_apply_must_not_debit.
--
-- These seven have ZERO call sites in either repo's client code. Verified:
--   fn_credit_stalled_seat_first_stacks   0 call sites  (VOLATILE - credits chips)
--   fn_ensure_club_wallet                 0 call sites  (VOLATILE - called only
--                                                        from inside other
--                                                        SECURITY DEFINER
--                                                        functions, which run as
--                                                        owner and keep EXECUTE)
--   fn_club_arena_global_wallet_check     0 call sites  (STABLE  - estate totals)
--   fn_club_chip_circulation              0 call sites  (STABLE  - per-club totals)
--   fn_union_chip_integrity_check         0 call sites  (STABLE  - union totals)
--   fn_union_can_manage_wallets           0 call sites  (STABLE  - predicate)
--   fn_bbj_credited_report                1 call site, and it is
--                                         pages/api/club-arena/union-wallet.js
--                                         on `supabaseAdmin` (service role)
--
-- The four STABLE ones do not move money, but they hand any logged-in player
-- the club's and the union's financial aggregates. That is not a report a
-- player should be able to run.
--
-- Checked before revoking: no RLS policy in `public` references any of these
-- seven. A policy predicate is evaluated as the querying role, so revoking a
-- function a policy calls would silently deny rows; none apply here.
--
-- ROLLBACK: GRANT EXECUTE ON FUNCTION <each signature below> TO authenticated;

REVOKE EXECUTE ON FUNCTION public.fn_credit_stalled_seat_first_stacks() FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_ensure_club_wallet(uuid, uuid) FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_club_arena_global_wallet_check() FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_club_chip_circulation(uuid) FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_union_chip_integrity_check() FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_union_can_manage_wallets(uuid, uuid) FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_bbj_credited_report(uuid, integer, integer) FROM authenticated, anon, PUBLIC;

-- DELIBERATELY NOT REVOKED, because the Club Arena SPA calls them AS THE USER
-- and a revoke would break the agent credit screens:
--   fn_apply_credit_payment       src/services/CreditService.ts:525
--   fn_generate_credit_invoice    src/services/CreditService.ts:374
--   fn_generate_all_credit_invoices  src/services/FinancialCronService.ts:218
-- All three are SECURITY DEFINER, write money, and contain no caller check at
-- all: any logged-in user can post a payment against any invoice, or generate
-- invoices for every agent on the platform. They need an authorisation
-- predicate (agent/admin role), not a revoke, and choosing that predicate is a
-- product decision. Tracked in
-- .agent/audits/2026-08-26-pr994-never-applied-and-defective.md.

DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('fn_credit_stalled_seat_first_stacks','fn_ensure_club_wallet',
                      'fn_club_arena_global_wallet_check','fn_club_chip_circulation',
                      'fn_union_chip_integrity_check','fn_union_can_manage_wallets',
                      'fn_bbj_credited_report')
    AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
      OR has_function_privilege('anon', p.oid, 'EXECUTE'));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'still reachable from the browser: %', v_bad;
  END IF;

  -- fn_ensure_club_wallet is PERFORMed from inside atomic_table_addon and
  -- atomic_table_cashout. Those are SECURITY DEFINER and run as their owner, so
  -- this must still hold.
  IF NOT has_function_privilege(
       (SELECT pg_get_userbyid(proowner) FROM pg_proc
         WHERE oid = 'public.atomic_table_cashout(uuid,uuid,integer)'::regprocedure),
       'public.fn_ensure_club_wallet(uuid,uuid)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'the cash-out owner lost EXECUTE on fn_ensure_club_wallet';
  END IF;
END
$$;
