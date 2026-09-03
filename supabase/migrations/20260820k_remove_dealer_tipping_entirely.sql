-- Applied to prod 2026-08-20.
-- ═══════════════════════════════════════════════════════════════════════════
-- REMOVE DEALER TIPPING ENTIRELY
--
-- Product decision, Dan 2026-08-20: Smarter Poker does not have dealers to tip
-- and will not be adding the feature. Every implementation of it is deleted —
-- the client modal, the GameServerAPI call, the POST /tipdealer route, the
-- engine method, and both database functions.
--
-- Safety check run before this migration:
--   select count(*) from wallet_transactions where category = 'TIP'          -> 0
--   select count(*) from wallet_transactions where description ilike '%dealer tip%' -> 0
-- Nothing has ever been tipped, so there is no data to preserve or migrate.
--
-- Why the functions are DROPPED rather than just revoked: a revoked function is
-- an invitation. Both of these moved chips off a seat stack, and the older one
-- (deduct_table_chip_lock, added 20260311) did it from the browser, behind the
-- authoritative engine's back — settlement then overwrote table_seats from the
-- engine's in-memory stack, handing the player their chips back while
-- clubs.chip_treasury kept a copy. It minted chips. It should not exist.
--
-- Supersedes: 20260311_deduct_table_chip_lock_rpc.sql,
--             20260312_fix_table_seat_tip_exploit.sql,
--             20260820i_atomic_table_dealer_tip.sql (deleted from the repo),
--             20260820j_revoke_deduct_table_chip_lock_from_clients.sql.
-- ═══════════════════════════════════════════════════════════════════════════

drop function if exists public.atomic_table_dealer_tip(uuid, uuid, numeric);
drop function if exists public.deduct_table_chip_lock(uuid, uuid, numeric);

-- Close the category off at the constraint, so no future code path can record a
-- tip even by accident. Verified zero existing rows above, so this cannot fail
-- on legacy data.
alter table public.wallet_transactions
  drop constraint if exists wallet_transactions_category_check;

alter table public.wallet_transactions
  add constraint wallet_transactions_category_check
  check (category = any (array[
    'buyin', 'cashout', 'promo', 'rake', 'transfer',
    'tournament_buyin', 'tournament_winnings', 'tournament_cashout',
    'horse_refill', 'deposit', 'withdrawal', 'refund', 'bbj', 'bonus',
    'mint', 'settlement', 'commission', 'INSURANCE', 'prize', 'rebuy',
    'addon', 'funding', 'promotion', 'rakeback', 'bounty', 'addon_refund',
    'bounty_own', 'prize_reversal'
  ]));

comment on constraint wallet_transactions_category_check on public.wallet_transactions is
  'Allowed ledger categories. ''TIP'' was removed on 2026-08-20 when dealer tipping was deleted from the product — do not re-add it without a deliberate product decision.';
