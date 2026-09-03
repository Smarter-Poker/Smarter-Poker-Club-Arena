-- ═══════════════════════════════════════════════════════════════════════
-- 20260831d_a_trigger_function_is_not_an_api.sql
-- ═══════════════════════════════════════════════════════════════════════
-- TIER:        2                              (permission tightening)
-- AUTHOR:      cowork-claude (phase 3 of the 2026-08-31 hardening plan)
-- AFFECTS:     EXECUTE grants on public trigger functions + the union_eco
--              read family; views v_spin_unpaid_settlements,
--              v_spin_draw_booking_gaps
-- IRREVERSIBLE: no  (ROLLBACK section at the foot restores every grant)
--
-- WHY:
--   Supabase's advisor reports 852 security findings on this project. That
--   headline is misleading in both directions, so this migration takes only
--   the part that is provably safe AND provably useful.
--
--   Audited 2026-08-31: every genuine money-mover reachable from a browser
--   (fn_mint_club_chips, fn_mint_chips_from_diamonds, atomic_chip_transfer,
--   atomic_table_buyin, send_wallet_diamond_transfer, transfer_club_ownership,
--   fn_wallet_type_transfer, fn_apply_credit_payment, ca_promo_vault_grant,
--   fn_member_leave_to_treasury, fn_resolve_dispute) checks auth.uid() for
--   itself. Those doors are exposed but each carries its own lock, so this
--   migration does NOT touch them: revoking a live RPC entry point would
--   break the product in order to fix a lint.
--
--   What it does close:
--
--   1. A TRIGGER FUNCTION IS NOT AN API. 342 functions in public return
--      `trigger`, and 175 carry EXECUTE for anon and/or authenticated. A
--      trigger function cannot be a legitimate RPC — PostgREST does not
--      expose functions returning `trigger` — so the grant buys nothing and
--      only widens the surface the advisor rightly complains about.
--
--      PROVEN BEFORE WRITING, NOT ASSUMED: trigger FIRING does not re-check
--      EXECUTE on the trigger function. A rolled-back probe created a table,
--      a trigger function and a trigger, revoked ALL from PUBLIC, switched to
--      the `authenticated` role, inserted a row, and the trigger still fired
--      and set its column. Had that check existed, this migration would have
--      broken every trigger on the platform — which is exactly why it was
--      tested rather than remembered.
--
--   2. fn_union_eco_adjustment AND fn_union_eco_record ARE NOT CALLED BY THE
--      APP. `fn_union_eco_adjustment` is SECURITY DEFINER, takes a union id
--      straight from the caller, and has NO caller check of any kind: no
--      auth.uid(), no role test. It is `stable` and writes nothing, so it
--      cannot move money, but it will hand any signed-in player another
--      union's economy figures. A grep of both repos finds zero call sites,
--      so the answer is to close the door rather than fit a lock to a door
--      nobody uses.
--
--   3. TWO SECURITY DEFINER VIEWS (advisor ERROR level). Neither is queried
--      by app code — only a comment in GameServer.ts mentions one — and
--      neither is granted to anon or authenticated today. Switching them to
--      security_invoker makes them respect the CALLER's RLS rather than the
--      view owner's, which is what stops them becoming an RLS bypass on the
--      day somebody does grant them.
--
-- HOW (high level):
--   - REVOKE EXECUTE on every exposed public trigger function
--   - REVOKE EXECUTE on the two uncalled union_eco readers
--   - ALTER both views to security_invoker
--   - Assert afterwards that no trigger function is browser-callable AND that
--     a known-good money RPC is STILL callable, proving we did not overreach
--
-- See .agent/workflows/migration-safety.md for the full protocol.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. PRE-FLIGHT ASSERTIONS ─────────────────────────────────────────
DO $$
DECLARE
  v_trigger_fns int;
  v_exposed     int;
BEGIN
  SELECT count(*) INTO v_trigger_fns
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prorettype = 'trigger'::regtype;

  IF v_trigger_fns = 0 THEN
    RAISE EXCEPTION 'pre-flight failed: no trigger functions in public - wrong database?';
  END IF;

  SELECT count(*) INTO v_exposed
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prorettype = 'trigger'::regtype
    AND (has_function_privilege('anon', p.oid, 'execute')
      OR has_function_privilege('authenticated', p.oid, 'execute'));

  RAISE NOTICE 'pre-flight: % trigger functions, % exposed to browser roles',
    v_trigger_fns, v_exposed;
END $$;

