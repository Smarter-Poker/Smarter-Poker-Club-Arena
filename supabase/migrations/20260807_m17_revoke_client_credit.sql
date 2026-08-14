-- ============================================================================
-- AUDIT M17 (capstone) — take the generic credit RPCs away from the browser
-- ============================================================================
--
-- Every client call site that credited a wallet has been converted to a
-- purpose-built SECURITY DEFINER function that derives its amount from
-- authoritative state and enforces its own authorization:
--
--   fn_claim_special_bonus              (M17 part 1)
--   fn_claim_daily_bonus                (M18)
--   fn_admin_kick_player                (M17 part 2)
--   fn_admin_close_table                (M17 part 3)
--   fn_admin_remove_tournament_player   (M17 part 4)
--   fn_resolve_dispute                  (M17 part 5)
--   fn_pay_credit_invoice_from_wallet   (M17 part 6)
--
-- and two dead ones were deleted outright rather than repaired:
-- ChipFlowService.mintToUnionOwner (a literal browser-callable chip mint with a
-- caller-supplied amount and no authorization at all) and the offline queue's
-- money-replay cases (amounts read out of IndexedDB and replayed after an
-- unknown delay). WalletService.unlockFromTable went the same way: the Cashier
-- now routes the player to the table, where the engine owns the withdrawal.
--
-- `grep -rn "rpc('atomic_credit_wallet_and_log'|'fn_idempotent_credit_wallet')"
-- src/` returns nothing. So the grants can go.
--
-- WHY THIS MATTERS EVEN THOUGH RLS ALREADY BLOCKED THESE
-- It blocked them by accident. `wallets` happens to have no UPDATE policy and
-- `idempotency_keys` happens to be service_role-only, so the calls failed at the
-- last possible moment, for a reason unrelated to intent. Anyone adding a
-- reasonable-looking wallets UPDATE policy, or making these wrappers SECURITY
-- DEFINER to "fix the bonus bug", would have converted a broken feature into an
-- unlimited chip mint for any signed-in player. Revoking EXECUTE states the
-- intent directly: a browser may not credit a wallet by naming an amount.
--
-- The engine is unaffected. It connects with the SERVICE ROLE key, and
-- service_role keeps EXECUTE — these are the functions behind markSeatAsLeft,
-- the add-on refund path and AutoRebuyService, all of which keep working. The
-- new DEFINER functions above also keep working: they run as their owner
-- (postgres), which likewise retains EXECUTE.
--
-- `anon` is named explicitly. Supabase's ALTER DEFAULT PRIVILEGES granted it
-- EXECUTE BY NAME, so `REVOKE ALL ... FROM PUBLIC` alone does not remove it.
-- That trap was hit once in M7 and is the reason this file has four statements
-- per function rather than one.
-- ============================================================================

REVOKE ALL ON FUNCTION public.atomic_credit_wallet_and_log(uuid, numeric, text, text, uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atomic_credit_wallet_and_log(uuid, numeric, text, text, uuid, uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.atomic_credit_wallet_and_log(uuid, numeric, text, text, uuid, uuid, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_credit_wallet_and_log(uuid, numeric, text, text, uuid, uuid, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.fn_idempotent_credit_wallet(text, uuid, numeric, text, text, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_idempotent_credit_wallet(text, uuid, numeric, text, text, uuid, uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.fn_idempotent_credit_wallet(text, uuid, numeric, text, text, uuid, uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_idempotent_credit_wallet(text, uuid, numeric, text, text, uuid, uuid, uuid) TO service_role;

-- The idempotency plumbing beneath fn_idempotent_credit_wallet. These were
-- granted broadly for the same reason the wrapper was, and they have no
-- legitimate browser caller either: claiming an idempotency key from a client is
-- how a client would suppress a retry it should not be able to influence.
REVOKE ALL ON FUNCTION public.claim_idempotency_key(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_idempotency_key(text, text) FROM anon;
REVOKE ALL ON FUNCTION public.claim_idempotency_key(text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_idempotency_key(text, text) TO service_role;

REVOKE ALL ON FUNCTION public.store_idempotency_result(text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.store_idempotency_result(text, jsonb, text) FROM anon;
REVOKE ALL ON FUNCTION public.store_idempotency_result(text, jsonb, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.store_idempotency_result(text, jsonb, text) TO service_role;

COMMENT ON FUNCTION public.atomic_credit_wallet_and_log(uuid, numeric, text, text, uuid, uuid, uuid, text) IS
  'AUDIT M17: service_role ONLY. This is the generic credit primitive - it takes '
  'the amount from its caller, so a browser-reachable grant on it is a chip mint. '
  'Client features credit through purpose-built SECURITY DEFINER functions that '
  'derive the amount from authoritative state (fn_claim_special_bonus, '
  'fn_admin_kick_player, and so on). Do not grant this to authenticated.';

COMMENT ON FUNCTION public.fn_idempotent_credit_wallet(text, uuid, numeric, text, text, uuid, uuid, uuid) IS
  'AUDIT M17: service_role ONLY, for the same reason as '
  'atomic_credit_wallet_and_log - it wraps it without narrowing the amount. '
  'Note it is SECURITY INVOKER despite older comments calling it a definer '
  'wrapper; that mistaken belief is what audit finding M1 was closed on.';
