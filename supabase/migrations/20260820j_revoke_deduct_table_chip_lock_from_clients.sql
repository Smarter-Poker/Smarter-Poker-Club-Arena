-- SUPERSEDED 2026-08-20 by 20260820k_remove_dealer_tipping_entirely.sql, which
-- DROPS deduct_table_chip_lock outright along with the rest of dealer tipping.
-- Kept because it is already applied in prod. DO NOT RE-APPLY.

-- Applied to prod 2026-08-20 as migration 20260820171145.
-- ═══════════════════════════════════════════════════════════════════════════
-- Lock down `deduct_table_chip_lock`.
--
-- It was granted to `authenticated`, i.e. any signed-in browser could call it.
-- Its only caller was WalletService.processDealerTip, which is gone as of
-- 2026-08-20 (superseded by atomic_table_dealer_tip, engine-only). Left with
-- the grant in place it is a live "reduce a seat stack from the client" hole
-- and, because it is SECURITY INVOKER, the paired clubs.chip_treasury credit
-- can be silently dropped by RLS while the seat debit lands — destroying chips.
--
-- The function is kept (not dropped) so any in-flight deploy of the old bundle
-- fails loudly with a permission error rather than a "function does not exist"
-- 404 that older client code may mishandle. It can be dropped once the old
-- bundle is fully rolled off.
-- ═══════════════════════════════════════════════════════════════════════════

revoke execute on function public.deduct_table_chip_lock(uuid, uuid, numeric) from authenticated;
revoke execute on function public.deduct_table_chip_lock(uuid, uuid, numeric) from anon;
revoke execute on function public.deduct_table_chip_lock(uuid, uuid, numeric) from public;

comment on function public.deduct_table_chip_lock(uuid, uuid, numeric) is
  'DEPRECATED 2026-08-20 — superseded by atomic_table_dealer_tip(). Client grants revoked: it wrote table_seats.stack behind the authoritative engine, which then overwrote it at settlement and duplicated the chips. Do not re-grant to anon/authenticated.';