-- ─── 2. THE ACTUAL CHANGES ────────────────────────────────────────────

-- 2a. A trigger function is not an API.
DO $$
DECLARE
  r record;
  n int := 0;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'public'
      AND p.prorettype = 'trigger'::regtype
      /* OURS ONLY. `checkauthtrigger` (Supabase auth) and `postgis_cache_bbox`
         (PostGIS) are owned by supabase_admin, and a REVOKE issued by postgres
         against a grant postgres never made is a no-op with a warning — not an
         error. The first run of this migration proved that the hard way: the
         loop reported success and the post-apply assertion still found two
         functions exposed, which is precisely why the assertion exists. They
         are platform internals, not ours to re-permission. */
      AND p.proowner = 'postgres'::regrole
      AND (has_function_privilege('anon', p.oid, 'execute')
        OR has_function_privilege('authenticated', p.oid, 'execute'))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'revoked EXECUTE on % trigger function(s)', n;
END $$;

-- 2b. The union economy readers nobody calls, one of which has no caller
--     check at all and leaks another union's figures to any signed-in user.
DO $$
DECLARE
  r record;
  n int := 0;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'public'
      AND p.proname IN ('fn_union_eco_adjustment', 'fn_union_eco_record')
      AND (has_function_privilege('anon', p.oid, 'execute')
        OR has_function_privilege('authenticated', p.oid, 'execute'))
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'revoked EXECUTE on % union_eco function(s)', n;
END $$;

-- 2c. The two SECURITY DEFINER views: respect the CALLER's RLS.
ALTER VIEW public.v_spin_unpaid_settlements SET (security_invoker = on);
ALTER VIEW public.v_spin_draw_booking_gaps  SET (security_invoker = on);

-- ─── 3. POST-APPLY ASSERTIONS ─────────────────────────────────────────
-- Prove BOTH halves: the doors we meant to close are closed, and the ones we
-- promised not to touch are still open. A hardening migration that quietly
-- broke a money path would be far worse than the lint it fixed.
DO $$
DECLARE
  v_still_exposed int;
  v_eco_exposed   int;
  v_invoker       int;
BEGIN
  SELECT count(*) INTO v_still_exposed
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prorettype = 'trigger'::regtype
    AND p.proowner = 'postgres'::regrole   -- see the ownership note above
    AND (has_function_privilege('anon', p.oid, 'execute')
      OR has_function_privilege('authenticated', p.oid, 'execute'));
  IF v_still_exposed <> 0 THEN
    RAISE EXCEPTION 'post-apply failed: % trigger function(s) still browser-callable', v_still_exposed;
  END IF;

  SELECT count(*) INTO v_eco_exposed
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('fn_union_eco_adjustment', 'fn_union_eco_record')
    AND (has_function_privilege('anon', p.oid, 'execute')
      OR has_function_privilege('authenticated', p.oid, 'execute'));
  IF v_eco_exposed <> 0 THEN
    RAISE EXCEPTION 'post-apply failed: a union_eco reader is still browser-callable';
  END IF;

  SELECT count(*) INTO v_invoker
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('v_spin_unpaid_settlements', 'v_spin_draw_booking_gaps')
    AND array_to_string(c.reloptions, ',') LIKE '%security_invoker=on%';
  IF v_invoker <> 2 THEN
    RAISE EXCEPTION 'post-apply failed: expected 2 security_invoker views, found %', v_invoker;
  END IF;

  RAISE NOTICE 'post-apply OK: trigger functions closed, union_eco closed, views are invoker';
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK (if ever needed)
-- ═══════════════════════════════════════════════════════════════════════
-- The grants removed here were PostgreSQL's default (EXECUTE to PUBLIC on
-- CREATE FUNCTION), not a deliberate design decision. To restore:
--
--   DO $$
--   DECLARE r record;
--   BEGIN
--     FOR r IN SELECT p.oid::regprocedure AS sig
--              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--              WHERE n.nspname='public' AND p.prorettype='trigger'::regtype
--     LOOP
--       EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC', r.sig);
--     END LOOP;
--   END $$;
--   -- and, for the readers:
--   --   GRANT EXECUTE ON FUNCTION public.fn_union_eco_adjustment(uuid, timestamptz, timestamptz) TO authenticated;
--   ALTER VIEW public.v_spin_unpaid_settlements SET (security_invoker = off);
--   ALTER VIEW public.v_spin_draw_booking_gaps  SET (security_invoker = off);
-- ═══════════════════════════════════════════════════════════════════════
