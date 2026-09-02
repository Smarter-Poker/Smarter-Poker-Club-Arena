-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827214020; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- CLOSE THE BROWSER MINT — 2026-08-27, security audit
--
-- 1. ANY CLUB MEMBER COULD MINT THEMSELVES UNLIMITED CHIPS.
--    `authenticated` held column-level UPDATE on club_members.chip_balance /
--    held_chips / locked_chips / promo_balance, and the RLS policy
--    club_members_update explicitly permits a member to update their OWN row
--    (role member/player, no credit line, no agent). Its WITH CHECK pins role,
--    credit_limit, credit_used, agent_id and parent_agent_id — and nothing
--    about the balances. The only trigger touching chip_balance is
--    trg_club_members_audit_chip_movement, which is AFTER UPDATE and merely
--    RECORDS the delta (its own handler swallows failures by design). So
--      supabase.from('club_members').update({ chip_balance: 9e8 }).eq('user_id', me)
--    succeeded from the SPA with the anon key, and atomic_table_buyin reads
--    that column as real money.
--
-- 2. A CLUB OWNER COULD SET clubs.chip_treasury TO ANY VALUE.
--    guard_wallet_balance_write is installed on wallets.balance and
--    clubs.chip_pool only. chip_treasury — the column fn_club_bank_send
--    actually moves and fn_club_bank_ledger reports on — had no guard, and
--    `authenticated` held UPDATE on it while the "Owners can update clubs"
--    policy allows an owner to write their own row. Treasury chips could be
--    created with no chip_transactions row.
--
-- THE FIX IS THE REVOKE, NOT A TRIGGER. 66 functions legitimately write these
-- columns — far more than guard_wallet_balance_write's whitelist — so adding a
-- blocking BEFORE trigger would break buy-ins, cashouts, joins and transfers
-- platform-wide. Removing the capability from the BROWSER role closes the hole
-- exactly: every legitimate writer is either SECURITY DEFINER (runs as its
-- owner) or is called only by the server with the service role, which keeps
-- its grants. Verified before applying: of the 29 SECURITY INVOKER writers,
-- only 3 are callable by `authenticated` (atomic_table_withdraw,
-- promo_apply_playthrough, reconcile_ledger_nightly) and all 3 are invoked
-- solely from the server — no client code path calls any of them.
--
-- 3. fn_award_satellite_seat: SECURITY DEFINER, granted to `authenticated`,
--    no auth check, and takes p_user_id from the caller. Any authenticated
--    user could seat any account into any ANNOUNCED/REGISTERING tournament for
--    free while inflating prize_pool and total_rake with money nobody paid.
--    Engine-only by intent (one caller, service role).
--
-- 4. profiles privilege escalation: UPDATE on is_admin/is_vip/role is revoked
--    and guarded, but INSERT was not, and profiles_delete + profiles_insert_self
--    both key on auth.uid() = id. An account could delete its own profile row
--    and re-insert it with is_admin = true, which satisfies ca_can_view_club()
--    for EVERY club.
--
-- 5. reconcile_ledger_nightly is an operations job, not a player action.
-- ═══════════════════════════════════════════════════════════════════════════

REVOKE UPDATE (chip_balance, held_chips, locked_chips, promo_balance)
  ON public.club_members FROM authenticated, anon;

REVOKE UPDATE (chip_treasury, chip_pool)
  ON public.clubs FROM authenticated, anon;

REVOKE INSERT (chip_balance, held_chips, locked_chips, promo_balance)
  ON public.club_members FROM authenticated, anon;

REVOKE EXECUTE ON FUNCTION public.fn_award_satellite_seat(uuid, uuid, uuid, text)
  FROM authenticated, anon;

REVOKE EXECUTE ON FUNCTION public.reconcile_ledger_nightly()
  FROM authenticated, anon;

DO $$
BEGIN
  BEGIN
    EXECUTE 'REVOKE INSERT (is_admin, is_vip, vip_expires_at, role) ON public.profiles FROM authenticated, anon';
  EXCEPTION WHEN undefined_column THEN
    EXECUTE 'REVOKE INSERT (is_admin) ON public.profiles FROM authenticated, anon';
  END;
END $$;
