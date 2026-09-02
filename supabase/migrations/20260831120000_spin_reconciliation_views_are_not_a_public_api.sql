-- ─────────────────────────────────────────────────────────────────────────────
-- THE SPIN RECONCILIATION VIEWS ARE NOT A PUBLIC API (2026-08-31)
--
-- Found by running the Supabase security advisor and then PROVING the finding
-- rather than trusting it: with nothing but the project's PUBLIC publishable
-- key - no account, no login, no session - this returned real production rows:
--
--   GET /rest/v1/v_spin_draw_booking_gaps
--       ?select=club_id,buy_in_amount,prize_drawn,prize_credited,draw_under_booked_by
--   -> 200 [{"club_id":"...","buy_in_amount":5.00,"prize_drawn":10.00,
--            "prize_credited":15.00,"draw_under_booked_by":5.00}]
--
-- That is an internal accounting discrepancy report - which spin tournaments
-- were under-booked, and by exactly how much - readable by anyone on the
-- internet who has looked at the site's own JavaScript bundle for the key.
--
-- TWO THINGS MADE IT PUBLIC AT ONCE, which is why neither guard caught it:
--
--   1. Both views are SECURITY DEFINER, so they execute as their owner and
--      every row-level policy underneath them is bypassed.
--   2. Both carry SELECT to `anon` and `authenticated` - the default grant a
--      view picks up in this project unless somebody takes it away.
--
-- Either alone is survivable. Together they are an open endpoint.
--
-- `v_spin_unpaid_settlements` answered 500 (statement timeout) rather than
-- 200 on the same probe. That is NOT a denial - the query was authorised and
-- had begun executing; it is simply too slow to finish. It is revoked here on
-- the same grounds as its sibling.
--
-- NOTHING IN A BROWSER READS THESE. Grepped both repos: the only mention
-- anywhere in client or engine code is a COMMENT in server/src/GameServer.ts
-- explaining what the view compares. They are operator diagnostics, so this
-- follows the house rule the push script prints for exactly this case -
-- "NOBODY IN A BROWSER SHOULD CALL IT" - and closes them to service_role.
--
-- PUBLIC is named explicitly alongside the two roles: revoking `anon` while
-- PUBLIC still holds the grant reads as a fix and does nothing.
--
-- VERIFIED AFTER APPLYING, from outside, with the same public key that proved
-- the leak: both views now answer
--   401 {"code":"42501","message":"permission denied for view ..."}
--
-- ROLLBACK:
--   GRANT SELECT ON public.v_spin_unpaid_settlements TO anon, authenticated;
--   GRANT SELECT ON public.v_spin_draw_booking_gaps  TO anon, authenticated;
-- ─────────────────────────────────────────────────────────────────────────────

REVOKE ALL ON public.v_spin_unpaid_settlements FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.v_spin_draw_booking_gaps  FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.v_spin_unpaid_settlements TO service_role;
GRANT SELECT ON public.v_spin_draw_booking_gaps  TO service_role;

COMMENT ON VIEW public.v_spin_unpaid_settlements IS
  'Operator diagnostic: spin settlements whose credited prize does not match what was drawn. service_role only - it was readable by anon until 2026-08-31 (SECURITY DEFINER view + default anon grant).';
COMMENT ON VIEW public.v_spin_draw_booking_gaps IS
  'Operator diagnostic: spin draws under-booked against the reserve pool. service_role only - it was readable by anon until 2026-08-31 and returned live club_id/buy_in/prize/shortfall rows to an unauthenticated caller.';

-- Post-apply assertions: the grants are actually gone, and service_role kept.
DO $$
DECLARE v_leak int; v_svc int;
BEGIN
  SELECT count(*) INTO v_leak
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND table_name IN ('v_spin_unpaid_settlements','v_spin_draw_booking_gaps')
     AND grantee IN ('anon','authenticated','PUBLIC');
  IF v_leak <> 0 THEN
    RAISE EXCEPTION 'post-apply failed: % browser-role grant(s) still present on the spin reconciliation views', v_leak;
  END IF;

  SELECT count(*) INTO v_svc
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public'
     AND table_name IN ('v_spin_unpaid_settlements','v_spin_draw_booking_gaps')
     AND grantee = 'service_role'
     AND privilege_type = 'SELECT';
  IF v_svc <> 2 THEN
    RAISE EXCEPTION 'post-apply failed: service_role lost SELECT on the spin reconciliation views (found %)', v_svc;
  END IF;
END $$;
